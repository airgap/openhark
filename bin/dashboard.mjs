#!/usr/bin/env node
// Local web dashboard + HTTP API for the agent swarm. Monitor + drive:
//  - reads the run state written live by coordinator.mjs (shared SQLite)
//  - lists open PRs from the configured forge (tokens never reach the browser)
//  - launches runs, kills a run or a stuck agent, and merges/reviews a PR
// Bound to 127.0.0.1 only. /api/* is gated by a shared token (x-swarm-token header or
// ?token=), minted/persisted in the state dir so the local TUI auto-connects.
//
//   node dashboard.mjs               # http://127.0.0.1:5400
//   DASH_PORT=5555 node dashboard.mjs
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, closeSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentRun, listRuns, ticketEvents, recentTickets, getRun, noReworkTicketIds, emit } from './swarm-state.mjs';
import { makeTracker, TRACKERS } from './trackers.mjs';
import { STATE_DIR, ensureStateDir, targetRoot, BIN_DIR } from './env.mjs';

const ROOT = targetRoot();
ensureStateDir();
const HTML = join(BIN_DIR, 'dashboard.html');
const PORT = Number(process.env.DASH_PORT || 5400);
// Web base + repo slug for building PR links in the browser page (cosmetic).
const FORGE_WEB = process.env.OPENHARK_FORGE_WEB || '';
const REPO_SLUG = process.env.GITHUB_REPO || process.env.GITEA_REPO || '';
// Shared token gating /api/*. Minted/persisted (0600) in the state dir so the local TUI
// auto-connects without wiring it by hand; override with OPENHARK_TOKEN or DASH_TOKEN.
const TOKEN_FILE = join(STATE_DIR, 'token');
let TOKEN = process.env.OPENHARK_TOKEN || process.env.DASH_TOKEN || '';
if (!TOKEN) { try { TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {} }
if (!TOKEN) TOKEN = randomBytes(24).toString('hex');
try { writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); } catch {}

// Per-agent forge tokens (GIT_PAT_<AGENT>), so a server-side forge action acts as the right user.
const SECRETS = process.env.OPENHARK_TOKENS_ENV || join(homedir(), '.config', 'openhark', 'tokens.env');
const secretEnv = {};
if (existsSync(SECRETS))
	for (const line of readFileSync(SECRETS, 'utf8').split('\n')) {
		const m = line.match(/^\s*export\s+(GIT_PAT_[A-Z0-9]+)=(.+)$/);
		if (m) secretEnv[m[1]] = m[2];
	}

// A default identity for read-only forge calls (PR listing), so the dashboard works off the tokens
// it already loaded even when no single token is in the env.
const READ_AGENT = Object.keys(secretEnv).map((k) => k.replace('GIT_PAT_', '').toLowerCase())[0];

// Runs launched from HERE, so we can kill the process group we started. A run
// started from a separate terminal is visible (via current.json) but not
// killable here, which the UI states rather than pretending otherwise.
const runs = new Map();

