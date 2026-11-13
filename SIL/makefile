# MaD SIL Testing - Makefile
#
# Commands:
#   make p2image        - Build the firmware's P2 image (pio env MaD), the one image the ISS executes
#   make emulator       - Build the SIL workspace
#   make test           - Build the image, run the Rust test suite
#   make playground     - mad-playground.toml under embsim run: the machine, MaD Control in a Chrome window on the board's clock
#   make playground-iss - The same target, under the name it had beside the native one
#   make playground-pty - mad.toml under embsim run, its host a PTY at /tmp/tty.iss, for a serial console
#   make playground-rom - mad-serial-boot-playground.toml: the ROM's serial boot, the app's flasher in a Chrome window
#   make e2e-emulator   - mad-cosim.toml under embsim run: the machine, a headless Chrome on the control port J4; prints the DevTools URL
#   make e2e            - The app served, e2e-emulator's board and the e2e suite against it (SCENARIOS selects)
#   make e2e-rom        - FW-ISS: the app's flasher against the ISS's mask ROM, on mad-serial-boot-cosim.toml
#   make e2e-bundle     - BUNDLE-live: the built bundle (as pages.yml builds it) on e2e-emulator's board
#   make e2e-motion     - The scenarios that move the carriage, on mad-cosim.toml (MOTION_SHARD splits them)
#   make e2e-stall      - SERVO-stall on mad-hard-stop-cosim.toml: the carriage jogged into a hard stop
#   make e2e-reflash    - FW1 and COMPAT-reflash: the app flashing the firmware for real over J1, DTR resetting the chip, on mad-reflash-cosim.toml
#   make reflash-image  - build/reflash.bin: the firmware's image stamped with a version of its own, FW1's
#   make flash-image    - build/flash.bin: stage-1 and the firmware's image, the module's boot flash
#   make sd-image       - build/sd.img: a 32 MiB FAT16 card mirroring ./sd
#   make check          - embsim check on MaD's eight project files (mad*.toml)
#   make clean          - Remove build artifacts
#
# There is ONE configuration a browser belongs in: the P2 image on the ISS,
# with the app in the host's Chrome held to the board's clock by embsim's
# `chrome-cdp` node. Every page and dedicated worker in that Chrome lives the
# board's time, a 1 ms quantum at a time over DevTools, and its Web Serial
# port is the node's, on the board's protocol pins. The e2e runs it on the
# machine's project, mad-cosim.toml (embsim MIGRATING-MAD.md step 10), the
# node on the carrier's control port J4, and FW-ISS on the project's serial
# boot, mad-serial-boot-cosim.toml, the node on the debug header J1, the
# programming port; e2e-motion, the scenarios that move
# the carriage, runs on mad-cosim.toml too, and the playgrounds on its
# headed copy (step 11); SERVO-stall (e2e-stall) on that file with a hard
# stop on its carriage, mad-hard-stop-cosim.toml (MaD #298); FW1 and
# COMPAT-reflash (e2e-reflash) on the board the app's flasher can reach,
# mad-reflash-cosim.toml, the node on J1 (MaD #134). A browser on the host's
# own clock (behind a PTY, or the WS bridge) measures the host, not the
# machine: the ISS interprets every instruction at a few percent of real
# time, and the app's 2 s response timeout would fire at a fraction of that
# in the board's time.

FIRMWARE_DIR = ../Firmware/MaDCore
# The firmware's one P2 image, the one everything here executes: the
# project files' module flash (flash-image), and the mad-catalog, p2core and
# p2iss suites. Its MAIN channel, the protocol, is on P30/P32 at 2 000 000
# baud, which the Edge carrier's isolator IC2 takes to its control port J4;
# its log is on P62, the debug header J1, which is otherwise the programming
# port (Firmware/MaDCore/platformio.ini).
P2_ENV = MaD
P2_IMAGE = $(FIRMWARE_DIR)/.pio/build/$(P2_ENV)/program
PROTOEMB_GENERATOR = ../Protocol/ProtoEmb/core/generate.py
PROTOEMB_SCHEMA = ../Protocol/MaDProtocol.yaml
PROTOEMB_TEMPLATES = ../Protocol/ProtoEmb/core/templates

