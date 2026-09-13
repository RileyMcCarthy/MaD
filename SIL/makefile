# MaD SIL Testing - Makefile
# 
# Commands:
#   make firmware   - Build firmware static library
#   make emulator   - Build Rust emulator (builds firmware if needed)
#   make test       - Build everything, run the Rust test suite
#   make playground - Build everything, start the emulator for manual testing
#   make playground-iss - Same, but running the real P2 image on the ISS
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

.PHONY: firmware p2image protocol emulator test playground playground-iss vm-image playground-cosim bootrom clean

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

# Start emulator + app for interactive development
playground: emulator
	cargo run --bin mad-emulator -- --sd-path ./sd --pty-path /tmp/tty.rpi --log-level info --trace-port 3000

# The same playground, but running the real P2 image on the ISS instead of the
# native firmware library. Same PTY, so every host-side tool and the browser
# e2e suite attach exactly as they do to the native emulator.
# `--release` is not optional here. The ISS interprets every instruction, so a
# debug build runs the guest far slower than real time and the app's 2 s
# protocol timeout expires before the firmware can answer. Measured on this
# machine: 0.64x real time in release.
# The boot ROM and the stage-1 flash loader the ISS boots through.
FLEXSPIN = $(HOME)/.platformio/packages/toolchain-flexcc/bin/macos-amd64/flexspin
bootrom:
	$(FLEXSPIN) -2 -o /tmp/rom_full.bin p2iss/rom/rom_booter_v33k.spin2
	python3 -c "open('p2iss/rom/rom_booter_v33k.bin','wb').write(open('/tmp/rom_full.bin','rb').read()[0xFC000:])"
	$(FLEXSPIN) -2 -o p2iss/rom/stage1.bin p2iss/rom/stage1.spin2

playground-iss: p2image
	cargo run --release --bin mad-emulator -- --iss $(P2_IMAGE) --sd-path ./sd --pty-path /tmp/tty.rpi --log-level info

# The computer node: the host is a QEMU guest running Chrome, metered by the
# board's clock (embsim-qemu). Build its image once (~10 min, cached outside the
# repo), then run the ISS with it; the e2e attaches over CDP:
#   make vm-image
#   make playground-cosim            # prints the DevTools URL (port 9222)
#   cd ../Software/Control && npm run dev -- --host      # the guest fetches the app from 10.0.2.2:5174
#   cd ../Software/Control && CDP_URL=http://127.0.0.1:9222 npm run e2e
VM_IMAGE ?= $(HOME)/.cache/embsim/qemu/chrome-debian13-$(shell uname -m | sed 's/arm64/aarch64/').qcow2
vm-image:
	embsim/qemu/guest/chrome/build.sh

playground-cosim: p2image
	cargo run --release --bin mad-emulator -- --iss $(P2_IMAGE) --computer $(VM_IMAGE) --devtools-port 9222 --sd-path ./sd --pty-path /tmp/tty.rpi --log-level info

# Clean build artifacts
clean:
	rm -rf test-results
	cargo clean
	cd $(FIRMWARE_DIR) && pio run -e $(PIO_ENV) -t clean