// Harnesses: the coding CLIs and their Gitea identities. The internal id is kept for
// the internal id (GIT_PAT_<ID>); `gemini` is DISPLAYED as "antigravity"
// (agy) without re-provisioning. Models are discovered per harness (claude has no list
// command, so it is seeded with Opus 4.8 as the default).
const HARNESS = {
	claude: { bin: 'claude', label: 'claude' },
	gemini: { bin: process.env.AGY_BIN || join(homedir(), '.local/bin/agy'), label: 'antigravity' },
	qwen: { bin: 'qwen', label: 'qwen' },
};
const CLAUDE_MODELS = ['claude-opus-4-8', 'opus', 'sonnet', 'haiku', 'fable'];
const PATH_DIRS = (process.env.PATH || '').split(':');
const onPath = (bin) => (bin.includes('/') ? existsSync(bin) : PATH_DIRS.some((d) => { try { return existsSync(join(d, bin)); } catch { return false; } }));
// { harness: { label, available, models } }, filled by refreshDiscovery (async: qwen's
// model list is an Ollama HTTP call, agy's is `agy models`, claude's is seeded).
let harnessMeta = Object.fromEntries(Object.entries(HARNESS).map(([id, h]) => [id, { label: h.label, available: onPath(h.bin), models: [] }]));
// Per-harness quota/throttle status, read from what the agent CLIs actually print in their logs
// (state/logs/<ticket>-<harness>-*.log). agy/gemini prints "Individual quota reached ... Resets in
// Xh Ym Zs" - a hard daily quota WITH a reset time; claude prints 429/RateLimit/529 (transient
// throttle, no reset); qwen (local) prints neither. None expose a remaining-quota number, so this
// is a STATE, not a percentage. Cached ~20s; it stats only logs touched in the last 6h, not every
// request, and reads a tail of each.
const parseDur = (s) => { let ms = 0; const h = s.match(/(\d+)\s*h/), m = s.match(/(\d+)\s*m/), sec = s.match(/(\d+)\s*s/); if (h) ms += +h[1] * 3600000; if (m) ms += +m[1] * 60000; if (sec) ms += +sec[1] * 1000; return ms; };
let quotaCache = { at: 0, data: {} };
function harnessQuota() {
	if (Date.now() - quotaCache.at < 20000) return quotaCache.data;
	const out = Object.fromEntries(Object.keys(HARNESS).map((h) => [h, { state: 'ok', lastHit: null, resetAt: null, detail: '' }]));
	try {
		const now = Date.now(), horizon = now - 6 * 3600000, dir = join(STATE_DIR, 'logs');
		for (const f of readdirSync(dir)) {
			const h = (f.match(/[-/](claude|gemini|qwen)\b/) || [])[1];
			if (!h || !f.endsWith('.log')) continue;
			let st; try { st = statSync(join(dir, f)); } catch { continue; }
			if (st.mtimeMs < horizon) continue;
			let tail; try { tail = readFileSync(join(dir, f), 'utf8').slice(-4000); } catch { continue; }
			const cur = out[h];
			const q = tail.match(/Individual quota reached[^\n]*?Resets in\s+([\dhms\s]+)/i);
			if (q) {
				const resetAt = st.mtimeMs + parseDur(q[1]);
				if (resetAt > now && (!cur.resetAt || resetAt > cur.resetAt)) { cur.state = 'exhausted'; cur.resetAt = resetAt; cur.lastHit = st.mtimeMs; cur.detail = 'individual quota reached'; }
				else if (st.mtimeMs > (cur.lastHit || 0)) cur.lastHit = st.mtimeMs;
			} else if (/\b429\b|RateLimit|rate.?limit|\b529\b|overloaded|resource_exhausted/i.test(tail)) {
				if (st.mtimeMs > (cur.lastHit || 0)) cur.lastHit = st.mtimeMs;
				if (cur.state !== 'exhausted') { cur.state = 'throttled'; cur.detail = 'rate-limited / overloaded'; }
			}
		}
	} catch {}
	quotaCache = { at: Date.now(), data: out };
	return out;
}
async function discoverModels(id) {
	if (id === 'claude') return CLAUDE_MODELS;
	if (id === 'gemini') {
		try {
			const out = execFileSync(HARNESS.gemini.bin, ['models'], { encoding: 'utf8', timeout: 30000 });
			const models = out.split('\n').map((l) => l.split('\t')[0].trim()).filter((m) => m && !/^Fetching/i.test(m));
			return models.length ? models : ['gemini-3.7-flash-high'];
		} catch { return ['gemini-3.7-flash-high']; }
	}
	if (id === 'qwen') {
		try {
			const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
			const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(6000) });
			const j = await r.json();
			const models = (j.data || []).map((m) => m.id).filter(Boolean);
			return models.length ? models : ['qwen3.5:cloud'];
		} catch { return ['qwen3.5:cloud']; }
	}
	return [];
}
async function refreshDiscovery() {
	for (const [id, h] of Object.entries(HARNESS)) {
		const available = onPath(h.bin);
		harnessMeta[id] = { label: h.label, available, models: available ? await discoverModels(id) : [] };
	}
}
refreshDiscovery().catch(() => {});

// Swarm config: a matrix of (harness, model) RUNNERS, each with a concurrency cap and
// an enabled flag. Total parallelism is the sum of enabled caps. Persisted so both
// clients agree and it survives a restart.
const SWARM_FILE = join(STATE_DIR, 'swarm.json');
let swarm = { runners: [{ harness: 'claude', model: 'claude-opus-4-8', cap: 1, enabled: true }] };
try {
	if (existsSync(SWARM_FILE)) {
		const s = JSON.parse(readFileSync(SWARM_FILE, 'utf8'));
		if (Array.isArray(s.runners) && s.runners.length) {
			swarm.runners = s.runners.filter((r) => HARNESS[r.harness]).map((r) => ({ harness: r.harness, model: r.model || '', cap: Math.min(16, Math.max(0, Math.floor(Number(r.cap)) || 0)), enabled: r.enabled !== false, ...(r.name ? { name: String(r.name) } : {}) }));
		} else if (Array.isArray(s.agents) && s.agents.length) {
			// Migrate the old {agents, max} shape into one default-model runner per agent.
			const cap = Math.max(1, Math.floor((Number(s.max) || 3) / s.agents.length));
			swarm.runners = s.agents.filter((a) => HARNESS[a]).map((a) => ({ harness: a, model: '', cap, enabled: true }));
		}
	}
} catch {}
const saveSwarm = () => { try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(SWARM_FILE, JSON.stringify(swarm)); } catch {} };
const enabledRunners = () => swarm.runners.filter((r) => r.enabled && r.cap > 0);
const totalCap = () => enabledRunners().reduce((s, r) => s + r.cap, 0) || 1;

