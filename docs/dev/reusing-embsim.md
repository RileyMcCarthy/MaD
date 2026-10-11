# Reusing embsim

**embsim** is the board engine behind MaD's emulator. It lives in its own
repository — [github.com/RileyMcCarthy/embsim](https://github.com/RileyMcCarthy/embsim)
— and is vendored here as the `SIL/embsim` git submodule. Its crates know
nothing about MaD's protocol or mechanics. This page is a pointer.

## What you provide

A board from its netlist, a core in the processor slot, and a host on the PTY.
The core drives and senses pads. The host is `HostPty`: bytes on `TX`/`RX`
become levels on the nets. The reference is a P2-EC32MB with the QEMU P2 core,
shown in the
[embsim README](https://github.com/RileyMcCarthy/embsim/blob/main/README.md#what-a-new-project-provides).

MaD's core is the instruction-set simulator in `SIL/p2iss`, seated as a
component named `P2` whose pins are `P0`..`P63`. The host is the same `HostPty`.

## How MaD uses it

| Crate | Role |
|---|---|
| `embsim-board`, `embsim-models`, `embsim-core` | Nets, device models, virtual clock, PTY |
| `p2iss` / `p2core` (`SIL/`) | The P2 image, executed instruction by instruction, as a board component |
| `models` (`SIL/models/`) | MaD physics: gantry, sample, strain gauge |
| `MaDSim` | The `mad-emulator` binary: ISS, bench, and host PTY |

The dependency graph is acyclic — no generic crate depends on a project crate.
See the [SIL emulator](../how-it-works/sil-emulator.md) page for the diagram.

!!! note "One emulator per process"
    The virtual clock and the host PTY are process-global. Run multiple
    processes to run multiple instances.
