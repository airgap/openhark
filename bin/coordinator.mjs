#!/usr/bin/env node
// Coordinator for the parallel agent swarm. Assigns disjoint tickets to
// heterogeneous agents, each in its own worktree/branch, gates their work, opens
// PRs on the configured forge, routes each PR to a DIFFERENT agent for review,
// and serializes approved merges onto main.
//
//   node coordinator.mjs run tickets.json            # DRY RUN (plan only)
//   node coordinator.mjs run tickets.json --go       # LIVE
//   node coordinator.mjs resume [runId]              # continue a run that
//        died - re-processes only its non-terminal tickets (latest unfinished if omitted)
//   ... --sim        run the pipeline with scripted edits + approval (no LLM, no cost)
//   ... --no-merge   stop at an approved PR, do not merge (validate up to merge)
//   ... --max=N      concurrency cap (default 3)
//   ... --fix-rounds=N     author retries on a red gate (default 3)
//   ... --revisions=N      author revisions to satisfy the blocking panel before
//                          authorship escalates to the next agent (default 4)
//
// tickets.json: [{ "id":"123","title":"...","scope":"src/foo","prompt":"..." }, ...]
//
// The coordinator owns everything deterministic (worktree, gate, commit, push,
// PR, merge); the AGENTS only produce the work (author edits code; reviewer
// reads the diff and posts its verdict as its own forge user). The local gate is
// the hard pre-merge guarantee, run by the author and again after the rebase. A
// PR is never authored and approved by the same identity (the forge rejects that anyway).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startRun, emit as stateEmit, getRun, latestUnfinishedRunId } from './swarm-state.mjs';
import { STATE_DIR, ensureStateDir, targetRoot, BIN_DIR } from './env.mjs';

// ROOT is the TARGET repo (the one whose worktrees agents work in); BIN_DIR is openhark's own
// scripts, so the coordinator can invoke its siblings (worktree.mjs, forge.mjs, gate.sh) by absolute
// path no matter which repo it is driving.
const ROOT = targetRoot();
const argv = process.argv.slice(2);
const GO = argv.includes('--go');
const SIM = argv.includes('--sim');
const NO_MERGE = argv.includes('--no-merge');
const MAX = Number((argv.find((a) => a.startsWith('--max=')) || '--max=3').split('=')[1]);
// Gates here are strict, so one author pass rarely clears them. On a red gate we
// hand the gate output back to the author to fix and re-gate, up to this many
// rounds before giving up.
const MAX_FIX_ROUNDS = Number((argv.find((a) => a.startsWith('--fix-rounds=')) || '--fix-rounds=3').split('=')[1]);
// A blocked review is not terminal: the same author addresses it and the PR is
// re-panelled, up to this many REVISIONS before authorship escalates to the next
// agent (which re-authors from scratch, seeded with the objection). Escalation is
// expensive (a fresh worktree + full re-author), so give each author real room to
// converge on the panel's objections first. Symmetric to the gate-fix loop above.
const MAX_REVISIONS = Number((argv.find((a) => a.startsWith('--revisions=')) || '--revisions=4').split('=')[1]);
const MODE = SIM ? 'LIVE(sim)' : GO ? 'LIVE' : 'DRY RUN';

// Run state lives in embedded SQLite (swarm-state.mjs), shared with the dashboard. RUN_ID is passed
// in when the dashboard launched us, so it can correlate and kill the run it started; STATE_DIR is
// also the home for per-agent captured logs (logs/<tag>.log).
ensureStateDir();
let RUN_ID = process.env.COORD_RUN_ID || String(Date.now());
const emit = (ev) => stateEmit(RUN_ID, ev);

// Per-agent forge tokens (GIT_PAT_<AGENT>) from a mode-600 env file, so each PR is opened and
// reviewed by a distinct forge identity (needed for real cross-review; GitHub and Gitea reject
// self-approval). Path from OPENHARK_TOKENS_ENV, else ~/.config/openhark/tokens.env.
const SECRETS = process.env.OPENHARK_TOKENS_ENV || join(homedir(), '.config', 'openhark', 'tokens.env');
const secretEnv = {};
if (existsSync(SECRETS)) {
	for (const line of readFileSync(SECRETS, 'utf8').split('\n')) {
		const m = line.match(/^\s*export\s+(GIT_PAT_[A-Z0-9]+)=(.+)$/);
		if (m) secretEnv[m[1]] = m[2];
	}
}

/**
 * The env one task runs with. Two independent keys, which is what lets one bot
 * drive many branches at once:
 *  - IDENTITY (bot): AGENT selects the forge token (GIT_PAT_<AGENT>) and CLI.
 *  - ISOLATION (workspace = branch/ticket): WORKSPACE + PORT_BASE keep two
 *    branches by the SAME bot from colliding (gate state, dev-server ports).
 */
const taskEnv = (bot, workspace, idx, model = '') => ({
	...process.env,
	...secretEnv,
	AGENT: bot,
	WORKSPACE: workspace,
	PORT_BASE: String(5300 + idx * 20),
	// Read by spawnAgent and handed to the ROSTER factory as the runner's model.
	_SWARM_MODEL: model || '',
});

// Roster: how to run each CLI headless + autonomously. Qwen uses the local
// Ollama proxy (signed in to Ollama Cloud), no external key.
const ROSTER = {
	// bypassPermissions (not acceptEdits) so it can run tests/git itself in its
	// isolated worktree, matching qwen (--yolo) and agy (--dangerously-skip). On
	// acceptEdits it could edit but not run a command, so it authored blind.
	// Each factory takes the runner's model (empty = the harness/CLI default). The model
	// travels in taskEnv as _SWARM_MODEL and spawnAgent hands it here, so a harness can
	// run several models at once (one worker per runner) without threading a param.
	claude: (wt, prompt, model) => ['claude', ['-p', prompt, '--permission-mode', 'bypassPermissions', ...(model ? ['--model', model] : [])], { cwd: wt }],
	// Antigravity CLI (agy) driving a Gemini (or proxied) model. Google retired the
	// standalone gemini-cli login for individuals (2026); agy is the successor and uses
	// the AI Pro entitlement. Keyed `gemini`, using the GEMINI forge identity and
	// GIT_PAT_GEMINI token; the dashboard displays it as "antigravity". Token is
	// file-based, so no keyring/DBUS is needed at spawn.
	gemini: (wt, prompt, model) => [
		process.env.AGY_BIN || join(homedir(), '.local/bin/agy'),
		['-p', prompt, '--dangerously-skip-permissions', '--model', model || process.env.AGY_MODEL || 'gemini-3.7-flash-high', '--print-timeout', process.env.AGY_TIMEOUT || '15m', '--output-format', 'text'],
		{ cwd: wt },
	],
	qwen: (wt, prompt, model) => [
		'qwen',
		['-p', prompt, '--approval-mode', 'yolo'],
		{
			cwd: wt,
			env: {
				OPENAI_API_KEY: process.env.OLLAMA_API_KEY || 'ollama',
				OPENAI_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
				OPENAI_MODEL: model || process.env.QWEN_MODEL || 'qwen3.5:cloud',
			},
		},
	],
};
// Runners: one (harness, model, cap) cell of the dashboard matrix. SWARM_RUNNERS_JSON
// carries the enabled cells; cap is how many tickets of that harness+model run at once,
// so the pool width is the sum of caps. Falls back to the old SWARM_AGENTS/--max split
// for a direct CLI run with no matrix.
function parseRunners() {
	if (process.env.SWARM_RUNNERS_JSON) {
		try {
			const rs = JSON.parse(process.env.SWARM_RUNNERS_JSON).filter((r) => ROSTER[r.harness] && Number(r.cap) > 0);
			if (rs.length) return rs.map((r) => ({ harness: r.harness, model: r.model || '', cap: Math.min(16, Math.max(1, Math.floor(Number(r.cap)))) }));
		} catch {}
	}
	const ags = (process.env.SWARM_AGENTS ? process.env.SWARM_AGENTS.split(',').map((s) => s.trim()) : Object.keys(ROSTER)).filter((a) => ROSTER[a]);
	const per = Math.max(1, Math.floor(MAX / Math.max(1, ags.length)));
	return ags.map((h) => ({ harness: h, model: '', cap: per }));
}
const RUNNERS = parseRunners();
// Active harnesses (unique), and each harness's representative model (its first runner),
// used for reviews and as the model when authorship escalates to another harness.
const AGENTS = [...new Set(RUNNERS.map((r) => r.harness))];
const HARNESS_MODEL = {};
for (const r of RUNNERS) if (!(r.harness in HARNESS_MODEL)) HARNESS_MODEL[r.harness] = r.model;
const TOTAL_CAP = RUNNERS.reduce((s, r) => s + r.cap, 0);
// A harness that hit a quota wall (rate-limit / overload) or hung to a spawn timeout is parked for a
// cooldown, so the review panel stops handing tickets to a harness that will only 429 or hang again.
// Cleared by time, not by success.
const THROTTLE_COOLDOWN = Number(process.env.SWARM_THROTTLE_COOLDOWN_MS || 20 * 60 * 1000);
const AGENT_TIMEOUT_MS = Number(process.env.SWARM_AGENT_TIMEOUT_MS || 15 * 60 * 1000);
const throttledUntil = new Map();
const isThrottled = (h) => (throttledUntil.get(h) || 0) > Date.now();
const markThrottled = (h) => { throttledUntil.set(h, Date.now() + THROTTLE_COOLDOWN); console.log(`[quota] ${h} parked ${Math.round(THROTTLE_COOLDOWN / 60000)}m (rate-limited or hung)`); };
// The order harnesses are tried for a ticket (fallback path only); also the escalation
// order when one cannot land the change.
const escalationOrder = (i) => AGENTS.map((_, k) => AGENTS[(i + k) % AGENTS.length]);
const authorFor = (i) => escalationOrder(i)[0];
// The blocking review panel: every agent that is neither the author nor the PR's
// opener (the forge rejects self-approval by the opener). These are the skeptics.
// An agent key (claude/gemini/qwen) maps to a forge login. Default: the login IS the key. Set
// OPENHARK_BOT_PREFIX when reviewers use dedicated accounts that share a prefix (e.g. "myorg-bot-").
const BOT_PREFIX = process.env.OPENHARK_BOT_PREFIX || '';
const botLogin = (a) => `${BOT_PREFIX}${a}`;
const botKey = (login) => (BOT_PREFIX && String(login).startsWith(BOT_PREFIX) ? String(login).slice(BOT_PREFIX.length) : login);
const panelOf = (author, prAuthorBot) => AGENTS.filter((a) => a !== author && botLogin(a) !== prAuthorBot && !isThrottled(a));