# The embsim tool, built from the pinned submodule; it builds and runs
# mad-runner, which holds MaD's kinds (embsim PROJECTS.md §10, "A runner the
# project owns"). EMBSIM=embsim uses an installed one.
EMBSIM ?= cargo run --release --quiet --manifest-path embsim/Cargo.toml -p embsim-cli --

# The files a project's module flash and card take (embsim MIGRATING-MAD.md
# step 4), until embsim's w25q128jv and sd-card kinds lay them out
# themselves (E5). MaD's root .gitignore keeps build/ out of git.
BUILD_DIR = build
FLASH_IMAGE = $(BUILD_DIR)/flash.bin
SD_IMAGE = $(BUILD_DIR)/sd.img

.PHONY: p2image protocol emulator test playground playground-iss playground-pty playground-rom e2e-emulator e2e e2e-rom e2e-bundle e2e-motion e2e-stall e2e-compat e2e-reflash flash-image reflash-image sd-image check bootrom clean

# Build the P2 image the ISS runs (`p2core`, `p2iss`, `mad-catalog`, and the
# project files' flash).
#
# A `make test` dependency on purpose: those crates' tests skip when the image
# is absent, and PlatformIO drops stale environment directories whenever the
# sources change — so without this a source edit silently turns the whole ISS
# suite into no-ops that still report green.
p2image:
	cd $(FIRMWARE_DIR) && pio run -e $(P2_ENV)

# Generate Rust protocol types used by SIL (MaD-specific; kept out of the
# generic embsim crates — lands in the `protocol` crate at ../Protocol).
protocol:
	python3 $(PROTOEMB_GENERATOR) --schema $(PROTOEMB_SCHEMA) --target rs --output ../Protocol/rust/src/generated --templates $(PROTOEMB_TEMPLATES)

# Build the SIL workspace. The image is a runtime input, not a link input.
emulator: protocol
	cargo build

# Run tests. MAD_REQUIRE_P2_IMAGE turns a test's "the image is missing, so
# skip" into a failure, so an image PlatformIO dropped fails the run.
test: emulator p2image
	MAD_REQUIRE_P2_IMAGE=1 cargo test

# MaD Control on the ISS, for a person (embsim MIGRATING-MAD.md step 11):
# mad-playground.toml, the machine (a headed copy of mad-cosim.toml),
# under embsim run. Its
# Chrome opens a window on the app, served by its dev server on 5174
# (started here unless this checkout's answers there), every page and worker
# in that Chrome on the board's clock; the run prints where its DevTools
# are. The page lives the time the board grants it, so the app runs as fast
# as the board does and no faster: its timeouts mean in board time what they
# say. Animation frames barely run on virtual time, so the live charts redraw
# only now and then. Ctrl-C stops the board, Chrome and the dev server.
PLAYGROUND_PROJECT = mad-playground.toml
playground: flash-image sd-image
	$(EMBSIM) check $(PLAYGROUND_PROJECT)
	EMBSIM="$(EMBSIM)" PLAYGROUND_PROJECT=$(PLAYGROUND_PROJECT) scripts/board-route.sh playground

# `playground` under the name it had while the native firmware held
# `playground`. Kept so the name, and embsim's MIGRATING-MAD.md step 11 that
# cites it, still resolve.
playground-iss: playground

# The machine's project with a serial port for its host, mad.toml under
# embsim run, its PTY at /tmp/tty.iss: the firmware's protocol at
# 2 000 000 baud on the control port J4, for a serial console or a program that speaks it. The
# board runs unpaced, at whatever rate the ISS manages. No browser belongs
# behind it (see the top of this file). The path is DELIBERATELY NOT
# /tmp/tty.rpi, the retired native firmware library's path that the old
# WS-to-PTY bridge opened by default: the ISS behind a bridge to a host-speed
# browser is the pairing that measures the host.
playground-pty: flash-image sd-image
	$(EMBSIM) run mad.toml --pty /tmp/tty.iss

# The e2e's board (embsim MIGRATING-MAD.md step 10): the machine's project
# with the host's Chrome on the carrier's control port J4, mad-cosim.toml,
# run by the embsim tool. The module boots the firmware off its flash
# (flash-image) with its card in its socket (sd-image); the chrome-cdp node
# launches Chrome headless at the run's first slice, its DevTools on 9222
# (the file's devtools_port), its one Web Serial port the line on J4, USB
# 0403:6001 (an FTDI FT232R), granted to every origin. The run is unpaced: the page lives
# only the time the board grants it. It runs until SIGTERM or Ctrl-C, then
# prints its summary.
E2E_PROJECT = mad-cosim.toml
E2E_BOARD = $(EMBSIM) run $(E2E_PROJECT)

