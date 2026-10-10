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

.PHONY: p2image protocol emulator emulator-release test playground playground-iss playground-pty playground-rom e2e-emulator e2e bootrom clean

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
#   cd ../Software/Control && CDP_URL=http://127.0.0.1:9222 npm run e2e
# Ctrl-C stops the board and its Chrome.
DEVTOOLS_PORT ?= 9222
e2e-emulator: p2image emulator-release
	$(EMULATOR) $(P2_IMAGE) --sd-path ./sd --chrome --headless --granted --devtools-port $(DEVTOOLS_PORT) --log-level info

# The e2e suite on the board route, start to finish: the dev server, the
# board with a headless Chrome on its clock, the suite attached to that
# Chrome, then everything stopped. `make e2e SCENARIOS=B1+C1,F7` runs a
# subset; logs land in target/board-route/.
e2e: p2image emulator-release
	scripts/board-route.sh e2e

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

# Clean build artifacts
clean:
	rm -rf test-results
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(P2_ENV) -t clean