// The one legitimate way to make no change: the deliverable already exists on main. An author or
// reviser says so with a lone ALREADY-DONE: line, letting the coordinator record a deliberate no-op
// (terminal, never re-picked) instead of reading an empty diff as a failure and retrying forever.
const ALREADY_DONE_CLAUSE = [
	`If, and ONLY if, this ticket is already fully satisfied by code on main and needs no change,`,
	`make no edits and output exactly one line: ALREADY-DONE: <why, cite the file or commit on main`,
	`that satisfies it>. Do not use this to avoid hard work: a false claim ships nothing and leaves`,
	`the ticket unmet.`,
].join('\n');

// A coder may reject a blocking objection instead of complying, but not by arguing in prose (a
// reviewer LLM tends to capitulate to a confident rebuttal, which turns review into a rubber stamp).
// It emits a lone DISPUTE: line and a neutral judge rules. Offered only when a judge exists (a real
// panel) and never twice on one objection, so an upheld dispute forces a genuine fix.
const DISPUTE_CLAUSE = [
	`If the objection is simply WRONG - a misread, out of scope, or not a real defect - do not`,
	`comply and do not argue in prose. Make no edits and output exactly one line: DISPUTE: <why the`,
	`objection is wrong, concretely>. A neutral judge then rules: if you are right the PR proceeds`,
	`unchanged; if not, you must fix it. Dispute only when you are confident.`,
].join('\n');

// A ticket's PREMISE can itself be wrong: it asks for the wrong thing, contradicts how the code
// already works, or poses a design choice a human must settle before any implementation is correct.
// No revision can satisfy that, and it is not an objection to a specific fix, so the coder says so
// with a lone DISPUTE-PREMISE: line and the ticket lands in the terminal `disputed` state for a human
// to re-scope. Trusted like ALREADY-DONE (no judge), so the reason is what a reviewing human reads.
const DISPUTE_PREMISE_CLAUSE = [
	`If the ticket's PREMISE itself is wrong - it asks for the wrong thing, contradicts how the code`,
	`already works, or poses a design decision a human must settle before any implementation is`,
	`correct - do not implement it and do not guess. Make no edits and output exactly one line:`,
	`DISPUTE-PREMISE: <why the ticket is misconceived, concretely, citing the code or commit>. A`,
	`human then re-scopes it. This is for a genuinely broken premise only, never a way to skip hard work.`,
].join('\n');

