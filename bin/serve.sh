#!/usr/bin/env bash
# Launch the openhark dashboard as a resilient systemd --user unit (survives the session). Pass
# OPENHARK_TOKEN (or DASH_TOKEN) in the env to pin the break-glass token; otherwise the server
# persists/mints one in the state dir (which the TUI reads).
set -euo pipefail
BIN="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
NODE="$(command -v node)"
UNIT=openhark-server
systemctl --user stop "$UNIT" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
# A stopped transient unit can linger 'loaded' for a moment, and systemd-run refuses to start over a
# loaded unit, so wait for it to unload; if the fragment persists, remove it and reload.
loadstate() { systemctl --user show "$UNIT" -p LoadState --value 2>/dev/null; }
for _ in $(seq 1 10); do [ "$(loadstate)" = "not-found" ] && break; sleep 0.5; done
if [ "$(loadstate)" != "not-found" ]; then
	frag="$(systemctl --user show "$UNIT" -p FragmentPath --value 2>/dev/null)"
	[ -n "$frag" ] && rm -f "$frag"
	systemctl --user daemon-reload
fi
# KillMode=process: a stop/restart signals only the dashboard process, so detached coordinators it
# spawned (in this unit's cgroup) survive a restart for a code change.
ARGS=(--user --unit="$UNIT" --collect --property=KillMode=process --working-directory="$BIN")
[ -n "${OPENHARK_TOKEN:-}" ] && ARGS+=(--setenv=DASH_TOKEN="$OPENHARK_TOKEN")
[ -n "${DASH_TOKEN:-}" ] && ARGS+=(--setenv=DASH_TOKEN="$DASH_TOKEN")
[ -n "${OPENHARK_TARGET:-}" ] && ARGS+=(--setenv=OPENHARK_TARGET="$OPENHARK_TARGET")
[ -n "${OPENHARK_STATE:-}" ] && ARGS+=(--setenv=OPENHARK_STATE="$OPENHARK_STATE")
systemd-run "${ARGS[@]}" "$NODE" "$BIN/dashboard.mjs"
echo "openhark-server (systemd --user) -> http://127.0.0.1:5400  (survives this session)"
