# MaD SIL Testing - Makefile
#
# Commands:
#   make p2image        - Build the P2 image the ISS executes (propeller2_debug)
#   make p2image-production - Build the production P2 image (propeller2), the one flash-image lays out
#   make emulator       - Build the Rust emulator
#   make test           - Build the image, run the Rust test suite
#   make playground     - The ISS with MaD Control in a Chrome window on the board's clock
#   make playground-iss - The same target, under the name it had beside the native one
#   make playground-pty - The ISS on a PTY at /tmp/tty.iss, for a serial console
#   make playground-rom - The ISS mask ROM, the app's flasher in a Chrome window on the board's clock
#   make e2e-emulator   - mad-cosim.toml under embsim run: the machine, a headless Chrome on J1; prints the DevTools URL
#   make e2e            - The app served, e2e-emulator's board and the e2e suite against it (SCENARIOS selects)
#   make e2e-rom        - FW-ISS: the app's flasher against the ISS's mask ROM, on mad-serial-boot-cosim.toml
#   make e2e-bundle     - BUNDLE-live: the built bundle (as pages.yml builds it) on e2e-emulator's board
#   make e2e-motion     - What the project cannot run (the carriage's scenarios), on mad-emulator, until IC14 is settled
#   make flash-image    - build/flash.bin: stage-1 and the production image, the module's boot flash
#   make sd-image       - build/sd.img: a 32 MiB FAT16 card mirroring ./sd
#   make check          - embsim check on MaD's four project files (mad*.toml)
#   make clean          - Remove build artifacts
#
# There is ONE configuration a browser belongs in: the P2 image on the ISS,
# with the app in the host's Chrome held to the board's clock by embsim's
# `chrome-cdp` node. Every page and dedicated worker in that Chrome lives the
# board's time, a 1 ms quantum at a time over DevTools, and its Web Serial
# port is the node's, on the board's protocol pins. The e2e runs it on the
# machine's project, mad-cosim.toml (embsim MIGRATING-MAD.md step 10), the
# node on the carrier's debug header J1, and FW-ISS on the project's serial
# boot, mad-serial-boot-cosim.toml; the playgrounds run it on
# mad-emulator (`--chrome`, step 1b) until step 11, and so does e2e-motion,
# what the project as drawn cannot run, until IC14 is settled. A browser on
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

# The release emulator the routes below run: the ISS interprets every
# instruction, and a debug build is far slower still.
EMULATOR = ./target/release/mad-emulator

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

.PHONY: p2image p2image-production protocol emulator emulator-release test playground playground-iss playground-pty playground-rom e2e-emulator e2e e2e-rom e2e-bundle e2e-motion flash-image sd-image check bootrom clean

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

# MaD Control on the ISS, for a person: a Chrome window on the app, served by
# its dev server (started here unless one answers on 5174), every page and
# worker in that Chrome on the board's clock. The page lives the time the
# board grants it, so the app runs as fast as the board does and no faster:
# its timeouts mean in board time what they say. Animation frames barely run
# on virtual time, so the live charts redraw only now and then. Ctrl-C stops
# the board, Chrome and the dev server.
playground: p2image emulator-release
	scripts/board-route.sh playground

# `playground` under the name it had while the native firmware held
# `playground`. Kept so the name, and embsim's MIGRATING-MAD.md step 11 that
# cites it, still resolve.
playground-iss: playground

# The ISS on a PTY at /tmp/tty.iss, at real time at most, for a serial
# console or a program that keeps wall time. No browser belongs behind it
# (see the top of this file). The path is DELIBERATELY NOT /tmp/tty.rpi,
# which Software/Control/tools/sil-ws-bridge.mjs opens by default: the ISS
# behind that bridge is the pairing that measures the host.
playground-pty: p2image emulator-release
	$(EMULATOR) $(P2_IMAGE) --sd-path ./sd --pty-path /tmp/tty.iss --log-level info

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

# What the project as drawn cannot run, on mad-emulator's board meanwhile
# (BOARD_ROUTE=emulator: the debug firmware on the bare chip, the host on
# P53/P55, a jam on --jam-file): the scenarios that move the carriage, which
# IC14 keeps from the drive on the project, and SERVO-stall, which jams it
# (run-all.mjs, PROJECT_CANNOT, listed by `--list --cannot`). Until the
# machine's carrier at IC14 is settled, so the motion coverage stays.
# `make e2e-motion SCENARIOS=G2+G3+H2+I` narrows the set; naming nothing in
# it fails.
e2e-motion: p2image emulator-release
	@ids=$$(cd ../Software/Control && node e2e/run-all.mjs --list --cannot | paste -sd, -); \
	if [ -z "$$ids" ]; then echo "e2e-motion: SCENARIOS names nothing the project cannot run" >&2; exit 1; fi; \
	echo "e2e-motion: $$ids"; \
	BOARD_ROUTE=emulator SCENARIOS="$$ids" scripts/board-route.sh e2e

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
# the same pins. `embsim check` builds each: every part placed, every wire
# on a connector, every option the kinds take; it boots the chip with time
# held and runs nothing. A chrome-cdp starts no Chrome at check, but check
# refuses its file on a machine where it finds none. Both boots name the
# card `make sd-image` writes; the flash boot names `make flash-image`'s.
PROJECTS = mad.toml mad-serial-boot.toml
COSIM_PROJECTS = mad-cosim.toml mad-serial-boot-cosim.toml
check: flash-image sd-image
	for project in $(PROJECTS) $(COSIM_PROJECTS); do $(EMBSIM) check $$project || exit 1; done

# The boot ROM and the stage-1 flash loader the ISS boots through.
FLEXSPIN = $(HOME)/.platformio/packages/toolchain-flexcc/bin/macos-amd64/flexspin
bootrom:
	$(FLEXSPIN) -2 -o /tmp/rom_full.bin p2iss/rom/rom_booter_v33k.spin2
	python3 -c "open('p2iss/rom/rom_booter_v33k.bin','wb').write(open('/tmp/rom_full.bin','rb').read()[0xFC000:])"
	$(FLEXSPIN) -2 -o p2iss/rom/stage1.bin p2iss/rom/stage1.spin2

# The ISS mask ROM on the programming UART (P62/P63), with the app's
# flasher in a Chrome window on the board's clock: the P2 Edge's own USB
# serial, an FTDI FT231X (0403:6015). The ROM's serial strap is a pull-up on
# P59, so `Prop_Chk` answers without a reset pulse: nothing models DTR, and
# the port's setSignals reaches no pin.
ROM_IMAGE = p2iss/rom/rom_booter_v33k.bin
playground-rom: emulator-release
	P2_IMAGE=$(ROM_IMAGE) BOARD_ARGS="--boot-rom --usb-product-id 0x6015" scripts/board-route.sh playground

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

# Clean build artifacts
clean:
	rm -rf test-results $(BUILD_DIR)
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(P2_ENV) -t clean
	cd $(FIRMWARE_DIR) && pio run -e $(PRODUCTION_ENV) -t clean