function authorPrompt(t, objection = '') {
	return [
		`You are working ticket ${t.id}: ${t.title}. Follow the repo's own CONTRIBUTING or AGENTS.md if present.`,
		`Make ONLY the code changes this ticket needs, strictly within: ${t.scope}.`,
		`Do not touch files outside that scope. Do not commit, push, or open a PR -`,
		`the coordinator gates, commits, and opens the PR for you. Just edit the code.`,
		...(objection
			? [``, `A PREVIOUS author's attempt on this ticket was REJECTED in review for the`, `reason below. Do not repeat that approach; take a genuinely different one.`, `--- prior review objection ---`, objection.slice(0, 2000)]
			: []),
		``,
		ALREADY_DONE_CLAUSE,
		``,
		DISPUTE_PREMISE_CLAUSE,
		``,
		t.prompt,
	].join('\n');
}
// Sent when an attempt produced no diff at all. An empty result is a failure to
// act, not a decision, so this is firmer than the first prompt.
function emptyRetryPrompt(t) {
	return [
		`You are on ticket ${t.id}: ${t.title}, within ${t.scope}. Your previous attempt`,
		`produced NO file changes. That is a failure, not a pass: this ticket needs a real`,
		`code edit. Do not only analyze, describe, or defer to a "pending decision", MAKE`,
		`the change. If the ticket poses a choice, implement the safest option and note it`,
		`in a comment. Edit the code within ${t.scope}, then stop. Do not commit or open a PR.`,
		``,
		ALREADY_DONE_CLAUSE,
		``,
		DISPUTE_PREMISE_CLAUSE,
		``,
		t.prompt,
	].join('\n');
}
// The lenses of the blocking panel: each skeptic gets one, so the panel refutes
// from genuinely different angles rather than N agents making the same pass.
const PANEL_LENSES = [
	'whether it ACTUALLY fixes the ticket - fully and at the root, not just plausibly',
	'correctness, edge cases, and breakage it could cause elsewhere',
	'security, scope creep beyond the ticket, and repo-rule violations',
];
// An adversarial reviewer prompt: find a real reason to REJECT, through one lens.
function refutePrompt(t, pr, lens) {
	return [
		`You are an ADVERSARIAL reviewer of PR #${pr} for ticket ${t.id}. You are NOT the author.`,
		`Your job is to REFUTE this PR through one lens: ${lens}.`,
		`Read the repo's CONTRIBUTING/AGENTS.md if present, then the diff (\`git log -p origin/main..HEAD\`). Hunt for a concrete,`,
		`real defect under your lens: a way it is wrong, unsafe, out of scope (beyond ${t.scope}),`,
		`breaks a repo rule, or does not truly fix the ticket. A plausible-looking diff is not`,
		`enough, and do not be agreeable. Approve ONLY if it genuinely holds up; if unsure,`,
		`REQUEST_CHANGES. Post your verdict as your own forge user:`,
		`  node ${FORGE} review --pr ${pr} --event REQUEST_CHANGES --body "<the concrete defect>"`,
		`or --event APPROVE --body "<why it survives the lens>".`,
	].join('\n');
}
// Sent to the author when their PR got REQUEST_CHANGES. Symmetric to fixPrompt (a
// red gate), but the objection is a human-style review rather than gate output.
function addressReviewPrompt(t, objection, allowDispute = false) {
	return [
		`You are STILL the author of ticket ${t.id}: ${t.title}, within ${t.scope}. Your PR`,
		`was reviewed and the reviewer REQUESTED CHANGES. Read the objection below, fix the`,
		`real problem in the code, and stop. Stay within ${t.scope}. Do NOT weaken or skip`,
		`tests, and do NOT commit, push, or open a PR - the coordinator re-gates, re-pushes,`,
		`and requests a fresh review after you stop.`,
		``,
		ALREADY_DONE_CLAUSE,
		``,
		DISPUTE_PREMISE_CLAUSE,
		...(allowDispute ? ['', DISPUTE_CLAUSE] : ['', `No second agent can judge a dispute of this specific objection, so do not argue it in prose - fix it. But you are not required to keep revising an objection you cannot satisfy: if the reason you cannot is that the TICKET's premise is wrong (its approach contradicts how the code works, not merely that the fix is hard), stop and use DISPUTE-PREMISE above instead of spending revisions on it.`]),
		``,
		`--- reviewer's requested changes ---`,
		objection.slice(0, 4000),
	].join('\n');
}
// Sent when a revise attempt produced no diff. As with emptyRetryPrompt for authoring, an
// empty revision is a refusal to act, not a verdict on the review, so this is firmer and
// names the exact dead ends seen in practice (planning, deferring, asking what to do next).
function emptyReviseRetryPrompt(t, objection, allowDispute = false) {
	return [
		`You are STILL the author of ticket ${t.id}: ${t.title}, within ${t.scope}. Your`,
		`previous revision produced NO file changes. That is a failure, not a pass: you must`,
		`EDIT the code to address the objection below. Do not only analyze, plan, defer, or`,
		`ask what to do next, make the change now within ${t.scope}, then stop. Do NOT weaken`,
		`or skip tests, and do NOT commit, push, or open a PR - the coordinator handles that.`,
		``,
		ALREADY_DONE_CLAUSE,
		``,
		DISPUTE_PREMISE_CLAUSE,
		...(allowDispute ? ['', DISPUTE_CLAUSE] : []),
		``,
		`--- reviewer's requested changes ---`,
		objection.slice(0, 4000),
	].join('\n');
}
// The judge on a disputed objection: a third agent, not the author and (when possible) not a
// refuter, ruling on the merits alone. Told to protect main - uphold unless the rebuttal is
// conclusive. Reads the diff itself; prints one RULING line the coordinator parses.
function adjudicatePrompt(t, pr, objection, rebuttal) {
	return [
		`You are an impartial judge on PR #${pr} for ticket ${t.id}: ${t.title}. A reviewer raised`,
		`an objection; the author disputes it. Decide who is right on the technical merits ALONE.`,
		`Read the repo's CONTRIBUTING/AGENTS.md if present and the diff (\`git log -p origin/main..HEAD\`). You wrote neither side; do`,
		`not favour either. Your job is to protect main: uphold the objection unless the author's`,
		`rebuttal is conclusively correct. Do NOT edit anything and do NOT run git write or forge`,
		`commands - this is a ruling only. End with EXACTLY one line and nothing after it:`,
		`  RULING: UPHOLD: <why the objection is a real defect the author must fix>`,
		`or`,
		`  RULING: OVERRULE: <why the objection is wrong and the PR should proceed unchanged>`,
		`If you are not sure, UPHOLD.`,
		``,
		`--- reviewer's objection ---`,
		objection.slice(0, 3000),
		``,
		`--- author's dispute ---`,
		rebuttal.slice(0, 2000),
	].join('\n');
}
// Solo self-review: when the roster is one agent there is no other bot to run the
// panel, so the author critiques its own PR. It cannot post an APPROVED review on
// its own PR (the forge blocks self-approval), so the verdict is read from a final VERDICT: line and
// the coordinator gates the merge on it (the admin token merges without an approval).
function selfReviewPrompt(t, pr) {
	return [
		`You are the AUTHOR of PR #${pr} for ticket ${t.id}: ${t.title}. No other agent is`,
		`available to review, so review your OWN work now with fresh, adversarial eyes - be`,
		`your own harshest critic, not agreeable. Read the repo's CONTRIBUTING/AGENTS.md if present, then the diff`,
		`(\`git log -p origin/main..HEAD\`) and check, ruthlessly:`,
		`  - does it ACTUALLY fix ${t.id} at the root, not just plausibly?`,
		`  - correctness, edge cases, and breakage elsewhere?`,
		`  - security, scope creep beyond ${t.scope}, and repo-rule violations?`,
		`Do NOT edit anything and do NOT run git or forge commands - this is review only.`,
		`End your output with EXACTLY one line and nothing after it:`,
		`  VERDICT: APPROVE`,
		`if it genuinely holds up, or`,
		`  VERDICT: BLOCK: <the single most important concrete defect to fix>`,
		`if it does not. If you are unsure, BLOCK.`,
	].join('\n');
}

