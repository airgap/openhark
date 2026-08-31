#!/usr/bin/env node
// OpenHark terminal client: a real mouse+keyboard TUI over the OpenHark dashboard
// HTTP API (dashboard.mjs). The server is the single source of truth; this is one
// of its clients (the web page is the other).
//
//   openhark                               # the installed command
//   node bin/tui/index.mjs
//
// Auto-connects to http://127.0.0.1:5400 using the server's local token file
// (<state>/token, written 0600 by the server). Override with OPENHARK_URL /
// OPENHARK_TOKEN. The /api routes are token-gated.
// Keys: up/down select, t detail tab (prompt/timeline/log), m merge, r retry, k kill, q quit.
import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'neo-blessed';
import { t as tr, padEndW, dispWidth, cycleLocale, getLocale, LOCALE_NAMES } from './i18n.mjs';
import { STATE_DIR } from '../env.mjs';
const blessed = pkg.default || pkg;
// blessed's default xterm mouse mode is the deprecated UTF-8 extension (1005), which
// modern terminals (Warp) and tmux passthrough do not report - so no mouse events
// arrive at all. Force SGR (1006) + all-motion, which everything supports. Must be set
// before the screen enables mouse (blessed reads it in program.enableMouse).
// Mouse is on by default but overridable via HARK_MOUSE: 0/off disables mouse entirely
// (pure-keyboard fallback), `click` keeps click-to-select but drops all-motion hover
// (for a laggy link where the hover event stream would flood). Keys are bound at the
// screen level, so the all-motion stream can no longer starve keyboard input.
const MOUSE = !/^(0|off|false|no)$/i.test(process.env.HARK_MOUSE || '');
const HOVER = MOUSE && !/^click$/i.test(process.env.HARK_MOUSE || '');
if (MOUSE) process.env.BLESSED_FORCE_MODES ??= HOVER ? 'SGRMOUSE,CELLMOTION,ALLMOTION' : 'SGRMOUSE,CELLMOTION';

const URL = (process.env.OPENHARK_URL || process.env.HARKNESS_URL || 'http://127.0.0.1:5400').replace(/\/$/, '');
// Auto-connect: fall back to the server's local token file (<state>/token, written
// 0600 by the server) so `openhark` just works against localhost with no env setup.
const readToken = () => {
	try {
		return readFileSync(join(STATE_DIR, 'token'), 'utf8').trim();
	} catch {
		return '';
	}
};
const TOKEN = process.env.OPENHARK_TOKEN || process.env.HARKNESS_TOKEN || process.env.DASH_TOKEN || readToken();
const lib = URL.startsWith('https:') ? https : http;

function req(method, path, body) {
	return new Promise((resolve, reject) => {
		const data = body ? JSON.stringify(body) : null;
		const headers = { accept: 'application/json' };
		if (data) headers['content-type'] = 'application/json';
		if (TOKEN) headers['x-swarm-token'] = TOKEN;
		const r = lib.request(URL + path, { method, headers, timeout: 15000 }, (res) => {
			let d = '';
			res.on('data', (c) => (d += c));
			res.on('end', () => {
				let j = {};
				try {
					j = d ? JSON.parse(d) : {};
				} catch {}
				if (res.statusCode >= 400) reject(new Error(j.error || `HTTP ${res.statusCode}`));
				else resolve(j);
			});
		});
		r.on('error', reject);
		r.on('timeout', () => r.destroy(new Error('timeout')));
		if (data) r.write(data);
		r.end();
	});
}
const apiGet = (p) => req('GET', p);
const apiPost = (p, b) => req('POST', p, b);

// --- palette (blessed tags) ---
const G = (s) => `{#7cf0a6-fg}${s}{/}`;
const DIM = (s) => `{#4f7d60-fg}${s}{/}`;
const AMB = (s) => `{#f0b429-fg}${s}{/}`;
const RED = (s) => `{#f2686a-fg}${s}{/}`;
const BLU = (s) => `{#6cc6ff-fg}${s}{/}`;
const ORG = (s) => `{#e8934a-fg}${s}{/}`; // FLAKY: an infra review failure, distinct from red rejects
const TEAL = (s) => `{#5fd0c0-fg}${s}{/}`; // DONE: already satisfied on main, distinct from a real merge
const VIO = (s) => `{#c58af0-fg}${s}{/}`; // DISPUTED: premise contested, needs a human decision, distinct from a reject
const B = (s) => `{bold}${s}{/bold}`;
const HDR = (hex, s) => `{bold}{${hex}-fg}${s}{/}`;
// Agent identity coloured per character along each harness's brand gradient, so the name carries
// the brand (Gemini blue->purple->pink, Qwen light lavender, Claude coral, Fable pink); Qwen is
// kept lighter so it never shares its cube colours with Gemini/Antigravity's purple end. Applied
// wherever an author or reviewer appears. The stops trace each brand's own gradient and are
// hand-verified to render as colour: neo-blessed's 256 matcher snaps exact cube hexes and many
// mid-tone blues to ANSI/grey, so these off-cube hexes are the ones that actually land on a cube
// entry. Characters sample the ramp by position (no interpolation, so no unverified hex ever
// reaches the matcher).
const GEMINI_GRAD = ['#4285f4', '#4a72ed', '#4d6beb', '#7561d9', '#9e72cc', '#c471d5', '#df70c3', '#e8709a'];
const AGENT_GRAD = {
	claude: ['#b8563a', '#c45a3a', '#d77454', '#e69b74', '#e69c75'],
	gemini: GEMINI_GRAD,
	agy: GEMINI_GRAD,
	qwen: ['#8f7cf0', '#9c86f1', '#b69df1', '#c4a9f0'],
	fable: ['#ff6fa8', '#ff74ab', '#ff9cc3', '#ff9ec4', '#ffc4d9'],
};
const AGENT_LABEL = { gemini: 'agy', agy: 'agy' }; // show 'agy' for the gemini-keyed harness; keep the id
const plainName = (n) => AGENT_LABEL[(n || '').toLowerCase()] || n || '?';
// The brand ramps pre-matched to palette indices, for the shimmer overlay (which writes indices
// straight into the screen buffer rather than emitting {hex-fg} tags).
const AGENT_GRAD_IDX = Object.fromEntries(Object.entries(AGENT_GRAD).map(([k, r]) => [k, r.map((h) => blessed.colors.match(h))]));
const gradText = (name, ramp) => [...name].map((c, i, arr) => `{${ramp[Math.round((arr.length < 2 ? 0 : i / (arr.length - 1)) * (ramp.length - 1))]}-fg}${c}{/}`).join('');
const agentTag = (n) => { const key = (n || '').toLowerCase(); const disp = AGENT_LABEL[key] || n || '?'; return AGENT_GRAD[key] ? gradText(disp, AGENT_GRAD[key]) : DIM(disp); };
// A reviewer is a '+'-joined panel (e.g. gemini+qwen), so map each name through agentTag, not
// the whole string, or the display label (gemini -> antigravity) is missed and the raw harness
// key leaks for multi-reviewer panels. A solo self-review shows "self" rather than "(none)".
const agentTags = (s) => (s || '?').split('+').map((n) => agentTag(n)).join(DIM('+'));
const whoTag = (a, r) => `${agentTags(a || '?')}${DIM('→')}${!r || r === '(none)' ? DIM(tr('self')) : agentTags(r)}`;

const STAGE_LABEL = { queued: 'QUEUED', worktree: 'WORKTREE', editing: 'EDITING', committing: 'COMMIT', gating: 'TESTS', fixing: 'FIXING', pr_open: 'PR OPEN', reviewing: 'REVIEW', approved: 'APPROVED', merging: 'MERGING', merged: 'MERGED', changes_requested: 'CHANGES', failed: 'FAILED', skipped: 'SKIPPED', flaky: 'FLAKY', already_done: 'DONE', disputed: 'DISPUTED', start: 'START' };
// One hue per stage, shared by the tag and the timeline so a status is the same
// colour everywhere it appears.
const stageHue = (s) => (s === 'merged' || s === 'approved') ? G : (s === 'failed' || s === 'skipped' || s === 'changes_requested') ? RED : (s === 'reviewing' || s === 'pr_open') ? BLU : s === 'flaky' ? ORG : s === 'already_done' ? TEAL : s === 'disputed' ? VIO : s === 'queued' ? DIM : AMB;
const stageTag = (s) => stageHue(s)(`[${STAGE_LABEL[s] || (s || '?').toUpperCase()}]`);
// The stage's colour as a hex, for the combined status bar's background/foreground.
const stageHex = (s) => (s === 'merged' || s === 'approved') ? '#7cf0a6' : (s === 'failed' || s === 'skipped' || s === 'changes_requested') ? '#f2686a' : (s === 'reviewing' || s === 'pr_open') ? '#6cc6ff' : s === 'flaky' ? '#e8934a' : s === 'already_done' ? '#5fd0c0' : s === 'disputed' ? '#c58af0' : s === 'queued' ? '#4f7d60' : '#f0b429';
// The REV cell reads D<n>/R<n>: version n while it is a Draft (author producing or fixing
// code) vs under Review. These are the code-producing stages; pr_open onward is published.
const REV_DRAFT = new Set(['editing', 'committing', 'gating', 'fixing', 'revising']);
// REV foreground grades green (a fresh draft, 0 reworks) to red (many reworks) so a ticket that
// keeps bouncing stands out. Indexed by revision count, clamped at the red end.
const REV_RAMP = ['#7cf0a6', '#b6e26a', '#f0d43c', '#f0a028', '#f2686a'];
const revHue = (rev) => REV_RAMP[Math.min(rev, REV_RAMP.length - 1)];

// Minimal markdown -> blessed tags for the agent log. Braces are escaped FIRST (the
// detail box has tags:true, so a literal { in the log would be read as a tag), then
// styling is layered as tags. Single-* italics are deliberately skipped: agent logs
// are full of globs and paths (*.ts, a * b) that would false-match.
// One pass, or the } inside an injected {open} gets re-escaped into {open{close}.
const mdEsc = (s) => s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));