// Autobatch must never be the thing that destroys in-progress edits. Agents work in
// isolated worktrees (and the coordinator now refuses a destructive git op outside one),
// but as defense in depth a batch will not start while the MAIN checkout has uncommitted
// TRACKED changes (what `reset --hard` destroys). Untracked/ignored files do not count - the
// coordinator's worktree guard is what keeps a run from ever touching the main checkout.
const mainTreeDirty = () => {
	try { return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''; } catch { return false; }
};

// Coordinators are spawned detached; their stdout/stderr used to go to /dev/null, so one that died
// mid-run (a segfault, an OOM kill, an uncaught throw during merge) left no trace and its ticket sat
// stuck forever. Route both streams to a per-run log instead. Append with a header so a retry that
// reuses its run's log is still separable. Returns an fd the caller passes as the child's stdio and
// then closes its own copy of (the child keeps the inherited fd).
const coordLog = (tag, what) => {
	mkdirSync(join(STATE_DIR, 'logs'), { recursive: true });
	const fd = openSync(join(STATE_DIR, 'logs', `coordinator-${tag}.log`), 'a');
	try { writeSync(fd, `\n===== ${what} @ ${new Date().toISOString()} =====\n`); } catch {}
	return fd;
};

// Launch a coordinator run over the given tickets and remember the child so it can be
// killed from here. `agents` restricts the roster via SWARM_AGENTS (the coordinator
// reads it at startup); defaults to the whole configured set.
const launchRun = (tickets, flags, runners = enabledRunners()) => {
	const runId = String(Date.now());
	mkdirSync(STATE_DIR, { recursive: true });
	const tf = join(STATE_DIR, `tickets-${runId}.json`);
	writeFileSync(tf, JSON.stringify(tickets, null, 2));
	const env = { ...process.env, COORD_RUN_ID: runId };
	const rs = (runners || []).filter((r) => r.enabled !== false && r.cap > 0);
	if (rs.length) env.SWARM_RUNNERS_JSON = JSON.stringify(rs.map((r) => ({ harness: r.harness, model: r.model || '', cap: r.cap })));
	const log = coordLog(runId, `run ${runId}`);
	const child = spawn('node', [join(BIN_DIR, 'coordinator.mjs'), 'run', tf, ...flags], {
		cwd: ROOT,
		detached: true,
		stdio: ['ignore', log, log],
		env,
	});
	closeSync(log);
	runs.set(runId, child);
	child.on('exit', () => runs.delete(runId));
	return runId;
};

// Opt-in keep-fed daemon: when on, launch a fresh disjoint batch whenever the
// pipeline is free, until the backlog is empty or it is turned off. Off by
// default, because in go mode it auto-spends on agents and auto-merges to main.
const autobatch = { on: false, mode: 'go', msg: '' };
// Re-entrancy guard: suggestBatch (an LLM planner call) routinely outlasts the tick
// interval, and without this a later tick would start while an earlier one is still
// planning - each then launches its own batch, so autobatch fans out several concurrent
// runs instead of one. Only one tick may be in flight at a time.
let autobatchRunning = false;
async function autobatchTick() {
	if (!autobatch.on || runs.size || autobatchRunning) return; // wait while a run we launched is alive
	autobatchRunning = true;
	try {
		if (mainTreeDirty()) { autobatch.on = false; autobatch.msg = 'main tree dirty; autobatch off (commit or stash first)'; return; }
		const run = currentRun();
		// A run whose coordinator was killed or crashed never marks itself done and never emits
		// another event, so without a freshness check its non-terminal tickets would block
		// autobatch forever. Treat a run with no activity in the last 10 minutes as not busy.
		const lastActivity = run ? Math.max(run.startedAt || 0, ...(run.tickets || []).map((t) => t.updated || 0)) : 0;
		const fresh = run && Date.now() - lastActivity < 10 * 60 * 1000;
		const busy = run && !run.done && fresh && (run.tickets || []).some((t) => !['merged', 'failed', 'skipped', 'changes_requested', 'approved', 'flaky', 'already_done', 'disputed'].includes(t.stage));
		if (busy) return;
		const tickets = await suggestBatch(totalCap());
		if (runs.size) return; // a run appeared while we were planning; do not double-launch
		if (!tickets.length) { autobatch.on = false; autobatch.msg = 'backlog empty; autobatch off'; return; }
		const modeFlags = autobatch.mode === 'sim' ? ['--sim'] : autobatch.mode === 'go' ? ['--go'] : [];
		launchRun(tickets, modeFlags);
		autobatch.msg = `launched ${tickets.length} at ${new Date().toLocaleTimeString()}`;
	} catch (e) {
		autobatch.msg = 'error: ' + String(e.message).slice(0, 80);
	} finally {
		autobatchRunning = false;
	}
}
setInterval(() => autobatchTick().catch(() => {}), 20000);