// --- primitives ------------------------------------------------------------
// A generous output cap: execFileSync defaults to 1MB and throws ENOBUFS past it,
// which killed a gate-green ticket at push and deleted its branch.
const MAXBUF = 256 * 1024 * 1024;
const git = (args, cwd, env) => execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: MAXBUF }).trim();
const run = (cmd, args, opts) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
// A worktree path lives UNDER the main repo (ROOT/.openhark/worktrees/<id>), so if it is
// missing or not a real worktree, git walks up to ROOT and a `reset --hard`/`clean` there
// wipes the MAIN checkout - this destroyed a working tree once. Refuse any destructive git
// unless cwd is genuinely its own worktree root (its toplevel is itself, and not ROOT).
function assertIsolatedWorktree(wt) {
	let top;
	try { top = git(['rev-parse', '--show-toplevel'], wt); } catch (e) { throw new Error(`worktree ${wt} unusable: ${String(e.message).slice(0, 120)}`); }
	const wtReal = realpathSync(wt), topReal = realpathSync(top), rootReal = realpathSync(ROOT);
	if (topReal !== wtReal || topReal === rootReal) throw new Error(`refusing destructive git in ${wt}: git resolves it to ${top} (main repo ${ROOT}); worktree missing or broken`);
}
const FORGE = join(BIN_DIR, 'forge.mjs');
function forge(sub, flags, env) {
	const out = execFileSync('node', [FORGE, sub, ...flags], { cwd: ROOT, encoding: 'utf8', env, maxBuffer: MAXBUF });
	return JSON.parse(out);
}
// Reset any lockfile a fresh install touched, so its churn is never committed by an agent. But a
// DELIBERATE dependency change (the branch edited a package.json) must keep its lockfile, or the
// build re-breaks and a frozen install fails. So only strip lockfiles when no package.json differs.
const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
function resetLockfiles(wt) {
	try {
		if (git(['diff', '--name-only', 'origin/main'], wt).split('\n').some((f) => f.endsWith('package.json'))) return;
	} catch {}
	for (const f of LOCKFILES) if (existsSync(join(wt, f))) { try { git(['checkout', '--', f], wt); } catch {} }
}
// Agents run with cwd set to their worktree, but they have bypass permissions and sometimes edit the
// MAIN checkout through an absolute path (the canonical repo path they know), leaking work outside
// the worktree.
// The main tree is clean at launch (the dashboard refuses a dirty one), so any tracked change
// there after an agent runs is a leak: revert it and warn. Untracked leaks are left (they
// block nothing and cleaning them is riskier).
function revertMainLeak(tag) {
	// git() trims its output, so porcelain status columns cannot be sliced reliably (a leading space
	// on the first line is gone, which drops a char from the first path). diff --name-only gives bare
	// paths; against HEAD it stays tracked-only, matching --untracked-files=no.
	let files = [];
	try { files = git(['diff', '--name-only', 'HEAD'], ROOT).split('\n').map((s) => s.trim()).filter(Boolean); } catch { return; }
	if (!files.length) return;
	try { git(['checkout', '--', ...files], ROOT); } catch {}
	console.error(`WARN: ${tag} leaked edits into the main checkout; reverted ${files.join(', ')}`);
}
// SIGKILL a process and all its descendants (a timed-out agent CLI leaves node grandchildren that
// would otherwise orphan). Not detached, so a run-level kill of the coordinator's group still reaps.
function killTree(pid) {
	try { for (const k of execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean)) killTree(k); } catch {}
	try { process.kill(pid, 'SIGKILL'); } catch {}
}
function spawnAgent(bot, wt, prompt, env, onPid, tag) {
	const [cmd, args, opts] = ROSTER[bot](wt, prompt, env && env._SWARM_MODEL);
	// Capture the agent's output to a per-run log. Dashboard-launched runs are
	// detached with stdio ignored, so without this an agent that dies takes its
	// reason to /dev/null ("gemini exited 1" and nothing else). We tee to a file
	// and keep a tail so a failure carries its own last words.
	const logDir = join(STATE_DIR, 'logs');
	mkdirSync(logDir, { recursive: true });
	const logPath = join(logDir, `${tag || bot}.log`);
	const logStream = createWriteStream(logPath);
	return new Promise((res, rej) => {
		const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts, env: { ...env, ...(opts.env || {}) } });
		if (onPid && p.pid) onPid(p.pid);
		let tail = '', timedOut = false;
		// A throttled backend that accepts the process but never answers (0% CPU) would keep a review
		// pending forever. Kill the agent's whole tree and let the caller treat it as a transient
		// failure (which also parks the harness as throttled).
		const killer = setTimeout(() => { timedOut = true; killTree(p.pid); }, AGENT_TIMEOUT_MS);
		const cap = (d) => {
			logStream.write(d);
			tail = (tail + d).slice(-2000);
			if (process.stdout.writable) process.stdout.write(d);
		};
		p.stdout.on('data', cap);
		p.stderr.on('data', cap);
		p.on('exit', (code) => {
			clearTimeout(killer);
			logStream.end();
			revertMainLeak(tag || bot);
			if (timedOut) return rej(new Error(`${bot} timed out after ${Math.round(AGENT_TIMEOUT_MS / 60000)}m (log ${logPath})`));
			if (code === 0) return res(tail); // the tail lets a caller read a verdict the agent printed
			rej(new Error(`${bot} exited ${code} (log ${logPath}); tail: ${tail.slice(-400).replace(/\s+/g, ' ').trim()}`));
		});
		p.on('error', (e) => {
			clearTimeout(killer);
			logStream.end();
			rej(e);
		});
	});
}
// A transient failure - a stalled first response, a dropped socket, a 5xx from the
// model backend - should not cost an agent its turn. Retry the same spawn a couple
// of times before the caller escalates to a different agent. A real nonzero exit
// whose output is not one of these is not retried; it escalates immediately.
const TRANSIENT_FAIL = /timeout waiting for response|timed out|ETIMEDOUT|ECONNRESET|socket hang up|50[234]\b|overloaded|unavailable|deadline exceeded/i;
// The subset that means the backend is out of budget, not the network hiccuped: park the harness.
const QUOTA_FAIL = /overloaded|rate.?limit|\b429\b|\b529\b|resource_exhausted|quota|timed out|timeout waiting/i;
async function spawnWithRetry(agent, wt, prompt, env, onPid, tag, retries = Number(process.env.SWARM_SPAWN_RETRIES || 2)) {
	for (let i = 0; ; i++) {
		try {
			return await spawnAgent(agent, wt, prompt, env, onPid, i === 0 ? tag : `${tag}-retry${i}`);
		} catch (e) {
			if (QUOTA_FAIL.test(String(e.message))) markThrottled(agent);
			if (i >= retries || !TRANSIENT_FAIL.test(String(e.message))) throw e;
			console.log(`[${tag}] transient failure (${String(e.message).slice(0, 90)}); retry ${i + 1}/${retries}`);
		}
	}
}
function simEdit(wt, t) {
	// A scripted, real, TRACKED edit so the pipeline can be validated without an
	// LLM. Under a local simruns/ scratch dir,
	// so git sees the change and the gate stays light.
	const dir = join(wt, 'scripts', 'agent', 'simruns');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${t.id}.md`), `sim edit for ${t.id}: ${t.title}\n`);
}

// Run the gate WITHOUT throwing, capturing its output so a red gate can be handed
// back to the author. execFileSync throws on non-zero; the output is on the error.
function runGateCapture(wt, env) {
	try {
		const out = execFileSync('bash', [join(BIN_DIR, 'gate.sh')], { cwd: wt, env, encoding: 'utf8', maxBuffer: MAXBUF });
		return { ok: true, output: out };
	} catch (e) {
		return { ok: false, output: `${e.stdout || ''}\n${e.stderr || ''}`.trim() };
	}
}
// The tail of a captured agent log, so a skip/failure can quote the agent's own
// last words instead of a bare status.
function readLogTail(tag) {
	try {
		const p = join(STATE_DIR, 'logs', `${tag}.log`);
		return existsSync(p) ? readFileSync(p, 'utf8').slice(-300).replace(/\s+/g, ' ').trim() : 'no agent log';
	} catch {
		return 'no agent log';
	}
}
// Scan an agent's full log for a WORD: <reason> sentinel and return the reason, or null. An empty
// diff plus a sentinel is a deliberate outcome (ALREADY-DONE: the work is already on main; DISPUTE:
// the objection is wrong); an empty diff without one is a failure to act. Only meaningful on an
// actually-empty diff.
function sentinelReason(tag, word, cap = 300) {
	try {
		const p = join(STATE_DIR, 'logs', `${tag}.log`);
		if (!existsSync(p)) return null;
		const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${word}:\\s*(.+)$`, 'm'));
		return m ? m[1].trim().replace(/\s+/g, ' ').slice(0, cap) : null;
	} catch {
		return null;
	}
}
const alreadyDoneReason = (tag) => sentinelReason(tag, 'ALREADY-DONE');
const disputeReason = (tag) => sentinelReason(tag, 'DISPUTE', 2000);
// DISPUTE-PREMISE has a distinct tag, so the DISPUTE regex (which requires `DISPUTE:`) never matches it.
const premiseDisputeReason = (tag) => sentinelReason(tag, 'DISPUTE-PREMISE', 2000);
function fixPrompt(t, gateOutput) {
	return [
		`You are still on ticket ${t.id}: ${t.title}, within ${t.scope}. Your changes are`,
		`committed but the local gate is RED. Read the gate output below, fix the real`,
		`cause in the code, and stop. Do NOT weaken or skip tests, do NOT touch files`,
		`outside ${t.scope} unless the failure genuinely requires it, and do NOT commit,`,
		`push, or open a PR. The coordinator re-commits and re-gates after you stop.`,
		``,
		`--- gate output (tail) ---`,
		gateOutput.slice(-4000),
	].join('\n');
}
function hookFixPrompt(t, hookOutput) {
	return [
		`You are still on ticket ${t.id}: ${t.title}, within ${t.scope}. Your changes are`,
		`staged but the pre-commit hook REJECTED the commit (lint, format, or secret checks).`,
		`Read the hook output below, fix the real cause in the code, and stop. Do NOT weaken or`,
		`skip the checks, do NOT touch files outside ${t.scope} unless the failure genuinely`,
		`requires it, and do NOT commit, push, or open a PR. The coordinator re-stages and`,
		`re-commits after you stop.`,
		``,
		`--- pre-commit hook output (tail) ---`,
		hookOutput.slice(-4000),
	].join('\n');
}
// Commit the staged work, treating a pre-commit-hook rejection as fixable, not terminal: the
// husky/lint-staged hook (ESLint --max-warnings 0, prettier, gitleaks) can block an otherwise
// good change over lint the author can fix, so hand its output back to the same agent up to
// MAX_FIX_ROUNDS and retry, the way the gate loop does. The hook is never skipped (--no-verify
// is banned). Returns { ok } or { ok:false, reason }.
async function commitOrFix(t, agent, wt, env, report, commitArgs, tagPrefix) {
	const idFlags = ['-c', `user.name=${botLogin(agent)}`, '-c', `user.email=${botLogin(agent)}@users.noreply.github.com`];
	for (let round = 0; ; round++) {
		try {
			git([...idFlags, 'commit', ...commitArgs], wt);
			return { ok: true };
		} catch (e) {
			const out = `${(e && e.stdout) || ''}\n${(e && e.stderr) || ''}`.trim();
			if (SIM || round >= MAX_FIX_ROUNDS) return { ok: false, reason: `pre-commit hook rejected the commit after ${round} fix round(s): ${out.slice(-300).replace(/\s+/g, ' ')}` };
			report('fixing', `${agent}: pre-commit hook rejected, fix round ${round + 1}/${MAX_FIX_ROUNDS}`);
			try {
				await spawnWithRetry(agent, wt, hookFixPrompt(t, out), env, (pid) => emit({ ticket: t.id, agentPid: pid, agentRole: 'author-fix' }), `${tagPrefix}-hook${round + 1}`);
			} catch (se) {
				return { ok: false, reason: `${agent} crashed fixing the pre-commit hook: ${String(se.message).slice(0, 120)}` };
			}
			try { resetLockfiles(wt); } catch {}
			git(['add', '-A'], wt);
		}
	}
}