# The e2e's board for a person, headless and nothing open. Once the run
# prints its "reached ... DevTools at http://127.0.0.1:9222" line (Chrome
# held; a page made before then is not on the board's clock), with the app
# served from the host (`npm run dev`, on 5174):
#   cd ../Software/Control && CDP_URL=http://127.0.0.1:9222 npm run e2e
# Ctrl-C stops the board and its Chrome.
e2e-emulator: flash-image sd-image
	$(E2E_BOARD)

# The e2e suite on e2e-emulator's board, start to finish: the app served (the
# dev server, started unless one answers on APP_PORT), the project checked
# (which builds mad-runner), e2e-emulator's board, the suite attached to its
# Chrome, then everything stopped. `make e2e SCENARIOS=B1+C1,F7` runs a
# subset; `BOARD_PER_SCENARIO=1` gives each scenario a fresh board (what CI
# does), so a board that stops costs one scenario; logs land in
# target/board-route/.
e2e: flash-image sd-image
	$(EMBSIM) check $(E2E_PROJECT)
	EMBSIM="$(EMBSIM)" E2E_PROJECT=$(E2E_PROJECT) scripts/board-route.sh e2e

# BUNDLE-live: the app as it ships. The bundle is built as pages.yml builds it
# (the Pages base path) and served by `vite preview`, on e2e-emulator's
# board. The dev server compiles for the newest Chrome and the bundle for the
# app's browser floor, so a fault the bundler brings in shows only here.
BUNDLE_BASE = /MaD/app/
BUNDLE_DIR = $(abspath target/board-route/bundle)
e2e-bundle: flash-image sd-image
	$(EMBSIM) check $(E2E_PROJECT)
	cd ../Software/Control && ./node_modules/.bin/vite build --base=$(BUNDLE_BASE) --outDir $(BUNDLE_DIR) --emptyOutDir
	APP_DIST=$(BUNDLE_DIR) APP_BASE=$(BUNDLE_BASE) SCENARIOS=BUNDLE-live EMBSIM="$(EMBSIM)" E2E_PROJECT=$(E2E_PROJECT) scripts/board-route.sh e2e

# The scenarios that move the carriage (run-all.mjs, MOVES, listed by
# `--list --moves`), on the machine's project, mad-cosim.toml. The list
# leaves out SERVO-stall, which drives the carriage into a hard stop:
# e2e-stall runs it. `make e2e-motion SCENARIOS=G2+G3+H2+I` narrows the set;
# naming nothing in it fails. MOTION_SHARD=K/N runs the K-th of N shares of
# the set, every N-th scenario from the K-th in the suite's order, so a
# workflow can split it across jobs (the nightly runs three); a share left
# empty, of a set narrowed below N, runs nothing and passes.
MOTION_PROJECT = mad-cosim.toml
MOTION_SHARD ?=
e2e-motion: flash-image sd-image
	$(EMBSIM) check $(MOTION_PROJECT)
	@ids=$$(cd ../Software/Control && node e2e/run-all.mjs --list --moves | paste -sd, -); \
	if [ -z "$$ids" ]; then echo "e2e-motion: SCENARIOS names no scenario that moves the carriage" >&2; exit 1; fi; \
	if [ -n "$(MOTION_SHARD)" ]; then \
	  echo "$(MOTION_SHARD)" | awk -F/ 'NF == 2 && $$1 >= 1 && $$2 >= $$1 { ok = 1 } END { exit !ok }' \
	    || { echo "e2e-motion: MOTION_SHARD=$(MOTION_SHARD) is not K/N with 1 <= K <= N" >&2; exit 2; }; \
	  ids=$$(echo "$$ids" | tr , '\n' | awk -v shard="$(MOTION_SHARD)" 'BEGIN { split(shard, s, "/") } (NR - 1) % s[2] == s[1] - 1' | paste -sd, -); \
	  if [ -z "$$ids" ]; then echo "e2e-motion: share $(MOTION_SHARD) of the set is empty: nothing to run"; exit 0; fi; \
	fi; \
	echo "e2e-motion: $$ids"; \
	EMBSIM="$(EMBSIM)" E2E_PROJECT=$(MOTION_PROJECT) SCENARIOS="$$ids" scripts/board-route.sh e2e

