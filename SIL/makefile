# MaD SIL Testing - Makefile
#
# Commands:
#   make p2image       - Build the P2 image the ISS executes
#   make emulator      - Build the Rust emulator
#   make test          - Build the image, run the Rust test suite
#   make playground    - ISS at real time on /tmp/tty.iss, a serial console for a person
#   make playground-iss - The same target, under the name it had beside the native one
#   make playground-rom - ISS mask ROM on the programming UART, host on /tmp/tty.iss
#   make e2e-emulator  - Refused: it was the ISS behind the WS bridge (see below)
#   make clean         - Remove build artifacts
#
# The e2e configuration, the ISS with Chrome in a QEMU guest the board's clock
# meters, has no target here: embsim 0.2.0 removed the guest it ran on, and the
# host kind that replaces it is embsim's to deliver (its MIGRATING-MAD.md §2,
# E4). Until then no board-touching e2e run is a valid SIL configuration.

FIRMWARE_DIR = ../Firmware/MaDCore
# The P2 image the instruction-set simulator executes: the artifact you flash.
P2_ENV = propeller2_debug
P2_IMAGE = $(FIRMWARE_DIR)/.pio/build/$(P2_ENV)/program
PROTOEMB_GENERATOR = ../Protocol/ProtoEmb/core/generate.py
PROTOEMB_SCHEMA = ../Protocol/MaDProtocol.yaml
PROTOEMB_TEMPLATES = ../Protocol/ProtoEmb/core/templates

.PHONY: p2image protocol emulator test playground e2e-emulator playground-iss playground-rom bootrom clean

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

# Start the emulator for INTERACTIVE use: a person, or a bot driving the real
# UI, watching a machine that moves at the speed the real one would. Real-time
# pacing is the point here: --speed 1.0 (the default) sleeps a wall microsecond
# per virtual microsecond, so what you see is what the machine does.
#
# `--release` is not optional. The ISS interprets every instruction, and a debug
# build falls behind a host that is counting wall time.
#
# The PTY is DELIBERATELY NOT /tmp/tty.rpi. There is exactly one valid SIL
# configuration, and it pairs the firmware with a way of providing serial:
#
#   real P2 image on the ISS  + Chrome in a QEMU guest + real Web Serial
#
# The ISS behind the WS bridge looks like it works and is worthless: the bridge
# hands the board's bytes to a browser running at host speed, so every wait in
# the suite measures the host's mood rather than the machine, and the ISS
# interprets far slower than real time. Only a guest the board's clock meters
# can pace the browser by the board. Sharing /tmp/tty.rpi with `playground`
# would make that pairing the path of least resistance, because
# Software/Control/tools/sil-ws-bridge.mjs defaults to exactly that path; a
# separate path makes reaching for it a deliberate act instead of an accident.
# (The native firmware library and the bridge were the other valid pairing, on
# /tmp/tty.rpi. The native library is gone.)
playground: p2image
	cargo run --release --bin mad-emulator -- $(P2_IMAGE) --sd-path ./sd --pty-path /tmp/tty.iss --log-level info

# `playground` under the name it had while the native firmware held
# `playground`. Kept so the name, and embsim's MIGRATING-MAD.md step 11 that
# cites it, still resolve.
playground-iss: playground

# Refused, on purpose. This target was the ISS behind the WS bridge on
# /tmp/tty.rpi, unpaced: what the e2e suite ran against once the native
# backend was removed. That is the pairing ruled out above, and the same rule
# answers MIGRATING-MAD.md §6's first question ("the ISS with a host that
# keeps wall time"): MaD does not keep it, the host the board's clock meters
# replaces it. So the target stays only as a name that explains itself, until
# the e2e target gets that host (E4, then MIGRATING-MAD.md step 10). No CI job
# runs it.
e2e-emulator:
	@echo "make e2e-emulator: refused." >&2
	@echo "It put the ISS behind the WS bridge, and that is not a valid SIL configuration:" >&2
	@echo "the bridge hands the board's bytes to a browser running at host speed, so the" >&2
	@echo "suite would measure the host, not the machine. The one valid configuration is" >&2
	@echo "the ISS with Chrome in a QEMU guest the board's clock meters, which waits on" >&2
	@echo "embsim's E4 (SIL/embsim/MIGRATING-MAD.md section 2). Until then the board-free" >&2
	@echo "scenarios run without an emulator, with npm run dev serving the app:" >&2
	@echo "  cd ../Software/Control && SCENARIOS=A1,FW1,FW2,FW3,FW5,FW6,FW7,FW8,FW9 npm run e2e" >&2
	@exit 1

# The boot ROM and the stage-1 flash loader the ISS boots through.
FLEXSPIN = $(HOME)/.platformio/packages/toolchain-flexcc/bin/macos-amd64/flexspin
bootrom:
	$(FLEXSPIN) -2 -o /tmp/rom_full.bin p2iss/rom/rom_booter_v33k.spin2
	python3 -c "open('p2iss/rom/rom_booter_v33k.bin','wb').write(open('/tmp/rom_full.bin','rb').read()[0xFC000:])"
	$(FLEXSPIN) -2 -o p2iss/rom/stage1.bin p2iss/rom/stage1.spin2

# ISS mask ROM on the programming UART (P62/P63). The host browser opens the PTY.
ROM_IMAGE = p2iss/rom/rom_booter_v33k.bin
playground-rom:
	cargo run --release --bin mad-emulator -- $(ROM_IMAGE) --boot-rom --pty-path /tmp/tty.iss --log-level info

# Clean build artifacts
clean:
	rm -rf test-results
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(P2_ENV) -t clean