// Code-fence syntax highlighting (One Dark-ish). One tokeniser per line splits into
// comment / string / number / identifier / other; identifiers are matched against a
// per-language keyword set. Strings keep an OPTIONAL closing quote so an unterminated
// line still colours. mdEsc runs per token, so braces inside code stay literal.
const CODE = { com: '#5c6370', str: '#98c379', num: '#d19a66', kw: '#c678dd', lit: '#56b6c2' };
const KW_JS = new Set('const let var function fun pure return if else for while do switch case break continue new class extends super this import export from default async await yield try catch finally throw typeof instanceof in of delete void interface type enum implements public private protected readonly static as is namespace declare abstract get set'.split(' '));
const KW_SH = new Set('if then else elif fi for while until do done case esac in function return export local readonly declare unset source alias set echo cd exit'.split(' '));
const LIT = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
// Groups: 1 line-comment, 2 block-comment, 3 string, 4 number, 5 identifier, 6 other.
const TOK_JS = /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)|(\s+|[^\s\w$])/g;
const TOK_SH = /(#[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)|(\s+|[^\s\w$])/g;
function highlightCode(line, lang) {
	const shell = /^(sh|bash|zsh|shell|console)$/.test(lang);
	const kws = shell ? KW_SH : KW_JS;
	const re = shell ? TOK_SH : TOK_JS;
	re.lastIndex = 0;
	let out = '', m;
	while ((m = re.exec(line))) {
		const tok = m[0];
		if (m[1] || m[2]) out += `{${CODE.com}-fg}${mdEsc(tok)}{/}`;
		else if (m[3]) out += `{${CODE.str}-fg}${mdEsc(tok)}{/}`;
		else if (m[4]) out += `{${CODE.num}-fg}${tok}{/}`;
		else if (m[5]) out += kws.has(tok) ? `{${CODE.kw}-fg}${tok}{/}` : LIT.has(tok) ? `{${CODE.lit}-fg}${tok}{/}` : tok;
		else out += mdEsc(tok);
		if (re.lastIndex === m.index) re.lastIndex++;
	}
	return out;
}
function mdTui(text) {
	if (!text) return '';
	const out = [];
	let fenced = false, lang = '';
	for (const raw of String(text).split('\n')) {
		const fm = raw.match(/^\s*```(\w*)/);
		if (fm) { fenced ? (fenced = false, lang = '') : (fenced = true, lang = fm[1].toLowerCase()); out.push(DIM(mdEsc(raw))); continue; }
		if (fenced) { out.push(highlightCode(raw, lang)); continue; }
		const h = raw.match(/^(#{1,6})\s+(.*)$/);
		if (h) { out.push(HDR('#e0a878', mdEsc(h[2]))); continue; }
		let l = mdEsc(raw).replace(/^(\s*)[-*]\s+/, '$1{#7cf0a6-fg}•{/} ');
		l = l.replace(/`([^`]+)`/g, (_, c) => `{#6cc6ff-fg}${c}{/}`);
		l = l.replace(/\*\*([^*]+)\*\*/g, (_, c) => `{bold}${c}{/bold}`);
		out.push(l);
	}
	return out.join('\n');
}
// Status label coloured in the stage's hue on the foreground, not a filled block: lighter, and
// it matches how stage colour is shown elsewhere (timeline, backlog). The foreground survives
// row selection now that invertSelected is off, so the colour holds on the selected row too.
// Deliberately NOT a progress bar - the flow loops back (gate->fix, review->changes_requested),
// so a monotonic fill would misrepresent it; the colour and the label carry the state.
const STATUS_W = 10;
const statusBar = (stage) => `{${stageHex(stage)}-fg}${padEndW(tr(STAGE_LABEL[stage] || (stage || '?').toUpperCase()), STATUS_W)}{/}`;
const GROUPS = [['queued', 'worktree', 'start'], ['editing', 'committing'], ['gating', 'fixing'], ['pr_open', 'reviewing', 'changes_requested', 'flaky', 'disputed'], ['approved', 'merging', 'merged', 'already_done']];
const GROUP_NAMES = ['queue', 'develop', 'test', 'blocking review', 'merge'];
const groupOf = (s) => { for (let i = 0; i < GROUPS.length; i++) if (GROUPS[i].includes(s)) return i; return 0; };
const fmtDur = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60; return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}m${String(s).padStart(2, '0')}`; };
const since = (ms) => ms ? fmtDur((Date.now() - ms) / 1000) : '';
const dur = (ms) => ms > 0 ? fmtDur(ms / 1000) : '0m00';
const TICKET_SETTLED = ['approved', 'merged', 'changes_requested', 'failed', 'skipped', 'flaky', 'already_done', 'disputed'];
const elapsedOf = (t) => !t.started ? since(t.updated) : dur((TICKET_SETTLED.includes(t.stage) ? (t.updated || t.started) : Date.now()) - t.started);
const hms = (ts) => ts ? new Date(ts).toLocaleTimeString('en-GB') : '';
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

// --- ui ---
const screen = blessed.screen({ smartCSR: true, mouse: true, title: 'OPENHARK', fullUnicode: true });
const theme = { fg: '#9fe3b2', bg: '#070a07' };
const border = { type: 'line', fg: '#1c3626' };

// Appearance config, persisted next to the token so it survives relaunch.
const UI_FILE = join(STATE_DIR, 'ui.json');
let UI = { rain: false, splitV: 62, splitH: 64 };
try { UI = { ...UI, ...JSON.parse(readFileSync(UI_FILE, 'utf8')) }; } catch {}
UI.splitV = Math.min(80, Math.max(25, UI.splitV || 62));
UI.splitH = Math.min(85, Math.max(20, UI.splitH || 64));
const saveUI = () => { try { writeFileSync(UI_FILE, JSON.stringify(UI)); } catch {} };

// Matrix rain: katakana glyphs composited into empty cells after each render, so the panels
// keep their real background. blessed's `transparent` blend was wrong here - it forces the cell
// background to ANSI-0 (grey in some terminals, e.g. Warp) and has no truecolor, collapsing the
// drops to grey. So only the glyph and its foreground are written; the background and any real
// content are left untouched.
//
// The movie look needs three things a flat two-tone drop lacks: a brightness RAMP from a near
// white head down through greens to black; glyphs that PERSIST as a column falls (each cell's
// glyph is fixed when the head passes and only rarely mutates, rather than the whole field
// scrambling every frame); and per-column fractional speeds so streams fall at different rates.
// Half-width katakana (U+FF66..FF9D) render single-width, so columns never drift.
const RAIN_GLYPHS = 'ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:=*+<>';
const rainGlyph = () => RAIN_GLYPHS[(Math.random() * RAIN_GLYPHS.length) | 0];
// Head (index 0) to tail, matched to the 256-colour palette once. Dim streams start a few steps
// in (no white head), which reads as depth behind the bright ones.
const RAIN_RAMP = ['#d7ffe4', '#9dffbf', '#7cf0a6', '#57cf86', '#41ad6c', '#2e8a54', '#207a48', '#16613a', '#12512d'].map((h) => blessed.colors.match(h));
const newDrop = (H) => ({ yf: -(Math.random() * H) - 2, hy: -1e6, len: 6 + ((Math.random() * 16) | 0), speed: 0.3 + Math.random() * 0.7, off: Math.random() < 0.3 ? 3 : 0, on: Math.random() < 0.62 });
let rainCols = [], RAIN_CELLS = [], glyphBuf = [], glyphW = 0, glyphH = 0;
function rainStep() {
	if (!UI.rain) return;
	const W = screen.width | 0, H = screen.height | 0;
	if (W < 2 || H < 2) return;
	if (glyphW !== W || glyphH !== H) { rainCols = Array.from({ length: W }, () => newDrop(H)); glyphBuf = new Array(W * H).fill(''); glyphW = W; glyphH = H; }
	const cells = [], N = RAIN_RAMP.length;
	for (let x = 0; x < W; x++) {
		const c = rainCols[x];
		c.yf += c.speed;
		const hy = Math.floor(c.yf);
		if (hy !== c.hy) { c.hy = hy; if (hy >= 0 && hy < H) glyphBuf[hy * W + x] = rainGlyph(); } // fresh glyph as the head enters a row
		if (c.on) for (let i = 0; i < c.len; i++) {
			const y = hy - i; if (y < 0 || y >= H) continue;
			let g = glyphBuf[y * W + x]; if (!g) g = glyphBuf[y * W + x] = rainGlyph();
			const ci = Math.min(N - 1, c.off + (((i / Math.max(1, c.len - 1)) * (N - 1 - c.off)) | 0));
			cells.push({ x, y, ch: g, col: RAIN_RAMP[ci] });
		}
		if (c.on && Math.random() < 0.1) { const y = hy - 1 - ((Math.random() * c.len) | 0); if (y >= 0 && y < H) glyphBuf[y * W + x] = rainGlyph(); } // shimmer: mutate one trailing glyph
		if (hy - c.len > H) Object.assign(c, newDrop(H));
	}
	RAIN_CELLS = cells;
	screen.render();
}
// Write the drops onto the composited buffer (foreground + glyph only), leaving each cell's
// background and any real content untouched, then flush the changed lines.
function stampRain() {
	const lines = screen.lines;
	for (const cell of RAIN_CELLS) {
		const row = lines[cell.y]; if (!row) continue;
		const cc = row[cell.x]; if (!cc || cc[1] !== ' ') continue;
		cc[0] = (cc[0] & ~(0x1ff << 9)) | (cell.col << 9);
		cc[1] = cell.ch;
		row.dirty = true;
	}
	screen.draw(0, screen.height - 1);
}
setInterval(rainStep, 75);
// Cursor fluid: a short-lived matrix trail follows mouse movement, drifting down as it fades,
// composited like the rain and gated on the same matrix toggle. Sparks are stamped after the
// rain so the trail reads as the brighter, leading glyphs near the pointer.
const SPARK_RAMP = ['#f0fff6', '#b6ffd0', '#8ef0b0', '#57cf86', '#2e8a54'].map((h) => blessed.colors.match(h));
let SPARKS = [], sparkTimer = null;
// Drop glyphs along the segment the pointer just travelled (so a fast flick leaves a continuous
// trail, not dots), plus an occasional lateral glyph for a splashy edge. Each spark starts at
// full brightness and ages out.
function addSparks(x0, y0, x1, y1) {
	const dx = x1 - x0, dy = y1 - y0, steps = Math.min(12, Math.max(1, Math.abs(dx), Math.abs(dy)));
	for (let k = 0; k <= steps; k++) {
		const x = Math.round(x0 + (dx * k) / steps), y = Math.round(y0 + (dy * k) / steps);
		if (Math.random() < 0.5) { const L = 6 + ((Math.random() * 4) | 0); SPARKS.push({ x, y, ch: rainGlyph(), life: L, max: L }); }
		if (Math.random() < 0.2) { const L = 4 + ((Math.random() * 3) | 0); SPARKS.push({ x: x + (Math.random() < 0.5 ? 1 : -1), y, ch: rainGlyph(), life: L, max: L }); }
	}
	if (SPARKS.length > 500) SPARKS.splice(0, SPARKS.length - 500);
	if (!sparkTimer) sparkTimer = setInterval(ageSparks, 55);
}
function ageSparks() {
	if (!SPARKS.length) { clearInterval(sparkTimer); sparkTimer = null; return; }
	const H = screen.height | 0;
	for (const s of SPARKS) { s.life--; if (Math.random() < 0.3) s.y++; if (Math.random() < 0.2) s.ch = rainGlyph(); } // drip + shimmer
	SPARKS = SPARKS.filter((s) => s.life > 0 && s.y < H);
	screen.render();
}
function stampSparks() {
	const lines = screen.lines, N = SPARK_RAMP.length;
	for (const s of SPARKS) {
		const row = lines[s.y]; if (!row) continue;
		const cc = row[s.x]; if (!cc || cc[1] !== ' ') continue;
		const ci = SPARK_RAMP[Math.min(N - 1, ((1 - s.life / s.max) * N) | 0)];
		cc[0] = (cc[0] & ~(0x1ff << 9)) | (ci << 9);
		cc[1] = s.ch;
		row.dirty = true;
	}
	screen.draw(0, screen.height - 1);
}
// The running agent's name shimmers (its brand gradient scrolls) to show life. runSideOf says
// which side has a live LLM - the author while editing/fixing/revising, the panel while reviewing
// (agentPid confirms a spawn is actually up). SHIMMER_TARGETS, built in renderPipe from the ptab
// layout, locate each running agent's cells; stampShimmer overwrites their fg with the ramp
// scrolled by SHIMMER, so it animates by re-stamping - no table rebuild, so scroll is untouched.
const AUTHOR_ACTIVE = new Set(['editing', 'fixing', 'revising']);
// Coordinator-only active stages: real work (git, gate, merge) with no LLM agent pid, so they
// carry no shimmer agent. The row still sweeps to show life, gated on freshness (below).
const CO_ACTIVE = new Set(['worktree', 'committing', 'gating', 'pr_open', 'merging']);
// The agent keys with a live LLM right now. During review: the ticket's `running` set (panel
// members still going, each shimmering independently) when the coordinator tracks it; else a
// fallback to the whole panel, gated on a live pid. Otherwise the sole author while it works.
// agentPid is dashboard-verified (dead pids are nulled), so a stuck ticket does not falsely shimmer.
const runningAgents = (x) => {
	if (!x) return [];
	if (x.stage === 'reviewing') return Array.isArray(x.running) ? x.running : x.agentPid && x.reviewer && x.reviewer !== '(none)' ? x.reviewer.split('+') : [];
	if (x.agentPid && AUTHOR_ACTIVE.has(x.stage)) return [x.author];
	return [];
};
// A ticket is "running" when a live process is on it right now: a live LLM agent (runningAgents), or a
// coordinator-only stage (merge/gate/commit/pr/worktree) whose coordinator PROCESS is alive. This is the
// same liveness that drives the row shimmer, so the running group is exactly the set of rows that sweep.
const isRunningTicket = (x) => !!x && (runningAgents(x).length > 0 || (CO_ACTIVE.has(x.stage) && x.coordAlive));
let SHIMMER = 0, SHIMMER_TARGETS = [], SHIMMER_ROWS = [];
function stampShimmer() {
	const lines = screen.lines, cb = ptab.childBase || 0, x0 = ptab.aleft + ptab.ileft, top = ptab.atop + ptab.itop;
	for (const t of SHIMMER_TARGETS) {
		const y = t.row - cb + top;
		if (y <= top || y >= ptab.abottom) continue; // header row or scrolled off
		const row = lines[y]; if (!row) continue;
		for (let j = 0; j < t.len; j++) {
			const cc = row[x0 + t.col + j]; if (!cc || cc[1] === ' ') continue;
			cc[0] = (cc[0] & ~(0x1ff << 9)) | (t.ramp[(((j + SHIMMER) % t.ramp.length) + t.ramp.length) % t.ramp.length] << 9);
			row.dirty = true;
		}
	}
	screen.draw(0, screen.height - 1);
}
// A Knight Rider green scanner: a bright-green band bounces left<->right across each actively-
// running row (SHIMMER_ROWS holds their visible table rows), dark green at the edges to bright at the
// centre. Only the bg bits are written, so text and its colour are untouched. Greens are verified
// to land on real cube palette entries (dark greens otherwise snap to grey).
const ROW_SHIMMER_BG = ['#16613a', '#237a4a', '#39a862', '#4fbf78', '#5fd08a'].map((h) => blessed.colors.match(h));
const SHIMMER_BAND = 8; // scanner half-width, in cells
function stampRowShimmer() {
	const lines = screen.lines, cb = ptab.childBase || 0, x0 = ptab.aleft + ptab.ileft, top = ptab.atop + ptab.itop;
	const inner = (ptab.width | 0) - 3, N = ROW_SHIMMER_BG.length;
	const p = (SHIMMER * 4) % (2 * inner); // 4 cells/tick
	const center = p <= inner ? p : 2 * inner - p; // triangle wave: sweep right, then back left
	for (const r of SHIMMER_ROWS) {
		if (r === ptab.selected) continue; // leave the selected/hover highlight alone
		const y = r - cb + top;
		if (y <= top || y >= ptab.abottom) continue;
		const row = lines[y]; if (!row) continue;
		for (let dx = 0; dx < inner; dx++) {
			const d = Math.abs(dx - center);
			if (d > SHIMMER_BAND) continue;
			const cc = row[x0 + dx]; if (!cc) continue;
			cc[0] = (cc[0] & ~0x1ff) | ROW_SHIMMER_BG[Math.min(N - 1, ((1 - d / SHIMMER_BAND) * N) | 0)];
			row.dirty = true;
		}
	}
	screen.draw(0, screen.height - 1);
}
// Re-stamp the drops on top of whatever was just drawn, so an unrelated redraw between ticks
// does not erase them.
const _render = screen.render.bind(screen);
// SHIMMER_TARGETS is populated only by renderPipe's jobs path and cleared in the other modes, so
// it stands in for "jobs mode with a live agent" without referencing MODE here (this wrapper runs
// during widget construction, before MODE's let is initialized).
// SHIMMER_TARGETS.length is checked first (it is [] until renderPipe runs): it short-circuits so
// MODAL/MODE, whose `let`s come later in the file, are never touched while widgets are still being
// constructed (this wrapper fires during that, before those bindings initialize).
screen.render = function () { _render(); if (UI.rain && RAIN_CELLS.length) stampRain(); if (UI.rain && SPARKS.length) stampSparks(); if (SHIMMER_ROWS.length && !MODAL) { stampRowShimmer(); stampShimmer(); } };
setInterval(() => { if (SHIMMER_ROWS.length && !MODAL) { SHIMMER++; screen.render(); } }, 90);

const bar = blessed.box({ parent: screen, top: 0, left: 0, height: 1, width: '100%', tags: true, style: { fg: theme.fg } });
const pipe = blessed.list({ parent: screen, label: ' JOBS ', top: 1, left: 0, width: UI.splitV + '%', height: UI.splitH + '%', border, tags: true, mouse: true, keys: false, scrollbar: { ch: ' ' }, style: { fg: theme.fg, border: { fg: '#1c3626' }, label: { fg: '#7cf0a6' }, selected: { bg: '#7cf0a6', fg: '#06130a' }, item: { fg: theme.fg } } });
// The pipeline board is a real table (auto-aligned columns + header row) in the same slot as
// `pipe`; setMode() toggles which is visible. Backlog + agent-log keep using `pipe` (a list).
// listtable measures cells by strWidth (tags stripped), so colored cells still align.
// The selected/hover row style overrides each cell's own colours, so it is a NEUTRAL slate,
// not green: a green highlight made the STATUS badge read as a 'done' status on that row.
// invertSelected:false stops neo-blessed forcing the selected row's foreground (element.js
// ~2003), so the badge keeps its stage colour on that row instead of collapsing to the
// selection fg. No fork needed - the behaviour is a built-in option.
const ptab = blessed.listtable({ parent: screen, label: ' JOBS ', top: 1, left: 0, width: UI.splitV + '%', height: UI.splitH + '%', border, tags: true, mouse: true, keys: false, align: 'left', pad: 1, noCellBorders: true, invertSelected: false, scrollbar: { ch: ' ' }, style: { fg: theme.fg, border: { fg: '#1c3626' }, label: { fg: '#7cf0a6' }, header: { fg: '#7cf0a6', bold: true }, cell: { fg: theme.fg, selected: { bg: '#33415e', fg: '#eef2fb' }, hover: { bg: '#28324a', fg: '#eef2fb' } } } });
ptab.hide();
// blessed's table sizing spreads the leftover panel width evenly across every column, so the
// small ones (REV/COM/TIME) get padded as much as the title. Instead keep each column at its
// content width (+pad, never below the header) and let the title column (index 1) alone flex: it
// takes the leftover width, or gives width back when the row would overflow, so the small
// columns stay at their real width and nothing runs off the right edge.
const TITLE_MIN = 16;
// Per-column content-width floors for the jobs board (column index -> min). TIME (8) always
// reserves room for a full duration (e.g. 59m59 / 23h59) so it never shrinks and jump-resizes.
const COL_MIN = { 8: 5 };
ptab._calculateMaxes = function () {
	if (this.detached) return;
	const maxes = [];
	for (const row of this.rows || []) row.forEach((cell, i) => { const w = this.strWidth(cell); if (maxes[i] == null || maxes[i] < w) maxes[i] = w; });
	if (!maxes.length) return (this._maxes = maxes);
	const widths = maxes.map((m, i) => Math.max(m, COL_MIN[i] || 0) + (this.pad || 0));
	const slack = (this.width | 0) - (widths.reduce((a, b) => a + b, 0) + widths.length + 1);
	if (widths.length > 1) widths[1] = Math.max(TITLE_MIN, widths[1] + slack);
	return (this._maxes = widths);
};
const activeList = () => (MODE === 'jobs' ? ptab : pipe);
const runs = blessed.box({ parent: screen, label: ' RUNS ', top: UI.splitH + 1 + '%', left: 0, width: UI.splitV + '%', bottom: 1, border, tags: true, scrollable: true, style: { fg: theme.fg, border: { fg: '#1a3c38' }, label: { fg: '#5ec7c4' } } });
const detail = blessed.box({ parent: screen, label: ' DETAIL ', top: 1, left: UI.splitV + '%', right: 0, bottom: 1, border, tags: true, scrollable: true, keys: true, mouse: true, scrollbar: { ch: ' ' }, style: { fg: theme.fg, border: { fg: '#2c2348' }, label: { fg: '#c58af9' } } });
const help = blessed.box({ parent: screen, bottom: 0, left: 0, height: 1, width: '100%', tags: true, style: { fg: '#4f7d60' } });
// Draggable pane splits: the vertical split is the detail's left edge (pipe/runs width),
// the horizontal split is the pipe's bottom edge (pipe vs runs). Repositions on drag.
function applySplits() {
	pipe.width = UI.splitV + '%'; runs.width = UI.splitV + '%'; detail.left = UI.splitV + '%';
	pipe.height = UI.splitH + '%'; runs.top = UI.splitH + 1 + '%';
	ptab.width = UI.splitV + '%'; ptab.height = UI.splitH + '%';
	screen.render();
}
let DRAG = null; // 'v' | 'h' while dragging a split
// Grabbable only on the panel BORDER cells (detail's left border and the pipe/runs right
// border beside it; runs' top border and pipe's bottom border above it), read from the
// rendered geometry. A rounded percentage with +/-1 slop bled one column into the detail
// pane, where the runner enable [x] sits flush against the border - so its clicks were
// swallowed as a split-grab and never toggled.
const splitAt = (x, y) => {
	const vx = detail.aleft; // detail left border; pipe/runs right border is vx-1
	const hy = runs.atop;    // runs top border; pipe bottom border is hy-1
	if ((x === vx || x === vx - 1) && y >= pipe.atop && y < screen.height - 1) return 'v';
	if ((y === hy || y === hy - 1) && x >= 0 && x < vx - 1) return 'h';
	return null;
};

// --- modal overlays: a dropdown list and a text input. screen.grabKeys routes keys to
// the focused overlay (suppressing the global screen.key handlers); the mouse handler
// bails while MODAL is set. Both restore focus to the list on close.
let MODAL = null;
// Last mouse position, so a click-opened overlay (the harness/model dropdown) anchors to its
// trigger instead of the screen centre.
let LAST_MOUSE = { x: 2, y: 2 };
function closeModal() { if (MODAL) { try { MODAL.destroy(); } catch {} MODAL = null; screen.grabKeys = false; activeList().focus(); screen.render(); } }
// idx-under-cursor for a modal list: invert the row layout (content row 0 sits at atop+itop).
const modalRowAt = (box, data) => (box.childBase || 0) + (data.y - box.atop - box.itop);
function openList(title, items, current, onPick, anchor) {
	closeModal();
	const w = Math.min(64, Math.max(24, ...items.map((s) => String(s).length)) + 4);
	const h = Math.min(items.length + 2, 18);
	// Drop from the trigger: anchor at the click, clamped so the box stays fully on-screen.
	const a = anchor || LAST_MOUSE;
	const top = Math.max(1, Math.min(a.y + 1, screen.height - h - 1));
	const left = Math.max(0, Math.min(a.x, screen.width - w));
	// mouse:false: the global handler drives clicks (_pick) and hover (_hover) via modalRowAt,
	// so blessed's own per-item click (which also fires on mouseup) does not double-act.
	const box = blessed.list({
		parent: screen, top, left, width: w, height: h,
		border: { type: 'line' }, label: ` ${title} (esc) `, tags: true, keys: true, mouse: false, vi: true,
		style: { fg: theme.fg, bg: '#0a140d', border: { fg: '#c58af9' }, label: { fg: '#c58af9' }, selected: { bg: '#7cf0a6', fg: '#06130a' }, item: { fg: theme.fg } },
		scrollbar: { ch: ' ', style: { bg: '#1c3626' } },
	});
	box.setItems(items.map(String));
	const ci = items.indexOf(current); if (ci >= 0) box.select(ci);
	let done = false;
	const pick = (idx) => { if (done || idx < 0 || idx >= items.length) return; done = true; const v = items[idx]; closeModal(); onPick(v, idx); };
	box.on('select', (_, idx) => pick(idx)); // keyboard enter
	// Require a press+release on the same row (a real click). A drag reports repeated
	// mousedowns, so acting on each would re-pick every move; the opening click's release
	// (its press landed before this modal existed) never matches.
	let downRow = -1;
	box._pick = (data) => {
		const i = modalRowAt(box, data);
		if (data.action === 'mousedown') downRow = i >= 0 && i < items.length ? i : -1;
		else if (data.action === 'mouseup') { if (downRow >= 0 && i === downRow) pick(i); downRow = -1; }
	};
	// Hover: slide the selection bar to the row under the cursor (needs mouse motion, same as
	// every other hover in the UI).
	box._hover = (data) => { if (data.action !== 'mousemove') return; const i = modalRowAt(box, data); if (i >= 0 && i < items.length && i !== box.selected) { box.select(i); screen.render(); } };
	box.key(['escape', 'q'], closeModal);
	MODAL = box; screen.grabKeys = true; box.focus(); screen.render();
}
function openInput(title, initial, onSubmit) {
	closeModal();
	const box = blessed.textbox({
		parent: screen, top: 'center', left: 'center', width: 50, height: 3,
		border: { type: 'line' }, label: ` ${title} (enter/esc) `, tags: true, mouse: true, inputOnFocus: true, keys: true,
		style: { fg: theme.fg, bg: '#0a140d', border: { fg: '#c58af9' }, label: { fg: '#c58af9' } },
	});
	box.setValue(initial || '');
	MODAL = box;
	box.readInput((err, val) => { closeModal(); if (val != null) onSubmit(val); });
	screen.render();
}
// Rain is composited by the render wrapper; toggling just re-renders, clearing the drops
// when turning it off so the next redraw wipes them.
function applyAppearance() {
	if (!UI.rain) RAIN_CELLS = [];
	screen.render();
}
function openSettings() {
	closeModal();
	const items = () => [`${tr('language')}: {#7cf0a6-fg}${LOCALE_NAMES[getLocale()]}{/}`, `${tr('matrix rain')}: ${UI.rain ? '{#7cf0a6-fg}ON{/}' : 'off'}`, tr('close')];
	const box = blessed.list({
		parent: screen, top: 'center', left: 'center', width: 42, height: 8,
		border: { type: 'line' }, label: ` ${tr('settings · appearance')} (esc) `, tags: true, keys: true, mouse: false, vi: true,
		style: { fg: theme.fg, bg: '#0a140d', border: { fg: '#c58af9' }, label: { fg: '#c58af9' }, selected: { bg: '#7cf0a6', fg: '#06130a' } },
	});
	box.setItems(items());
	// Selecting the language row cycles to the next locale and repaints every surface behind the modal;
	// its own label and items are rebuilt too, so the settings screen itself shows the new language.
	const choose = (idx) => {
		if (idx === 0) { const l = cycleLocale(); MSG = G(LOCALE_NAMES[l]); box.setLabel(` ${tr('settings · appearance')} (esc) `); box.setItems(items()); box.select(0); renderHelp(); renderBar(); renderPipe(); renderDetail(); refreshRuns(); screen.render(); }
		else if (idx === 1) { UI.rain = !UI.rain; saveUI(); applyAppearance(); box.setItems(items()); box.select(1); screen.render(); }
		else if (idx === 2) closeModal();
	};
	box.on('select', (_, idx) => choose(idx));
	let downRow = -1;
	box._pick = (data) => {
		const i = modalRowAt(box, data);
		if (data.action === 'mousedown') downRow = i >= 0 && i < 3 ? i : -1;
		else if (data.action === 'mouseup') { if (downRow >= 0 && i === downRow) choose(i); downRow = -1; }
	};
	box._hover = (data) => { if (data.action !== 'mousemove') return; const i = modalRowAt(box, data); if (i >= 0 && i < 3 && i !== box.selected) { box.select(i); screen.render(); } };
	box.key(['escape', 'q'], closeModal);
	MODAL = box; screen.grabKeys = true; box.focus(); screen.render();
}
// Tracker + project selection (POST /api/tracker). Row 0 cycles the tracker; the rest are the
// active adapter's projects as checkboxes to pull from. Multi-select, so it stays open on a
// toggle and saves on esc. An unconfigured adapter (jira/asana) reports no projects.
async function openTrackerPicker() {
	closeModal();
	let cfg;
	try { cfg = await apiGet('/api/tracker'); } catch (e) { MSG = RED('tracker: ' + String(e.message).slice(0, 60)); screen.render(); return; }
	const trackers = cfg.trackers || ['github'];
	const avail = cfg.available || [];
	const sel = new Set((cfg.projects || []).map((s) => String(s).toUpperCase()));
	let track = cfg.tracker || 'github';
	const items = () => {
		const rows = [`${tr('tracker')}: {#7cf0a6-fg}${track}{/}  ${DIM(tr('(enter/click cycles)'))}`];
		if (!avail.length) rows.push(DIM('  ' + tr('no projects (adapter not configured)')));
		else for (const p of avail) rows.push(`  ${sel.has(p.key) ? G('[x]') : DIM('[ ]')} ${B(p.key)}  ${DIM(clip(p.name || '', 22))}`);
		return rows;
	};
	const h = Math.min(items().length + 2, 22), w = 46, a = LAST_MOUSE;
	const box = blessed.list({
		parent: screen, top: Math.max(1, Math.min(a.y + 1, screen.height - h - 1)), left: Math.max(0, Math.min(a.x, screen.width - w)), width: w, height: h,
		border: { type: 'line' }, label: ` ${tr('tracker + projects')} (${tr('esc saves')}) `, tags: true, keys: true, mouse: false, vi: true,
		style: { fg: theme.fg, bg: '#0a140d', border: { fg: '#c58af9' }, label: { fg: '#c58af9' }, selected: { bg: '#7cf0a6', fg: '#06130a' } },
		scrollbar: { ch: ' ', style: { bg: '#1c3626' } },
	});
	const render = () => { const s = box.selected; box.setItems(items()); box.select(Math.min(s || 0, box.items.length - 1)); screen.render(); };
	render();
	const act = (i) => {
		if (i === 0) { track = trackers[(trackers.indexOf(track) + 1) % trackers.length]; render(); }
		else if (avail.length && i >= 1 && i <= avail.length) { const k = avail[i - 1].key; sel.has(k) ? sel.delete(k) : sel.add(k); render(); }
	};
	let downRow = -1;
	box._pick = (data) => { const i = modalRowAt(box, data); if (data.action === 'mousedown') downRow = i; else if (data.action === 'mouseup') { if (i === downRow) act(i); downRow = -1; } };
	box.on('select', (_, i) => act(i));
	box._hover = (data) => { if (data.action !== 'mousemove') return; const i = modalRowAt(box, data); if (i >= 0 && i < box.items.length && i !== box.selected) { box.select(i); screen.render(); } };
	const save = async () => {
		closeModal();
		try { await apiPost('/api/tracker', { tracker: track, projects: [...sel] }); MSG = G('tracker ' + track + ' · ' + ([...sel].join(',') || 'none')); }
		catch (e) { MSG = RED('tracker save: ' + String(e.message).slice(0, 60)); }
		renderBar(); if (MODE === 'backlog') loadBacklog(); screen.render();
	};
	box.key(['escape', 'q'], save);
	MODAL = box; screen.grabKeys = true; box.focus(); screen.render();
}
// A keybinding hint with the shortcut underlined inside the word (l -> {u}l{/}aunch), the rest dim.
// A key that is not a single letter of the word (spc, up/down) falls back to "key word".
const hint = (key, word) => {
	const i = key.length === 1 ? word.toLowerCase().indexOf(key.toLowerCase()) : -1;
	if (i < 0) return `{#4f7d60-fg}${key} ${word}{/}`;
	return `{#4f7d60-fg}${word.slice(0, i)}{/}{underline}{#a6e3c0-fg}${word[i]}{/}{/underline}{#4f7d60-fg}${word.slice(i + 1)}{/}`;
};
function renderHelp() {
	help.setContent([tr('up/down sel'), hint('b', tr('tab')), hint('spc', tr('pick')), hint('l', tr('launch')), hint('a', 'fable'), hint('A', tr('auto')), hint('m', tr('merge')), hint('r', tr('retry')), hint('k', tr('kill')), hint('c', tr('connect')), hint('p', tr('tracker')), hint('s', tr('settings')), hint('L', tr('lang')), hint('q', tr('quit'))].map((s) => (s.includes('{') ? s : DIM(s))).join('  ') + '  ' + DIM('· ' + LOCALE_NAMES[getLocale()]));
	runs.setLabel(' ' + tr('RUNS') + ' '); detail.setLabel(' ' + tr('DETAIL') + ' ');
}
renderHelp();

let RUN = null, HISTORY = [], PRS = [], SEL = 0, TAB = 'prompt', MSG = '', SPECS = {}, LOGS = {}, EVENTS = {}, HOVER_TAB = null;
let SORT = { col: -1, dir: 1 }; // jobs board sort: col -1 = server order (newest run first); dir 1 asc / -1 desc
// Jobs table row <-> ticket-index maps, rebuilt in renderPipe: the header and the group separators
// mean a visible table row and a tickets() index no longer differ by a constant. selOfRow[row] is the
// ticket index for a data row, or -1 for the header/a separator; rowOfSel[sel] is the inverse.
let SEL_OF_ROW = [], ROW_OF_SEL = [];
let MODE = 'jobs', BACKLOG = [], CHECKED = new Set(), AUTO = { on: false, mode: 'go' }, BACKLOG_LOADING = false;
let TRACKER = { connected: false, exp: null }, CONNECTING = false, SRVERR = '';
let SWARM = { runners: [], total: 1 }, HMETA = {}, HQUOTA = {}, HOVER_CTRL = null, HOVER_ROW = -1, HOVER_NAV = null;
// Agent chat: a conversational Claude with the harkness MCP tools. Each turn spawns
// `claude -p ... --continue` in a dedicated cwd so the conversation persists.
let CHAT = [], CHAT_BUSY = false;
const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'agent-chat');
const DEFAULT_SP = 'You are OpenHark Copilot, an operator for an autonomous coding swarm. Use the openhark MCP tools (openhark_state, openhark_runs, openhark_backlog, openhark_launch, openhark_retry, openhark_swarm, openhark_autobatch, openhark_ticket, openhark_merge, openhark_kill) to inspect and manage it. Be concise and act: when asked to change config or launch/merge/retry work, call the tool rather than describing it. Confirm what you did in one or two lines.';
// Click spans for the backlog controls rendered in the detail pane: { contentRow: { id: [colStart, colEnd] } }.
let CTRL_HITS = {};
// The plain (untinted) item strings currently in the pipe list, so a hover tint can be
// applied/removed on a single row via pipe.setItem without a full setItems (which resets
// the scroll). Rewritten whenever renderPipe/renderBacklog rebuilds the list.
let LIST_ITEMS = [];
const HOVER_BG = '#2d5a3f';
// Tint one visible list row as the hover indicator (never the selected row) using
// setItem, so scrolling/pagination is preserved. Called from the mousemove handler.
function setHoverRow(j) {
	if (j === HOVER_ROW) return;
	// setItem targets the blessed list's real rows, which can lag LIST_ITEMS (e.g. the board
	// just went idle: pipe.items is empty while LIST_ITEMS is still the last run). Bound every
	// setItem by BOTH so a hover never dereferences a row that no longer exists.
	const n = Math.min(LIST_ITEMS.length, pipe.items.length);
	if (HOVER_ROW >= 0 && HOVER_ROW < n) pipe.setItem(HOVER_ROW, LIST_ITEMS[HOVER_ROW]);
	HOVER_ROW = j;
	if (j >= 0 && j < n && j !== pipe.selected) pipe.setItem(j, `{${HOVER_BG}-bg}${LIST_ITEMS[j]}{/}`);
	screen.render();
}
const trackerDays = () => TRACKER.exp ? Math.max(0, Math.round((TRACKER.exp - Date.now() / 1000) / 86400)) : 0;
// The same ticket appears once per run it ran in (a retry or re-launch is a new run), so the raw
// history carries visual duplicates - most glaringly when a ticket was retried many times. Collapse to
// one row per ticket id, keeping the most recently updated (its freshest state: a live run beats a
// stale terminal duplicate, and two terminals keep the later settle). Identity filter preserves the
// incoming newest-run-first order, so the kept rows stay ordered.
const dedupeLatest = (list) => {
	const best = new Map();
	for (const t of list) {
		const p = best.get(t.id);
		if (!p || (t.updated || 0) > (p.updated || 0) || ((t.updated || 0) === (p.updated || 0) && (t.runStarted || 0) > (p.runStarted || 0))) best.set(t.id, t);
	}
	return list.filter((t) => best.get(t.id) === t);
};
// The board is the persistent job history (every run's tickets, newest first) once it has loaded;
// the current run alone is the fallback before the first /api/state lands.
const baseTickets = () => (HISTORY.length ? HISTORY : (RUN && RUN.tickets) || []);
// Jobs sort keys, one per column index. STATUS sorts by pipeline order (GROUPS) not alphabetically;
// END sorts unfinished tickets last; TIME is the real duration, not the formatted cell.
const STAGE_RANK = Object.fromEntries(GROUPS.flat().map((s, i) => [s, i]));
const comCount = (x) => { const pr = x.pr ? PRS.find((p) => p.number === x.pr) : null; return pr ? (pr.comments || 0) + (pr.review_comments || 0) : 0; };
const jobDurMs = (x) => (x.started ? (TICKET_SETTLED.includes(x.stage) ? x.updated || x.started : Date.now()) - x.started : 0);
const sortVal = (x, col) =>
	col === 0 ? x.id || '' : col === 1 ? (x.title || '').toLowerCase() : col === 2 ? (x.author || '').toLowerCase() : col === 3 ? STAGE_RANK[x.stage] ?? 99 : col === 4 ? (x.rev == null ? -1 : x.rev) : col === 5 ? comCount(x) : col === 6 ? x.runStarted || x.started || 0 : col === 7 ? (TICKET_SETTLED.includes(x.stage) ? x.updated || 0 : Infinity) : jobDurMs(x);
// Re-applied on every read so a chosen sort survives refreshes; col < 0 keeps the server order.
const SORT_NAMES = ['ID', 'TICKET', 'AGENTS', 'STATUS', 'REV', 'COM', 'START', 'END', 'TIME'];
const isActiveTicket = (t) => !TICKET_SETTLED.includes(t.stage); // still in flight, not a terminal outcome
// Three display groups, top to bottom: 0 running (a live process is on it), 1 active (in flight but
// nothing running right now), 2 done (terminal). The board always lists them in this order. (Distinct
// from groupOf above, which buckets a single stage string into its pipeline phase.)
const dispGroup = (x) => (isRunningTicket(x) ? 0 : isActiveTicket(x) ? 1 : 2);
const tickets = () => {
	const base = baseTickets();
	const sorted = SORT.col < 0 ? base : base.slice().sort((a, b) => {
		const va = sortVal(a, SORT.col), vb = sortVal(b, SORT.col);
		let c = (typeof va === 'string' ? va.localeCompare(vb, undefined, { numeric: true }) : va < vb ? -1 : va > vb ? 1 : 0) * SORT.dir;
		if (c === 0) c = (a.id || '').localeCompare(b.id || '', undefined, { numeric: true }); // tie-break by id so any sort reorders visibly
		return c;
	});
	// Running tasks first, then active (idle, in-flight), then done, whatever the sort column; each split
	// is stable, so the chosen sort order is preserved within every group.
	const g = [[], [], []];
	for (const t of sorted) g[dispGroup(t)].push(t);
	return g[0].concat(g[1], g[2]);
};
const cur = () => tickets()[SEL] || null;
// The jobs table inserts a labeled separator row between adjacent groups, so a visible table row and a
// tickets() index no longer differ by a constant; renderPipe fills SEL_OF_ROW / ROW_OF_SEL to map both
// ways. A separator (or the header) maps to -1, which the callers already treat as "no selection".
const rowToSel = (row) => (row >= 0 && row < SEL_OF_ROW.length ? SEL_OF_ROW[row] : -1);
const selToRow = (sel) => (sel >= 0 && sel < ROW_OF_SEL.length ? ROW_OF_SEL[sel] : sel + 1);
// Sort by a column: a new column starts ascending, the same column flips direction. Two-state, so a
// column is never silently un-sorted mid-toggle (press 0 to clear back to the server order).
function sortBy(col) {
	if (col == null || col < -1) return;
	const selKey = cur() ? ckey(cur()) : null;
	if (col < 0) SORT = { col: -1, dir: 1 };
	else if (SORT.col === col) SORT.dir = -SORT.dir;
	else SORT = { col, dir: 1 };
	if (selKey) { const i = tickets().findIndex((x) => ckey(x) === selKey); if (i >= 0) SEL = i; }
	MSG = DIM(SORT.col < 0 ? tr('sort: newest run first') : `${tr('sort')}: ${tr(SORT_NAMES[SORT.col])} ${SORT.dir > 0 ? '▲' : '▼'}`);
	renderPipe(); renderBar(); renderDetail(); screen.render();
}
// A ticket can be kicked off from the jobs list unless it is already done (merged/approved) or a
// live agent is on it right now. That covers reworkable terminals (failed/skipped/flaky/changes)
// AND non-terminal tickets stranded by a dead coordinator; agentPid is dashboard-verified live.
const canRetry = (t) => !!t && !['merged', 'approved', 'already_done'].includes(t.stage) && !t.agentPid;
// Detail caches key by run + id: the same ticket id recurs across runs, so a bare id would show
// one run's timeline/spec for another. runId is absent only on the pre-history fallback rows.
const ckey = (t) => (t && t.runId ? t.runId + ':' : '') + (t && t.id);
const runQ = (t) => (t && t.runId ? '&run=' + encodeURIComponent(t.runId) : '');
const bsel = () => (MODE === 'backlog' ? BACKLOG[pipe.selected] : null) || null;
// Hit-tests for the backlog UI: a control id under (x,y) in the detail pane (via the
// CTRL_HITS spans recorded at render), the backlog list row under the cursor, and
// whether a list click landed in the leftmost checkbox column.
const ctrlAt = (x, y) => {
	if (MODE !== 'backlog' && MODE !== 'agent') return null; // both panes render CTRL_HITS controls
	const drow = (y - detail.atop - detail.itop) + (detail.childBase || 0);
	const dcol = x - detail.aleft - detail.ileft;
	const hits = CTRL_HITS[drow];
	if (!hits) return null;
	for (const id in hits) { const [a, b] = hits[id]; if (dcol >= a && dcol <= b) return id; }
	return null;
};
// The jobs-table column index under x (for a header click -> sort). Columns start at the cell area
// (aleft+ileft) and each occupies its _maxes width plus a 1-col gap, matching the shimmer geometry.
const headerColAt = (x) => {
	const mx = ptab._maxes; if (!mx || !mx.length) return -1;
	const dcol = x - (ptab.aleft + ptab.ileft);
	if (dcol < 0) return -1;
	let pos = 0;
	// each column owns its width plus the 1-col separator that follows, so a click in the gap still
	// sorts that column; a click past the last column falls to it rather than being lost.
	for (let i = 0; i < mx.length; i++) { pos += mx[i] + 1; if (dcol < pos) return i; }
	return mx.length - 1;
};
// The visible list row (absolute item index) under (x,y), for either mode's list body.
const listRowAt = (x, y) => { const w = activeList(); return x >= w.aleft && x <= w.aright && y > w.atop && y < w.abottom ? (w.childBase || 0) + (y - w.atop - w.itop) : -1; };
const inCheckbox = (x) => x - pipe.aleft - pipe.ileft <= 3;

// tracker connect indicator: green dot when the durable token is live, amber c-hint when not.
const trkTag = () => TRACKER.connected ? `${DIM(tr('trk') + ':')}${G('●' + trackerDays() + 'd')}` : `${DIM(tr('trk') + ':')}${AMB('○ c:connect')}`;
// Harness quota widget. agy/gemini reports a hard daily quota WITH a reset time, claude a transient
// throttle (no reset), qwen (local) nothing. Show the worst known state per harness, with a live
// countdown for an agy reset. There is no remaining-quota number to read, so this is a state.
const cdFmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h${m}m` : `${m || 1}m`; };
const quotaSeg = (h) => {
	const q = HQUOTA[h]; if (!q) return '';
	const nm = plainName(h);
	if (q.state === 'exhausted') return RED(`${nm} ⚠ ${q.resetAt ? 'resets ' + cdFmt(q.resetAt - Date.now()) : 'quota'}`);
	if (q.state === 'throttled') return ORG(`${nm} throttled${q.lastHit ? ' ' + cdFmt(Date.now() - q.lastHit) + ' ago' : ''}`);
	return DIM(`${nm} ok`);
};
const quotaHarnesses = () => [...new Set((SWARM.runners || []).map((r) => r.harness))];
const quotaWarn = () => {
	const ex = quotaHarnesses().filter((h) => HQUOTA[h] && HQUOTA[h].state === 'exhausted');
	return ex.length ? '   ' + RED('⚠ ' + ex.map((h) => `${plainName(h)} quota${HQUOTA[h].resetAt ? ' ' + cdFmt(HQUOTA[h].resetAt - Date.now()) : ''}`).join(' · ')) : '';
};
function renderBar() {
	if (!RUN) { bar.setContent(`{inverse} OPENHARK {/inverse} ${DIM(tr('no active run'))} ${trkTag()} ${AUTO.on ? AMB('◆auto:' + AUTO.mode + ' ' + tr('watching')) : ''}${quotaWarn()}${MSG ? '  ' + MSG : ''}${SRVERR ? '  ' + RED('⚠ ' + SRVERR) : ''}`); return; }
	const t = tickets();
	const active = !RUN.done && t.some((x) => !['merged', 'failed', 'skipped', 'changes_requested', 'flaky', 'already_done', 'disputed', 'queued'].includes(x.stage));
	const merged = t.filter((x) => x.stage === 'merged').length;
	const failed = t.filter((x) => x.stage === 'failed' || x.stage === 'skipped').length;
	const agents = t.filter((x) => x.agentPid).length;
	bar.setContent(`{inverse} OPENHARK {/inverse} ${DIM(tr('run') + ':')}${RUN.runId} ${active ? G('● ' + tr('RUNNING')) : DIM('○ ' + tr('idle'))} ${DIM(tr('up') + ':')}${since(RUN.startedAt)} ${DIM(tr('agents') + ':')}${agents} ${DIM(tr('failed') + ':')}${failed ? RED(failed) : failed} ${DIM(tr('merged') + ':')}${G(merged)} ${DIM(tr('mode') + ':')}${RUN.mode} ${trkTag()} ${AUTO.on ? AMB('◆auto:' + AUTO.mode) : ''}${quotaWarn()}${MSG ? '   ' + MSG : ''}${SRVERR ? '   ' + RED('⚠ ' + SRVERR) : ''}`);
}
// The panel's label IS the jobs/backlog tab bar. Both tabs keep a fixed visible
// width (` jobs `, ` backlog `) whether or not they are the selected/inverse one,
// so the click-column mapping in navAt stays put. Any backlog count trails the
// tabs and never shifts them.
function setPipeTabs() {
	// selected tab is inverse; hovered (non-selected) tab gets the green pad. All keep the same
	// ` name ` width so navAt's column mapping is unchanged.
	const tab = (name, active) => { const s = ` ${tr(name)} `; return active ? `{inverse}${s}{/inverse}` : HOVER_NAV === name ? `{#7cf0a6-fg}{#1c3626-bg}${s}{/}` : s; };
	// The tab bar IS the panel label; in jobs mode the visible panel is ptab (the table), in
	// backlog/agent it is pipe (the list), so label both and whichever is shown reads correctly.
	const label = `${tab('jobs', MODE === 'jobs')}${tab('backlog', MODE === 'backlog')}${tab('agent', MODE === 'agent')}${MODE === 'backlog' && CHECKED.size ? DIM('  ' + CHECKED.size + ' sel') : ''}`;
	pipe.setLabel(label); ptab.setLabel(label);
}
async function setMode(m) {
	if (MODE === m) return;
	MODE = m; HOVER_CTRL = null; HOVER_ROW = -1;
	// The pipeline board is the table; backlog + agent use the list. Show one, hide the other.
	if (m === 'jobs') { pipe.hide(); ptab.show(); } else { ptab.hide(); pipe.show(); }
	if (m === 'backlog' && !BACKLOG.length) await loadBacklog();
	renderPipe(); renderDetail(); renderBar(); screen.render();
}
function renderBacklog() {
	setPipeTabs();
	if (BACKLOG_LOADING) { LIST_ITEMS = [DIM('  ' + tr('listing open tickets from the tracker...'))]; pipe.setItems(LIST_ITEMS); return; }
	if (!BACKLOG.length) { LIST_ITEMS = [DIM('  ' + tr('press b to reload, or the backlog is empty'))]; pipe.setItems(LIST_ITEMS); return; }
	const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));
	// Title fills the panel: inner width minus the checkbox+id+gaps prefix (14) and the scrollbar (1).
	const tw = Math.max(10, (pipe.width || 60) - 2 - 1 - 14);
	// setItems resets cursor/scroll, so save+restore both, keep LIST_ITEMS plain, and
	// re-apply the hover tint on one row via setItem so scroll/pagination is preserved.
	const sel = pipe.selected, base = pipe.childBase || 0;
	LIST_ITEMS = BACKLOG.map((t) => `${CHECKED.has(t.id) ? G('[x]') : DIM('[ ]')} ${B(pad(t.id, 9))} ${clip(t.title || '', tw).padEnd(tw)}`);
	pipe.setItems(LIST_ITEMS);
	pipe.selected = Math.max(0, Math.min(sel || 0, pipe.items.length - 1));
	pipe.childBase = base;
	if (HOVER_ROW >= 0 && HOVER_ROW < LIST_ITEMS.length && HOVER_ROW !== pipe.selected) pipe.setItem(HOVER_ROW, `{${HOVER_BG}-bg}${LIST_ITEMS[HOVER_ROW]}{/}`);
}
async function loadBacklog() {
	BACKLOG_LOADING = true; renderBacklog(); screen.render();
	try { const r = await apiGet('/api/backlog'); BACKLOG = r.tickets || []; MSG = r.error ? RED('backlog: ' + r.error) : ''; } catch (e) { MSG = RED('backlog: ' + e.message); }
	BACKLOG_LOADING = false; renderBacklog(); screen.render();
}
// Full ticket detail (priority/type/labels/description), fetched once per id and cached.
const BL_DETAIL = {}, BL_LOADING = new Set();
async function loadBacklogTicket(id) {
	if (BL_DETAIL[id] || BL_LOADING.has(id)) return;
	BL_LOADING.add(id);
	try { const r = await apiGet('/api/backlog-ticket?id=' + encodeURIComponent(id)); if (r && r.issue) BL_DETAIL[id] = r.issue; } catch {}
	BL_LOADING.delete(id);
	const b = bsel();
	if (MODE === 'backlog' && b && b.id === id) { renderDetail(); screen.render(); }
}
// The agent transcript, one compact line per turn, lives in the pipe list; the full
// rendered conversation is in the detail pane (renderDetail's agent branch).
function renderAgentLog() {
	setPipeTabs();
	const w = Math.max(20, (pipe.width || 60) - 14);
	const roleW = Math.max(dispWidth(tr('you')), dispWidth(tr('copilot')));
	const items = CHAT.length ? CHAT.map((m) => `${m.role === 'user' ? G(padEndW(tr('you'), roleW)) : BLU(padEndW(tr('copilot'), roleW))} ${DIM(clip((m.text || '').replace(/\s+/g, ' '), w))}`) : [DIM('  ' + tr('press i to chat with the agent'))];
	if (CHAT_BUSY) items.push(AMB('  ' + tr('copilot is working...')));
	LIST_ITEMS = items; pipe.setItems(items);
	pipe.select(Math.max(0, items.length - 1));
}
// The agent tab owns the swarm runner matrix (harness/model/cap/enable) - global config that has no
// place in a backlog ticket's detail. The matrix rows go FIRST so their click-map indices are fixed;
// the copilot conversation trails below (variable length, non-interactive), and the chat log also
// lives in the left list pane. Controls reuse CTRL_HITS, so ctrlAt must accept agent mode too.
function renderAgentDetail() {
	CTRL_HITS = {};
	const lines = [];
	const line = (segs) => lines.push(ctrlRow(lines.length, segs));
	const rn = SWARM.runners || [];
	const dw = Math.max(24, (detail.width || 44) - 3);
	lines.push(HDR('#c58af9', tr('SWARM RUNNERS')) + DIM('  ' + tr('(click harness/model to pick, [e] renames)')));
	const CW = 3 + 2 + 3 + 1 + 3 + 1 + 3; // [-] NN [+] _ del _ [e]
	const maxLabel = Math.max(10, dw - 4 - CW);
	const parts = rn.map((r) => {
		const h = (HMETA[r.harness] && HMETA[r.harness].label) || r.harness;
		const nm = r.name ? ` (${r.name})` : '';
		return { h, nm, m: clip(r.model || 'default', Math.max(3, maxLabel - h.length - 1 - nm.length)) };
	});
	const labelCol = Math.min(maxLabel, Math.max(8, ...parts.map((p) => p.h.length + 1 + p.m.length + p.nm.length)) + 1);
	rn.forEach((r, k) => {
		const { h, nm, m } = parts[k];
		const labelLen = h.length + 1 + m.length + nm.length;
		line([
			btn('en:' + k, r.enabled ? '[x]' : '[ ]', { on: r.enabled, off: !r.enabled }),
			seg(' ', null),
			btn('harness:' + k, h), seg('/', null), btn('model:' + k, m), seg(nm, DIM),
			seg(' '.repeat(Math.max(1, labelCol - labelLen)), null),
			btn('capd:' + k, '[-]'), seg(String(r.cap), null), btn('capi:' + k, '[+]'),
			seg(' ', null), btn('rm:' + k, 'del'), seg(' ', null), btn('name:' + k, '[e]'),
		]);
	});
	line([pill('add', '+ add runner'), seg('   parallel ', DIM), seg(String(SWARM.total || 0), G)]);
	const qh = quotaHarnesses();
	if (qh.length) lines.push(DIM(tr('quota') + '  ') + qh.map(quotaSeg).filter(Boolean).join(DIM('  ·  ')));
	lines.push('');
	lines.push(HDR('#c58af9', tr('OPENHARK COPILOT')) + DIM('   ' + tr('i: send   p: prompt')));
	if (!CHAT.length) lines.push(DIM(tr('Ask me to inspect or manage the swarm, e.g.\n  what is the current run?\n  enable claude sonnet at cap 3\n  retry 42')));
	else for (const m of CHAT) lines.push((m.role === 'user' ? B(G(tr('you'))) : B(BLU(tr('copilot')))) + '\n' + (m.role === 'assistant' ? mdTui(m.text || '') : m.text || ''));
	if (CHAT_BUSY) lines.push(AMB(tr('copilot is working...')));
	detail.setContent(lines.join('\n'));
}
// One turn: spawn `claude -p` with the harkness MCP in a dedicated cwd, --continue after
// the first turn so the conversation persists. Non-streaming: the reply lands whole.
function runClaude(msg) {
	return new Promise((resolve, reject) => {
		const args = ['-p', msg, '--append-system-prompt', UI.agentPrompt || DEFAULT_SP, '--allowedTools', 'mcp__harkness__*', '--permission-mode', 'bypassPermissions', '--output-format', 'text'];
		if (CHAT.length > 1) args.push('--continue');
		let out = '', err = '';
		const p = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd: AGENT_DIR });
		p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (err += d));
		p.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error((err || out || 'claude exited ' + code).slice(-400).trim()))));
		p.on('error', reject);
	});
}
async function sendAgentMessage(msg) {
	if (CHAT_BUSY || !msg || !msg.trim()) return;
	CHAT.push({ role: 'user', text: msg.trim() });
	CHAT_BUSY = true; renderPipe(); renderDetail(); screen.render();
	try { mkdirSync(AGENT_DIR, { recursive: true }); CHAT.push({ role: 'assistant', text: (await runClaude(msg.trim())) || '(no output)' }); }
	catch (e) { CHAT.push({ role: 'assistant', text: 'error: ' + e.message }); }
	CHAT_BUSY = false; renderPipe(); renderDetail();
	if (MODE === 'agent') try { detail.setScrollPerc(100); } catch {} // the runner matrix leads the pane; scroll to the fresh reply
	screen.render();
}
function renderPipe() {
	if (MODE !== 'jobs') { SHIMMER_TARGETS = []; SHIMMER_ROWS = []; } // only the jobs board (ptab) shimmers; clear stale targets
	if (MODE === 'agent') return renderAgentLog();
	if (MODE === 'backlog') return renderBacklog();
	setPipeTabs();
	const t = tickets();
	// Each header is numbered (1..9) so its sort key is obvious: press that number to sort the column.
	// The sorted column highlights (bold + green) and its number carries a ▲/▼ direction marker in
	// place of the separating space, so the width never changes. strWidth ignores the tags.
	const header = SORT_NAMES.map((h0, i) => tr(h0)).map((h, i) =>
		i === SORT.col ? `{bold}{#7cf0a6-fg}${i + 1}${SORT.dir > 0 ? '▲' : '▼'}${h}{/}` : `${i + 1} ${h}`);
	if (!t.length) { SHIMMER_TARGETS = []; SHIMMER_ROWS = []; SEL_OF_ROW = []; ROW_OF_SEL = []; ptab.setData([header, ['', DIM(tr('no jobs yet')), '', '', '', '', '', '', '']]); return; }
	if (SEL >= t.length) SEL = t.length - 1;
	// listtable auto-sizes columns to the widest visible cell (tags stripped), so cells carry
	// their colour without manual padding. REV pairs the 1-indexed version with its phase: D<n>
	// while version n is a draft, R<n> once it is under review, so a ticket walks D1 R1 D2 R2 as
	// it reworks. A dot means not yet picked up. COM is the PR's comment + review-comment count,
	// joined from the open-PR list. A failed ticket's reason shows in the detail pane on select.
	// Build the non-title cells first so we can measure their real widths, then clip the title to
	// the width left over in the panel; ptab._calculateMaxes hands that slack to the title column.
	const built = t.map((x) => {
		const pr = x.pr ? PRS.find((p) => p.number === x.pr) : null;
		const nc = pr ? (pr.comments || 0) + (pr.review_comments || 0) : 0;
		return { x, id: B(x.id), who: whoTag(x.author, x.reviewer), status: statusBar(x.stage), rev: x.rev == null ? DIM('·') : `{${revHue(x.rev)}-fg}${(REV_DRAFT.has(x.stage) ? 'D' : 'R') + (x.rev + 1)}{/}`, com: nc ? String(nc) : DIM('·'), start: DIM(hms(x.runStarted || x.started) || '·'), end: DIM(TICKET_SETTLED.includes(x.stage) ? (hms(x.updated) || '·') : '·'), time: DIM(elapsedOf(x)) };
	});
	const colW = (i, key) => Math.max(ptab.strWidth(header[i]), ...built.map((b) => ptab.strWidth(b[key]))); // header[i] carries the sort arrow, so measure it
	const fixed = colW(0, 'id') + colW(2, 'who') + colW(3, 'status') + colW(4, 'rev') + colW(5, 'com') + colW(6, 'start') + colW(7, 'end') + Math.max(colW(8, 'time'), COL_MIN[8]);
	const titleW = Math.max(TITLE_MIN, ((ptab.width | 0) - 3) - fixed - 17); // panel inner, less the fixed columns and per-column pad + gaps
	const rows = [header];
	SEL_OF_ROW = [-1]; ROW_OF_SEL = []; // header row 0 -> no ticket
	// A dim labeled separator heads each group, which tickets() already ordered running, then active,
	// then done. Every non-empty group carries its own header, whether or not the group above it exists,
	// so the labels stay stable and present as tickets move between groups.
	const SEP_LABELS = { 0: 'running', 1: 'active', 2: 'done' };
	// Size the separator to the title column (titleW display cells) so listtable never clips it mid-tag:
	// a clipped closing {/} leaks as literal text. Center the label in box-drawing dashes; use dispWidth
	// so a CJK or matrix label still lands the right total width.
	const sepRow = (label) => {
		const inner = ` ${label} `, dashes = Math.max(2, titleW - dispWidth(inner)), l = dashes >> 1;
		return ['', DIM('─'.repeat(l) + inner + '─'.repeat(dashes - l)), '', '', '', '', '', '', ''];
	};
	// Strip braces (rare in titles) rather than escape, so listtable can re-clip the cell safely
	// if the flex leaves the column a hair narrower than this estimate; no tag tokens to cut.
	let prevG = -1;
	built.forEach((b, k) => {
		const g = dispGroup(b.x);
		if (g !== prevG) { rows.push(sepRow(tr(SEP_LABELS[g]))); SEL_OF_ROW.push(-1); }
		prevG = g;
		ROW_OF_SEL[k] = rows.length;
		rows.push([b.id, clip((b.x.title || '').replace(/[{}]/g, ''), titleW), b.who, b.status, b.rev, b.com, b.start, b.end, b.time]);
		SEL_OF_ROW.push(k);
	});
	ptab.setData(rows);
	ptab.select(Math.min(selToRow(SEL), rows.length - 1)); // account for the header row and the separator
	// Locate the shimmer cells for tickets with a live agent: the running side's name(s) and their
	// column inside the AGENTS cell (index 2), from the just-settled column widths.
	SHIMMER_TARGETS = []; SHIMMER_ROWS = [];
	const mx = ptab._maxes;
	if (mx && mx.length > 2) {
		const col2 = mx[0] + 1 + mx[1] + 1;
		built.forEach((b, k) => {
			const run = new Set(runningAgents(b.x).map((a) => String(a).toLowerCase()));
			// Any active status sweeps the row: a live LLM agent (run.size), or a coordinator-only stage
			// (merge/gate/commit/pr/worktree, no agent pid) whose coordinator PROCESS is alive (coordAlive,
			// set by the server from the process table). So an in-flight merge sweeps for its full duration,
			// however long the re-gate takes, but a stuck stage whose coordinator died does not.
			if (!isRunningTicket(b.x)) return; // same liveness as group 0, so the running group is exactly what sweeps
			const y = ROW_OF_SEL[k]; // resolved visible row, past the header and the group separators
			SHIMMER_ROWS.push(y); // the row is actively running -> its background sweeps, even without a gradient agent
			if (!run.size) return; // coordinator stage: no agent name to gradient-shimmer
			const aKey = (b.x.author || '').toLowerCase();
			if (run.has(aKey) && AGENT_GRAD_IDX[aKey]) SHIMMER_TARGETS.push({ row: y, col: col2, len: plainName(b.x.author).length, ramp: AGENT_GRAD_IDX[aKey] });
			if (b.x.reviewer && b.x.reviewer !== '(none)') {
				let off = plainName(b.x.author).length + 1; // past "author→"
				for (const sk of b.x.reviewer.split('+')) { const key = sk.toLowerCase(), nm = plainName(sk); if (run.has(key) && AGENT_GRAD_IDX[key]) SHIMMER_TARGETS.push({ row: y, col: col2 + off, len: nm.length, ramp: AGENT_GRAD_IDX[key] }); off += nm.length + 1; }
			}
		});
	}
}
function renderRuns(list) {
	if (!list || !list.length) { runs.setContent(DIM('  ' + tr('no runs yet'))); return; }
	let s = ` ${DIM(padEndW(tr('RUN'), 16))}${DIM(padEndW(tr('STARTED'), 11))}${DIM(padEndW(tr('TKT'), 5))}${DIM(padEndW(tr('MRG'), 5))}${DIM(padEndW(tr('FAIL'), 5))}${DIM(tr('STATUS'))}\n`;
	for (const r of list.slice(0, 8)) {
		const st = r.started ? new Date(r.started).toLocaleTimeString('en-GB') : '?';
		const fv = String(r.failed);
		const failCell = (r.failed ? RED(fv) : fv) + ' '.repeat(Math.max(1, 5 - fv.length));
		s += ` ${G(String(r.runId).padEnd(16))}${st.padEnd(11)}${String(r.tickets).padEnd(5)}${String(r.merged).padEnd(5)}${failCell}${r.running ? AMB(tr('running')) : DIM(tr('complete'))}\n`;
	}
	runs.setContent(s);
}
// --- backlog controls (rendered in the detail pane, clickable + hoverable) ---
// A control row records each clickable segment's visible column span in CTRL_HITS[row]
// so the mouse handler can map a click back to an id. seg lengths are VISIBLE widths
// (before tags), so keep every label ASCII to avoid wide-glyph column drift.
function seg(text, colorFn) { return { render: colorFn ? colorFn(text) : text, len: dispWidth(text) }; }
function pill(id, label, { on = false, off = false } = {}) {
	const t = ` ${label} `;
	const render = HOVER_CTRL === id ? `{#7cf0a6-fg}{#1c3626-bg}${t}{/}` : on ? `{inverse}${t}{/inverse}` : off ? DIM(t) : t;
	return { render, len: dispWidth(t), id };
}
// Like pill but WITHOUT the surrounding spaces, for tight controls (e.g. [-]5[+]).
function btn(id, label, { on = false, off = false } = {}) {
	const render = HOVER_CTRL === id ? `{#7cf0a6-fg}{#1c3626-bg}${label}{/}` : on ? `{inverse}${label}{/inverse}` : off ? DIM(label) : label;
	return { render, len: dispWidth(label), id };
}
function ctrlRow(row, segs) {
	CTRL_HITS[row] = {};
	let str = '', col = 0;
	for (const s of segs) { if (s.id) CTRL_HITS[row][s.id] = [col, col + s.len - 1]; str += s.render; col += s.len; }
	return str;
}
function renderBacklogDetail() {
	CTRL_HITS = {};
	// Build line-by-line so each control row's index (for click mapping) is exactly its
	// content row. The ticket preview is appended after all control rows, so its internal
	// newlines do not shift any control's row.
	const lines = [];
	const line = (segs) => lines.push(ctrlRow(lines.length, segs));
	const N = CHECKED.size;
	line([N > 0 ? pill('launch', `> ${tr('launch')} ${N} ${tr('selected')}`, { on: true }) : seg(' ' + tr('> launch: check a ticket first') + ' ', DIM)]);
	line([seg(tr('autobatch') + ' ', DIM), pill('auto', AUTO.on ? 'ON ' : 'OFF', { on: AUTO.on }), seg(' ', null), pill('mode', (AUTO.mode || 'go').padEnd(3)), seg('   ' + tr('runners + quota: agent tab'), DIM)]);
	lines.push('');
	const t = bsel();
	if (!t) lines.push(DIM('  ' + tr('click or arrow to a backlog ticket to see it')));
	else {
		if (!BL_DETAIL[t.id]) loadBacklogTicket(t.id); // fire-and-forget; re-renders when it lands
		const d = BL_DETAIL[t.id];
		const PRI = ['none', 'low', 'medium', 'high', 'urgent'];
		let tk = `${B(G(t.id))} ${stageHue(t.status)('[' + (t.status || 'backlog') + ']')}${CHECKED.has(t.id) ? '  ' + G('✓ checked') : ''}\n${B(mdEsc((d && d.title) || t.title || ''))}\n`;
		if (d) {
			const bits = [];
			if (d.priority != null) bits.push(AMB('pri ' + (PRI[d.priority] || d.priority)));
			if (d.type) bits.push(DIM('type ' + d.type));
			if (d.assigneeId) bits.push(BLU(tr('assigned')));
			if (Array.isArray(d.labels) && d.labels.length) bits.push(DIM('labels ' + d.labels.map((l) => l.name || l.title || l).join(',')));
			if (bits.length) tk += bits.join('  ') + '\n';
			tk += '\n' + (d.description ? mdTui(d.description) : DIM(tr('(no description)')));
		} else tk += '\n' + DIM(tr('loading ticket detail...'));
		lines.push(tk);
	}
	detail.setContent(lines.join('\n'));
}
function renderDetail() {
	if (MODE === 'agent') return renderAgentDetail();
	if (MODE === 'backlog') return renderBacklogDetail();
	const t = cur();
	if (!t) { detail.setContent(DIM('  ' + tr('select a ticket'))); return; }
	const spec = SPECS[ckey(t)] || {};
	const kill = (['editing', 'reviewing', 'fixing', 'gating'].includes(t.stage) && t.agentPid) ? '  ' + RED(tr('[k: kill]')) : canRetry(t) ? '  ' + AMB(tr('[r: re-launch]')) : '';
	// Tab bar first so it is always on content row 0 (the header title can wrap, which
	// would otherwise move the tabs to a variable row and break click mapping). Active
	// tab is inverse, hovered tab is underlined; both keep the same visible width as a
	// plain ` label ` so the click-column mapping below stays fixed.
	const tab = (name) => { const s = ` ${tr(name)} `; return TAB === name ? `{inverse}${s}{/inverse}` : HOVER_TAB === name ? `{#7cf0a6-fg}{#1c3626-bg}${s}{/}` : s; };
	let s = `${tab('prompt')}  ${tab('timeline')}  ${tab('log')}   ${DIM(tr('(click or t)'))}\n\n`;
	s += `${B(G(t.id))} ${stageTag(t.stage)} ${whoTag(t.author, t.reviewer)}${kill}\n${mdEsc(t.title || '')}\n\n`;
	// A settled-bad ticket carries its reason in the latest event's detail (the skipped/failed
	// report), so surface it up top on select rather than only inside the timeline tab.
	if (t.detail && (t.stage === 'skipped' || t.stage === 'failed' || t.stage === 'changes_requested' || t.stage === 'flaky' || t.stage === 'already_done' || t.stage === 'disputed')) {
		s += HDR(t.stage === 'flaky' ? '#e8934a' : t.stage === 'already_done' ? '#5fd0c0' : t.stage === 'disputed' ? '#c58af0' : '#f2686a', tr(t.stage === 'skipped' ? 'WHY SKIPPED' : t.stage === 'failed' ? 'WHY FAILED' : t.stage === 'flaky' ? 'REVIEW FLAKY' : t.stage === 'already_done' ? 'ALREADY DONE' : t.stage === 'disputed' ? 'PREMISE DISPUTED' : 'CHANGES REQUESTED')) + '\n' + mdEsc(t.detail) + '\n\n';
	}
	if (TAB === 'prompt') {
		s += HDR('#6cc6ff', tr('PROMPT')) + '\n' + (spec.prompt ? mdEsc(spec.prompt) : DIM(tr('(loading)'))) + '\n\n';
		s += HDR('#e0a878', tr('SCOPE')) + '\n' + mdEsc(spec.scope || t.scope || '') + '\n\n';
		s += HDR('#7cf0a6', tr('STAGES')) + '\n';
		const g = t.stage === 'merged' ? GROUPS.length : groupOf(t.stage); const bad = t.stage === 'failed' || t.stage === 'skipped';
		GROUP_NAMES.forEach((name0, i) => {
			const name = tr(name0);
			const done = i < g && !bad, now = i === g && !bad;
			s += `  ${done ? G('✓') : now ? AMB('▸') : DIM('·')} ${done ? name : now ? AMB(name) : DIM(name)}\n`;
		});
	} else if (TAB === 'timeline') {
		s += HDR('#5ec7c4', tr('TIMELINE')) + '\n';
		const evs = EVENTS[ckey(t)] || [];
		if (!evs.length) s += DIM('  ' + tr('(no events yet)'));
		else for (const e of evs) s += `${DIM(hms(e.ts))} ${stageHue(e.stage)(padEndW(tr(STAGE_LABEL[e.stage] || e.stage || ''), 7))} ${mdEsc(e.detail || '')}\n`;
	} else {
		s += HDR('#c58af9', tr('AGENT LOG')) + '\n' + (LOGS[ckey(t)] ? mdTui(LOGS[ckey(t)]) : DIM(tr('(loading)')));
	}
	s += `\n${DIM(tr('pid'))} ${t.agentPid || '-'}  ${DIM(tr('elapsed'))} ${elapsedOf(t) || '-'}` + (t.pr ? `  ${DIM('PR')} #${t.pr}${PRS.some((p) => p.number === t.pr) ? ' ' + AMB(tr('(m: merge)')) : ' ' + G(tr('merged'))}` : '');
	detail.setContent(s);
}

