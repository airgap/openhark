// Shared path/config resolution for openhark.
//
// State (the SQLite db, the dashboard token, per-run logs) lives OUTSIDE any repo so
// neither openhark's own tree nor the target repo can accidentally commit it, and so a
// worktree existing under the target repo cannot break its checkout. The "target repo"
// is the one whose worktrees the agents actually work in; openhark itself is a separate
// tool that can live anywhere.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

export const STATE_DIR = process.env.OPENHARK_STATE || join(homedir(), '.openhark');
export function ensureStateDir() {
	mkdirSync(STATE_DIR, { recursive: true });
	return STATE_DIR;
}

// The repo whose branches/worktrees agents work in. Explicit OPENHARK_TARGET wins;
// otherwise the git toplevel of the current directory.
export function targetRoot(cwd = process.cwd()) {
	if (process.env.OPENHARK_TARGET) return process.env.OPENHARK_TARGET;
	return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
}

// openhark's own bin/ directory, so a coordinator can invoke its sibling scripts
// (worktree.mjs, forge.mjs, gate.sh) by absolute path regardless of where it was
// launched from or which repo it is operating on.
export const BIN_DIR = dirname(fileURLToPath(import.meta.url));
