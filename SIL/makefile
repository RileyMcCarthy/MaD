# MaD SIL Testing - Makefile
#
# Commands:
#   make p2image       - Build the P2 image the ISS executes
#   make emulator      - Build the Rust emulator
#   make test          - Build the image, run the Rust test suite
#   make playground    - ISS at real time on /tmp/tty.rpi
#   make e2e-emulator  - ISS behind the WS bridge, unpaced (NOT a valid SIL configuration; see below)
#   make playground-iss - Same ISS on /tmp/tty.iss, so it does not take the e2e PTY
#   make playground-rom - ISS mask ROM on the programming UART, host on the PTY
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

# Start the emulator for INTERACTIVE use — a human, or a bot driving the real UI,
# watching a machine that moves at the speed the real one would. Real-time pacing
# is the point here: --speed 1.0 sleeps a wall microsecond per virtual
# microsecond, so what you see is what the machine does.
#
# `--release` is not optional. The ISS interprets every instruction, and a debug
# build falls behind a host that is counting wall time.
playground: p2image
	cargo run --release --bin mad-emulator -- $(P2_IMAGE) --sd-path ./sd --pty-path /tmp/tty.rpi --log-level info

# The ISS behind the WS bridge, unpaced — what the e2e suite ran against when
# the native backend was removed. It is NOT a valid SIL configuration: the
# bridge hands the board's bytes to a browser running at host speed, so every
# wait in the suite measures the host rather than the machine, and the ISS
# interprets far slower than real time. Only a host the board's clock meters
# can stand in for the browser, and embsim owes that host (E4, above). No CI
# job runs this target; it stays until the move onto an embsim project retires
# it (embsim MIGRATING-MAD.md, step 10). What follows is its original rationale.
#
# The suite has no reason to run at real-time speed, and pacing actively harms
# it. Under --speed 1.0 the emulator must SUSTAIN a real-time factor of 1.0, and
# it cannot: free-running pacing bounds the factor above by 1.0 and every bit of
# simulation overhead drags it under (measured ~0.25 on a 4-vCPU CI runner also
# hosting Chrome, Vite and the bridge). The suite's waits then observe a machine
# that is behind schedule — a property of the HOST, not of the code under test.
# That is the whole reason 13 scenarios failed on CI while passing on a
# developer's box.
#
# Unpaced (--speed 0), virtual time advances by idle jump as fast as the host can
# compute it, with no wall sleeps anywhere in the loop. The simulated timeline
# stops depending on how fast — or how loaded — the machine is. It is also
# quicker in wall time, because simulated seconds cost only the compute to
# produce them rather than their full real-time duration.
#
# No --trace-port: the trace server is a debugging aid for the playground, and an
# extra HTTP listener is pure overhead for an automated run.
e2e-emulator: p2image
	cargo run --release --bin mad-emulator -- $(P2_IMAGE) --sd-path ./sd --pty-path /tmp/tty.rpi --log-level info --speed 0

# The boot ROM and the stage-1 flash loader the ISS boots through.
FLEXSPIN = $(HOME)/.platformio/packages/toolchain-flexcc/bin/macos-amd64/flexspin
bootrom:
	$(FLEXSPIN) -2 -o /tmp/rom_full.bin p2iss/rom/rom_booter_v33k.spin2
	python3 -c "open('p2iss/rom/rom_booter_v33k.bin','wb').write(open('/tmp/rom_full.bin','rb').read()[0xFC000:])"
	$(FLEXSPIN) -2 -o p2iss/rom/stage1.bin p2iss/rom/stage1.spin2

# The same ISS as `playground`, on a PTY the e2e bridge does not open.
# `/tmp/tty.iss` is a different path from `/tmp/tty.rpi`, so a manual session
# does not attach to a suite that is already running.
playground-iss: p2image
	cargo run --release --bin mad-emulator -- $(P2_IMAGE) --sd-path ./sd --pty-path /tmp/tty.iss --log-level info

# ISS mask ROM on the programming UART (P62/P63). The host browser opens the PTY.
ROM_IMAGE = p2iss/rom/rom_booter_v33k.bin
playground-rom:
	cargo run --release --bin mad-emulator -- $(ROM_IMAGE) --boot-rom --pty-path /tmp/tty.iss --log-level info

# Clean build artifacts
clean:
	rm -rf test-results
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(P2_ENV) -t clean
