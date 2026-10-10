#!/usr/bin/env bash
# The board route: the P2 image on the ISS, and MaD Control in the host's
# Chrome, every page and worker held to the board's clock by embsim's
# `chrome-cdp` node (`mad-emulator --chrome`), its Web Serial port the board's
# protocol line. The app is served by its dev server (Software/Control,
# `vite`), started here unless one already answers on APP_PORT.
#
#   scripts/board-route.sh playground   a Chrome window on the app; Ctrl-C stops it all
#   scripts/board-route.sh e2e          headless; runs the e2e suite against it
#                                       (SCENARIOS selects, as for `npm run e2e`),
#                                       then stops it all; exits with the suite's status
#
# Environment: P2_IMAGE, EMULATOR (the mad-emulator binary), APP_PORT (5174),
# DEVTOOLS_PORT (9222; empty for one Chrome picks), BOARD_LOGS (where the
# board's and the dev server's logs go), BOARD_ARGS (more mad-emulator
# arguments), E2E_TIMINGS (a JSON file of per-scenario host and board times).
#
# The run prints Chrome's DevTools URL in its "reached" line once the node
# holds Chrome, and only then may a harness attach: a page made before the
# node holds Chrome is not on the board's clock. This script waits for that
# line and hands its URL on as CDP_URL.
set -euo pipefail

mode=${1:-}
case "$mode" in
  playground | e2e) ;;
  *)
    echo "usage: $0 playground|e2e" >&2
    exit 2
    ;;
esac

sil=$(cd "$(dirname "$0")/.." && pwd)
control="$sil/../Software/Control"
image=${P2_IMAGE:-$sil/../Firmware/MaDCore/.pio/build/propeller2_debug/program}
emulator=${EMULATOR:-$sil/target/release/mad-emulator}
app_port=${APP_PORT:-5174}
app_url="http://127.0.0.1:$app_port/"
logs=${BOARD_LOGS:-$sil/target/board-route}
mkdir -p "$logs"

for need in "$image" "$emulator"; do
  [ -f "$need" ] || {
    echo "board-route: missing $need (make p2image; cargo build --release --bin mad-emulator)" >&2
    exit 2
  }
done

# Only what this script started is stopped on the way out.
vite_pid=''
board_pid=''
stop() {
  local status=$?
  if [ -n "$board_pid" ] && kill -0 "$board_pid" 2>/dev/null; then
    # SIGTERM: the emulator stops the system in order, its chrome-cdp closes
    # the Chrome it launched, and the run's summary is printed.
    kill -TERM "$board_pid" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$board_pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "$board_pid" 2>/dev/null || true
  fi
  if [ -n "$vite_pid" ]; then
    kill -TERM "$vite_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap stop EXIT
trap 'exit 130' INT TERM

if curl -sf "$app_url" >/dev/null 2>&1; then
  echo "board-route: the app is already served at $app_url; using it"
else
  (cd "$control" && exec ./node_modules/.bin/vite --host 127.0.0.1 --port "$app_port" --strictPort) \
    >"$logs/vite.log" 2>&1 &
  vite_pid=$!
  for _ in $(seq 1 60); do
    curl -sf "$app_url" >/dev/null 2>&1 && break
    kill -0 "$vite_pid" 2>/dev/null || break
    sleep 1
  done
  curl -sf "$app_url" >/dev/null 2>&1 || {
    echo "board-route: the dev server did not come up; its log:" >&2
    cat "$logs/vite.log" >&2
    exit 1
  }
  echo "board-route: the app is served at $app_url (log: $logs/vite.log)"
fi

# shellcheck disable=SC2086 # BOARD_ARGS is a list of arguments
args=("$image" --sd-path "$sil/sd" --chrome --granted --log-level info ${BOARD_ARGS:-})
devtools_port=${DEVTOOLS_PORT-9222}
[ -n "$devtools_port" ] && args+=(--devtools-port "$devtools_port")
if [ "$mode" = playground ]; then
  args+=(--url "$app_url")
else
  args+=(--headless)
fi
"$emulator" "${args[@]}" >"$logs/board.log" 2>&1 &
board_pid=$!
echo "board-route: mad-emulator ${args[*]} (pid $board_pid, log: $logs/board.log)"

# The node launches Chrome at the board's first slice and holds it; its
# "reached" line names the DevTools URL. (The first line names where Chrome
# will listen, before Chrome is up: not that one.)
cdp_url=''
for _ in $(seq 1 240); do
  cdp_url=$(grep -ao 'reached in [0-9.]* s of host time.*DevTools at http://[0-9.:]*' "$logs/board.log" \
    | head -1 | sed 's/.*DevTools at //' || true)
  [ -n "$cdp_url" ] && break
  kill -0 "$board_pid" 2>/dev/null || break
  sleep 0.5
done
if [ -z "$cdp_url" ]; then
  echo "board-route: the board never reached Chrome; its log:" >&2
  tail -60 "$logs/board.log" >&2
  exit 1
fi
echo "board-route: Chrome is on the board's clock; DevTools at $cdp_url"

if [ "$mode" = playground ]; then
  echo "board-route: the app is open in the Chrome window. Ctrl-C stops the board, Chrome and the dev server."
  # Follow the board's own words (the guest's console, the link, the host).
  tail -n +1 -f "$logs/board.log" &
  tail_pid=$!
  wait "$board_pid" || true
  kill "$tail_pid" 2>/dev/null || true
  board_pid=''
  exit 0
fi

set +e
(cd "$control" && CDP_URL="$cdp_url" APP_URL="$app_url" node e2e/run-all.mjs)
suite=$?
set -e
echo "board-route: the suite exited $suite; the board's summary is at the end of $logs/board.log"
exit "$suite"