// Merges touch main, so only one runs at a time. The mutex chain must stay alive so one
// merge's failure never blocks the next, yet the caller still has to see ITS OWN merge
// reject. Swallowing that rejection was masking failed rebases/gates/merges and stranding
// the ticket at 'merging' instead of reporting it 'failed'.
let mergeChain = Promise.resolve();
const serialize = (fn) => {
	const run = mergeChain.then(fn, fn);
	mergeChain = run.catch(() => {});
	return run;
};

// Run the gate and, on red, hand the output back to the same agent up to
// MAX_FIX_ROUNDS, re-committing (amend) each round. Shared by landChange (initial)
// and reviseChange (after a review). Returns { ok } or { ok:false, reason }.
async function gateFixLoop(t, agent, wt, env, report, tagPrefix) {
	report('gating', 'gate');
	let gate = runGateCapture(wt, env);
	for (let round = 1; !gate.ok; round++) {
		if (round > MAX_FIX_ROUNDS) return { ok: false, reason: `gate still red after ${MAX_FIX_ROUNDS} fix round(s): ${readLogTail(`${tagPrefix}-fix${round - 1}`)}` };
		report('fixing', `${agent}: gate red, fix round ${round}/${MAX_FIX_ROUNDS}`);
		if (SIM) writeFileSync(join(wt, 'scripts', 'agent', 'simruns', `${t.id}.md`), `sim fix ${round} for ${t.id}\n`);
		else
			try {
				await spawnWithRetry(agent, wt, fixPrompt(t, gate.output), env, (pid) => emit({ ticket: t.id, agentPid: pid, agentRole: 'author-fix' }), `${tagPrefix}-fix${round}`);
			} catch (e) {
				return { ok: false, reason: `${agent} crashed on fix: ${String(e.message).slice(0, 120)}` };
			}
		try {
			resetLockfiles(wt);
		} catch {}
		if (git(['status', '--porcelain'], wt).trim() === '') return { ok: false, reason: `fix round ${round} changed nothing; gate still red` };
		git(['add', '-A'], wt);
		const recommitted = await commitOrFix(t, agent, wt, env, report, ['--amend', '--no-edit'], `${tagPrefix}-fix${round}`);
		if (!recommitted.ok) return recommitted;
		gate = runGateCapture(wt, env);
	}
	return { ok: true };
}

// One agent's attempt to land a gate-green commit on the branch: edit (re-prompt on
// an empty diff), commit, gate (fix on red). Returns { ok } or { ok:false, reason }
// so the caller can escalate to the next agent. Resets the worktree to a clean base
// first, so it never builds on a prior agent's dead end; `objection`, when set (an
// escalation after a rejected review), is injected into the author prompt.
async function landChange(t, agent, wt, env, report, objection = '') {
	assertIsolatedWorktree(wt);
	git(['reset', '--hard', 'origin/main'], wt);
	try {
		git(['clean', '-fd'], wt);
	} catch {}

	report('editing', `author edits (${agent})`, { rev: 0 });
	for (let attempt = 1; ; attempt++) {
		const tag = `${t.id}-${agent}-edit${attempt > 1 ? attempt : ''}`;
		if (SIM) simEdit(wt, t);
		else
			try {
				await spawnWithRetry(agent, wt, attempt === 1 ? authorPrompt(t, objection) : emptyRetryPrompt(t), env, (pid) => emit({ ticket: t.id, agentPid: pid, agentRole: 'author' }), tag);
			} catch (e) {
				return { ok: false, reason: `${agent} crashed: ${String(e.message).slice(0, 120)}` };
			}
		try {
			resetLockfiles(wt);
		} catch {}
		if (git(['status', '--porcelain'], wt).trim() !== '') break;
		const done = alreadyDoneReason(tag);
		if (done) return { ok: false, alreadyDone: true, reason: done };
		const premise = premiseDisputeReason(tag);
		if (premise) return { ok: false, premiseDisputed: true, reason: premise };
		if (attempt >= MAX_FIX_ROUNDS) return { ok: false, reason: `no diff after ${attempt} attempt(s): ${readLogTail(tag)}` };
		report('editing', `${agent}: no diff (attempt ${attempt}/${MAX_FIX_ROUNDS}); re-prompting`);
	}

	report('committing', 'commit', { agentPid: null });
	git(['add', '-A'], wt);
	const committed = await commitOrFix(t, agent, wt, env, report, ['-m', `${t.id}: ${t.title}`], `${t.id}-${agent}`);
	if (!committed.ok) return committed;
	return gateFixLoop(t, agent, wt, env, report, `${t.id}-${agent}`);
}

// The same author addresses a REQUEST_CHANGES on the existing branch (no reset - it
// builds on the PR's commits), re-prompts on an empty diff (an agent that narrates a plan
// instead of editing is a no-op, not a decline), commits the revision, and re-gates.
async function reviseChange(t, agent, wt, env, objection, report, nextRev, allowDispute = false) {
	report('revising', `${agent} addresses review`, { rev: nextRev });
	let tag;
	for (let attempt = 1; ; attempt++) {
		tag = `${t.id}-${agent}-revise${attempt > 1 ? attempt : ''}`;
		if (SIM) writeFileSync(join(wt, 'scripts', 'agent', 'simruns', `${t.id}.md`), `sim revision by ${agent} for ${t.id}\n`);
		else
			try {
				await spawnWithRetry(agent, wt, attempt === 1 ? addressReviewPrompt(t, objection, allowDispute) : emptyReviseRetryPrompt(t, objection, allowDispute), env, (pid) => emit({ ticket: t.id, agentPid: pid, agentRole: 'author-revise' }), tag);
			} catch (e) {
				return { ok: false, reason: `${agent} crashed addressing review: ${String(e.message).slice(0, 120)}` };
			}
		try {
			resetLockfiles(wt);
		} catch {}
		if (git(['status', '--porcelain'], wt).trim() !== '') break;
		const done = alreadyDoneReason(tag);
		if (done) return { ok: false, alreadyDone: true, reason: done };
		const premise = premiseDisputeReason(tag);
		if (premise) return { ok: false, premiseDisputed: true, reason: premise };
		if (allowDispute) { const d = disputeReason(tag); if (d) return { ok: false, disputed: true, rebuttal: d }; }
		if (attempt >= MAX_FIX_ROUNDS) return { ok: false, reason: `revision changed nothing after ${attempt} attempt(s): ${readLogTail(tag)}` };
		report('revising', `${agent}: revision made no changes (attempt ${attempt}/${MAX_FIX_ROUNDS}); re-prompting`, { rev: nextRev });
	}
	git(['add', '-A'], wt);
	const committed = await commitOrFix(t, agent, wt, env, report, ['-m', `${t.id}: address review`], `${t.id}-${agent}-rev`);
	if (!committed.ok) return committed;
	return gateFixLoop(t, agent, wt, env, report, `${t.id}-${agent}-rev`);
}