async function loadDetail(t) {
	if (!t) return;
	const k = ckey(t);
	if (!SPECS[k]) { try { SPECS[k] = (await apiGet('/api/ticket?id=' + encodeURIComponent(t.id) + runQ(t))).spec || {}; } catch {} }
	if (TAB === 'log') { try { LOGS[k] = (await apiGet('/api/log?ticket=' + encodeURIComponent(t.id) + runQ(t))).log || '(no log)'; } catch { LOGS[k] = '(log unavailable)'; } }
	if (TAB === 'timeline') { try { EVENTS[k] = (await apiGet('/api/events?ticket=' + encodeURIComponent(t.id) + runQ(t))).events || []; } catch {} }
	renderDetail(); screen.render();
}

async function refresh() {
	try {
		const s = await apiGet('/api/state');
		SRVERR = ''; // a successful poll clears any stale connection error (e.g. a server restart blip)
		RUN = s.run; HISTORY = dedupeLatest(Array.isArray(s.history) ? s.history : []); PRS = Array.isArray(s.prs) ? s.prs : [];
		if (s.autobatch) AUTO = s.autobatch;
		if (s.swarm) SWARM = s.swarm;
		if (s.harnessMeta) HMETA = s.harnessMeta;
		if (s.harnessQuota) HQUOTA = s.harnessQuota;
		if (s.tracker) {
			const was = TRACKER.connected; TRACKER = s.tracker;
			// The connect flow completes in the browser; the poll that first sees the
			// durable token is where we confirm it and refresh a stale backlog view.
			if (CONNECTING && !was && TRACKER.connected) { CONNECTING = false; MSG = G(`${tr('tracker connected')} (~${trackerDays()} ${tr('days')})`); if (MODE === 'backlog') loadBacklog(); }
		}
		renderBar(); renderPipe(); renderDetail(); screen.render();
		if (MODE !== 'backlog') loadDetail(cur());
	} catch (e) {
		SRVERR = e.message && /HTTP 401|login/i.test(e.message) ? 'unauthorized (set OPENHARK_TOKEN to the server token)' : 'server: ' + e.message;
		renderBar(); screen.render();
	}
}
async function refreshRuns() { try { renderRuns((await apiGet('/api/runs')).runs); screen.render(); } catch {} }

