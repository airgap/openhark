// Tracker adapters. The swarm reads its backlog and transitions merged tickets through one small
// interface, so GitHub Issues is just one implementation and Jira / Asana / a custom HTTP source sit
// behind the same shape. Selection (which tracker, which projects) lives in the dashboard config.
//
// Interface (all async unless noted):
//   name                                          string id of the adapter
//   capabilities                                  Set<string> of the methods that actually work
//   listProjects()                             -> [{ key, id, name }]
//   listBacklog({ projectKeys, excludeLabels }) -> [{ id, key, rawId, projectKey, title, status, labels }]
//                                                 (open items only; rows carrying an excluded
//                                                  label are dropped; labels are lowercased names)
//   transition(rawId, toType='completed')      -> void  (move a ticket to its done status)
//   getTicket(idOrKey)                          -> raw detail object (or null)
//
// rawId is the tracker's own id used for writes; key is the human id. The reconcile matches merged
// commits by key and writes by rawId, so listBacklog returns both.
import { execFileSync } from 'node:child_process';
import { targetRoot } from './env.mjs';

const norm = (s) => String(s || '').trim().toLowerCase();
const labelName = (l) => (typeof l === 'string' ? l : l && l.name) || '';
// Uniform label filter so every adapter honours excludeLabels the same way, whether or not the
// source already filtered.
const dropExcluded = (rows, excludeLabels = []) => {
	if (!excludeLabels.length) return rows;
	const ex = new Set(excludeLabels.map(norm));
	return rows.filter((r) => !(r.labels || []).some((l) => ex.has(norm(labelName(l)))));
};

// --- GitHub Issues -----------------------------------------------------------
// Open issues are the backlog; a merged ticket's issue is closed on reconcile. Uses GITHUB_TOKEN
// when present, else the gh CLI's own auth. Repo from GITHUB_REPO (owner/repo) else the target
// repo's github origin remote. "Projects" maps to the single configured repo.
function githubRepo() {
	if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
	try {
		const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: targetRoot(), encoding: 'utf8' }).trim();
		const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
		if (m) return m[1];
	} catch {}
	throw new Error('set GITHUB_REPO=owner/repo (or give the target repo a github origin remote)');
}
async function ghCall(method, path, body) {
	const token = process.env.GITHUB_TOKEN;
	if (token) {
		const res = await fetch(`https://api.github.com${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'openhark' },
			body: body ? JSON.stringify(body) : undefined,
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : {};
	}
	const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
	const opts = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
	if (body) { args.push('--input', '-'); opts.input = JSON.stringify(body); }
	const out = execFileSync('gh', args, opts);
	return out ? JSON.parse(out) : {};
}
export function githubAdapter() {
	const repo = () => githubRepo();
	return {
		name: 'github',
		capabilities: new Set(['listProjects', 'listBacklog', 'transition', 'getTicket', 'labels']),
		listProjects: async () => { const r = repo(); return [{ key: r.toUpperCase(), id: r, name: r }]; },
		async listBacklog({ projectKeys, excludeLabels = [] } = {}) {
			const r = repo();
			const want = projectKeys && projectKeys.length ? new Set(projectKeys.map((k) => String(k).toUpperCase())) : null;
			if (want && !want.has(r.toUpperCase())) return [];
			const issues = await ghCall('GET', `/repos/${r}/issues?state=open&per_page=100`);
			const out = [];
			for (const it of Array.isArray(issues) ? issues : []) {
				if (it.pull_request) continue; // the issues endpoint also returns PRs
				const key = String(it.number);
				out.push({ id: key, key, rawId: key, projectKey: r.toUpperCase(), title: it.title || '', status: it.state || 'open', labels: (it.labels || []).map((l) => norm(labelName(l))) });
			}
			return dropExcluded(out, excludeLabels);
		},
		async transition(rawId) { await ghCall('PATCH', `/repos/${repo()}/issues/${rawId}`, { state: 'closed' }); },
		getTicket: (idOrKey) => ghCall('GET', `/repos/${repo()}/issues/${String(idOrKey).replace(/^#/, '')}`).catch(() => null),
	};
}

// Scaffolds. Each declares the config it needs and how each interface method maps onto the
// provider's API, then throws until wired, so the seam is real and finishing one is a filling-in
// exercise rather than a redesign. capabilities is empty so the reconcile/UI degrade gracefully.
const scaffold = (name, needEnv, notes) => (config = {}) => {
	const missing = needEnv.filter((k) => !config[k] && !process.env[k]);
	const fail = () => { throw new Error(`${name} adapter not configured: set ${needEnv.join(', ')} and implement its calls (${notes})`); };
	return { name, capabilities: new Set(), _missing: missing, listProjects: fail, listBacklog: fail, transition: fail, getTicket: fail };
};

// Jira Cloud: basic auth (email + API token). backlog = JQL `project = KEY AND statusCategory =
// "To Do"`; labels = issue.fields.labels; transition = POST /rest/api/3/issue/{id}/transitions.
export const jiraAdapter = scaffold('jira', ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'], 'REST /rest/api/3, JQL for backlog, /transitions for writes');
// Asana: personal access token or OAuth. backlog = tasks with completed=false; labels = tags;
// transition = PUT /tasks/{gid} completed:true.
export const asanaAdapter = scaffold('asana', ['ASANA_TOKEN'], 'REST app.asana.com/api/1.0, tags as labels, completed flag as done');
// Custom: point it at any HTTP endpoint that speaks this interface. It POSTs {method, args} to
// CUSTOM_TRACKER_URL (optional bearer CUSTOM_TRACKER_TOKEN) and expects that method's shape back.
export function customAdapter(config = {}) {
	const url = config.CUSTOM_TRACKER_URL || process.env.CUSTOM_TRACKER_URL;
	if (!url) return scaffold('custom', ['CUSTOM_TRACKER_URL'], 'POST {method,args} to your endpoint returning the interface shapes')(config);
	const token = config.CUSTOM_TRACKER_TOKEN || process.env.CUSTOM_TRACKER_TOKEN;
	const call = async (method, args) => {
		const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ method, args: args || {} }) });
		if (!r.ok) throw new Error(`custom tracker ${method} ${r.status}`);
		return r.json();
	};
	return {
		name: 'custom',
		capabilities: new Set(['listProjects', 'listBacklog', 'transition', 'getTicket', 'labels']),
		listProjects: async () => (await call('listProjects', {})) || [],
		listBacklog: async (opts = {}) => dropExcluded((await call('listBacklog', opts)) || [], opts.excludeLabels || []),
		transition: (rawId, toType = 'completed') => call('transition', { rawId, toType }),
		getTicket: (idOrKey) => call('getTicket', { idOrKey }),
	};
}

export const TRACKERS = ['github', 'jira', 'asana', 'custom'];
export function makeTracker(name, ctx = {}) {
	switch (norm(name) || 'github') {
		case 'github': return githubAdapter(ctx);
		case 'jira': return jiraAdapter(ctx.config || {});
		case 'asana': return asanaAdapter(ctx.config || {});
		case 'custom': return customAdapter(ctx.config || {});
		default: throw new Error(`unknown tracker '${name}' (known: ${TRACKERS.join(', ')})`);
	}
}