// The blocking adversarial review: every skeptic reviews the PR through a distinct
// lens (told to refute), concurrently (a review only reads the worktree). Returns
// { approved, objection }. Majority-refute (refuters > approvers) blocks; a tie or an
// approval majority with at least one approval passes. The latest verdict per skeptic
// counts, so a skeptic that refuted then approved across revise rounds counts as pass.
// One agent reviewing its own PR: gate on a parsed VERDICT line rather than a forge
// review (which it cannot APPROVE on its own PR). Defaults to BLOCK when no clear
// verdict is printed, so nothing merges unreviewed.
async function selfReview(t, prNumber, author, wt, i, report, model) {
	if (SIM) return { approved: true, objection: '' };
	// running:[author] so the board shimmers the self-reviewer: solo review has no panel, and the
	// reviewer reads as (none), so without this the row shows REVIEW with nothing alive on it.
	report('reviewing', `solo self-review by ${author}`, { running: [author] });
	let out = '';
	try {
		out = await spawnWithRetry(author, wt, selfReviewPrompt(t, prNumber), taskEnv(author, t.id, i, model), (pid) => emit({ ticket: t.id, agentPid: pid, agentRole: `selfreview:${author}` }), `${t.id}-selfreview`);
	} catch (e) {
		emit({ ticket: t.id, agentPid: null, running: [] });
		return { approved: false, objection: `self-review failed to run: ${String(e.message).slice(0, 300)}` };
	}
	const m = [...String(out || '').matchAll(/VERDICT:\s*(APPROVE|BLOCK)\s*:?\s*([^\n]*)/gi)].pop();
	const approved = !!m && m[1].toUpperCase() === 'APPROVE';
	const objection = approved ? '' : m ? `[self-review] ${m[2].trim()}` : '[self-review] no clear verdict printed; treating as blocked';
	report('reviewing', `self-review verdict: ${approved ? 'APPROVE' : 'BLOCK'}`, { agentPid: null, running: [] });
	return { approved, objection };
}
async function reviewPanel(t, prNumber, author, prAuthorBot, wt, i, report, authorModel) {
	const skeptics = panelOf(author, prAuthorBot);
	// No eligible skeptic (solo roster, or the other harnesses are parked as throttled): a self-review
	// the coordinator still gates beats blocking the ticket on nobody.
	if (!skeptics.length) return selfReview(t, prNumber, author, wt, i, report, authorModel);
	report('reviewing', `blocking panel: ${skeptics.join(', ')}`);
	// Track which reviewers are live so the board shimmers each independently: a reviewer is added
	// on spawn and removed when it finishes (posts or crashes), so one can stop before the other.
	const live = new Set();
	const emitLive = () => emit({ ticket: t.id, running: [...live] });
	const runSkeptic = (sk) => {
		live.add(sk); emitLive();
		return (SIM
			? Promise.resolve(forge('review', ['--pr', String(prNumber), '--event', 'APPROVED', '--body', 'sim panel'], taskEnv(sk, t.id, i)))
			: spawnWithRetry(sk, wt, refutePrompt(t, prNumber, PANEL_LENSES[skeptics.indexOf(sk) % PANEL_LENSES.length]), taskEnv(sk, t.id, i, HARNESS_MODEL[sk]), (pid) => emit({ ticket: t.id, agentPid: pid, agentRole: `panel:${sk}` }), `${t.id}-panel-${sk}`)
		).catch(() => {}).finally(() => { live.delete(sk); emitLive(); });
	};
	const votesBy = () => { const reviews = forge('reviews', ['--pr', String(prNumber)], taskEnv(author, t.id, i)); const latest = {}; for (const r of reviews) if (r.user?.login && r.user.login !== prAuthorBot) latest[r.user.login] = r; return latest; };
	await Promise.all(skeptics.map(runSkeptic));
	let latest = votesBy();
	// A reviewer that crashed or timed out posts no review, and no-vote reads as no-approval -
	// a silent block. Retry the non-voters once; if they still do not vote the block is a panel
	// flake, not a real REQUEST_CHANGES, so the caller marks it FLAKY rather than a rejection.
	let missing = skeptics.filter((sk) => !latest[botLogin(sk)]);
	if (missing.length) {
		report('reviewing', `no review from ${missing.join(', ')}; retrying`);
		await Promise.all(missing.map(runSkeptic));
		latest = votesBy();
		missing = skeptics.filter((sk) => !latest[botLogin(sk)]);
	}
	const votes = skeptics.map((sk) => latest[botLogin(sk)]).filter(Boolean);
	const refuters = votes.filter((r) => r.state === 'REQUEST_CHANGES');
	const approvers = votes.filter((r) => r.state === 'APPROVED');
	const objection = refuters.map((r) => `[${r.user.login}] ${(r.body || '').trim()}`).join('\n\n').slice(0, 4000);
	const approved = approvers.length > 0 && refuters.length <= approvers.length;
	const flaky = !approved && refuters.length === 0 && missing.length > 0; // blocked only by non-votes
	report('reviewing', `panel verdict: ${approvers.length} approve / ${refuters.length} refute${missing.length ? ` / ${missing.length} no-vote` : ''} -> ${approved ? 'PASS' : flaky ? 'FLAKY' : 'BLOCKED'}`, { agentPid: null });
	return { approved, flaky, refuters: refuters.map((r) => botKey(r.user.login)), objection: objection || (flaky ? `no review posted after retry by: ${missing.join(', ')}` : '') };
}

// Rule on a coder's DISPUTE of a blocking objection. A fresh agent - not the author, and not a
// refuter when the roster allows - reads the diff, objection, and rebuttal and prints a RULING.
// OVERRULE clears the objection (and the judge posts a formal APPROVED so the PR merges cleanly);
// anything else, including a crash or no clear ruling, upholds it (protect main). One call per
// objection; the caller forces a real fix after an upheld dispute.
async function adjudicate(t, prNumber, author, refuters, objection, rebuttal, wt, i, report) {
	const pool = AGENTS.filter((a) => a !== author);
	const judge = pool.find((a) => !refuters.includes(a)) || pool[0];
	if (!judge) return { overruled: false, judge: '(none)', reason: 'no judge available' };
	const jEnv = taskEnv(judge, t.id, i, HARNESS_MODEL[judge]);
	report('reviewing', `dispute by ${author}; ${judge} adjudicating`, { running: [judge] });
	let out = '';
	try {
		out = await spawnWithRetry(judge, wt, adjudicatePrompt(t, prNumber, objection, rebuttal), jEnv, (pid) => emit({ ticket: t.id, agentPid: pid, agentRole: `judge:${judge}` }), `${t.id}-judge`);
	} catch (e) {
		return { overruled: false, judge, reason: `judge failed to run: ${String(e.message).slice(0, 120)}` };
	}
	const m = [...String(out || '').matchAll(/RULING:\s*(UPHOLD|OVERRULE)\s*:?\s*([^\n]*)/gi)].pop();
	const overruled = !!m && m[1].toUpperCase() === 'OVERRULE';
	const reason = m ? m[2].trim().slice(0, 300) : 'no clear ruling printed; upholding to protect main';
	if (overruled) try { forge('review', ['--pr', String(prNumber), '--event', 'APPROVED', '--body', `dispute upheld by judge ${judge}: ${reason}`.slice(0, 400)], jEnv); } catch {}
	report('reviewing', `ruling by ${judge}: ${overruled ? 'OVERRULE (objection cleared)' : 'UPHOLD (objection stands)'}`, { agentPid: null, running: [] });
	return { overruled, judge, reason };
}

