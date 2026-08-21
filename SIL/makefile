# MaD SIL Testing - Makefile
# 
# Commands:
#   make firmware   - Build firmware static library
#   make emulator   - Build Rust emulator (builds firmware if needed)
#   make test       - Build everything, run the Rust test suite
#   make playground - Build everything, start the emulator for manual testing
#   make clean      - Remove build artifacts

FIRMWARE_DIR = ../Firmware/MaDCore
PIO_ENV = native_emulator
FIRMWARE_LIB = $(FIRMWARE_DIR)/.pio/build/$(PIO_ENV)/libfirmware.a
PROTOEMB_GENERATOR = ../Protocol/ProtoEmb/core/generate.py
PROTOEMB_SCHEMA = ../Protocol/MaDProtocol.yaml
PROTOEMB_TEMPLATES = ../Protocol/ProtoEmb/core/templates

.PHONY: firmware protocol emulator test playground clean

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

# Start emulator + app for interactive development
playground: emulator
	cargo run --bin mad-emulator -- --sd-path ./sd --pty-path /tmp/tty.rpi --log-level info --trace-port 3000

# Clean build artifacts
clean:
	rm -rf test-results
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(PIO_ENV) -t clean
