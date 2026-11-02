#!/usr/bin/env bash
# The board route: the P2 image on the ISS, and MaD Control in the host's
# Chrome, every page and worker held to the board's clock by embsim's
# `chrome-cdp` node, its Web Serial port the board's protocol line. The app
# is served by its dev server (Software/Control, `vite`), started here unless
# this checkout's already answers on APP_PORT (a server another checkout
# started there is refused), or, with APP_DIST, as the built bundle (below).
#
#   scripts/board-route.sh playground   a Chrome window on the app; Ctrl-C stops it all
#   scripts/board-route.sh e2e          headless; runs the e2e suite against it
#                                       (SCENARIOS selects, as for `npm run e2e`),
#                                       then stops it all; exits with the suite's status
#
# Two boards, BOARD_ROUTE picking (embsim MIGRATING-MAD.md steps 10 and 11):
#
#   project   the default: a machine's project file under `$EMBSIM run`, the
#             host's Chrome on the carrier's debug header J1 (USB 0403:6015).
#             The e2e runs E2E_PROJECT (mad-cosim.toml, the production
#             firmware booted off the module's flash, headless; make
#             e2e-motion names mad-ic14-fixed-cosim.toml, the board with MaD
#             #285 fixed, make e2e-stall mad-hard-stop-cosim.toml, that board
#             with a hard stop on its carriage (MaD #298), and make e2e-rom
#             mad-serial-boot-cosim.toml, the ROM's serial boot with the
#             flash erased). The playground runs
#             PLAYGROUND_PROJECT (mad-playground.toml, a headed copy of the
#             #285-fixed file; make playground-rom names
#             mad-serial-boot-playground.toml), its Chrome a window opened on
#             the app at the file's url, the dev server on 5174. The files fix
#             Chrome's DevTools port (9222) and grant the port; `make
#             flash-image sd-image` writes the images they name.
#   emulator  `mad-emulator --chrome`, the debug image P2_IMAGE on the bare
#             chip, the host on P30/P32 (USB 0403:6001), headless. No make
#             target or CI job runs it: SERVO-stall, the last scenario it
#             carried, runs on mad-hard-stop-cosim.toml (MaD #298), and the
#             route retires with mad-emulator (embsim MIGRATING-MAD.md step
#             11). The e2e only: every playground is a project's.
#
# Environment: BOARD_ROUTE, EMBSIM (the embsim command; by default the
# pinned submodule's, through cargo), E2E_PROJECT (mad-cosim.toml, relative
# to SIL/; exported to the suite, which skips by it), PLAYGROUND_PROJECT
# (mad-playground.toml), P2_IMAGE and EMULATOR (the mad-emulator binary),
# APP_PORT (5174),
# DEVTOOLS_PORT (the emulator's: 9222; empty for one Chrome picks),
# BOARD_LOGS (where the board's and the dev server's logs go), BOARD_ARGS
# (more mad-emulator arguments), E2E_TIMINGS (a JSON file of per-scenario
# host and board times), E2E_JAM_FILE (the emulator's: the file whose
# presence jams the board's carriage, passed to mad-emulator as --jam-file;
# default $BOARD_LOGS/jam; no scenario creates it), and
# BOARD_PER_SCENARIO=1: a fresh board for each
# scenario, so a board that stops (the node's worker-boot stall) costs that
# scenario alone.
#
# APP_DIST=DIR serves a built bundle (`vite build --base=APP_BASE --outDir
# DIR`) with `vite preview` in place of the dev server: the code the app ships
# as, compiled for its browser floor, where the dev server compiles for the
# newest. APP_BASE (/) is the base it was built for; APP_PORT defaults to 4173,
# and must be free. The suite is told (E2E_APP=bundle), which runs BUNDLE-live.
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
route=${BOARD_ROUTE:-project}
case "$route" in
  project | emulator) ;;
  *)
    echo "board-route: BOARD_ROUTE is project or emulator, not $route" >&2
    exit 2
    ;;
esac
image=${P2_IMAGE:-$sil/../Firmware/MaDCore/.pio/build/propeller2_debug/program}
emulator=${EMULATOR:-$sil/target/release/mad-emulator}
embsim=${EMBSIM:-cargo run --release --quiet --manifest-path $sil/embsim/Cargo.toml -p embsim-cli --}
if [ "$mode" = playground ]; then
  project=${PLAYGROUND_PROJECT:-mad-playground.toml}
else
  project=${E2E_PROJECT:-mad-cosim.toml}
