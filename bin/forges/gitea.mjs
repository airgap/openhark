// Gitea forge backend. All host/repo/token come from the environment:
//   GITEA_API   full repos base, e.g. https://gitea.example.com/api/v1/repos/OWNER/REPO
//               (or set GITEA_BASE + GITEA_REPO and it is assembled)
//   GITEA_BASE  host, default https://gitea.example.com   GITEA_REPO  owner/repo
//   token       GIT_PAT_<AGENT> (per-agent, for cross-review) else GIT_PAT else GITEA_TOKEN
//
// Exposes the uniform forge contract (open/list/get/reviews/review/merge) that
// forge.mjs dispatches to; get() is normalized to the shared PR shape.
const API = (() => {
	if (process.env.GITEA_API) return process.env.GITEA_API.replace(/\/$/, '');
	const base = (process.env.GITEA_BASE || 'https://gitea.example.com').replace(/\/$/, '');
	const repo = process.env.GITEA_REPO || 'OWNER/REPO';
	return `${base}/api/v1/repos/${repo}`;
})();

function token() {
	const a = (process.env.AGENT || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
	const t = (a && process.env[`GIT_PAT_${a}`]) || process.env.GIT_PAT || process.env.GITEA_TOKEN;
	if (!t) throw new Error('no Gitea token (set AGENT + GIT_PAT_<AGENT>, or GIT_PAT / GITEA_TOKEN)');
	return t;
}

async function call(method, path, body) {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: { Authorization: `token ${token()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(15000), // a stalled forge connection must abort, never hang forever
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
	return text ? JSON.parse(text) : {};
}

const norm = (p) => ({ number: p.number, state: p.state, merged: !!p.merged, mergeable: p.mergeable, title: p.title, head: { ref: p.head && p.head.ref }, base: { ref: p.base && p.base.ref } });
const need = (flags, k) => { if (flags[k] === undefined) throw new Error(`--${k} required`); return flags[k]; };
// Gitea uses APPROVED where GitHub uses APPROVE; accept either from the caller.
const eventMap = { APPROVE: 'APPROVED', APPROVED: 'APPROVED', REQUEST_CHANGES: 'REQUEST_CHANGES', COMMENT: 'COMMENT' };

export async function open(flags) {
	try {
		return await call('POST', '/pulls', { head: need(flags, 'head'), base: flags.base || 'main', title: need(flags, 'title'), body: flags.body || '' });
	} catch (e) {
		// A branch that already has an open PR (a retry of the same ticket) reuses it.
		if (!/already exist|pull request|4(09|22)/i.test(String(e.message))) throw e;
		const list = await call('GET', `/pulls?state=open&limit=50`);
		const existing = Array.isArray(list) ? list.find((p) => p.head && p.head.ref === flags.head) : null;
		if (existing) return existing;
		throw e;
	}
}
export const list = (flags) => call('GET', `/pulls?state=${flags.state || 'open'}&limit=50`);
export const get = async (flags) => norm(await call('GET', `/pulls/${need(flags, 'pr')}`));
export const reviews = (flags) => call('GET', `/pulls/${need(flags, 'pr')}/reviews`);
export const review = (flags) => call('POST', `/pulls/${need(flags, 'pr')}/reviews`, { event: eventMap[need(flags, 'event')] || need(flags, 'event'), body: flags.body || '' });
export async function merge(flags) {
	try {
		return await call('POST', `/pulls/${need(flags, 'pr')}/merge`, { Do: flags.do || 'rebase', delete_branch_after_merge: true });
	} catch (e) {
		if (/already merged/i.test(String(e.message))) return { merged: true, alreadyMerged: true };
		throw e;
	}
}
