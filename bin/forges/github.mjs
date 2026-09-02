// GitHub forge backend. Repo from GITHUB_REPO (owner/repo) else parsed from the target
// repo's origin remote. Requests use a token when present (GIT_PAT_<AGENT> for per-agent
// identity, else GITHUB_TOKEN); with no token they shell out to `gh api`, which carries
// gh's own auth. Note GitHub blocks approving your OWN pull request, so real cross-review
// needs a DISTINCT identity per reviewer (a separate GIT_PAT_<AGENT> or a GitHub App);
// a single token still drives solo self-review + the gated auto-merge.
import { execFileSync } from 'node:child_process';
import { targetRoot } from '../env.mjs';

function repo() {
	if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
	try {
		const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: targetRoot(), encoding: 'utf8' }).trim();
		const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
		if (m) return m[1];
	} catch {}
	throw new Error('set GITHUB_REPO=owner/repo (or give the target repo a github origin remote)');
}

function token() {
	const a = (process.env.AGENT || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
	return (a && process.env[`GIT_PAT_${a}`]) || process.env.GITHUB_TOKEN || null;
}

async function call(method, path, body) {
	const t = token();
	if (t) {
		const res = await fetch(`https://api.github.com${path}`, {
			method,
			headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'openhark' },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(15000), // a stalled forge connection must abort, never hang forever
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
		return text ? JSON.parse(text) : {};
	}
	// No token: use the gh CLI, which handles auth itself.
	const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
	const opts = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
	if (body) { args.push('--input', '-'); opts.input = JSON.stringify(body); }
	let out;
	try { out = execFileSync('gh', args, opts); }
	catch (e) { throw new Error(`gh api ${method} ${path} -> ${String((e.stdout || '') + (e.stderr || '') || e.message).slice(0, 400)}`); }
	return out ? JSON.parse(out) : {};
}

const R = () => `/repos/${repo()}`;
const norm = (p) => ({ number: p.number, state: p.merged ? 'merged' : p.state, merged: !!p.merged, mergeable: p.mergeable, title: p.title, head: { ref: p.head && p.head.ref }, base: { ref: p.base && p.base.ref } });
const need = (flags, k) => { if (flags[k] === undefined) throw new Error(`--${k} required`); return flags[k]; };
// The old Gitea flow says APPROVED; GitHub wants APPROVE. Accept both.
const eventMap = { APPROVE: 'APPROVE', APPROVED: 'APPROVE', REQUEST_CHANGES: 'REQUEST_CHANGES', COMMENT: 'COMMENT' };
const mergeMethod = { rebase: 'rebase', 'rebase-merge': 'rebase', squash: 'squash', merge: 'merge' };

export async function open(flags) {
	try {
		return await call('POST', `${R()}/pulls`, { head: need(flags, 'head'), base: flags.base || 'main', title: need(flags, 'title'), body: flags.body || '' });
	} catch (e) {
		if (!/already exists|422/i.test(String(e.message))) throw e;
		const list = await call('GET', `${R()}/pulls?state=open&per_page=100`);
		const existing = Array.isArray(list) ? list.find((p) => p.head && p.head.ref === flags.head) : null;
		if (existing) return existing;
		throw e;
	}
}
export const list = (flags) => call('GET', `${R()}/pulls?state=${flags.state || 'open'}&per_page=100`);
export const get = async (flags) => norm(await call('GET', `${R()}/pulls/${need(flags, 'pr')}`));
export const reviews = (flags) => call('GET', `${R()}/pulls/${need(flags, 'pr')}/reviews`);
export const review = (flags) => call('POST', `${R()}/pulls/${need(flags, 'pr')}/reviews`, { event: eventMap[need(flags, 'event')] || need(flags, 'event'), body: flags.body || '' });
export async function merge(flags) {
	const n = need(flags, 'pr');
	// A second merge attempt on an already-merged PR is a success, not an error.
	const cur = await call('GET', `${R()}/pulls/${n}`).catch(() => null);
	if (cur && cur.merged) return { merged: true, alreadyMerged: true };
	return call('PUT', `${R()}/pulls/${n}/merge`, { merge_method: mergeMethod[flags.do] || 'rebase' });
}