fi
app_dist=''
if [ -n "${APP_DIST:-}" ]; then
  [ -f "$APP_DIST/index.html" ] || {
    echo "board-route: no built bundle at $APP_DIST (vite build --outDir it first)" >&2
    exit 2
  }
  app_dist=$(cd "$APP_DIST" && pwd)
fi
app_base=${APP_BASE:-/}
app_port=${APP_PORT:-$([ -n "$app_dist" ] && echo 4173 || echo 5174)}
if [ "$mode" = playground ] && [ "$route" = project ]; then
  # A playground file opens the app at its HOST's url (a project's options
  # come from its file alone): serve the app on that url's port.
  file_port=$(sed -n 's|^url = "http://127\.0\.0\.1:\([0-9]*\)/.*|\1|p' "$sil/$project" | head -1)
  if [ -n "$file_port" ] && [ -n "${APP_PORT:-}" ] && [ "$APP_PORT" != "$file_port" ]; then
    echo "board-route: $project opens the app on port $file_port; APP_PORT=$APP_PORT would serve it where that window does not look" >&2
    exit 2
  fi
  app_port=${file_port:-$app_port}
fi
app_url="http://127.0.0.1:$app_port$app_base"
logs=${BOARD_LOGS:-$sil/target/board-route}
mkdir -p "$logs"
if [ "$route" = emulator ]; then
  # Every playground is a project's (embsim MIGRATING-MAD.md step 11).
  if [ "$mode" = playground ]; then
    echo "board-route: mad-emulator runs no playground; a playground runs a project (make playground)" >&2
    exit 2
  fi
  # mad-emulator jams its carriage while this file exists.
  export E2E_JAM_FILE=${E2E_JAM_FILE:-$logs/jam}
  # mad-emulator's port is the FT232R's, unless BOARD_ARGS names another.
  case " ${BOARD_ARGS:-} " in
    *" --usb-product-id 0x6015 "*) export E2E_PORT_USB=${E2E_PORT_USB:-0403:6015} ;;
    *) export E2E_PORT_USB=${E2E_PORT_USB:-0403:6001} ;;
  esac
  export E2E_BOARD_ROUTE=emulator
  for need in "$image" "$emulator"; do
    [ -f "$need" ] || {
      echo "board-route: missing $need (make p2image; cargo build --release --bin mad-emulator)" >&2
      exit 2
    }
  done
else
  # The suite skips by the file (run-all.mjs, PROJECT_CANNOT): what IC14 as
  # drawn keeps from the drive runs on the file with MaD #285 fixed, and
  # SERVO-stall on that file with a hard stop on its carriage, which skips
  # the other scenarios that move the carriage.
  unset E2E_JAM_FILE
  export E2E_BOARD_ROUTE=project
  export E2E_PROJECT=$project
  [ -f "$sil/$project" ] || {
    echo "board-route: missing $sil/$project" >&2
    exit 2
  }
  # The images the file names (its `image = "..."` options): the flash boot's
  # flash and card, the serial boot's card alone.
  for named in $(sed -n 's/^image = "\(.*\)"$/\1/p' "$sil/$project"); do
    [ -f "$sil/$named" ] || {
      echo "board-route: missing $sil/$named, which $project names (make flash-image sd-image)" >&2
      exit 2
    }
  done
fi

