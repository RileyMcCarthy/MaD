# Spike 1c — QEMU linked into a Rust process

Part of [`docs/dev/p2-qemu-target-plan.md`](../../../docs/dev/p2-qemu-target-plan.md).
Artefacts: [`README.md`](README.md).

**Verdict: PASSED. Upstream QEMU links into a Rust binary and runs TCG from it,
at +0.4 % of `qemu-system` — statistically identical. The structural claim the
whole plan rests on is now proven rather than approximated, and the macOS
entitlement fear was unfounded.**

Measured 2026-09-20, M2, patched QEMU v10.1.0.

---

## Why this spike

The plan's central architectural claim is that QEMU must be **linked
in-process** (QBox-style `libqemu`), because pin ops have to reach embsim
synchronously at MHz rates. The plan calls this *"the single biggest
under-appreciated cost in this project"*.

Spike 0a measured the slice primitive using **Unicorn** as a stand-in — a fork
of QEMU 5.0 that is already a library. Nobody had linked **upstream** QEMU into
a foreign process. This does.

## What it took — three non-obvious things

1. **QEMU emits no `libqemu-<target>.a`.** Despite `libqemu-riscv32-softmmu.a.p`
   existing as a meson object collection, no archive is produced: the emulator
   is linked from a raw list of **764 object files** plus `libqemuutil.a`,
   `libfdt.a`, 20 dylibs and 4 frameworks (`CoreAudio`, `CoreFoundation`,
   `IOKit`, `vmnet`). The way in is to scrape that list out of `build.ninja`.
2. **Exactly one object defines `main()`** —
   `qemu-system-riscv32-unsigned.p/system_main.c.o`. Drop it and there is **no
   symbol collision with the Rust runtime at all**. That was the risk I most
   expected to bite, and it did not.
3. **The init seam is two calls.** `system/main.c` is only
   `qemu_init()` → `qemu_main_loop()` → `qemu_cleanup()`, and `qemu_init()`
   already does everything a host needs: builds the machine, creates the CPU and
   its vCPU thread, and autostarts via `qmp_cont()` → `vm_start()` →
   `resume_all_vcpus()`. It returns with the **BQL and replay mutex held** —
   `main()` releases both before handing off, and so must the shim. The entire
   C shim is:

```c
void p2lib_boot(int argc, char **argv)
{
    qemu_init(argc, argv);
    bql_unlock();
    replay_mutex_unlock();
}
```

## The macOS entitlement fear was unfounded

The build post-processes the binary with `scripts/entitlement.sh`, which looked
like a hard blocker for a foreign binary. It is not: the entitlement is
`accel/hvf/entitlements.plist` = **`com.apple.security.hypervisor`**, which is
for **HVF only**. TCG's `MAP_JIT` needs none of it — every measurement in this
whole spike programme has been run against `qemu-system-riscv32-**unsigned**`.

## The number

8 harts, quantum 48, `-icount shift=0,sleep=off`, best of 5, run back to back:

| | ns/inst |
|---|---|
| `qemu-system-riscv32` (reference) | 3.782 |
| **Rust process, QEMU linked in** | **3.796 (+0.4 %)** |

**Linking QEMU into a Rust process costs nothing measurable.**

> A first run showed 4.17 vs 3.21 and looked like a 30 % regression. It was
> machine load — the two binaries had been measured minutes apart. Always run
> the comparison back to back; this is the third time in this programme that a
> cross-run comparison produced a false result.

## What this does and does not prove

**Proven:**
- Upstream QEMU links into a Rust binary (763 objects, no symbol conflicts).
- `qemu_init()` + two unlocks is the whole initialisation seam.
- TCG executes, icount is exact (`insns/round = 384.00`), 8 vCPUs run.
- No macOS entitlement is required for TCG.
- The library configuration costs +0.4 %.

**Not yet proven:**
- **Rust's own thread calling `cpu_exec`.** Here QEMU's vCPU thread still drives
  the slice (via 0c's `QEMU_SPIKE_SLICE` hook); the *process* is Rust but the
  *caller* is not. Making the host thread drive it needs
  `rcu_register_thread()` + `tcg_register_thread()` on that thread and a
  `TCGAccelOps.create_vcpu_thread` override that creates none. That is the next
  increment, and nothing measured here suggests it is hard.
- A pin callback from TCG into Rust. 0a measured that shape at 19–27 ns through
  Unicorn, and 1a/1b proved the helper mechanism upstream; wiring the two
  together is mechanical.

## Caveats

- The link list is scraped from one configured build directory. A different
  `configure` line produces a different list, so `gen-build-rs.py` regenerates
  it rather than hard-coding.
- `-iquote` takes a separate argument and QEMU's `-I` paths are relative to the
  build directory; both must be fixed up or the shim will not compile. The
  generator handles it.
- macOS-specific: `system/main.c` runs a `CFRunLoop` on the main thread for UI.
  With `-nographic -display none` the shim skips it and nothing missed it, but a
  configuration that wants a UI would need that thread back.