// What the pipeline board shows: the run that is LIVE right now, never the last dead one.
// A run this dashboard launched is live while its coordinator child is alive (the runs map);
// a run from before a restart counts as live only if it is not done and still seeing ticket
// activity. Otherwise the board is idle - the RUNS panel keeps the finished/failed history.
const boardRun = () => {
	const r = currentRun();
	if (!r) return null;
	if (runs.has(r.runId)) return r;
	if (r.done) return null;
	const last = Math.max(r.startedAt || 0, ...(r.tickets || []).map((t) => t.updated || 0));
	return Date.now() - last < 10 * 60 * 1000 ? r : null;
};

// A crashed coordinator leaves a stale agent_pid (and running set) on its ticket. Null them when
// the process is gone so the board never shows a dead ticket as live (the shimmer keys off this).
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// runIds with a live full-run coordinator, and run:ticket pairs with a live retry coordinator, read
// from the OS. Coordinator-only stages (merging, gating) can run minutes with no DB write, and the
// in-memory runs map is lost on a dashboard restart, so the board reads liveness from the process
// table instead. Cached briefly.
let coordCache = { at: 0, runs: new Set(), retries: new Set() };
const liveCoords = () => {
	if (Date.now() - coordCache.at < 4000) return coordCache;
	const runs = new Set(), retries = new Set();
	try {
		for (const line of execFileSync('pgrep', ['-af', 'coordinator.mjs'], { encoding: 'utf8' }).split('\n')) {
			let m = line.match(/tickets-(\d+)\.json/); if (m) { runs.add(m[1]); continue; }
			m = line.match(/coordinator\.mjs retry (\d+) (\S+)/); if (m) retries.add(`${m[1]}:${m[2]}`);
		}
	} catch {}
	coordCache = { at: Date.now(), runs, retries };
	return coordCache;
};
const coordAlive = (runId, id) => { const c = liveCoords(); return c.runs.has(String(runId)) || c.retries.has(`${runId}:${id}`); };
// Null a dead agent's pid, and stamp coordAlive on any ticket whose coordinator process is up, so the
// board can sweep an in-flight coordinator stage yet stop sweeping a stuck one whose coordinator died.
const withLiveness = (tickets, runId) => (Array.isArray(tickets) ? tickets.map((t) => {
	const t2 = t.agentPid && !pidAlive(t.agentPid) ? { ...t, agentPid: undefined, running: undefined } : t;
	return coordAlive(t.runId || runId, t.id) ? { ...t2, coordAlive: true } : t2;
}) : tickets);

const send = (res, code, obj) => {
	res.writeHead(code, { 'content-type': 'application/json' });
	res.end(JSON.stringify(obj));
};
const readBody = (req) =>
	new Promise((resolve, reject) => {
		let d = '';
		req.on('data', (c) => (d += c));
		req.on('end', () => {
			try {
				resolve(d ? JSON.parse(d) : {});
			} catch (e) {
				reject(e);
			}
		});
	});
const forge = (args, env) =>
	// Bounded: forge.mjs already times out its own fetch, but cap the synchronous child too so a
	// wedged forge call can never freeze the dashboard's event loop indefinitely.
	JSON.parse(execFileSync('node', [join(BIN_DIR, 'forge.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...secretEnv, ...env } }));

// Async capture so a slow planner call never blocks the poll loop.
const capture = (cmd, args) =>
	new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd: ROOT });
		let out = '', err = '';
		p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (err += d));
		p.on('error', reject);
		p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((err || out).slice(0, 300) || `exit ${code}`))));
	});