async function action(fn, okMsg) {
	try { await fn(); MSG = G(okMsg); } catch (e) { MSG = RED(tr('error') + ': ' + e.message); }
	renderBar(); screen.render(); refresh();
}

// --- backlog control actions (shared by the clickable controls and the keys) ---
function doLaunch() {
	if (MODE !== 'backlog' || !CHECKED.size) return;
	const list = [...CHECKED].map((id) => { const t = BACKLOG.find((x) => x.id === id) || {}; return { id, title: t.title || '', scope: t.scope || '', prompt: `Implement ticket ${id} (${t.title || ''}) and stay strictly within ${t.scope || 'the relevant files'}.` }; });
	action(() => apiPost('/api/run', { tickets: list, go: true }), `${tr('launched')} ${list.length}`);
	CHECKED.clear(); MODE = 'jobs';
}
async function toggleAuto() {
	try { const r = await apiPost('/api/autobatch', { on: !AUTO.on, mode: AUTO.mode || 'go' }); AUTO = { on: r.on, mode: r.mode }; MSG = AUTO.on ? AMB(tr('autobatch ON') + ' (' + AUTO.mode + ')') : DIM(tr('autobatch off')); } catch (e) { MSG = RED('autobatch: ' + e.message); }
	renderDetail(); renderBar(); screen.render();
}
async function cycleMode() {
	const order = ['go', 'sim', 'dry']; const next = order[(order.indexOf(AUTO.mode || 'go') + 1) % order.length];
	try { const r = await apiPost('/api/autobatch', { mode: next }); AUTO = { on: r.on, mode: r.mode }; MSG = DIM(tr('autobatch mode') + ' ' + next); } catch (e) { MSG = RED('autobatch: ' + e.message); }
	renderDetail(); renderBar(); screen.render();
}
// Runner matrix ops: mutate a copy of SWARM.runners then persist the whole set. On a
// rejected write (e.g. no runner left enabled) SWARM keeps the server's truth.
const runnersCopy = () => (SWARM.runners || []).map((r) => ({ ...r }));
async function saveRunners(runners, okMsg) {
	try { const r = await apiPost('/api/swarm', { runners }); SWARM = { ...SWARM, runners: r.runners, total: r.total }; if (okMsg) MSG = DIM(okMsg); } catch (e) { MSG = RED('swarm: ' + e.message); }
	renderDetail(); renderBar(); screen.render();
}
function toggleRunner(k) { const rs = runnersCopy(); if (!rs[k]) return; rs[k].enabled = !rs[k].enabled; saveRunners(rs); }
function setRunnerCap(k, d) { const rs = runnersCopy(); if (!rs[k]) return; rs[k].cap = Math.min(16, Math.max(0, (rs[k].cap || 0) + d)); saveRunners(rs); }
function removeRunner(k) { const rs = runnersCopy(); if (!rs[k]) return; if (rs.length <= 1) { MSG = RED(tr('keep at least one runner')); renderBar(); screen.render(); return; } rs.splice(k, 1); saveRunners(rs); }
function pickRunnerHarness(k) {
	const r = (SWARM.runners || [])[k]; if (!r) return;
	const ids = Object.keys(HMETA).filter((id) => HMETA[id].available);
	if (!ids.length) { MSG = RED(tr('no harnesses available')); renderBar(); screen.render(); return; }
	openList('harness', ids.map((id) => HMETA[id].label), HMETA[r.harness] && HMETA[r.harness].label, (_, idx) => {
		const rs = runnersCopy(); const h = ids[idx]; rs[k].harness = h; rs[k].model = (HMETA[h].models && HMETA[h].models[0]) || ''; saveRunners(rs, 'harness ' + HMETA[h].label);
	});
}
function pickRunnerModel(k) {
	const r = (SWARM.runners || [])[k]; if (!r) return;
	const models = (HMETA[r.harness] && HMETA[r.harness].models) || [];
	if (!models.length) { MSG = RED(tr('no models discovered for') + ' ' + r.harness); renderBar(); screen.render(); return; }
	openList('model', models, r.model, (v) => { const rs = runnersCopy(); rs[k].model = v; saveRunners(rs, 'model ' + v); });
}
function renameRunner(k) {
	const r = (SWARM.runners || [])[k]; if (!r) return;
	openInput('runner name (blank clears)', r.name || '', (v) => { const rs = runnersCopy(); rs[k].name = (v || '').trim() || undefined; saveRunners(rs, rs[k].name ? 'named ' + rs[k].name : 'name cleared'); });
}
function addRunner() {
	const rs = runnersCopy();
	const h = Object.keys(HMETA).find((id) => HMETA[id].available) || 'claude';
	const models = (HMETA[h] && HMETA[h].models) || [];
	rs.push({ harness: h, model: models[0] || '', cap: 1, enabled: false });
	saveRunners(rs, 'runner added - pick a model and enable it');
}
function handleCtrl(id) {
	if (id === 'launch') return doLaunch();
	if (id === 'auto') return toggleAuto();
	if (id === 'mode') return cycleMode();
	if (id === 'add') return addRunner();
	const m = id.match(/^(en|harness|model|capd|capi|rm|name):(\d+)$/);
	if (!m) return;
	const k = Number(m[2]);
	if (m[1] === 'en') toggleRunner(k);
	else if (m[1] === 'harness') pickRunnerHarness(k);
	else if (m[1] === 'model') pickRunnerModel(k);
	else if (m[1] === 'capd') setRunnerCap(k, -1);
	else if (m[1] === 'capi') setRunnerCap(k, 1);
	else if (m[1] === 'rm') removeRunner(k);
	else if (m[1] === 'name') renameRunner(k);
}

