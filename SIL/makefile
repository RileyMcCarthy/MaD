# MaD SIL Testing - Makefile
# 
# Commands:
#   make firmware   - Build firmware static library
#   make emulator   - Build Rust emulator (builds firmware if needed)
#   make test       - Build everything, run the Rust test suite
#   make playground    - Build everything, start the emulator for manual testing (real-time)
#   make e2e-emulator  - Start the emulator for the e2e suite (unpaced virtual time)
#   make clean      - Remove build artifacts

FIRMWARE_DIR = ../Firmware/MaDCore
PIO_ENV = native_emulator
FIRMWARE_LIB = $(FIRMWARE_DIR)/.pio/build/$(PIO_ENV)/libfirmware.a
PROTOEMB_GENERATOR = ../Protocol/ProtoEmb/core/generate.py
PROTOEMB_SCHEMA = ../Protocol/MaDProtocol.yaml
PROTOEMB_TEMPLATES = ../Protocol/ProtoEmb/core/templates

.PHONY: firmware protocol emulator test playground e2e-emulator clean

# Build firmware as static library
firmware:
	cd $(FIRMWARE_DIR) && pio run -e $(PIO_ENV)

# Generate Rust protocol types used by SIL (MaD-specific; kept out of the
# generic embsim crates — lands in the `protocol` crate at ../Protocol).
protocol:
	python3 $(PROTOEMB_GENERATOR) --schema $(PROTOEMB_SCHEMA) --target rs --output ../Protocol/rust/src/generated --templates $(PROTOEMB_TEMPLATES)

# Build Rust emulator (depends on firmware library)
emulator: firmware protocol
	cargo build

# Run tests
test: emulator
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

# Clean build artifacts
clean:
	rm -rf test-results
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(PIO_ENV) -t clean