// The planner model: an LLM reads a list of open tickets and picks a batch with non-overlapping file
// scopes so a run's agents do not collide (see suggestFromListPrompt).
const PLANNER_MODEL = process.env.SWARM_PLANNER_MODEL || 'claude-fable-5';
const extractJsonArray = (text) => {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const arr = (fenced ? fenced[1] : text).match(/\[[\s\S]*\]/);
	if (!arr) throw new Error('planner returned no JSON array');
	return JSON.parse(arr[0]);
};
// The open backlog, cached briefly so hovering the list is cheap. Filled from the tracker adapter
// (listBacklogDirect), not an LLM call.
let backlogCache = { at: 0, tickets: [], source: '' };
// Ticket ids whose work already landed on origin/main. Merging a PR does NOT transition the tracker
// ticket out of its backlog status, so without this the swarm re-picks and re-works tickets it
// already merged. Merged commits keep their `<ID>: ...` subject (rebase-merge), so scan recent
// origin/main subjects for a leading ticket id (KEY-123 or a bare issue number).
const mergedTicketIds = () => {
	try {
		execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: ROOT });
		const log = execFileSync('git', ['log', 'origin/main', '--format=%s', '-n', '3000'], { cwd: ROOT, encoding: 'utf8' });
		const ids = new Set();
		for (const m of log.matchAll(/^([A-Z][A-Z0-9]*-\d+|\d+):/gm)) ids.add(m[1]);
		return ids;
	} catch { return new Set(); }
};
// Tracker selection (which adapter + which projects + which labels to skip). Seeded from env,
// persisted so a TUI toggle survives a restart. Each adapter reads its own env credentials.
const TRACKER_CFG_FILE = join(STATE_DIR, 'tracker-config.json');
const csv = (v, d) => String(v ?? d).split(',').map((s) => s.trim()).filter(Boolean);
const defaultTrackerCfg = () => ({
	tracker: (process.env.OPENHARK_TRACKER || 'github').toLowerCase(),
	projects: csv(process.env.SWARM_PROJECTS, '').map((s) => s.toUpperCase()), // empty = every project the adapter exposes
	excludeLabels: csv(process.env.SWARM_EXCLUDE_LABELS, ''),
});
let trackerCfg = defaultTrackerCfg();
try { if (existsSync(TRACKER_CFG_FILE)) trackerCfg = { ...trackerCfg, ...JSON.parse(readFileSync(TRACKER_CFG_FILE, 'utf8')) }; } catch {}
const saveTrackerCfg = () => { try { writeFileSync(TRACKER_CFG_FILE, JSON.stringify(trackerCfg)); } catch {} };
let tracker = makeTracker(trackerCfg.tracker);
const remakeTracker = () => { try { tracker = makeTracker(trackerCfg.tracker); } catch (e) { console.error('tracker adapter:', e.message); tracker = makeTracker('github'); trackerCfg.tracker = 'github'; } };

async function listBacklogDirect() {
	const rows = await tracker.listBacklog({ projectKeys: trackerCfg.projects, excludeLabels: trackerCfg.excludeLabels });
	const merged = mergedTicketIds();
	const done = noReworkTicketIds(); // recorded no-ops + disputed tickets the picker cannot infer from a commit subject
	return rows.filter((t) => !merged.has(t.key) && !done.has(t.key)).map((t) => ({ id: t.key, title: t.title, status: t.status }));
}
// Root fix for the re-work loop: merging a PR does not transition the tracker ticket, so a
// merged ticket lingers in 'backlog' (and the swarm re-picks it). Move any backlog ticket
// whose work is already on origin/main to the completed status. Needs a tracker token; a
// no-op without one. `reconciledDone` avoids re-issuing writes for tickets already handled.
const reconciledDone = new Set();
let reconcileOff = false; // some tracker tokens are read-only; back off on a 403
async function reconcileMergedTickets() {
	if (reconcileOff || !tracker.capabilities.has('transition')) return;
	const merged = mergedTicketIds();
	const pending = [...merged].filter((k) => !reconciledDone.has(k));
	if (!pending.length) return;
	let backlog;
	try { backlog = await tracker.listBacklog({ projectKeys: trackerCfg.projects, excludeLabels: [] }); }
	catch { return; }
	const backlogKeys = new Set(backlog.map((r) => r.key));
	pending.filter((k) => !backlogKeys.has(k)).forEach((k) => reconciledDone.add(k)); // not stuck in backlog
	const stuck = backlog.filter((r) => merged.has(r.key));
	if (!stuck.length) return;
	for (const r of stuck) {
		try { await tracker.transition(r.rawId); reconciledDone.add(r.key); }
		catch (e) { if (/\b403\b|write scope/i.test(String(e.message))) { reconcileOff = true; console.error('tracker token is read-only (write scope needed); merged-ticket transition disabled'); return; } }
	}
}
setInterval(() => reconcileMergedTickets().catch(() => {}), 60000);
setTimeout(() => reconcileMergedTickets().catch(() => {}), 8000); // once shortly after start

// The open-PR list is on the hot path (/api/state, polled continuously by every TUI). Fetching it
// with the SYNCHRONOUS forge() froze the event loop whenever the forge stalled, and with several TUIs
// polling the loop never drained the accept queue. Fetch it in the background with a spawn (never
// blocks the loop) and serve the cache; a stalled forge only makes the list go stale.
let prsCache = { at: 0, data: [] };
function forgeAsync(args, env) {
	return new Promise((resolve, reject) => {
		const p = spawn('node', [join(BIN_DIR, 'forge.mjs'), ...args], { cwd: ROOT, env: { ...process.env, ...secretEnv, ...env } });
		let out = '', err = '';
		const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('forge timeout')); }, 20000);
		p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (err += d));
		p.on('error', (e) => { clearTimeout(t); reject(e); });
		p.on('close', (code) => { clearTimeout(t); if (code !== 0) return reject(new Error(err.slice(0, 300) || `exit ${code}`)); try { resolve(JSON.parse(out)); } catch (e2) { reject(e2); } });
	});
}
async function refreshPrs() {
	try { prsCache = { at: Date.now(), data: await forgeAsync(['list', '--state', 'open'], READ_AGENT ? { AGENT: READ_AGENT } : {}) }; }
	catch (e) { prsCache = { at: prsCache.at, data: prsCache.data, error: String(e.message).slice(0, 200) }; }
}
setInterval(() => refreshPrs().catch(() => {}), 20000);
setTimeout(() => refreshPrs().catch(() => {}), 2000);
// Fable reasons over a list we hand it (scope inference + disjoint pick). When the
// server can list directly, this avoids the LLM driving the flaky MCP itself
// (the "select: timeout" the daemon hit); the MCP path is the fallback.
const suggestFromListPrompt = (max, list) =>
	`Here are open tickets as JSON: ${JSON.stringify(list.map((t) => ({ id: t.id, title: t.title })))}. For each, infer the primary file or directory it would modify from its title. Select up to ${max} tickets whose inferred scopes do NOT overlap (disjoint files/dirs), preferring small, well-scoped ones. Output ONLY a JSON array, no prose and no tool calls: each element {"id","title","scope","prompt"} where scope is the inferred path and prompt is a one-sentence implementation instruction.`;
