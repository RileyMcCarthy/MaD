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
FIRMWARE_LIB = $(FIRMWARE_DIR)/.pio/build/native_emulator/libfirmware.a

.PHONY: setup firmware emulator test playground clean

# First-time setup
setup:
	npm install
	@echo "✅ Setup complete. Run 'make test' to run tests."

# Build firmware as static library
firmware:
	cd $(FIRMWARE_DIR) && pio run -e native_emulator

# Build Rust emulator (depends on firmware library)
emulator: firmware
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
	cd $(FIRMWARE_DIR) && pio run -e native_emulator -t clean