# Only what this script started is stopped on the way out.
server_pid=''
board_pid=''
tail_pid=''
stop_board() {
  if [ -n "$board_pid" ] && kill -0 "$board_pid" 2>/dev/null; then
    # SIGTERM: the emulator stops the system in order, its chrome-cdp closes
    # the Chrome it launched, and the run's summary is printed.
    kill -TERM "$board_pid" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$board_pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "$board_pid" 2>/dev/null || true
  fi
  board_pid=''
}
stop() {
  local status=$?
  if [ -n "$tail_pid" ]; then kill "$tail_pid" 2>/dev/null || true; fi
  stop_board
  if [ -n "$server_pid" ]; then
    kill -TERM "$server_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap stop EXIT
trap 'exit 130' INT TERM

# Serve the app: `vite` (the dev server) or `vite preview` (the bundle in
# APP_DIST), its log at $logs/$1.log.
serve() {
  local name=$1
  shift
  (cd "$control" && exec ./node_modules/.bin/vite "$@" --host 127.0.0.1 --port "$app_port" --strictPort) \
    >"$logs/$name.log" 2>&1 &
  server_pid=$!
  for _ in $(seq 1 60); do
    curl -sf "$app_url" >/dev/null 2>&1 && break
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 1
  done
  curl -sf "$app_url" >/dev/null 2>&1 || {
    echo "board-route: $name did not come up at $app_url; its log:" >&2
    cat "$logs/$name.log" >&2
    exit 1
  }
}

if [ -n "$app_dist" ]; then
  # Never a server that is already there: it could be the dev server.
  if curl -sf "$app_url" >/dev/null 2>&1; then
    echo "board-route: something already answers at $app_url; the bundle needs that port (APP_PORT)" >&2
    exit 2
  fi
  serve preview preview --outDir "$app_dist" --base "$app_base"
  export E2E_APP=bundle
  echo "board-route: the built bundle in $app_dist is served at $app_url (log: $logs/preview.log)"
elif curl -sf "$app_url" >/dev/null 2>&1; then
  # Only this checkout's app: the server listening there must have been
  # started in this checkout's Software/Control (its working directory, as
  # lsof reports it), or the suite would test another checkout's app.
  listener=$(lsof -nP -iTCP:"$app_port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
  served_from=''
  if [ -n "$listener" ]; then
    served_from=$(lsof -a -p "$listener" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)
  fi
  ours=$(cd "$control" && pwd -P)
  if [ "$served_from" != "$ours" ]; then
    echo "board-route: something already answers at $app_url, served from ${served_from:-a directory lsof cannot name}, not this checkout's $ours; stop it, or set APP_PORT to a free port" >&2
    exit 2
  fi
  echo "board-route: this checkout's app is already served at $app_url; using it"
else
  serve vite
  echo "board-route: the app is served at $app_url (log: $logs/vite.log)"
fi

# Start the board, its log at $1, and wait until the node holds Chrome: its
# "reached" line names the DevTools URL, left in $cdp_url. (The first line
# names where Chrome will listen, before Chrome is up: not that one.)
cdp_url=''
start_board() {
  local log=$1
  if [ "$route" = project ]; then
    # The file fixes the DevTools port. A Chrome already answering there
    # would be some other run's, and the suite would attach to it.
    if curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
      echo "board-route: something already answers DevTools at http://127.0.0.1:9222, the port $project fixes" >&2
      return 1
    fi
    # `exec`: cargo runs the tool in its place, and the tool the runner in
    # its, so $board_pid is the run itself, which SIGTERM ends with its
    # summary.
    # shellcheck disable=SC2086 # EMBSIM is a command and its arguments
    (cd "$sil" && exec $embsim run "$project") >"$log" 2>&1 &
    board_pid=$!
    echo "board-route: $embsim run $project (pid $board_pid, log: $log)"
  else
    # shellcheck disable=SC2086 # BOARD_ARGS is a list of arguments
    local args=("$image" --sd-path "$sil/sd" --chrome --granted --log-level info
      --jam-file "$E2E_JAM_FILE" ${BOARD_ARGS:-})
    local devtools_port=${DEVTOOLS_PORT-9222}
    if [ -n "$devtools_port" ]; then args+=(--devtools-port "$devtools_port"); fi
    args+=(--headless)
    "$emulator" "${args[@]}" >"$log" 2>&1 &
    board_pid=$!
    echo "board-route: mad-emulator ${args[*]} (pid $board_pid, log: $log)"
  fi
  cdp_url=''
  # A bound on a hang, in host time: the project's run builds nothing here
  # (`make e2e` checks the file first, which builds the runner) and reaches
  # Chrome within seconds.
  for _ in $(seq 1 600); do
    cdp_url=$(grep -ao 'reached in [0-9.]* s of host time.*DevTools at http://[0-9.:]*' "$log" \
      | head -1 | sed 's/.*DevTools at //' || true)
    [ -n "$cdp_url" ] && break
    kill -0 "$board_pid" 2>/dev/null || break
    sleep 0.5
  done
  if [ -z "$cdp_url" ]; then
    echo "board-route: the board never reached Chrome; its log:" >&2
    tail -60 "$log" >&2
    return 1
  fi
  echo "board-route: Chrome is on the board's clock; DevTools at $cdp_url"
  if [ "$route" = project ] && [ "$mode" = e2e ] && [ "${E2E_BOARD:-}" != rom ]; then
    # Pacing, not a check: the scenario starts once the firmware is up, as
    # a person finds the machine powered, and its connect is what checks
    # that the firmware answers (fixtures.mjs, connectToSil: samples and a
    # published firmware version, in page time). Off the flash the module
    # spends about 1.2 s of board time in its ROM and stage-1 (measured), and
    # a page that connected then would spend its first opening read on a
    # board with nothing to answer it, the rest queued behind it
    # (src/device/DeviceSession.worker.ts, runOp): 2252 ms of board time
    # until the response timeout, measured on a silent board. The hint is the
    # production firmware's first line on P62 (Firmware/MaDCore/src/Main/
    # main.c), which the run prints as the core's console. Without it the
    # scenario starts anyway once the bound passes (300 s of host time, a
    # hang's bound only), and its connect decides.
    local booted=''
    for _ in $(seq 1 600); do
      if grep -qF 'P62 "Starting MaD Board' "$log"; then
        booted=1
        break
      fi
      kill -0 "$board_pid" 2>/dev/null || break
      sleep 0.5
    done
    if [ -n "$booted" ]; then
      echo "board-route: the firmware has printed its boot line"
    elif kill -0 "$board_pid" 2>/dev/null; then
      echo "board-route: no boot line from the firmware yet; the scenario's connect decides whether it answers" >&2
    else
      echo "board-route: the board's run ended before the firmware printed its boot line; its log:" >&2
      tail -60 "$log" >&2
      return 1
    fi
  fi
}

if [ "$mode" = playground ]; then
  start_board "$logs/board.log"
  # The project's Chrome opens the file's url itself, a page on the board's
  # clock from its first instant.
  echo "board-route: the app is open in the Chrome window. Ctrl-C stops the board, Chrome and the app's server."
  # Follow the board's own words (the guest's console, the link, the host).
  tail -n +1 -f "$logs/board.log" &
  tail_pid=$!
  wait "$board_pid" || true
  board_pid=''
  exit 0
fi

if [ "${BOARD_PER_SCENARIO:-}" != 1 ]; then
  start_board "$logs/board.log"
  set +e
  (cd "$control" && CDP_URL="$cdp_url" APP_URL="$app_url" node e2e/run-all.mjs)
  suite=$?
  set -e
  echo "board-route: the suite exited $suite; the board's summary is at the end of $logs/board.log"
  exit "$suite"
fi

# One board per scenario. The suite's own order, SCENARIOS selecting; the
# list says on stderr what this board cannot run, and why. (Written for the
# bash 3.2 macOS ships: no mapfile, no empty-array expansion under set -u.)
ids=$(cd "$control" && node e2e/run-all.mjs --list)
if [ -z "$ids" ]; then
  echo "board-route: no scenario to run on this board: the run would check nothing" >&2
  exit 1
fi
# The scenarios that need no board (a host Chrome against in-page fakes)
# run with none: a board would only cost its boot.
free=" $(cd "$control" && node e2e/run-all.mjs --list --board-free | tr '\n' ' ') "
count=0
failed=''
parts=''
for id in $ids; do
  count=$((count + 1))
  safe=$(printf '%s' "$id" | tr -c 'A-Za-z0-9_-' '_')
  case "$free" in
    *" $id "*)
      set +e
      (cd "$control" && APP_URL="$app_url" SCENARIOS="$id" \
        E2E_TIMINGS="$logs/timings-$safe.json" node e2e/run-all.mjs)
      status=$?
      set -e
      [ "$status" -eq 0 ] || failed="$failed $id"
      parts="$parts $logs/timings-$safe.json"
      continue
      ;;
  esac
  if ! start_board "$logs/board-$safe.log"; then
    failed="$failed $id(its-board-never-came-up)"
    stop_board
    continue
  fi
  set +e
  (cd "$control" && CDP_URL="$cdp_url" APP_URL="$app_url" SCENARIOS="$id" \
    E2E_TIMINGS="$logs/timings-$safe.json" node e2e/run-all.mjs)
  status=$?
  set -e
  stop_board
  [ "$status" -eq 0 ] || failed="$failed $id"
  parts="$parts $logs/timings-$safe.json"
done
if [ -n "${E2E_TIMINGS:-}" ]; then
  # shellcheck disable=SC2086 # $parts is a list of paths without spaces
  node -e '
    const fs = require("fs");
    const [out, ...parts] = process.argv.slice(1);
    const timings = parts.flatMap((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).timings; } catch { return []; } });
    fs.writeFileSync(out, JSON.stringify({ board: true, perScenarioBoard: true, timings }, null, 2));
  ' "$E2E_TIMINGS" $parts
fi
echo "board-route: $count scenarios, one board each (none for those that need no board); failed:${failed:- none}"
[ -z "$failed" ]
