#!/usr/bin/env bash
# The per-merge LOCAL gate: the merge guarantee. Both the author agent and the reviewer run this
# green before a PR merges, and the coordinator re-runs it after rebasing onto main. What "green"
# means is your call: set OPENHARK_GATE to the command that proves a change is safe for your repo
# (tests, typecheck, lint, build). It runs in the worktree being gated.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -n "${OPENHARK_GATE:-}" ]; then
	echo "gate: running OPENHARK_GATE"
	bash -c "$OPENHARK_GATE"
	echo "gate: PASS"
	exit 0
fi

# Fall back to `npm test` when the repo defines a test script, so a Node project works out of the box.
if [ -f package.json ] && node -e 'process.exit(require("./package.json").scripts&&require("./package.json").scripts.test?0:1)' 2>/dev/null; then
	echo "gate: running npm test (set OPENHARK_GATE to override)"
	npm test
	echo "gate: PASS"
	exit 0
fi

echo "gate: WARNING no gate configured; set OPENHARK_GATE to a real check. Passing by default." >&2
echo "gate: PASS (no-op)"
