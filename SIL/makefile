# MaD SIL Testing - Makefile
#
# Commands:
#   make p2image        - Build the P2 image the ISS executes (propeller2_debug)
#   make p2image-production - Build the production P2 image (propeller2), the one flash-image lays out
#   make emulator       - Build the Rust emulator
#   make test           - Build the image, run the Rust test suite
#   make playground     - mad-playground.toml under embsim run: the machine (IC14 fixed), MaD Control in a Chrome window on the board's clock
#   make playground-iss - The same target, under the name it had beside the native one
#   make playground-pty - mad.toml under embsim run, its host a PTY at /tmp/tty.iss, for a serial console
#   make playground-rom - mad-serial-boot-playground.toml: the ROM's serial boot, the app's flasher in a Chrome window
#   make e2e-emulator   - mad-cosim.toml under embsim run: the machine, a headless Chrome on J1; prints the DevTools URL
#   make e2e            - The app served, e2e-emulator's board and the e2e suite against it (SCENARIOS selects)
#   make e2e-rom        - FW-ISS: the app's flasher against the ISS's mask ROM, on mad-serial-boot-cosim.toml
#   make e2e-bundle     - BUNDLE-live: the built bundle (as pages.yml builds it) on e2e-emulator's board
#   make e2e-motion     - What the project as drawn cannot run (the carriage's scenarios), on mad-ic14-fixed-cosim.toml
#   make e2e-stall      - SERVO-stall on mad-emulator, the one scenario no project can run (its jam)
#   make flash-image    - build/flash.bin: stage-1 and the production image, the module's boot flash
#   make sd-image       - build/sd.img: a 32 MiB FAT16 card mirroring ./sd
#   make check          - embsim check on MaD's seven project files (mad*.toml)
#   make clean          - Remove build artifacts
#
# There is ONE configuration a browser belongs in: the P2 image on the ISS,
# with the app in the host's Chrome held to the board's clock by embsim's
# `chrome-cdp` node. Every page and dedicated worker in that Chrome lives the
# board's time, a 1 ms quantum at a time over DevTools, and its Web Serial
# port is the node's, on the board's protocol pins. The e2e runs it on the
# machine's project, mad-cosim.toml (embsim MIGRATING-MAD.md step 10), the
# node on the carrier's debug header J1, and FW-ISS on the project's serial
# boot, mad-serial-boot-cosim.toml; e2e-motion, what the project as drawn
# cannot run, and the playgrounds run it on the board with MaD #285 fixed,
# mad-ic14-fixed-cosim.toml and its headed copy (step 11). Only SERVO-stall
# (e2e-stall) is still mad-emulator's (`--chrome`, step 1b), for its jam,
# which no project has (MaD #298). A browser on
# the host's own clock (behind a PTY, or the WS bridge) measures the host,
# not the machine: the ISS interprets every instruction at a few percent of
# real time, and the app's 2 s response timeout would fire at a fraction of
# that in the board's time.

FIRMWARE_DIR = ../Firmware/MaDCore
# The P2 image mad-emulator and the p2core/p2iss suites execute: the debug
# build, its MAIN channel on P53/P55 and its log on P62. Those routes put
# the host straight on the chip's P53/P55 and read the log: the chip on no
# module and no carrier, so nothing sits between the host and those pins.
P2_ENV = propeller2_debug
P2_IMAGE = $(FIRMWARE_DIR)/.pio/build/$(P2_ENV)/program
# The production build, the project files' route (the user's decision;
# which image the machine runs is open, SIL/mad.toml's header): its MAIN
# channel on P62/P63, the carrier's debug header J1, where the Prop Plug
# sits. The project files' module flash holds it (flash-image), and
# mad-catalog/tests/mad.rs boots it.
PRODUCTION_ENV = propeller2
PRODUCTION_IMAGE = $(FIRMWARE_DIR)/.pio/build/$(PRODUCTION_ENV)/program
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

.PHONY: p2image p2image-production protocol emulator emulator-release test playground playground-iss playground-pty playground-rom e2e-emulator e2e e2e-rom e2e-bundle e2e-motion e2e-stall flash-image sd-image check bootrom clean

# Build the P2 image the ISS runs (`p2core`, `p2iss`, `mad-emulator`).
#
# A `make test` dependency on purpose: those crates' tests skip when the image
# is absent, and PlatformIO drops stale environment directories whenever the
# sources change — so without this a source edit silently turns the whole ISS
# suite into no-ops that still report green.
p2image:
	cd $(FIRMWARE_DIR) && pio run -e $(P2_ENV)