# The firmware-compatibility scenarios that need other firmware on the
# board (run-all.mjs, NEEDS_FIRMWARE), on e2e's board with that firmware in
# the module's flash: COMPAT-app-too-old on this tree's firmware built one
# protocol_version ahead. scripts/compat-images.sh builds it; no firmware
# source changes for it. This tree's image goes back in the flash
# afterwards, however the run ends. The scenarios that need this tree's
# firmware (COMPAT-ok, and COMPAT-ok-motion in e2e-motion) run with the rest
# of the suite.
#
# COMPAT-too-old does not run here. Its firmware, a release from before the
# app could ask the firmware which protocol it speaks (firmware-v0.14 and
# every release before the one-image firmware), has its protocol on P62/P63,
# the debug header J1, and e2e's board has its host on the control port J4
# (P30/P32), where that firmware never listens: the app would see a board
# that never answers, not a firmware too old. No project file puts a
# flash-booted machine's host on J1 but the reflash board's (e2e-reflash),
# where firmware-v0.14 does answer, as COMPAT-reflash's starting firmware.
e2e-compat: flash-image sd-image
	$(EMBSIM) check $(E2E_PROJECT)
	EMBSIM="$(EMBSIM)" scripts/compat-images.sh
	@trap '$(EMBSIM) flash-image $(P2_IMAGE) -o $(FLASH_IMAGE) >/dev/null' EXIT; \
	status=0; \
	for run in future:COMPAT-app-too-old; do \
	  firmware=$${run%%:*}; \
	  echo "e2e-compat: $${run#*:} on the $$firmware firmware"; \
	  cp $(BUILD_DIR)/flash-compat-$$firmware.bin $(FLASH_IMAGE); \
	  E2E_FIRMWARE=$$firmware SCENARIOS=$${run#*:} EMBSIM="$(EMBSIM)" E2E_PROJECT=$(E2E_PROJECT) \
	    scripts/board-route.sh e2e || status=1; \
	done; \
	exit $$status

# The module's boot flash: embsim's stage-1 loader, then the firmware's
# image behind it, as the P2's ROM boots it off the flash (`embsim
# flash-image`). A project names it in its w25q128jv entry (`image =
# "build/flash.bin"`).
flash-image: p2image
	mkdir -p $(BUILD_DIR)
	$(EMBSIM) flash-image $(P2_IMAGE) -o $(FLASH_IMAGE)

# The card in the module's socket: 32 MiB of FAT16 holding the directories
# the firmware writes into, with ./sd mirrored onto it when it is there, the
# card `p2iss::sdimage::mad_card` builds. A project names it in its sd-card
# entry (`image = "build/sd.img"`).
sd-image:
	mkdir -p $(BUILD_DIR)
	cargo run --release --quiet -p p2iss --example dump_card -- $(SD_IMAGE) sd

# MaD's project files (embsim MIGRATING-MAD.md section 1): the machine as it
# runs, booting the firmware off the module's flash, and the ROM's serial
# boot, each with a host-serial and with the host's Chrome (chrome-cdp) on
# the same pins; that file with a hard stop on the carriage (MaD #298); and
# the two playgrounds, headed copies of the two Chrome files. `embsim check`
# builds each: every part placed, every wire on a
# connector, every option the kinds take; it boots the chip with time held
# and runs nothing. A chrome-cdp starts no Chrome at check, but check
# refuses its file on a machine where it finds none. Both boots name the
# card `make sd-image` writes; the flash boot names `make flash-image`'s.
PROJECTS = mad.toml mad-serial-boot.toml
COSIM_PROJECTS = mad-cosim.toml mad-serial-boot-cosim.toml mad-hard-stop-cosim.toml mad-reflash-cosim.toml
PLAYGROUND_PROJECTS = mad-playground.toml mad-serial-boot-playground.toml
check: flash-image sd-image
	for project in $(PROJECTS) $(COSIM_PROJECTS) $(PLAYGROUND_PROJECTS); do $(EMBSIM) check $$project || exit 1; done

# The boot ROM and the stage-1 flash loader the ISS boots through.
FLEXSPIN = $(HOME)/.platformio/packages/toolchain-flexcc/bin/macos-amd64/flexspin
bootrom:
	$(FLEXSPIN) -2 -o /tmp/rom_full.bin p2iss/rom/rom_booter_v33k.spin2
	python3 -c "open('p2iss/rom/rom_booter_v33k.bin','wb').write(open('/tmp/rom_full.bin','rb').read()[0xFC000:])"
	$(FLEXSPIN) -2 -o p2iss/rom/stage1.bin p2iss/rom/stage1.spin2

# The ROM's serial boot on the machine's project, with the app's flasher in
# a Chrome window on the board's clock: mad-serial-boot-playground.toml, a
# headed copy of mad-serial-boot-cosim.toml, its window on the app's
# Firmware page. The module's flash is erased and S301 pulls P59 up, so the
# ROM waits for a serial boot on J1 (P62/P63), where the Prop Plug's FT231X
# (0403:6015) sits; `Prop_Chk` answers without a reset pulse: this file
# leaves J1.3 (RESn) and the host's DTR unwired, so the port's setSignals
# reaches no pin here. The board where DTR reaches the Prop Plug's reset
# stage and resets the P2 is mad-reflash-cosim.toml (make e2e-reflash). The app's
# flasher writes the flash, as FW-ISS does on the -cosim copy (make
# e2e-rom); a RAM load's reply is garbled there until MaD #295 is fixed.
ROM_PLAYGROUND_PROJECT = mad-serial-boot-playground.toml
playground-rom: flash-image sd-image
	$(EMBSIM) check $(ROM_PLAYGROUND_PROJECT)
	EMBSIM="$(EMBSIM)" PLAYGROUND_PROJECT=$(ROM_PLAYGROUND_PROJECT) scripts/board-route.sh playground

# FW-ISS on the ROM board: the app's flasher, in a headless Chrome on the
# board's clock, writing the program into the module's flash through the
# mask ROM on the programming UART. The board is the machine's project with
# the ROM's serial boot, mad-serial-boot-cosim.toml (S301 position 3, the
# flash erased), the node on J1 (USB 0403:6015). Nothing pulses RESn: J1.3
# and the node's DTR are unwired in the file. The ROM listens from
# the START instant for 90 s of board time (600 timeouts of 3 000 000
# clocks on its 20 MHz RC oscillator), and the probe arrives within a
# second of it (measured: the ROM replies at 0.63-0.95 s of board time). The
# e2e suite's other scenarios need the
# firmware's board (make e2e).
ROM_PROJECT = mad-serial-boot-cosim.toml
e2e-rom: sd-image
	$(EMBSIM) check $(ROM_PROJECT)
	EMBSIM="$(EMBSIM)" E2E_PROJECT=$(ROM_PROJECT) E2E_BOARD=rom SCENARIOS=FW-ISS scripts/board-route.sh e2e

# SERVO-stall (a carriage jogged into a hard stop latches the stall; Live
# clears it and re-enables motion; a jog takes the carriage off the stop) on
# mad-hard-stop-cosim.toml: mad-cosim.toml with a hard stop 3 mm
# above the carriage's start (the machine's hard_stop_mm;
# mad-catalog/src/machine.rs, "The hard stop"; mad-catalog/tests/projects.rs
# holds the file to that one option). The suite skips the board's other
# scenarios that move the carriage, which the stop would meet (MaD #298).
STALL_PROJECT = mad-hard-stop-cosim.toml
e2e-stall: flash-image sd-image
	$(EMBSIM) check $(STALL_PROJECT)
	EMBSIM="$(EMBSIM)" E2E_PROJECT=$(STALL_PROJECT) SCENARIOS=SERVO-stall scripts/board-route.sh e2e

# FW1's image (MaD #134): the firmware's build (pio env MaD) stamped with a
# version the flash image's build does not report (it reports 0.0.0, no
# stamp), built into a directory of its own so the flash image's build is
# left as it is. The app flashes it on the reflash board, and the boot line
# the firmware writes on J1 afterwards, "Starting MaD Board sil-reflash",
# is this image, running (Firmware/MaDCore/src/Main/main.c). 15 characters
# at most: the protocol carries no more (extra_scripts/
# check_firmware_version.py refuses longer).
REFLASH_VERSION = sil-reflash
REFLASH_BUILD = $(abspath $(BUILD_DIR))/reflash-pio
REFLASH_IMAGE = $(BUILD_DIR)/reflash.bin
reflash-image:
	mkdir -p $(BUILD_DIR)
	cd $(FIRMWARE_DIR) && PLATFORMIO_BUILD_DIR=$(REFLASH_BUILD) PLATFORMIO_BUILD_FLAGS='-DFIRMWARE_VERSION=\"$(REFLASH_VERSION)\"' pio run -e $(P2_ENV)
	cp $(REFLASH_BUILD)/$(P2_ENV)/program $(REFLASH_IMAGE)

# The reflash board, mad-reflash-cosim.toml: mad-cosim.toml with its node
# on the programming port J1 (the Prop Plug's FT231X, 0403:6015), the Prop
# Plug's reset stage on J1.3 (the node's DTR, the stage's open collector,
# the chip's RESN) and S301's P59 pulls open, so after a reset the ROM
# listens on J1 for 100 ms before it boots the flash. Two scenarios, each
# updating the machine's firmware for real, in a headless Chrome on the
# board's clock: the app's DTR pulse resets the chip into that window, the
# ROM's loader takes build/reflash.bin, and the board boots it. The new
# firmware's protocol is on the control port J4, which this board's one
# Chrome port does not reach, so the app does not reconnect; each scenario
# reads the firmware's boot line on J1 instead, from the board's log
# (scripts/board-route.sh, E2E_BOARD_LOG).
#   FW1             on this tree's firmware, a local file on the Firmware
#                   screen; passes once the board's log shows
#                   "Starting MaD Board sil-reflash" after the flash
#   COMPAT-reflash  on the release from before the protocol handshake
#                   (COMPAT_OLD_TAG, scripts/compat-images.sh), whose
#                   protocol is on J1; the no-answer banner's Install
#                   recommended firmware, then the same boot line
# This tree's image goes back in the flash afterwards, however the runs end,
# and E2E_TIMINGS, when set, gets both runs' timings.
# The e2e suite's other scenarios need the firmware's board (make e2e).
REFLASH_PROJECT = mad-reflash-cosim.toml
COMPAT_OLD_TAG ?= firmware-v0.14
e2e-reflash: flash-image sd-image reflash-image
	$(EMBSIM) check $(REFLASH_PROJECT)
	EMBSIM="$(EMBSIM)" COMPAT_OLD_TAG=$(COMPAT_OLD_TAG) scripts/compat-images.sh
	@trap '$(EMBSIM) flash-image $(P2_IMAGE) -o $(FLASH_IMAGE) >/dev/null' EXIT; \
	status=0; \
	for run in current:FW1 old:COMPAT-reflash; do \
	  firmware=$${run%%:*}; \
	  echo "e2e-reflash: $${run#*:} on the $$firmware firmware"; \
	  if [ $$firmware = current ]; then \
	    $(EMBSIM) flash-image $(P2_IMAGE) -o $(FLASH_IMAGE) >/dev/null; \
	  else \
	    cp $(BUILD_DIR)/flash-compat-$$firmware.bin $(FLASH_IMAGE); \
	  fi; \
	  E2E_FIRMWARE=$$firmware SCENARIOS=$${run#*:} EMBSIM="$(EMBSIM)" \
	    E2E_PROJECT=$(REFLASH_PROJECT) E2E_BOARD=reflash \
	    E2E_REFLASH_IMAGE=$(abspath $(REFLASH_IMAGE)) E2E_REFLASH_VERSION=$(REFLASH_VERSION) \
	    E2E_TIMINGS=$${E2E_TIMINGS:+$$E2E_TIMINGS.$$firmware} \
	    scripts/board-route.sh e2e || status=1; \
	done; \
	if [ -n "$${E2E_TIMINGS:-}" ]; then \
	  node -e 'const fs = require("fs"); const [out, ...parts] = process.argv.slice(1); const timings = parts.flatMap((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).timings; } catch { return []; } }); fs.writeFileSync(out, JSON.stringify({ board: true, timings }, null, 2));' \
	    "$$E2E_TIMINGS" "$$E2E_TIMINGS.current" "$$E2E_TIMINGS.old"; \
	fi; \
	exit $$status

# Clean build artifacts
clean:
	rm -rf test-results $(BUILD_DIR)
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(P2_ENV) -t clean
