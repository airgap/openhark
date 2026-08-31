// Embedded-SQLite state for the swarm, shared by coordinator.mjs (writer) and
// dashboard.mjs (reader). Replaces the old current.json snapshot + <runId>.jsonl
// event logs, whose single-file-rewrite model let any invocation (even a dry-run
// preview) clobber a finished run's board. Here each ticket row is an atomic
// upsert, runs coexist, and WAL lets the server read while the coordinator writes.
//
// node:sqlite is built in (Node 22.5+), so there is no dependency to install.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, ensureStateDir } from './env.mjs';

ensureStateDir();
const DB_PATH = join(STATE_DIR, 'swarm.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
	CREATE TABLE IF NOT EXISTS runs (
		run_id TEXT PRIMARY KEY, mode TEXT, max INTEGER, started_at INTEGER, done INTEGER DEFAULT 0, updated INTEGER
	);
	CREATE TABLE IF NOT EXISTS tickets (
		run_id TEXT, id TEXT, title TEXT, author TEXT, reviewer TEXT, stage TEXT, scope TEXT,
		pr INTEGER, agent_pid INTEGER, detail TEXT, started INTEGER, updated INTEGER,
		PRIMARY KEY (run_id, id)
	);
	CREATE TABLE IF NOT EXISTS events (
		seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts INTEGER, ticket TEXT,
		stage TEXT, detail TEXT, pr INTEGER, agent_pid INTEGER, role TEXT, raw TEXT
	);
	CREATE INDEX IF NOT EXISTS ix_events_run ON events (run_id, seq);
	CREATE INDEX IF NOT EXISTS ix_runs_started ON runs (started_at DESC);
`);
// `started` was added after the first DBs existed; add it if missing, then backfill
// it from each ticket's earliest event so a settled ticket can show a frozen duration.
try {
	db.exec('ALTER TABLE tickets ADD COLUMN started INTEGER');
} catch {}
db.exec('UPDATE tickets SET started = (SELECT MIN(ts) FROM events e WHERE e.run_id = tickets.run_id AND e.ticket = tickets.id) WHERE started IS NULL');
// `rev`: the author's revision count in the blocking-review loop, added the same way.
try { db.exec('ALTER TABLE tickets ADD COLUMN rev INTEGER'); } catch {}
// `running`: JSON array of the agent keys with a live LLM right now (during review, the panel
// members that have not yet posted), so the board can shimmer each independently.
try { db.exec('ALTER TABLE tickets ADD COLUMN running TEXT'); } catch {}

const insRun = db.prepare('INSERT OR REPLACE INTO runs (run_id, mode, max, started_at, done, updated) VALUES (?, ?, ?, ?, COALESCE((SELECT done FROM runs WHERE run_id = ?), 0), ?)');
const setDone = db.prepare('UPDATE runs SET done = 1, updated = ? WHERE run_id = ?');
const insEvent = db.prepare('INSERT INTO events (run_id, ts, ticket, stage, detail, pr, agent_pid, role, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const selTicket = db.prepare('SELECT * FROM tickets WHERE run_id = ? AND id = ?');
const upsTicket = db.prepare(`
	INSERT INTO tickets (run_id, id, title, author, reviewer, stage, scope, pr, agent_pid, detail, rev, running, started, updated)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (run_id, id) DO UPDATE SET
		title = ?, author = ?, reviewer = ?, stage = ?, scope = ?, pr = ?, agent_pid = ?, detail = ?, rev = ?, running = ?, updated = ?`);

export function startRun({ runId, mode, max, startedAt }) {
	insRun.run(runId, mode ?? null, max ?? null, startedAt, runId, Date.now());
}

// Fold one emitted event: append it to the log, and (JS Object.assign semantics)
// overwrite ONLY the ticket columns present in the event, so a status update that
// carries just { stage, agentPid: null } clears the pid without wiping the title.
export function emit(runId, ev) {
	const ts = Date.now();
	writeEvent(runId, ev, ts);
}
function writeEvent(runId, ev, ts) {
	insEvent.run(runId, ts, ev.ticket ?? null, ev.stage ?? null, ev.detail ?? null, ev.pr ?? null, ev.agentPid ?? null, ev.agentRole ?? null, JSON.stringify(ev));
	if (ev.done) setDone.run(ts, runId);
	if (!ev.ticket) return;
	const r = selTicket.get(runId, ev.ticket) || { run_id: runId, id: ev.ticket, title: null, author: null, reviewer: null, stage: null, scope: null, pr: null, agent_pid: null, detail: null, rev: null, running: null, started: null };
	if ('title' in ev) r.title = ev.title ?? null;
	if ('author' in ev) r.author = ev.author ?? null;
	if ('reviewer' in ev) r.reviewer = ev.reviewer ?? null;
	if ('stage' in ev) r.stage = ev.stage ?? null;
	if ('scope' in ev) r.scope = ev.scope ?? null;
	if ('pr' in ev) r.pr = ev.pr ?? null;
	if ('agentPid' in ev) r.agent_pid = ev.agentPid ?? null;
	if ('detail' in ev) r.detail = ev.detail ?? null;
	if ('rev' in ev) r.rev = ev.rev ?? null;
	if ('running' in ev) r.running = ev.running ? JSON.stringify(ev.running) : null; // [] stored as "[]" so a tracked-empty set is distinguishable from never-tracked (null)
	upsTicket.run(runId, ev.ticket, r.title, r.author, r.reviewer, r.stage, r.scope, r.pr, r.agent_pid, r.detail, r.rev ?? null, r.running ?? null, r.started ?? ts, ts, r.title, r.author, r.reviewer, r.stage, r.scope, r.pr, r.agent_pid, r.detail, r.rev ?? null, r.running ?? null, ts);
}

const parseArr = (s) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
const ticketRow = (t) => ({ id: t.id, ticket: t.id, title: t.title, author: t.author, reviewer: t.reviewer, stage: t.stage, scope: t.scope, ...(t.pr != null ? { pr: t.pr } : {}), ...(t.agent_pid != null ? { agentPid: t.agent_pid } : {}), ...(t.rev != null ? { rev: t.rev } : {}), ...(t.running ? { running: parseArr(t.running) } : {}), detail: t.detail, started: t.started, updated: t.updated });

// The latest run and its board, shaped exactly like the old current.json.
export function currentRun() {
	const r = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get();
	if (!r) return null;
	const tickets = db.prepare('SELECT * FROM tickets WHERE run_id = ? ORDER BY rowid').all(r.run_id).map(ticketRow);
	return { runId: r.run_id, mode: r.mode, max: r.max, startedAt: r.started_at, done: !!r.done, tickets };
}

// The event history for one ticket: the narrative (stage transitions, panel verdicts,
// escalations) that the board's single current-stage cannot show. Detail-bearing
// events only - the seed and bare status pings are noise here.
export function ticketEvents(runId, ticketId, limit = 300) {
	const rows = db.prepare("SELECT ts, stage, detail, role FROM events WHERE run_id = ? AND ticket = ? AND detail IS NOT NULL AND detail != '' ORDER BY seq").all(runId, ticketId);
	return rows.slice(-limit).map((e) => ({ ts: e.ts, stage: e.stage, detail: e.detail, role: e.role }));
}

// One run by id, shaped like currentRun (for resume).
export function getRun(runId) {
	const r = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
	if (!r) return null;
	const tickets = db.prepare('SELECT * FROM tickets WHERE run_id = ? ORDER BY rowid').all(runId).map(ticketRow);
	return { runId: r.run_id, mode: r.mode, max: r.max, startedAt: r.started_at, done: !!r.done, tickets };
}
// The most recent run that still has a non-terminal ticket (a candidate to resume).
export function latestUnfinishedRunId() {
	const row = db
		.prepare(
			"SELECT r.run_id FROM runs r WHERE EXISTS (SELECT 1 FROM tickets t WHERE t.run_id = r.run_id AND t.stage NOT IN ('approved','merged','changes_requested','failed','skipped','flaky','already_done','disputed')) ORDER BY r.started_at DESC LIMIT 1",
		)
		.get();
	return row ? row.run_id : null;
}

// The persistent job history for the board: every run's tickets, newest run first and stable
// within a run (rowid order), so live rows never reorder as they update. Each row carries its
// run id + start so the detail pane can fetch that run's events/spec.
export function recentTickets(limit = 400) {
	const rows = db.prepare('SELECT t.*, r.started_at AS run_started, r.mode AS run_mode FROM tickets t JOIN runs r ON r.run_id = t.run_id ORDER BY r.started_at DESC, t.rowid ASC LIMIT ?').all(limit);
	return rows.map((t) => ({ ...ticketRow(t), runId: t.run_id, runStarted: t.run_started, runMode: t.run_mode }));
}

const TERMINAL = new Set(['merged', 'failed', 'skipped', 'changes_requested', 'approved', 'flaky', 'already_done', 'disputed']);
// Ticket ids the swarm recorded as already satisfied on main (a deliberate no-op author/revise
// determination). A merge leaves a `<ID>:` commit subject the backlog picker keys off; an already-done
// ticket (nothing to do) and a disputed one (blocked on a human to re-scope) leave none, so the picker
// reads both from here to avoid re-working them until a human deliberately re-launches.
export function noReworkTicketIds() {
	return new Set(db.prepare("SELECT DISTINCT id FROM tickets WHERE stage IN ('already_done','disputed')").all().map((r) => r.id));
}
// Recent runs, summarized. `running` here is the DB-derivable part (not marked done,
// recent activity, some non-terminal ticket); the caller ORs in its own liveness
// (a coordinator process it launched and still holds).
export function listRuns(limit = 12) {
	const rows = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
	return rows.map((r) => {
		const ts = db.prepare('SELECT stage, updated FROM tickets WHERE run_id = ?').all(r.run_id);
		const stages = ts.map((x) => x.stage);
		const ended = ts.reduce((m, x) => Math.max(m, x.updated || 0), r.started_at);
		const fresh = ended > Date.now() - 15 * 60_000;
		return {
			runId: r.run_id,
			started: r.started_at,
			ended,
			tickets: stages.length,
			merged: stages.filter((s) => s === 'merged').length,
			failed: stages.filter((s) => s === 'failed' || s === 'skipped').length,
			running: !r.done && fresh && stages.some((s) => !TERMINAL.has(s)),
		};
	});
}

// One-time import of the legacy file state so no history or the current board is
// lost on the cutover. Runs only when the DB is empty and old logs exist.
(function migrateLegacy() {
	if (db.prepare('SELECT count(*) c FROM runs').get().c > 0) return;
	let files = [];
	try {
		files = readdirSync(STATE_DIR).filter((f) => /^\d+\.jsonl$/.test(f));
	} catch {}
	if (!files.length) return;
	db.exec('BEGIN');
	try {
		for (const f of files) {
			const runId = f.replace('.jsonl', '');
			const evs = readFileSync(join(STATE_DIR, f), 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.filter(Boolean);
			if (!evs.length) continue;
			const started = Math.min(...evs.map((e) => e.t || Date.now()));
			insRun.run(runId, 'LIVE', null, started, runId, Date.now());
			for (const e of evs) writeEvent(runId, e, e.t || started);
		}
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
})();
