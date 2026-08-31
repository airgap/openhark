#!/usr/bin/env node
// Per-agent git worktree lifecycle in the TARGET repo. Worktrees live under
// <target>/.openhark/worktrees/, so each agent gets its own checkout + node_modules and
// two agents never touch the same working tree.
//
//   node worktree.mjs create <agent> [baseBranch]
//   node worktree.mjs env    <agent> [index]   # prints an env block
//   node worktree.mjs remove <agent>
//   node worktree.mjs list
//
// `create` adds a worktree on a fresh branch `agent/<agent>` off origin/main and installs
// dependencies. The install command is OPENHARK_INSTALL if set, else inferred from the
// lockfile (bun/pnpm/yarn/npm). The lockfile is reset afterwards so a fresh install's churn
// is never committed.
import { execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { targetRoot } from './env.mjs';

const ROOT = targetRoot();
const WT_DIR = join(ROOT, '.openhark', 'worktrees');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
const cap = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts }).trim();

const [, , action, agent, arg] = process.argv;

// A stable per-agent port block so any dev servers an agent starts never collide.
function portBase(agent, index) {
	const idx = index !== undefined ? Number(index) : [...agent].reduce((a, c) => a + c.charCodeAt(0), 0) % 40;
	return 5300 + idx * 20;
}

function envBlock(agent, index) {
	return [`AGENT=${agent}`, `PORT_BASE=${portBase(agent, index)}`].join('\n');
}

const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const detectLock = (dir) => LOCKFILES.find((f) => existsSync(join(dir, f)));
function installCmd(lock) {
	if (process.env.OPENHARK_INSTALL) return ['bash', ['-c', process.env.OPENHARK_INSTALL]];
	if (lock === 'bun.lock' || lock === 'bun.lockb') return ['bun', ['install']];
	if (lock === 'pnpm-lock.yaml') return ['pnpm', ['install']];
	if (lock === 'yarn.lock') return ['yarn', ['install']];
	return ['npm', ['install']];
}

// Clear any leftover state for this agent: a registered worktree, a bare stale dir (left by a
// killed run - `git worktree remove` fails on that, so prune + rm), and the agent branch. Any of
// these would make a fresh `worktree add` fail. Best-effort: each step ignores its own failure.
function purge(agent, path = join(WT_DIR, agent)) {
	try { run('git', ['worktree', 'remove', '--force', path], { stdio: 'pipe' }); } catch {}
	try { run('git', ['worktree', 'prune'], { stdio: 'pipe' }); } catch {}
	try { rmSync(path, { recursive: true, force: true }); } catch {}
	try { run('git', ['branch', '-D', `agent/${agent}`], { stdio: 'pipe' }); } catch {}
}

function create(agent, baseBranch = 'origin/main') {
	if (!agent) throw new Error('agent name required');
	const path = join(WT_DIR, agent);
	purge(agent, path);
	run('git', ['fetch', '-q', 'origin', 'main']);
	const branch = `agent/${agent}`;
	run('git', ['worktree', 'add', '-b', branch, path, baseBranch]);
	if (existsSync(join(path, 'package.json'))) {
		const [cmd, args] = installCmd(detectLock(path));
		console.error(`installing deps in ${path} (${cmd} ${args.join(' ')})...`);
		// Retry: native postinstall steps occasionally throw a transient SIGBUS/SIGSEGV.
		for (let attempt = 1; ; attempt++) {
			try { run(cmd, args, { cwd: path }); break; }
			catch (e) { if (attempt >= 3) throw e; console.error(`  install crashed (attempt ${attempt}); retrying...`); }
		}
		const lock = detectLock(path);
		if (lock) { try { run('git', ['checkout', '--', lock], { cwd: path }); } catch {} }
	}
	console.error(`\nworktree ready: ${path} on ${branch}`);
	console.error(`env for this agent:\n${envBlock(agent)}`);
}

function remove(agent) {
	if (!agent) throw new Error('agent name required');
	purge(agent);
	console.error(`removed worktree + branch for ${agent}`);
}

switch (action) {
	case 'create': create(agent, arg); break;
	case 'env': console.log(envBlock(agent, arg)); break;
	case 'remove': remove(agent); break;
	case 'list': console.log(cap('git', ['worktree', 'list'])); break;
	default:
		console.error('usage: worktree.mjs create|env|remove|list <agent> [arg]');
		process.exit(2);
}
