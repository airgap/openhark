#!/usr/bin/env bash
# Launch the coordinator resiliently, so a session/harness kill cannot reap the run, with a stable
# run id so `resume` can recover it. Prefers a transient systemd --user unit; falls back to setsid.
# All args pass through to coordinator.mjs, e.g.:
#   bash launch.sh run <tickets.json> --go --no-merge --max=1
#   bash launch.sh resume <runId>
set -euo pipefail
BIN="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
STATE="${OPENHARK_STATE:-$HOME/.openhark}"; mkdir -p "$STATE/logs"
RUN_ID="${COORD_RUN_ID:-$(date +%s)}"
LOG="$STATE/logs/run-$RUN_ID.log"
NODE="$(command -v node)"

EXTRA=()
[ -n "${SWARM_RUNNERS_JSON:-}" ] && EXTRA+=(--setenv=SWARM_RUNNERS_JSON="$SWARM_RUNNERS_JSON")
[ -n "${SWARM_AGENTS:-}" ] && EXTRA+=(--setenv=SWARM_AGENTS="$SWARM_AGENTS")
[ -n "${OPENHARK_TARGET:-}" ] && EXTRA+=(--setenv=OPENHARK_TARGET="$OPENHARK_TARGET")
[ -n "${OPENHARK_STATE:-}" ] && EXTRA+=(--setenv=OPENHARK_STATE="$OPENHARK_STATE")
if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
	UNIT="openhark-run-$RUN_ID"
	systemctl --user reset-failed "$UNIT" 2>/dev/null || true
	systemd-run --user --unit="$UNIT" --collect \
		--setenv=COORD_RUN_ID="$RUN_ID" --setenv=PATH="$PATH" "${EXTRA[@]}" \
		bash -c "exec '$NODE' '$BIN/coordinator.mjs' \"\$@\" > '$LOG' 2>&1" bash "$@"
	echo "runId=$RUN_ID  unit=$UNIT  log=$LOG  (systemd --user; survives this session)"
else
	setsid bash -c 'PIDF=$1; shift; NODE=$1; shift; BIN=$1; shift; echo $$ > "$PIDF"; exec "$NODE" "$BIN/coordinator.mjs" "$@"' bash "$STATE/run-$RUN_ID.pid" "$NODE" "$BIN" "$@" > "$LOG" 2>&1 < /dev/null &
	disown || true
	echo "runId=$RUN_ID  log=$LOG  (setsid fallback)"
fi