async function processTicket(t, i, resume = null, runner = null) {
	// The worker that pulled this ticket is bound to a runner (harness+model); that is
	// the first author, and authorship escalates to the other active harnesses. Its own
	// model authors first; an escalated harness uses its representative model. On resume,
	// continue from the author the run died on.
	const full = runner ? [runner.harness, ...AGENTS.filter((h) => h !== runner.harness)] : escalationOrder(i);
	const order = resume && full.includes(resume.author) ? full.slice(full.indexOf(resume.author)) : full;
	// The runner's model applies only to the runner's OWN harness. On a resume the first candidate
	// is the PR's author, which may be a different harness (e.g. qwen), so it must use that
	// harness's model - handing qwen claude-opus-4-8 makes qwen's API 404 and the agent exit 1.
	const modelFor = (cand, ci) => (ci === 0 && runner && cand === runner.harness ? runner.model : HARNESS_MODEL[cand] || '');
	const wt = join(ROOT, '.openhark', 'worktrees', t.id);
	const branch = `agent/${t.id}`;
	// author/reviewer are settled by escalation; report reads them live so the
	// board shows whichever agent is currently attempting the ticket.
	let author = order[0];
	let reviewer = panelOf(author, null).join('+');
	const log = (m) => console.log(`[${t.id} ${author}->${reviewer}] ${m}`);
	const report = (stage, m, extra) => {
		if (m) log(m);
		emit({ ticket: t.id, title: t.title, author, reviewer, stage, detail: m || '', ...extra });
	};
	report('start');
	try {
		report('worktree', 'worktree + isolated db');
		try { run('node', [join(BIN_DIR, 'worktree.mjs'), 'remove', t.id]); } catch {} // clear a leftover from a killed run
		run('node', [join(BIN_DIR, 'worktree.mjs'), 'create', t.id]);

		// One candidate author at a time: land a gate-green commit, open (or update)
		// the PR, then iterate review <-> revise. If this author cannot earn an approval
		// within MAX_REVISIONS, escalate authorship to the next agent (fresh eyes),
		// seeded with the last objection so it does not repeat the rejected approach.
		// Each landChange resets the worktree, so a stuck model never poisons the next.
		// A REQUEST_CHANGES is terminal only once every candidate is spent.
		let prNumber = null;
		let prAuthorBot = null; // the bot that opened the PR; a reviewer is never this
		let objection = '';
		let approvedPr = false;
		let anyFlaky = false, anyRealBlock = false; // flaky = reviewers never voted; realBlock = a genuine REQUEST_CHANGES
		const reasons = [];
		for (let ci = 0; ci < order.length; ci++) {
			const cand = order[ci];
			author = cand;
			reviewer = panelOf(cand, prAuthorBot).join('+') || '(none)';
			const candModel = modelFor(cand, ci);
			const aEnv = taskEnv(cand, t.id, i, candModel);

			// Resume: the run died with this author's PR already pushed. Reuse it - load
			// the last-pushed commit into the worktree and go straight to review, rather
			// than throwing away a committed, possibly gate-green attempt.
			let resumed = false;
			if (resume && ci === 0 && resume.pr) {
				try { assertIsolatedWorktree(wt); git(['fetch', 'origin', branch], wt); git(['reset', '--hard', 'FETCH_HEAD'], wt); resumed = true; } catch {}
			}
			if (resumed) {
				prNumber = resume.pr;
				try { prAuthorBot = (forge('get', ['--pr', String(resume.pr)], aEnv).user || {}).login || botLogin(cand); } catch { prAuthorBot = botLogin(cand); }
				reviewer = panelOf(cand, prAuthorBot).join('+') || '(none)';
				report('pr_open', `resuming PR #${prNumber} at review (${cand})`, { pr: prNumber });
			} else {
				const res = await landChange(t, cand, wt, aEnv, report, objection);
				if (!res.ok) {
					if (res.alreadyDone) return report('already_done', `${cand}: already satisfied on main, no change needed. ${res.reason}`, { agentPid: null });
					if (res.premiseDisputed) return report('disputed', `${cand}: premise disputed, needs a human decision before any code. ${res.reason}`, { agentPid: null });
					reasons.push(`${cand} author: ${res.reason}`);
					report('editing', `${cand} could not land it, escalating`, { agentPid: null });
					continue;
				}
				report('pr_open', prNumber ? 'update PR + re-review' : 'push + open PR');
				// Sync the remote-tracking ref to the remote's truth before --force-with-lease,
				// or it bails with "stale info". A re-run reuses agent/<id>: the branch may
				// still exist remotely (fetch re-establishes a current lease) OR have been
				// merged+deleted, leaving a STALE local tracking ref pointing at a gone branch
				// (which the fetch cannot clear). Drop the tracking ref first, then fetch: if
				// the branch exists the fetch recreates it current; if it is gone there is no
				// ref and the lease treats it as a new branch, pushing fresh.
				try { git(['update-ref', '-d', `refs/remotes/origin/${branch}`], wt); } catch {}
				try { git(['fetch', 'origin', branch], wt); } catch {}
				git(['push', '-u', 'origin', branch, '--force-with-lease'], wt);
				if (!prNumber) {
					const pr = forge('open', ['--head', branch, '--title', `${t.id}: ${t.title}`, '--body', t.prompt.slice(0, 500)], aEnv);
					prNumber = pr.number;
					prAuthorBot = botLogin(cand);
				}
				report('pr_open', `PR #${prNumber}`, { pr: prNumber });
				reviewer = panelOf(cand, prAuthorBot).join('+') || '(none)';
			}
			for (let revision = 0; ; revision++) {
				report('reviewing', revision > 0 ? `blocking review (revision ${revision})` : 'blocking review', { rev: revision });
				const verdict = await reviewPanel(t, prNumber, cand, prAuthorBot, wt, i, report, candModel);
				if (verdict.approved) {
					approvedPr = true;
					break;
				}
				// A flaky verdict has no real objection to revise against, so do not burn a revision
				// on it; break and let escalation try a fresh panel (a different author excludes a
				// different reviewer). Only a genuine REQUEST_CHANGES drives the revise loop.
				if (verdict.flaky) {
					anyFlaky = true;
					reasons.push(`${cand}: review flaky (${verdict.objection})`);
					break;
				}
				anyRealBlock = true;
				objection = verdict.objection || objection;
				if (revision >= MAX_REVISIONS) {
					reasons.push(`${cand}: panel blocked after ${revision} revision(s)`);
					break;
				}
				// The coder may DISPUTE the objection instead of editing (only with a real panel, so a
				// judge exists). A neutral judge rules: OVERRULE clears the objection and the PR merges
				// as-is; UPHOLD forces a genuine fix (no second dispute on the same objection).
				let rev = await reviseChange(t, cand, wt, aEnv, objection, report, revision + 1, AGENTS.length > 1);
				if (!rev.ok && rev.disputed) {
					const ruling = await adjudicate(t, prNumber, cand, verdict.refuters || [], objection, rev.rebuttal, wt, i, report);
					if (ruling.overruled) {
						report('reviewing', `${cand}'s dispute upheld by ${ruling.judge}; objection overruled, PR #${prNumber} proceeds. ${ruling.reason}`, { pr: prNumber, agentPid: null });
						approvedPr = true;
						break;
					}
					objection = `${objection}\n\n[judge ${ruling.judge} UPHELD the objection over the author's dispute: ${ruling.reason}]`;
					report('revising', `${cand}'s dispute rejected by ${ruling.judge}; must fix now. ${ruling.reason}`, { rev: revision + 1 });
					rev = await reviseChange(t, cand, wt, aEnv, objection, report, revision + 1, false);
				}
				if (!rev.ok) {
					if (rev.alreadyDone) return report('already_done', `${cand}: PR #${prNumber} unnecessary, already satisfied on main. ${rev.reason}`, { pr: prNumber, agentPid: null });
					if (rev.premiseDisputed) return report('disputed', `${cand}: premise disputed during revision, needs a human decision. PR #${prNumber} left open. ${rev.reason}`, { pr: prNumber, agentPid: null });
					reasons.push(`${cand} revise: ${rev.reason}`);
					break;
				}
				git(['push', '--force-with-lease', 'origin', branch], wt);
			}
			if (approvedPr) break;
			report('reviewing', `${cand} could not survive the panel, escalating`, { agentPid: null });
		}

		if (!approvedPr) {
			if (!prNumber) return report('skipped', `no agent could land a gate-green change. ${reasons.join(' | ')}`, { agentPid: null });
			// FLAKY: a PR exists but every author was blocked only by reviewers that never voted,
			// never by a real objection - an infrastructure failure to review, not a rejection.
			if (anyFlaky && !anyRealBlock) return report('flaky', `review could not be completed (reviewers crashed); PR #${prNumber} left open. ${reasons.join(' | ')}`, { pr: prNumber, agentPid: null });
			return report('changes_requested', `no agent earned approval after review rounds; PR #${prNumber} left open. ${reasons.join(' | ')}`, { pr: prNumber, agentPid: null });
		}

		const aEnv = taskEnv(author, t.id, i);
		if (NO_MERGE) return report('approved', `approved; --no-merge, PR #${prNumber} left open`, { pr: prNumber, agentPid: null });
		report('approved', `approved PR #${prNumber}`, { pr: prNumber, agentPid: null });

		// Merge under the mutex: rebase onto current main, then re-gate. Both can break because main
		// moved under the branch, so bounce a conflict or a red re-gate back instead of dead-ending
		// at 'failed'. A red re-gate is handed to the author to fix and re-commit (gateFixLoop, the
		// same loop authoring uses), so a fixable rebase break is repaired rather than stranding.
		let mergeBlocked = null;
		await serialize(async () => {
			report('merging', 'rebase onto main + re-gate + merge', { pr: prNumber });
			git(['fetch', 'origin', 'main'], wt);
			try {
				git(['rebase', 'origin/main'], wt);
			} catch (e) {
				try { git(['rebase', '--abort'], wt); } catch {}
				mergeBlocked = `rebase onto main conflicted: ${String(e.message).slice(0, 200)}`;
				return;
			}
			const gated = await gateFixLoop(t, author, wt, aEnv, report, `${t.id}-${author}-merge`);
			if (!gated.ok) { mergeBlocked = gated.reason; return; }
			git(['push', '--force-with-lease', 'origin', branch], wt);
			// Right after the force-push the forge is still recomputing mergeability and briefly
			// answers the merge call with a transient "try again later" (Gitea 405/500, GitHub 405/
			// 5xx/429). The branch is gate-green and approved, so retry with backoff before failing.
			for (let attempt = 1; ; attempt++) {
				try { forge('merge', ['--pr', String(prNumber), '--do', 'rebase'], aEnv); break; }
				catch (e) {
					const transient = /\b(405|429|5\d\d)\b|try again later/i.test(String(e.message));
					if (!transient || attempt >= 5) throw e;
					report('merging', `merge not ready yet (attempt ${attempt}/5); retrying`, { pr: prNumber });
					await new Promise((r) => setTimeout(r, 3000 * attempt));
				}
			}
			report('merged', `MERGED #${prNumber}`, { pr: prNumber });
		});
		if (mergeBlocked) return report('changes_requested', `approved, but the merge re-gate did not go green; PR #${prNumber} left open. ${mergeBlocked}`, { pr: prNumber, agentPid: null });
	} catch (e) {
		report('failed', `FAILED: ${e.message}`, { agentPid: null });
		console.error(`[${t.id}] FAILED: ${e.message}`);
	} finally {
		try {
			run('node', [join(BIN_DIR, 'worktree.mjs'), 'remove', t.id]);
		} catch {}
	}
}

