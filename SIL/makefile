# MaD SIL Testing - Makefile
# 
# Commands:
#   make firmware   - Build firmware static library
#   make emulator   - Build Rust emulator (builds firmware if needed)
#   make test       - Build everything, run the Rust test suite
#   make playground    - Build everything, start the emulator for manual testing (real-time)
#   make e2e-emulator  - Start the emulator for the e2e suite (unpaced virtual time)
#   make playground-iss - Manual testing against the real P2 image on the ISS
#   make playground-cosim - The ISS plus a QEMU guest running Chrome (the e2e config)
#   make clean      - Remove build artifacts

FIRMWARE_DIR = ../Firmware/MaDCore
PIO_ENV = native_emulator
FIRMWARE_LIB = $(FIRMWARE_DIR)/.pio/build/$(PIO_ENV)/libfirmware.a
# The real P2 image the instruction-set simulator executes. A different
# artifact from the static library above: that one is host-compiled firmware
# with a substituted HAL, this one is what you actually flash.
P2_ENV = propeller2_debug
P2_IMAGE = $(FIRMWARE_DIR)/.pio/build/$(P2_ENV)/program
PROTOEMB_GENERATOR = ../Protocol/ProtoEmb/core/generate.py
PROTOEMB_SCHEMA = ../Protocol/MaDProtocol.yaml
PROTOEMB_TEMPLATES = ../Protocol/ProtoEmb/core/templates

.PHONY: firmware p2image protocol emulator test playground e2e-emulator playground-iss vm-image playground-cosim bootrom clean

# Build firmware as static library
firmware:
	cd $(FIRMWARE_DIR) && pio run -e $(PIO_ENV)

# Build the P2 image the ISS runs (`p2core`, `p2iss`).
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

# Build Rust emulator (depends on firmware library)
emulator: firmware protocol
	cargo build

# Run tests
test: emulator p2image
	cargo test

# Start the emulator for INTERACTIVE use — a human, or a bot driving the real UI,
# watching a machine that moves at the speed the real one would. Real-time pacing
# is the point here: --speed 1.0 sleeps a wall microsecond per virtual
# microsecond, so what you see is what the machine does.
playground: emulator
	cargo run --bin mad-emulator -- --sd-path ./sd --pty-path /tmp/tty.rpi --log-level info --trace-port 3000

# Start the emulator for the E2E SUITE — unpaced virtual time.
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
e2e-emulator: emulator
	cargo run --bin mad-emulator -- --sd-path ./sd --pty-path /tmp/tty.rpi --log-level info --speed 0

# The boot ROM and the stage-1 flash loader the ISS boots through.
FLEXSPIN = $(HOME)/.platformio/packages/toolchain-flexcc/bin/macos-amd64/flexspin
bootrom:
	$(FLEXSPIN) -2 -o /tmp/rom_full.bin p2iss/rom/rom_booter_v33k.spin2
	python3 -c "open('p2iss/rom/rom_booter_v33k.bin','wb').write(open('/tmp/rom_full.bin','rb').read()[0xFC000:])"
	$(FLEXSPIN) -2 -o p2iss/rom/stage1.bin p2iss/rom/stage1.spin2

# Manual testing against the real P2 image on the ISS: a serial console for a
# human, not a host for the e2e suite.
#
# The PTY is DELIBERATELY NOT /tmp/tty.rpi. There are exactly two valid SIL
# configurations, and they pair a firmware backend with a way of providing
# serial:
#
#   native library + host Chrome  + fake serial over the WS/PTY bridge
#   real P2 image on the ISS      + Chrome in a QEMU guest + real Web Serial
#
# The cross pairing — the ISS behind the bridge — looks like it works and is
# worthless: the bridge hands the board's bytes to a browser running at host
# speed, so every wait in the suite measures the host's mood rather than the
# machine, and the ISS interprets far slower than real time. Only the QEMU
# guest can meter the browser by the board's clock. Sharing /tmp/tty.rpi with
# `playground` made that cross pairing the path of least resistance, because
# tools/sil-ws-bridge.mjs defaults to exactly that path; a separate path makes
# reaching for it a deliberate act instead of an accident.
#
# `--release` is not optional. The ISS interprets every instruction, and a debug
# build is slow enough that a human waiting on the console gives up.
playground-iss: p2image
	cargo run --release --bin mad-emulator -- --iss $(P2_IMAGE) --sd-path ./sd --pty-path /tmp/tty.iss --log-level info

# The computer node: the host is a QEMU guest running Chrome, metered by the
# board's clock (embsim-qemu). This is the ISS-side e2e configuration — the
# browser cannot outrun the board, because the board decides when the browser's
# vCPU gets to run at all. Build the guest image once (~10 min, cached outside
# the repo), then:
#   make vm-image
#   make playground-cosim            # prints the DevTools URL (port 9222)
#   cd ../Software/Control && npm run dev -- --host   # the guest fetches from 10.0.2.2:5174
#   cd ../Software/Control && CDP_URL=http://127.0.0.1:9222 npm run e2e
VM_IMAGE ?= $(HOME)/.cache/embsim/qemu/chrome-debian13-$(shell uname -m | sed 's/arm64/aarch64/').qcow2
vm-image:
	embsim/qemu/guest/chrome/build.sh

playground-cosim: p2image
	cargo run --release --bin mad-emulator -- --iss $(P2_IMAGE) --computer $(VM_IMAGE) --devtools-port 9222 --trace-port 9223 --sd-path ./sd --pty-path /tmp/tty.iss --log-level info

# Clean build artifacts
clean:
	rm -rf test-results
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(PIO_ENV) -t clean