// The list highlights by VISUAL row (failed tickets add a reason sub-line), so
// map pipe.selected back to a ticket index. Runs on enter/click (select) and on
// arrow movement (keypress), so the detail pane tracks the highlight live.
function syncFromList() {
	const t = tickets(); const i = rowToSel(ptab.selected || 1); // visible row -> ticket index (skips header + separator)
	if (i >= 0 && i < t.length && SEL !== i) { SEL = i; TAB = 'prompt'; renderDetail(); screen.render(); loadDetail(cur()); }
}
ptab.on('select', syncFromList);
ptab.on('keypress', () => setTimeout(syncFromList, 0));

// Point-and-click + hover, driven from the screen's own mouse event (blessed's per-
// element 'select' does not fire on every terminal). The detail tab bar is content
// row 0; the pipeline rows are the list body. A click acts; a move (all-motion) only
// highlights - the hovered tab underlines and the hovered row previews its detail.
if (MOUSE) {
	try { screen.enableMouse(); } catch {}
	// Force all-motion (1003) + SGR (1006) directly at the terminal, in case blessed did
	// not emit them - some setups need the explicit request for hover (motion) to arrive.
	if (HOVER) try { screen.program.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h'); } catch {}
	// Which interactive target is under (x,y): a detail tab, a pipeline row, or neither.
	const tabAt = (x, y) => {
		if (MODE !== 'jobs') return null; // the prompt/timeline/log detail-tabs exist only in jobs mode
		const row = (y - detail.atop - detail.itop) + (detail.childBase || 0);
		const col = x - detail.aleft - detail.ileft;
		if (row !== 0 || col < 0) return null;
		// Same localized-width walk as navAt: ` name ` tabs separated by 2 spaces, so a click lands
		// on the right sub-tab in any language.
		let pos = 0;
		for (const name of ['prompt', 'timeline', 'log']) { const w = dispWidth(tr(name)) + 2; if (col >= pos && col < pos + w) return name; pos += w + 2; }
		return null;
	};
	const navAt = (x, y) => {
		if (y !== pipe.atop) return null; // the label sits on the panel's top border row
		let lx = x - (pipe._label ? pipe._label.aleft : pipe.aleft + 2);
		if (lx < 0) return null;
		// Walk the localized tab widths (` name ` = display width + 2 spaces) so a click maps to the
		// right tab in any language, where the widths differ (CJK is 2 cells per glyph).
		for (const name of ['jobs', 'backlog', 'agent']) { const w = dispWidth(tr(name)) + 2; if (lx < w) return name; lx -= w; }
		return null;
	};
	screen.on('mouse', (data) => {
		const prevM = LAST_MOUSE;
		LAST_MOUSE = { x: data.x, y: data.y };
		if (MODAL) { if (MODAL._hover) MODAL._hover(data); if (MODAL._pick) MODAL._pick(data); return; } // overlay handles its own mouse
		if (UI.rain && data.action === 'mousemove') addSparks(prevM.x, prevM.y, data.x, data.y);
		if (DRAG) {
			if (data.action === 'mouseup') { DRAG = null; saveUI(); return; }
			if (data.action === 'mousemove') {
				if (DRAG === 'v') UI.splitV = Math.min(80, Math.max(25, Math.round((data.x / screen.width) * 100)));
				else UI.splitH = Math.min(85, Math.max(20, Math.round((data.y / screen.height) * 100)));
				applySplits();
			}
		return;
		}
		const overTab = tabAt(data.x, data.y);
		const overCtrl = ctrlAt(data.x, data.y);
		const overNav = navAt(data.x, data.y);
		const overList = listRowAt(data.x, data.y);
		if (data.action === 'wheelup' || data.action === 'wheeldown') { activeList().scroll(data.action === 'wheelup' ? -3 : 3); screen.render(); return; }
		if (data.action === 'mousemove') {
			if (!HOVER) return;
			let dirty = false;
			if (overTab !== HOVER_TAB) { HOVER_TAB = overTab; renderDetail(); dirty = true; }
			if (overCtrl !== HOVER_CTRL) { HOVER_CTRL = overCtrl; renderDetail(); dirty = true; }
			if (overNav !== HOVER_NAV) { HOVER_NAV = overNav; setPipeTabs(); dirty = true; }
			if (MODE !== 'jobs') setHoverRow(overList >= 0 && overList < LIST_ITEMS.length ? overList : -1); // the table hovers natively
			if (dirty) screen.render();
			return;
		}
		if (data.action === 'mouseup') {
				// Header sort fires on RELEASE. A drag spams mousedowns but sends one mouseup, so this fires
				// exactly once per interaction. It sorts whatever column the release is over.
				if (MODE === 'jobs' && overList === 0) { const c = headerColAt(data.x); if (c >= 0) sortBy(c); }
				return;
			}
		if (data.action === 'mousedown') {
				const sp = splitAt(data.x, data.y); if (sp) { DRAG = sp; return; }
			if (overNav) { setMode(overNav); return; }
			if (overCtrl) { handleCtrl(overCtrl); return; }
			if (MODE === 'jobs') {
				// row 0 is the header: consume its press so the release (mouseup) is what sorts, which fires
				// once even though this terminal reports a drag as a stream of mousedowns. Rows 1..N select.
				if (overList === 0) return;
				{ const i = rowToSel(overList); if (i >= 0 && i < tickets().length) { ptab.select(overList); syncFromList(); return; } }
			} else if (overList >= 0 && overList < LIST_ITEMS.length) {
				if (MODE === 'backlog') {
					const t = BACKLOG[overList];
					pipe.select(overList);
					if (inCheckbox(data.x) && t) { CHECKED.has(t.id) ? CHECKED.delete(t.id) : CHECKED.add(t.id); }
					renderBacklog(); renderDetail(); screen.render();
				} else { pipe.select(overList); syncFromList(); }
				return;
			}
			if (overTab && overTab !== TAB) { TAB = overTab; renderDetail(); loadDetail(cur()); }
			renderBar(); screen.render();
		}
	});
}

screen.key(['q', 'C-c'], () => { screen.destroy(); process.exit(0); });
// Sort the jobs board by column number 1-9 (ID..TIME), same three-state toggle as a header click.
// A reliable path that never depends on click geometry (narrow panels clip the right columns).
for (let n = 1; n <= 9; n++) screen.key(String(n), () => { if (MODE === 'jobs' && !MODAL) sortBy(n - 1); });
screen.key('0', () => { if (MODE === 'jobs' && !MODAL) sortBy(-1); }); // clear sort -> newest run first
screen.key('t', () => { TAB = TAB === 'prompt' ? 'timeline' : TAB === 'timeline' ? 'log' : 'prompt'; renderDetail(); screen.render(); loadDetail(cur()); });
screen.key('m', () => { const t = cur(); if (t && t.pr && PRS.some((p) => p.number === t.pr)) action(() => apiPost('/api/pr/merge', { pr: t.pr, do: 'rebase' }), `${tr('merged PR')} #${t.pr}`); });
screen.key('r', () => { const t = cur(); if (canRetry(t)) action(() => apiPost('/api/retry', { id: t.id, run: t.runId }), `${tr('re-launched')} ${t.id}`); });
screen.key('k', () => { const t = cur(); if (t && t.agentPid) action(() => apiPost('/api/kill', { pid: t.agentPid }), `${tr('killed agent on')} ${t.id}`); });
// Tracker auth: the durable connect is a browser OAuth flow (the callback lands on the
// server), so from here we can only hand over the URL and wait for the next /api/state
// poll to see the token. c shows the URL; refresh() confirms once it is connected.
screen.key('c', () => {
	if (TRACKER.connected) { MSG = G(`${tr('tracker connected')} (~${trackerDays()} ${tr('days left')})`); }
	else { CONNECTING = true; MSG = BLU(`open ${URL}/connect-tracker in your browser to connect the tracker (waiting...)`); }
	renderBar(); screen.render();
});
screen.key('?', () => { MSG = [hint('b', tr('backlog')), hint('spc', tr('pick')), hint('l', tr('launch')), hint('A', tr('auto')), DIM(tr('sort 1-9 (0 clear)')), hint('m', tr('merge')), hint('r', tr('retry')), hint('k', tr('kill')), hint('c', tr('connect'))].join('  '); renderBar(); screen.render(); });
screen.key('b', () => setMode(MODE === 'jobs' ? 'backlog' : MODE === 'backlog' ? 'agent' : 'jobs'));
// Agent chat: i opens an input to send a message; p edits the copilot's system prompt.
screen.key('i', () => { if (MODE === 'agent' && !CHAT_BUSY) openInput('message copilot', '', (v) => sendAgentMessage(v)); });
screen.key('p', () => { if (MODE === 'agent') openInput('copilot system prompt', UI.agentPrompt || DEFAULT_SP, (v) => { UI.agentPrompt = (v || '').trim() || undefined; saveUI(); MSG = DIM(tr('prompt saved')); renderBar(); screen.render(); }); else openTrackerPicker(); });
screen.key('space', () => { if (MODE !== 'backlog') return; const t = bsel(); if (t) { CHECKED.has(t.id) ? CHECKED.delete(t.id) : CHECKED.add(t.id); renderPipe(); renderDetail(); screen.render(); } });
screen.key('l', () => doLaunch());
screen.key('a', async () => {
	if (MODE !== 'backlog') return;
	MSG = DIM(tr('fable picking disjoint...')); renderBar(); screen.render();
	try { CHECKED = new Set(((await apiPost('/api/suggest', { max: SWARM.total || 4 })).tickets || []).map((t) => t.id)); MSG = G(`${tr('checked')} ${CHECKED.size} ${tr('disjoint')}`); } catch (e) { MSG = RED('suggest: ' + e.message); }
	renderPipe(); renderDetail(); renderBar(); screen.render();
});
screen.key('A', () => toggleAuto());
// The runner matrix (enable/model/cap/remove) is edited by clicking its controls in the
// backlog detail pane; there is no per-runner keyboard binding.
// Navigation is global too (the list itself has keys:false), so it works no matter
// what blessed thinks is focused. In backlog mode it previews the highlighted ticket.
// In backlog mode arrows move the selection, keep it vertically centered, and preview it.
screen.key(['up'], () => { const w = activeList(); w.up(1); if (w === ptab && (w.selected || 0) < 1) w.select(1); MODE === 'backlog' ? renderDetail() : syncFromList(); screen.render(); });
screen.key(['down'], () => { activeList().down(1); MODE === 'backlog' ? renderDetail() : syncFromList(); screen.render(); });

screen.key('s', () => openSettings());
// Cycle the UI language: en -> fr -> es -> zh -> mx (matrix) -> en. Persisted; repaint every surface.
screen.key('L', () => { const l = cycleLocale(); MSG = G(LOCALE_NAMES[l]); renderHelp(); renderBar(); renderPipe(); renderDetail(); refreshRuns(); screen.render(); });
// Default mode is 'active', so show the table and hide the list up front.
pipe.hide(); ptab.show(); ptab.focus();
setPipeTabs(); // label the tab bar before the first paint so the static ' JOBS ' never flashes
applyAppearance(); applySplits();
refresh(); refreshRuns();
setInterval(refresh, 1500);
setInterval(refreshRuns, 8000);
setInterval(() => { if (RUN) { renderBar(); screen.render(); } }, 1000);
