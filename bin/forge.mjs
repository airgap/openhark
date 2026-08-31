#!/usr/bin/env node
// Forge dispatcher. `node forge.mjs <sub> [--flags]`, sub in open|list|get|reviews|review|merge.
// Selects the backend from OPENHARK_FORGE (github|gitea, default github) and prints JSON. This is
// the single seam the coordinator and dashboard call, so switching forges never touches them.
//
//   node forge.mjs open   --head <branch> --title <t> [--body <b>] [--base main]
//   node forge.mjs list   [--state open]
//   node forge.mjs get    --pr <n>
//   node forge.mjs review --pr <n> --event APPROVE|REQUEST_CHANGES|COMMENT [--body <b>]
//   node forge.mjs merge  --pr <n> [--do rebase|squash|merge]
const argv = process.argv.slice(2);
const action = argv[0];
const flags = {};
for (let i = 1; i < argv.length; i++) {
	if (argv[i].startsWith('--')) {
		const k = argv[i].slice(2);
		const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
		flags[k] = v;
	}
}

const which = (process.env.OPENHARK_FORGE || 'github').toLowerCase();
const backends = { github: './forges/github.mjs', gitea: './forges/gitea.mjs' };
if (!backends[which]) { console.error(`unknown OPENHARK_FORGE '${which}' (github|gitea)`); process.exit(2); }

const backend = await import(new URL(backends[which], import.meta.url));
const fn = backend[action];
if (typeof fn !== 'function') { console.error('usage: forge.mjs open|list|get|reviews|review|merge [--flags]'); process.exit(2); }
try {
	const r = await fn(flags);
	console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
} catch (e) {
	console.error(String(e.message || e));
	process.exit(1);
}
