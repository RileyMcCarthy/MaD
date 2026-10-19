# MaD SIL Testing - Makefile
#
# Commands:
#   make p2image        - Build the P2 image the ISS executes
#   make emulator       - Build the Rust emulator
#   make test           - Build the image, run the Rust test suite
#   make playground     - The ISS with MaD Control in a Chrome window on the board's clock
#   make playground-iss - The same target, under the name it had beside the native one
#   make playground-pty - The ISS on a PTY at /tmp/tty.iss, for a serial console
#   make playground-rom - The ISS mask ROM, the app's flasher in a Chrome window on the board's clock
#   make e2e-emulator   - The ISS with a headless Chrome on the board's clock; prints the DevTools URL
#   make e2e            - All of it, headless, and the e2e suite against it (SCENARIOS selects)
#   make e2e-rom        - FW-ISS: the app's flasher against the ISS's mask ROM, headless
#   make e2e-bundle     - BUNDLE-live: the built bundle (as pages.yml builds it) on the board, headless
#   make flash-image    - build/flash.bin: stage-1 and the P2 image, the module's boot flash
#   make sd-image       - build/sd.img: a 32 MiB FAT16 card mirroring ./sd
#   make clean          - Remove build artifacts
#
# There is ONE configuration a browser belongs in: the P2 image on the ISS,
# with the app in the host's Chrome held to the board's clock by embsim's
# `chrome-cdp` node (`mad-emulator --chrome`, embsim MIGRATING-MAD.md step
# 1b). Every page and dedicated worker in that Chrome lives the board's time,
# a 1 ms quantum at a time over DevTools, and its Web Serial port is the
# node's, on the board's protocol pins. A browser on the host's own clock
# (behind a PTY, or the WS bridge) measures the host, not the machine: the ISS
# interprets every instruction at a few percent of real time, and the app's
# 2 s response timeout would fire at a fraction of that in the board's time.

FIRMWARE_DIR = ../Firmware/MaDCore
# The P2 image the instruction-set simulator executes: the artifact you flash.
P2_ENV = propeller2_debug
P2_IMAGE = $(FIRMWARE_DIR)/.pio/build/$(P2_ENV)/program
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

.PHONY: p2image protocol emulator emulator-release test playground playground-iss playground-pty playground-rom e2e-emulator e2e e2e-rom e2e-bundle flash-image sd-image bootrom clean

# Build the P2 image the ISS runs (`p2core`, `p2iss`, `mad-emulator`).
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

# Build the Rust emulator. The image is a runtime input, not a link input.
emulator: protocol
	cargo build

# Run tests
test: emulator p2image
	cargo test

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

# The board route for a person, headless: the ISS with Chrome on the board's
# clock and nothing open, DevTools on DEVTOOLS_PORT. Once the run prints its
# "reached ... DevTools at http://127.0.0.1:9222" line (Chrome held; a page
# made before then is not on the board's clock), with the app served
# (`npm run dev`):
#   cd ../Software/Control && CDP_URL=http://127.0.0.1:9222 E2E_JAM_FILE=/tmp/mad-sil.jam npm run e2e
# Ctrl-C stops the board and its Chrome. The carriage jams while JAM_FILE
# exists (the SERVO-stall scenario's lever; the suite's E2E_JAM_FILE).
DEVTOOLS_PORT ?= 9222
JAM_FILE ?= /tmp/mad-sil.jam
e2e-emulator: p2image emulator-release
	$(EMULATOR) $(P2_IMAGE) --sd-path ./sd --chrome --headless --granted --devtools-port $(DEVTOOLS_PORT) --jam-file $(JAM_FILE) --log-level info

# The e2e suite on the board route, start to finish: the dev server, the
# board with a headless Chrome on its clock, the suite attached to that
# Chrome, then everything stopped. `make e2e SCENARIOS=B1+C1,F7` runs a
# subset; `BOARD_PER_SCENARIO=1` gives each scenario a fresh board (what CI
# does), so a board that stops costs one scenario; logs land in
# target/board-route/.
e2e: p2image emulator-release
	scripts/board-route.sh e2e

# BUNDLE-live: the app as it ships. The bundle is built as pages.yml builds it
# (the Pages base path) and served by `vite preview`, on a headless board. The
# dev server compiles for the newest Chrome and the bundle for the app's
# browser floor, so a fault the bundler brings in shows only here.
BUNDLE_BASE = /MaD/app/
BUNDLE_DIR = $(abspath target/board-route/bundle)
e2e-bundle: p2image emulator-release
	cd ../Software/Control && ./node_modules/.bin/vite build --base=$(BUNDLE_BASE) --outDir $(BUNDLE_DIR) --emptyOutDir
	APP_DIST=$(BUNDLE_DIR) APP_BASE=$(BUNDLE_BASE) SCENARIOS=BUNDLE-live scripts/board-route.sh e2e

# The module's boot flash: embsim's stage-1 loader, then the P2 image behind
# it, as the P2's ROM boots it off the flash (`embsim flash-image`). A
# project names it in its w25q128jv entry (`image = "build/flash.bin"`).
flash-image: p2image
	mkdir -p $(BUILD_DIR)
	$(EMBSIM) flash-image $(P2_IMAGE) -o $(FLASH_IMAGE)

# The card in the module's socket: 32 MiB of FAT16 holding the directories
# the firmware writes into, with ./sd mirrored onto it when it is there, the
# card mad-emulator --sd-path builds. A project names it in its sd-card
# entry (`image = "build/sd.img"`).
sd-image:
	mkdir -p $(BUILD_DIR)
	cargo run --release --quiet -p p2iss --example dump_card -- $(SD_IMAGE) sd

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
# mask ROM on the programming UART (USB 0403:6015). The e2e suite's other
# scenarios need the firmware's board (make e2e).
e2e-rom: emulator-release
	P2_IMAGE=$(ROM_IMAGE) BOARD_ARGS="--boot-rom --usb-product-id 0x6015" E2E_BOARD=rom SCENARIOS=FW-ISS scripts/board-route.sh e2e

# Clean build artifacts
clean:
	rm -rf test-results $(BUILD_DIR)
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(P2_ENV) -t clean
