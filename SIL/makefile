# MaD SIL Testing - Makefile
# 
# Commands:
#   make setup      - First-time setup (npm deps)
#   make firmware   - Build firmware static library
#   make emulator   - Build Rust emulator (builds firmware if needed)
#   make test       - Build everything, run Playwright tests
#   make playground - Build everything, start emulator + app for manual testing
#   make clean      - Remove build artifacts

FIRMWARE_DIR = ../Firmware/MaDCore
PIO_ENV = native_emulator
FIRMWARE_LIB = $(FIRMWARE_DIR)/.pio/build/$(PIO_ENV)/libfirmware.a
PROTOEMB_GENERATOR = ../Protocol/ProtoEmb/core/generate.py
PROTOEMB_SCHEMA = ../Protocol/MaDProtocol.yaml
PROTOEMB_TEMPLATES = ../Protocol/ProtoEmb/core/templates
PROTOEMB_RUNTIME_DIR = ../Protocol/ProtoEmb/runtime

.PHONY: setup firmware protocol bridge emulator test playground clean

# First-time setup
setup:
	npm install
	@echo "✅ Setup complete. Run 'make test' to run tests."

# Build firmware as static library
firmware:
	cd $(FIRMWARE_DIR) && pio run -e $(PIO_ENV)

# Generate Rust protocol types used by SIL (MaD-specific; kept out of the
# generic embsim crates — lands in the `protocol` crate at ../Protocol).
protocol:
	python3 $(PROTOEMB_GENERATOR) --schema $(PROTOEMB_SCHEMA) --target rs --output ../Protocol/rust/src/generated --templates $(PROTOEMB_TEMPLATES)

# Build generic ProtoEmb bridge binary used by MaDControl main process
bridge:
	cd $(PROTOEMB_RUNTIME_DIR) && cargo build --bin protoemb-bridge

# Build Rust emulator (depends on firmware library)
emulator: firmware protocol bridge
	cargo build

# Run tests
test: emulator
	npm test

# Start emulator + app for interactive development
playground: emulator
	cargo run --bin mad-emulator -- --sd-path ./sd --pty-path /tmp/tty.rpi --log-level info --trace-port 3000

# Clean build artifacts
clean:
	rm -rf test-results build
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(PIO_ENV) -t clean