# Build the production image the project files' flash holds, a `make test`
# dependency for the same reason: mad-catalog/tests/mad.rs skips without it.
p2image-production:
	cd $(FIRMWARE_DIR) && pio run -e $(PRODUCTION_ENV)

# Generate Rust protocol types used by SIL (MaD-specific; kept out of the
# generic embsim crates — lands in the `protocol` crate at ../Protocol).
protocol:
	python3 $(PROTOEMB_GENERATOR) --schema $(PROTOEMB_SCHEMA) --target rs --output ../Protocol/rust/src/generated --templates $(PROTOEMB_TEMPLATES)

# Build the Rust emulator. The image is a runtime input, not a link input.
emulator: protocol
	cargo build

# Run tests. The production image is built first and the debug image last,
# the order CI builds them in (.github/workflows/ci.yml: building one env
# has been seen to remove another env's output). MAD_REQUIRE_P2_IMAGE turns
# a test's "the image is missing, so skip" into a failure, so an image lost
# that way fails the run.
test: emulator p2image-production p2image
	MAD_REQUIRE_P2_IMAGE=1 cargo test

emulator-release: protocol
	cargo build --release --bin mad-emulator

# MaD Control on the ISS, for a person (embsim MIGRATING-MAD.md step 11):
# mad-playground.toml, the machine with MaD #285 fixed (a headed copy of
# mad-ic14-fixed-cosim.toml, so the carriage moves), under embsim run. Its
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
# embsim run, its PTY at /tmp/tty.iss: the production firmware's protocol at
# 2 000 000 baud on J1, for a serial console or a program that speaks it. The
# board runs unpaced, at whatever rate the ISS manages. No browser belongs
# behind it (see the top of this file). The path is DELIBERATELY NOT
# /tmp/tty.rpi, which Software/Control/tools/sil-ws-bridge.mjs opens by
# default: the ISS behind that bridge is the pairing that measures the host.
playground-pty: flash-image sd-image
	$(EMBSIM) run mad.toml --pty /tmp/tty.iss

# The e2e's board (embsim MIGRATING-MAD.md step 10): the machine's project
# with the host's Chrome on the carrier's debug header J1, mad-cosim.toml,
# run by the embsim tool. The module boots the production firmware off its
# flash (flash-image) with its card in its socket (sd-image); the chrome-cdp
# node launches Chrome headless at the run's first slice, its DevTools on
# 9222 (the file's devtools_port), its one Web Serial port the line on J1,
# USB 0403:6015, granted to every origin. The run is unpaced: the page lives
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

# What the project as drawn cannot run (run-all.mjs, PROJECT_CANNOT, listed
# by `--list --cannot`): the scenarios that move the carriage, which IC14 as
# drawn keeps from the drive (MaD #285), on the board with #285 fixed,
# mad-ic14-fixed-cosim.toml: mad-cosim.toml with one wire from IC14's ground
# to EN_GND (mad-catalog/tests/projects.rs holds it to that). The suite
# skips SERVO-stall there, which jams the carriage, saying why: no project
# has a jam yet. `make e2e-motion SCENARIOS=G2+G3+H2+I` narrows the set;
# naming nothing in it fails. MOTION_SHARD=K/N runs the K-th of N shares of
# the set, every N-th scenario from the K-th in the suite's order, so a
# workflow can split it across jobs (the nightly runs three); a share left
# empty, of a set narrowed below N, runs nothing and passes.
MOTION_PROJECT = mad-ic14-fixed-cosim.toml
MOTION_SHARD ?=
e2e-motion: flash-image sd-image
	$(EMBSIM) check $(MOTION_PROJECT)
	@ids=$$(cd ../Software/Control && node e2e/run-all.mjs --list --cannot | paste -sd, -); \
	if [ -z "$$ids" ]; then echo "e2e-motion: SCENARIOS names nothing the project cannot run" >&2; exit 1; fi; \
	if [ -n "$(MOTION_SHARD)" ]; then \
	  echo "$(MOTION_SHARD)" | awk -F/ 'NF == 2 && $$1 >= 1 && $$2 >= $$1 { ok = 1 } END { exit !ok }' \
	    || { echo "e2e-motion: MOTION_SHARD=$(MOTION_SHARD) is not K/N with 1 <= K <= N" >&2; exit 2; }; \
	  ids=$$(echo "$$ids" | tr , '\n' | awk -v shard="$(MOTION_SHARD)" 'BEGIN { split(shard, s, "/") } (NR - 1) % s[2] == s[1] - 1' | paste -sd, -); \
	  if [ -z "$$ids" ]; then echo "e2e-motion: share $(MOTION_SHARD) of the set is empty: nothing to run"; exit 0; fi; \
	fi; \
	echo "e2e-motion: $$ids"; \
	EMBSIM="$(EMBSIM)" E2E_PROJECT=$(MOTION_PROJECT) SCENARIOS="$$ids" scripts/board-route.sh e2e

