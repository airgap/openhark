#!/usr/bin/env bash
# The per-merge LOCAL gate: the merge guarantee. Both the author agent and the reviewer run this
# green before a PR merges, and the coordinator re-runs it after rebasing onto main. What "green"
# means is your call: set OPENHARK_GATE to the command that proves a change is safe for your repo
# (tests, typecheck, lint, build). It runs in the worktree being gated.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -n "${OPENHARK_GATE:-}" ]; then
	if [[ ! "$OPENHARK_GATE" =~ [^[:space:]] ]]; then
		echo "gate: FAIL OPENHARK_GATE must contain a check command" >&2
		exit 1
	fi
	echo "gate: running OPENHARK_GATE"
	bash -c "$OPENHARK_GATE"
	echo "gate: PASS"
	exit 0
fi

# Fall back to `npm test` when the repo defines a test script, so a Node project works out of the box.
if [ -f package.json ] && node -e 'const test = require("./package.json").scripts?.test; process.exit(typeof test === "string" && test.trim() ? 0 : 1)' 2>/dev/null; then
	echo "gate: running npm test (set OPENHARK_GATE to override)"
	npm test
	echo "gate: PASS"
	exit 0
fi

echo "gate: FAIL no check configured; set OPENHARK_GATE to a real check or define an npm test script" >&2
exit 1
