# Spike 1c artefacts — QEMU linked into a Rust process

Proves the structural claim the whole plan rests on. Spike 0a could only
approximate it with Unicorn; this links **upstream QEMU v10.1.0** into a Rust
binary and runs TCG from it. See `RESULTS.md`.

```bash
python3 gen-build-rs.py /path/to/qemu/build-prod   # writes build.rs
cargo build --release
QEMU_SPIKE_SLICE=48 QEMU_SPIKE_N=20000 ./target/release/qemu-lib-spike \
    -M virt -m 8M -smp 8 -bios none -icount shift=0,sleep=off \
    -nographic -monitor none -serial none -display none \
    -device loader,file=loop-nop.bin,addr=0x80000000,cpu-num=0   # ...x8
```

Needs the patched QEMU from 0c (`spike-rr-smp.patch` supplies `QEMU_SPIKE_SLICE`).

**Three things that make this work, none of them obvious:**

1. QEMU emits **no** `libqemu-<target>.a`. The emulator is linked from a raw
   list of 764 `.o` files. `gen-build-rs.py` scrapes that list out of
   `build.ninja` rather than trying to invent an archive.
2. Exactly one object defines `main()` —
   `qemu-system-riscv32-unsigned.p/system_main.c.o`. Drop it and there is no
   symbol collision with the Rust runtime at all.
3. `-iquote` takes a **separate** argument, and QEMU's `-I` paths are relative
   to the *build* directory. Both must be fixed up or the shim will not compile.