# The module's boot flash: embsim's stage-1 loader, then the production
# image behind it, as the P2's ROM boots it off the flash (`embsim
# flash-image`). A project names it in its w25q128jv entry (`image =
# "build/flash.bin"`). The production image, because the project files'
# host is on J1 (P62/P63), where that build's MAIN channel is.
flash-image: p2image-production
	mkdir -p $(BUILD_DIR)
	$(EMBSIM) flash-image $(PRODUCTION_IMAGE) -o $(FLASH_IMAGE)

# The card in the module's socket: 32 MiB of FAT16 holding the directories
# the firmware writes into, with ./sd mirrored onto it when it is there, the
# card mad-emulator --sd-path builds. A project names it in its sd-card
# entry (`image = "build/sd.img"`).
sd-image:
	mkdir -p $(BUILD_DIR)
	cargo run --release --quiet -p p2iss --example dump_card -- $(SD_IMAGE) sd

# MaD's project files (embsim MIGRATING-MAD.md section 1): the machine as it
# runs, booting the firmware off the module's flash, and the ROM's serial
# boot, each with a host-serial and with the host's Chrome (chrome-cdp) on
# the same pins; the flash boot with MaD #285 fixed, with the host's Chrome;
# and the two playgrounds, headed copies of that file and of the serial
# boot's. `embsim check` builds each: every part placed, every wire on a
# connector, every option the kinds take; it boots the chip with time held
# and runs nothing. A chrome-cdp starts no Chrome at check, but check
# refuses its file on a machine where it finds none. Both boots name the
# card `make sd-image` writes; the flash boot names `make flash-image`'s.
PROJECTS = mad.toml mad-serial-boot.toml
COSIM_PROJECTS = mad-cosim.toml mad-serial-boot-cosim.toml mad-ic14-fixed-cosim.toml
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
# (0403:6015) sits; `Prop_Chk` answers without a reset pulse: no host kind
# has modem-control pins, so the port's setSignals reaches no pin. The app's
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
# flash erased), the node on J1 (USB 0403:6015). Nothing pulses RESn: the
# node has no DTR, and J1.3 is unwired in the file. The ROM listens from
# the START instant for 90 s of board time (600 timeouts of 3 000 000
# clocks on its 20 MHz RC oscillator), and the probe arrives within a
# second of it (measured, 0.54 s). The e2e suite's other scenarios need the
# firmware's board (make e2e).
ROM_PROJECT = mad-serial-boot-cosim.toml
e2e-rom: sd-image
	$(EMBSIM) check $(ROM_PROJECT)
	EMBSIM="$(EMBSIM)" E2E_PROJECT=$(ROM_PROJECT) E2E_BOARD=rom SCENARIOS=FW-ISS scripts/board-route.sh e2e

# SERVO-stall (a jammed carriage latches the stall; Live clears it and
# re-enables motion), the one scenario no project can run: its jam is
# mad-emulator's --jam-file, a lever the project's machine has no stepped
# form of (mad-catalog/src/machine.rs, "Not modelled"). So it runs on
# mad-emulator's board (BOARD_ROUTE=emulator): the debug image on the bare
# chip, the host on P53/P55, a headless Chrome on the board's clock. This
# target, mad-emulator and the debug image's route are what keep
# mad-emulator in the tree (embsim MIGRATING-MAD.md step 11's exception;
# MaD #298 is the jam a project would need).
e2e-stall: p2image emulator-release
	BOARD_ROUTE=emulator SCENARIOS=SERVO-stall scripts/board-route.sh e2e

# Clean build artifacts
clean:
	rm -rf test-results $(BUILD_DIR)
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(P2_ENV) -t clean
	cd $(FIRMWARE_DIR) && pio run -e $(PRODUCTION_ENV) -t clean
