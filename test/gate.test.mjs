import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGateCapture } from '../bin/gate.mjs';

function fixture(t, manifest) {
	const root = mkdtempSync(join(tmpdir(), 'openhark-gate-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// Do not inherit a user's configured gate or another repository's git context.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'OPENHARK_GATE'));
	execFileSync('git', ['init', '--quiet', root], { env });
	if (manifest !== undefined) writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
	const nested = join(root, 'nested');
	mkdirSync(nested);
	return { root, nested, env };
}

test('missing checks fail the same gate used by the merge coordinator', (t) => {
	const { root, env } = fixture(t);
	const result = runGateCapture(root, env);
	assert.equal(result.ok, false);
	assert.match(result.output, /FAIL no check configured/);
	assert.doesNotMatch(result.output, /PASS/);
});

for (const script of [undefined, '', ' \t ', 42]) {
	test(`an unusable npm test script (${JSON.stringify(script)}) cannot approve a merge`, (t) => {
		const { root, env } = fixture(t, { scripts: { test: script } });
		assert.equal(runGateCapture(root, { ...env, OPENHARK_GATE: '' }).ok, false);
	});
}

test('explicit passing command takes precedence and runs at the target root', (t) => {
	const { root, nested, env } = fixture(t, { scripts: { test: 'exit 29' } });
	writeFileSync(join(root, 'check-marker'), 'present');
	const result = runGateCapture(nested, { ...env, OPENHARK_GATE: 'test -f check-marker' });
	assert.equal(result.ok, true, result.output);
	assert.match(result.output, /running OPENHARK_GATE/);
	assert.match(result.output, /gate: PASS/);
});

test('explicit failing command cannot fall back to a passing npm check', (t) => {
	const { root, env } = fixture(t, { scripts: { test: 'exit 0' } });
	const result = runGateCapture(root, { ...env, OPENHARK_GATE: 'echo configured-failure >&2; exit 23' });
	assert.equal(result.ok, false);
	assert.match(result.output, /configured-failure/);
	assert.doesNotMatch(result.output, /PASS|running npm test/);
});

test('whitespace-only explicit command is rejected even with a passing fallback', (t) => {
	const { root, env } = fixture(t, { scripts: { test: 'exit 0' } });
	const result = runGateCapture(root, { ...env, OPENHARK_GATE: ' \n\t ' });
	assert.equal(result.ok, false);
	assert.match(result.output, /must contain a check command/);
});

for (const exit of [0, 17]) {
	test(`npm fallback ${exit === 0 ? 'passes' : 'fails'} with the test command`, (t) => {
		const { root, env } = fixture(t, { scripts: { test: `exit ${exit}` } });
		const result = runGateCapture(root, env);
		assert.equal(result.ok, exit === 0, result.output);
		assert.match(result.output, /running npm test/);
		assert.equal(result.output.includes('gate: PASS'), exit === 0);
	});
}
