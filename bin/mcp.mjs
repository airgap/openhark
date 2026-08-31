#!/usr/bin/env node
// openhark MCP server: exposes the agent swarm (runs, backlog, launch, retry, runner config) as MCP
// tools. It is a thin stdio wrapper over the local dashboard HTTP API (dashboard.mjs on
// 127.0.0.1:5400), reusing the server's own token file so no credentials are needed. Register in
// .mcp.json:
//   "openhark": { "type": "stdio", "command": "node", "args": ["<path>/bin/mcp.mjs"] }
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './env.mjs';

const BASE = (process.env.OPENHARK_URL || process.env.HARKNESS_URL || 'http://127.0.0.1:5400').replace(/\/$/, '');
const readToken = () => {
	if (process.env.OPENHARK_TOKEN || process.env.DASH_TOKEN) return process.env.OPENHARK_TOKEN || process.env.DASH_TOKEN;
	try {
		return readFileSync(join(STATE_DIR, 'token'), 'utf8').trim();
	} catch {
		return '';
	}
};

async function api(method, path, body) {
	const token = readToken();
	const headers = { accept: 'application/json' };
	if (token) headers['x-swarm-token'] = token;
	if (body) headers['content-type'] = 'application/json';
	let res;
	try {
		res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
	} catch (e) {
		throw new Error(`openhark server unreachable at ${BASE} (${e.message}). Start it with: node bin/dashboard.mjs (or bin/serve.sh)`);
	}
	const text = await res.text();
	let json = {};
	try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
	if (!res.ok) throw new Error(json.error || `HTTP ${res.status}: ${text.slice(0, 300)}`);
	return json;
}
// MCP tool result helpers: text is the model-facing payload.
const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `error: ${e.message || e}` }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args || {})); } catch (e) { return fail(e); } };

// A compact ticket view so the model is not flooded by the full event stream.
const ticketBrief = (t) => ({ id: t.id, stage: t.stage, author: t.author, reviewer: t.reviewer, pr: t.pr || null, agentPid: t.agentPid || null, detail: (t.detail || '').slice(0, 200) });

const server = new McpServer({ name: 'openhark', version: '0.1.0' });

server.registerTool('openhark_state', { description: 'Current run with its tickets and stages, open PRs, the swarm runner config, and tracker/autobatch status.', inputSchema: {} }, wrap(async () => {
	const s = await api('GET', '/api/state');
	return {
		run: s.run ? { runId: s.run.runId, mode: s.run.mode, done: s.run.done, tickets: (s.run.tickets || []).map(ticketBrief) } : null,
		prs: Array.isArray(s.prs) ? s.prs.map((p) => ({ number: p.number, title: p.title, head: p.head?.ref })) : s.prs,
		swarm: s.swarm,
		harnessMeta: s.harnessMeta,
		autobatch: s.autobatch,
		tracker: s.tracker,
	};
}));

server.registerTool('openhark_runs', { description: 'Recent runs (newest first) with ticket/merged/failed counts and running status.', inputSchema: {} }, wrap(async () => (await api('GET', '/api/runs')).runs));

server.registerTool('openhark_backlog', { description: 'Open tickets from the tracker (needs the tracker connected in the dashboard). Returns id, title, status.', inputSchema: { refresh: z.boolean().optional().describe('bypass the 5-minute cache') } }, wrap(async ({ refresh }) => {
	const r = await api('GET', '/api/backlog' + (refresh ? '?refresh=1' : ''));
	if (r.error) throw new Error(r.error);
	return r.tickets;
}));

server.registerTool('openhark_ticket', { description: "A ticket's full spec (prompt, scope), recent timeline events, and the tail of its agent log.", inputSchema: { id: z.string().describe('ticket id, e.g. 42') } }, wrap(async ({ id }) => {
	const [spec, events, log] = await Promise.all([
		api('GET', '/api/ticket?id=' + encodeURIComponent(id)).catch(() => ({})),
		api('GET', '/api/events?ticket=' + encodeURIComponent(id)).catch(() => ({ events: [] })),
		api('GET', '/api/log?ticket=' + encodeURIComponent(id)).catch(() => ({ log: '' })),
	]);
	return { id, spec: spec.spec || {}, events: (events.events || []).slice(-40), log: (log.log || '').slice(-4000) };
}));