// One worker per runner slot (cap slots per runner). Each pulls the next ticket off a
// shared queue and authors it with its own harness+model, so a harness runs at most its
// cap tickets at once and the total in flight is the sum of caps.
async function poolRunners(items) {
	const q = items.map((t, i) => [t, i]);
	const worker = (runner) => async () => {
		for (;;) {
			const next = q.shift();
			if (!next) return;
			await processTicket(next[0], next[1], null, runner);
		}
	};
	const workers = [];
	for (const r of RUNNERS) for (let k = 0; k < r.cap; k++) workers.push(worker(r));
	await Promise.all(workers.map((w) => w()));
}

// Resume a run that died (killed, crashed, OOM). Re-processes only its non-terminal
// tickets, continuing the SAME run/board. Each such ticket resumes from the author it
// died on and, if that author's PR was already pushed, jumps straight back to the
// review panel on the last-pushed commit rather than throwing the attempt away.
async function resumeRun(argRunId) {
	const runId = argRunId || latestUnfinishedRunId();
	if (!runId) return console.log('resume: no unfinished run found.');
	RUN_ID = runId; // continue the SAME run/board, not a new one
	const specPath = join(STATE_DIR, `tickets-${runId}.json`);
	if (!existsSync(specPath)) {
		console.error(`resume: no ticket spec at ${specPath}; cannot resume ${runId}.`);
		process.exitCode = 1;
		return;
	}
	const spec = JSON.parse(readFileSync(specPath, 'utf8'));
	const dbRun = getRun(runId);
	const TERMINALS = ['approved', 'merged', 'changes_requested', 'failed', 'skipped'];
	const pending = spec.map((t, i) => ({ t, i })).filter(({ t }) => {
		const st = dbRun && dbRun.tickets.find((x) => x.id === t.id);
		return !st || !TERMINALS.includes(st.stage);
	});
	console.log(`resume ${runId}: ${pending.length} unfinished of ${spec.length} ticket(s), roster [${AGENTS.join(', ')}]\n`);
	const q = [...pending];
	const worker = async () => {
		for (;;) {
			const item = q.shift();
			if (!item) return;
			const st = (dbRun && dbRun.tickets.find((x) => x.id === item.t.id)) || {};
			const resume = st.author ? { author: st.author, pr: st.pr ?? null } : null;
			await processTicket(item.t, item.i, resume);
		}
	};
	await Promise.all(Array.from({ length: Math.min(TOTAL_CAP || 1, pending.length || 1) }, worker));
	console.log('\ncoordinator: resume done.');
	emit({ done: true });
}

if (argv[0] === 'resume') {
	await resumeRun(argv[1]);
} else if (argv[0] === 'retry') {
	// Re-run ONE ticket inside its EXISTING run (same runId/board) with no new run row and
	// no done marker, so sibling tickets stay visible and the run is not ended by a retry.
	const runId = argv[1], ticketId = argv[2];
	RUN_ID = runId;
	const specPath = join(STATE_DIR, `tickets-${runId}.json`);
	if (!existsSync(specPath)) { console.error(`retry: no ticket spec for run ${runId}`); process.exitCode = 1; }
	else {
		const spec = JSON.parse(readFileSync(specPath, 'utf8'));
		const idx = spec.findIndex((t) => t.id === ticketId);
		if (idx < 0) { console.error(`retry: ${ticketId} not in run ${runId}`); process.exitCode = 1; }
		else {
			const t = spec[idx];
			// Resume from the ticket's existing PR when it has one: a flaked or changes_requested
			// ticket already has gate-green work pushed, so re-review that (processTicket's resume
			// path loads the pushed commit and goes straight to the panel) instead of throwing the
			// hours of authoring away. `--fresh` forces a clean re-author; no PR also means fresh.
			const prior = argv.includes('--fresh') ? null : (getRun(runId)?.tickets || []).find((x) => x.id === ticketId);
			const resume = prior && prior.pr ? { author: prior.author, pr: prior.pr } : null;
			const startAuthor = resume ? resume.author : authorFor(idx);
			console.log(`coordinator: retry ${ticketId} in run ${runId}${resume ? ` (resume PR #${resume.pr} at review, author ${resume.author})` : ' (fresh author)'}, runners [${RUNNERS.map((r) => `${r.harness}/${r.model || 'default'}`).join(', ')}]\n`);
			emit({ ticket: t.id, title: t.title, author: startAuthor, reviewer: panelOf(startAuthor, null).join('+'), stage: 'queued', scope: t.scope });
			await processTicket(t, idx, resume, RUNNERS[0] || null);
			console.log(`\ncoordinator: retry of ${ticketId} done.`);
		}
	}
} else {
	const tickets = JSON.parse(readFileSync(argv[1] || 'tickets.json', 'utf8'));
	console.log(`coordinator: ${tickets.length} tickets, ${MODE}, parallel ${TOTAL_CAP}, runners [${RUNNERS.map((r) => `${r.harness}/${r.model || 'default'}x${r.cap}`).join(', ')}]${NO_MERGE ? ', no-merge' : ''}\n`);
	if (!GO && !SIM) {
		// DRY RUN: print the plan only. It must NOT write the live board -
		// a preview overwriting a finished run's results left two dead "queued" rows once.
		for (const [i, t] of tickets.entries()) {
			console.log(`# ${t.id} "${t.title}"  author=${authorFor(i)} reviewer=${panelOf(authorFor(i), null).join('+')} scope=${t.scope}`);
		}
		console.log('\ndry run: pass --go (real agents) or --sim (scripted) to execute.');
	} else {
		// A run row + board writes happen only here (executing), never on a dry-run.
		startRun({ runId: RUN_ID, mode: MODE, max: TOTAL_CAP, startedAt: Date.now() });
		// Persist the spec so `resume <runId>` can recover prompts after a crash/kill.
		writeFileSync(join(STATE_DIR, `tickets-${RUN_ID}.json`), JSON.stringify(tickets, null, 2));
		// Seed the board so the dashboard shows the plan immediately, then run.
		for (const [i, t] of tickets.entries())
			emit({ ticket: t.id, title: t.title, author: authorFor(i), reviewer: panelOf(authorFor(i), null).join('+'), stage: 'queued', scope: t.scope });
		await poolRunners(tickets);
		console.log('\ncoordinator: done.');
		emit({ done: true }); // marks the run done in the DB (also a /api/runs end marker)
	}
}