async function suggestBatch(max) {
	const backlog = await listBacklogDirect();
	if (!backlog.length) return [];
	return extractJsonArray(await capture('claude', ['-p', suggestFromListPrompt(max, backlog), '--model', PLANNER_MODEL]));
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	try {
		if (url.pathname.startsWith('/api/')) {
			const t = req.headers['x-swarm-token'] || url.searchParams.get('token');
			if (!(TOKEN && t === TOKEN)) return send(res, 401, { error: 'unauthorized' });
		}

		if (req.method === 'GET' && url.pathname === '/auth/me') {
			const t = req.headers['x-swarm-token'] || url.searchParams.get('token');
			return send(res, 200, { authenticated: !!(TOKEN && t === TOKEN), tokenFallback: !!TOKEN });
		}

		if (req.method === 'GET' && url.pathname === '/') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			return res.end(readFileSync(HTML));
		}

		if (req.method === 'GET' && url.pathname === '/api/ticket') {
			// The full spec (prompt, scope) for a ticket. `run` selects a historical run; the
			// current run is the default.
			const id = String(url.searchParams.get('id') || '');
			const runId = url.searchParams.get('run') || (currentRun() || {}).runId;
			const tf = runId && join(STATE_DIR, `tickets-${runId}.json`);
			const spec = tf && existsSync(tf) ? JSON.parse(readFileSync(tf, 'utf8')).find((t) => t.id === id) : null;
			return send(res, 200, { spec: spec || null });
		}

		if (req.method === 'GET' && url.pathname === '/api/log') {
			// The most recent captured agent log for a ticket (author, fix, or review).
			const id = String(url.searchParams.get('ticket') || '');
			const dir = join(STATE_DIR, 'logs');
			let files = [];
			try {
				files = readdirSync(dir).filter((f) => id && f.startsWith(`${id}-`) && f.endsWith('.log'));
			} catch {}
			if (!files.length) return send(res, 200, { log: '' });
			files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
			return send(res, 200, { file: files[0], log: readFileSync(join(dir, files[0]), 'utf8').slice(-20000) });
		}

		if (req.method === 'GET' && url.pathname === '/api/events') {
			// The event timeline for a ticket (stage transitions, panel verdicts, escalations).
			// `run` selects a historical run; the current run is the default.
			const id = String(url.searchParams.get('ticket') || '');
			const runId = url.searchParams.get('run') || (currentRun() || {}).runId;
			return send(res, 200, { events: runId ? ticketEvents(runId, id) : [] });
		}

		if (req.method === 'GET' && url.pathname === '/api/runs') {
			// Recent runs, summarized from the DB. listRuns() gives the DB-derivable
			// `running` (not done + recent + a non-terminal ticket); OR in this server's
			// own liveness (a coordinator process it launched and still holds), which the
			// DB cannot know. A killed or externally-started run thus reads correctly.
			const runList = listRuns(12).map((r) => ({ ...r, running: runs.has(r.runId) || r.running }));
			return send(res, 200, { runs: runList });
		}

		if (req.method === 'GET' && url.pathname === '/api/state') {
			const run = boardRun();
			if (run && run.tickets) run.tickets = withLiveness(run.tickets, run.runId);
			const prs = prsCache.data; // served from the background cache; never a blocking forge call on this path
			const trackerStatus = { connected: tracker.capabilities.has('listBacklog'), exp: null };
			return send(res, 200, { run, history: withLiveness(recentTickets(400)), prs, base: FORGE_WEB, repo: REPO_SLUG, killable: [...runs.keys()], tracker: trackerStatus, autobatch: { on: autobatch.on, mode: autobatch.mode, msg: autobatch.msg }, swarm: { runners: swarm.runners, total: totalCap() }, harnessMeta, harnessQuota: harnessQuota() });
		}

		if (req.method === 'GET' && url.pathname === '/api/backlog') {
			if (!url.searchParams.get('refresh') && backlogCache.tickets.length && Date.now() - backlogCache.at < 5 * 60_000)
				return send(res, 200, { tickets: backlogCache.tickets, cachedAt: backlogCache.at, source: backlogCache.source });
			try {
				const tickets = await listBacklogDirect(); // the server's own token, no LLM
				backlogCache = { at: Date.now(), tickets, source: 'tracker' };
				return send(res, 200, { tickets, cachedAt: backlogCache.at, source: 'tracker' });
			} catch {
				// The direct tracker token (a ~1h identity login) has lapsed. Do NOT fall
				// back to the slow Fable/MCP path - it hangs. Say so and point at re-login.
				return send(res, 200, { tickets: [], error: 'tracker not connected - press c to connect (durable, ~90 days)', source: 'none' });
			}
		}

		// Full detail for one backlog ticket (priority, assignee, description, labels) via
		// the tracker's getIssue. Cached briefly so hovering the list is cheap.
		if (req.method === 'GET' && url.pathname === '/api/backlog-ticket') {
			const id = url.searchParams.get('id');
			if (!id) return send(res, 400, { error: 'id required' });
			try {
				return send(res, 200, { issue: await tracker.getTicket(id) });
			} catch (e) {
				return send(res, 200, { error: String(e.message).slice(0, 200) });
			}
		}

		// Tracker + project selection for hark. GET returns the current choice plus the projects
		// available on the active adapter; POST changes it and rebuilds the adapter. Gated with
		// the rest of /api/*.
		if (url.pathname === '/api/tracker') {
			if (req.method === 'GET') {
				let available = [];
				try { available = (await tracker.listProjects()).map((p) => ({ key: p.key, name: p.name })); } catch {}
				return send(res, 200, { tracker: trackerCfg.tracker, trackers: TRACKERS, projects: trackerCfg.projects, excludeLabels: trackerCfg.excludeLabels, available, canWrite: tracker.capabilities.has('transition') });
			}
			if (req.method === 'POST') {
				const b = await readBody(req);
				if (b.tracker && TRACKERS.includes(String(b.tracker).toLowerCase())) trackerCfg.tracker = String(b.tracker).toLowerCase();
				if (Array.isArray(b.projects)) trackerCfg.projects = b.projects.map((s) => String(s).toUpperCase());
				if (Array.isArray(b.excludeLabels)) trackerCfg.excludeLabels = b.excludeLabels.map(String);
				saveTrackerCfg();
				remakeTracker();
				return send(res, 200, { ok: true, tracker: trackerCfg.tracker, projects: trackerCfg.projects, excludeLabels: trackerCfg.excludeLabels });
			}
		}

		if (req.method === 'POST' && url.pathname === '/api/autobatch') {
			const b = await readBody(req);
			if (b.on === true && mainTreeDirty()) {
				autobatch.msg = 'refused: main tree has uncommitted changes';
				return send(res, 409, { error: 'main checkout has uncommitted changes; commit, stash, or discard them before enabling autobatch', on: false, mode: autobatch.mode });
			}
			if (typeof b.on === 'boolean') autobatch.on = b.on;
			if (b.mode) autobatch.mode = String(b.mode);
			if (autobatch.on) autobatchTick().catch(() => {});
			return send(res, 200, { on: autobatch.on, mode: autobatch.mode, total: totalCap() });
		}

		// Swarm config: the full runner matrix. Both clients read it from /api/state; this
		// validates against known harnesses, persists, and returns the stored set.
		if (req.method === 'POST' && url.pathname === '/api/swarm') {
			const b = await readBody(req);
			if (!Array.isArray(b.runners)) return send(res, 400, { error: 'runners array required' });
			const runners = b.runners.filter((r) => r && HARNESS[r.harness]).map((r) => ({ harness: r.harness, model: String(r.model || ''), cap: Math.min(16, Math.max(0, Math.floor(Number(r.cap)) || 0)), enabled: r.enabled !== false, ...(r.name ? { name: String(r.name).slice(0, 40) } : {}) }));
			if (!runners.some((r) => r.enabled && r.cap > 0)) return send(res, 400, { error: 'at least one runner must be enabled with cap >= 1' });
			swarm.runners = runners;
			saveSwarm();
			return send(res, 200, { runners: swarm.runners, total: totalCap() });
		}

		// Re-run harness/model discovery on demand (e.g. after installing a CLI).
		if (req.method === 'POST' && url.pathname === '/api/discover') {
			await refreshDiscovery();
			return send(res, 200, { harnessMeta });
		}

		if (req.method === 'POST' && url.pathname === '/api/suggest') {
			const b = await readBody(req);
			const max = Math.min(16, Math.max(1, Math.floor(Number(b.max)) || totalCap()));
			return send(res, 200, { tickets: await suggestBatch(max), model: PLANNER_MODEL });
		}

		if (req.method === 'POST' && url.pathname === '/api/run') {
			const b = await readBody(req);
			if (!Array.isArray(b.tickets) || !b.tickets.length) return send(res, 400, { error: 'tickets array required' });
			const flags = [];
			if (b.sim) flags.push('--sim');
			else if (b.go) flags.push('--go');
			if (b.noMerge) flags.push('--no-merge');
			return send(res, 200, { runId: launchRun(b.tickets, flags), flags });
		}

		if (req.method === 'POST' && url.pathname === '/api/retry') {
			const b = await readBody(req);
			// A ticket in ANY run can be re-launched from the jobs list, not just the current run,
			// so accept its runId; default to the current run for the plain case.
			const runId = String(b.run || (currentRun() || {}).runId || '');
			if (!runId) return send(res, 400, { error: 'no run to retry from' });
			const runRow = getRun(runId);
			const tf = join(STATE_DIR, `tickets-${runId}.json`);
			if (!existsSync(tf)) return send(res, 400, { error: `the ticket spec for run ${runId} is gone; relaunch from the backlog` });
			if (!JSON.parse(readFileSync(tf, 'utf8')).some((t) => t.id === b.id)) return send(res, 404, { error: `ticket ${b.id} not found in run ${runId}` });
			// Re-run the one ticket INSIDE its run (retry subcommand resumes its PR when it has one,
			// no new run row), so the sibling tickets stay on the board and the run is not re-ended.
			const flags = runRow && runRow.mode === 'LIVE(sim)' ? ['--sim'] : ['--go'];
			const env = { ...process.env };
			const rs = enabledRunners();
			if (rs.length) env.SWARM_RUNNERS_JSON = JSON.stringify(rs.map((r) => ({ harness: r.harness, model: r.model || '', cap: r.cap })));
			const log = coordLog(`${runId}-${b.id}`, `retry ${runId} ${b.id}`);
			const child = spawn('node', [join(BIN_DIR, 'coordinator.mjs'), 'retry', runId, String(b.id), ...flags], { cwd: ROOT, detached: true, stdio: ['ignore', log, log], env });
			closeSync(log);
			const key = `retry:${runId}:${b.id}:${Date.now()}`;
			runs.set(key, child);
			child.on('exit', () => runs.delete(key));
			return send(res, 200, { retried: b.id, runId });
		}

		if (req.method === 'POST' && url.pathname === '/api/kill') {
			const b = await readBody(req);
			if (b.pid) {
				try {
					process.kill(Number(b.pid));
				} catch (e) {
					return send(res, 500, { error: String(e.message) });
				}
				return send(res, 200, { killed: `pid ${b.pid}` });
			}
			const rid = String(b.runId);
			const child = runs.get(rid);
			if (child) {
				try {
					process.kill(-child.pid); // whole process group (coordinator + its agents)
				} catch {
					try {
						child.kill('SIGTERM');
					} catch {}
				}
			}
			// Finalize the run so its non-terminal tickets stop counting as a live run - an
			// unfinished run blocks autobatch and shows the board busy forever. This also lets
			// a run orphaned by a previous dashboard (not in our map) be cleared from here.
			emit(rid, { done: true });
			return send(res, 200, { killed: child ? `run ${rid}` : `run ${rid} (already exited; marked done)` });
		}

		if (req.method === 'POST' && url.pathname === '/api/pr/merge') {
			const b = await readBody(req);
			// forge.mjs needs an identity to resolve a token; the bot tokens are what
			// the dashboard has, so merge as READ_AGENT (a bot may merge its own PR;
			// Gitea only blocks self-approve, not self-merge).
			forge(['merge', '--pr', String(b.pr), '--do', b.do || 'rebase'], READ_AGENT ? { AGENT: READ_AGENT } : {});
			// Reflect the merge on the board - a manual merge otherwise leaves the ticket
			// at "approved" with a live merge button that errors on a second click.
			try {
				const cur = currentRun();
				const t = cur && cur.tickets.find((x) => x.pr === Number(b.pr));
				if (t) emit(cur.runId, { ticket: t.id, stage: 'merged', pr: Number(b.pr), detail: `merged PR #${b.pr}`, agentPid: null });
			} catch {}
			return send(res, 200, { ok: true, merged: `PR #${b.pr}` });
		}

		if (req.method === 'POST' && url.pathname === '/api/pr/review') {
			const b = await readBody(req);
			const agent = b.agent || READ_AGENT;
			return send(res, 200, forge(['review', '--pr', String(b.pr), '--event', b.event, '--body', b.body || ''], agent ? { AGENT: agent } : {}));
		}

		res.writeHead(404);
		res.end('not found');
	} catch (e) {
		send(res, 500, { error: String(e.message || e) });
	}
});
server.listen(PORT, '127.0.0.1', () => console.log(`swarm dashboard: http://127.0.0.1:${PORT}`));