server.registerTool('openhark_launch', { description: 'Launch a run over the given tickets using the configured runners. Each ticket needs an id; title/scope/prompt are optional (a default prompt is built).', inputSchema: {
	tickets: z.array(z.object({ id: z.string(), title: z.string().optional(), scope: z.string().optional(), prompt: z.string().optional() })).min(1),
	mode: z.enum(['go', 'sim', 'dry']).optional().describe('go = real agents + auto-merge (default), sim = scripted, dry = plan only'),
	noMerge: z.boolean().optional(),
} }, wrap(async ({ tickets, mode = 'go', noMerge }) => {
	const list = tickets.map((t) => ({ id: t.id, title: t.title || '', scope: t.scope || '', prompt: t.prompt || `Read ticket ${t.id} (${t.title || ''}) in the tracker and implement it, strictly within ${t.scope || 'the relevant files'}.` }));
	return api('POST', '/api/run', { tickets: list, go: mode === 'go', sim: mode === 'sim', noMerge: !!noMerge });
}));

server.registerTool('openhark_retry', { description: 'Re-run one ticket inside its current run (does not start a new run or hide siblings).', inputSchema: { id: z.string() } }, wrap(async ({ id }) => api('POST', '/api/retry', { id })));

server.registerTool('openhark_merge', { description: 'Merge an open PR (rebase by default).', inputSchema: { pr: z.number(), do: z.enum(['rebase', 'rebase-merge', 'squash', 'merge']).optional() } }, wrap(async ({ pr, do: doo }) => api('POST', '/api/pr/merge', { pr, do: doo || 'rebase' })));

server.registerTool('openhark_kill', { description: "Kill a single agent by pid, or a whole run's process group by runId.", inputSchema: { pid: z.number().optional(), runId: z.string().optional() } }, wrap(async ({ pid, runId }) => {
	if (pid == null && !runId) throw new Error('pass pid or runId');
	return api('POST', '/api/kill', pid != null ? { pid } : { runId });
}));

server.registerTool('openhark_swarm', { description: 'Get the runner matrix, or set it by passing runners. Each runner is {harness, model, cap, enabled}; total parallelism is the sum of enabled caps. Harnesses/models come from openhark_state.harnessMeta.', inputSchema: {
	runners: z.array(z.object({ harness: z.string(), model: z.string().optional(), cap: z.number(), enabled: z.boolean().optional() })).optional().describe('omit to just read the current config'),
} }, wrap(async ({ runners }) => {
	if (!runners) return (await api('GET', '/api/state')).swarm;
	return api('POST', '/api/swarm', { runners });
}));

server.registerTool('openhark_autobatch', { description: 'Read or change the keep-fed autobatch daemon (launches a fresh disjoint batch whenever the pipeline is free).', inputSchema: { on: z.boolean().optional(), mode: z.enum(['go', 'sim', 'dry']).optional() } }, wrap(async ({ on, mode }) => {
	if (on === undefined && mode === undefined) return (await api('GET', '/api/state')).autobatch;
	return api('POST', '/api/autobatch', { ...(on !== undefined ? { on } : {}), ...(mode ? { mode } : {}) });
}));

server.registerTool('openhark_suggest', { description: 'Ask the planner to pick up to `max` open backlog tickets with disjoint file scopes (returns them; does not launch).', inputSchema: { max: z.number().optional() } }, wrap(async ({ max }) => (await api('POST', '/api/suggest', max ? { max } : {})).tickets));

server.registerTool('openhark_discover', { description: 'Re-run harness/model discovery (after installing a CLI or changing models).', inputSchema: {} }, wrap(async () => (await api('POST', '/api/discover')).harnessMeta));

await server.connect(new StdioServerTransport());
