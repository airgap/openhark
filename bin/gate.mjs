import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Shared by authoring and the final merge re-gate. A missing or failed check is
// red; only a successfully executed check may authorize the next pipeline step.
export function runGateCapture(wt, env) {
	try {
		const output = execFileSync('bash', [fileURLToPath(new URL('./gate.sh', import.meta.url))], {
			cwd: wt, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: 'pipe',
		});
		return { ok: true, output };
	} catch (e) {
		return { ok: false, output: `${e.stdout || ''}\n${e.stderr || e.message || ''}`.trim() };
	}
}
