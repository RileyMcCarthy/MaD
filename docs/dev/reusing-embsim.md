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

MaD's core is the instruction-set simulator in `SIL/p2iss`. In MaD's project
files (`SIL/mad.toml` and its twins) it sits in the P2-EC32MB's package as
the `mad-p2iss` core, the carrier, the add-on and the machine are kinds of
`SIL/mad-catalog`, and the host is a `host-serial` (a PTY) or a `chrome-cdp`
(the host's Chrome on the board's clock) on the carrier's debug header `J1`;
`embsim run` hands the files to `SIL/mad-runner`, the embsim command over
MaD's kinds. `mad-emulator` seats the same ISS as a component named `P2`
whose pins are `P0`..`P63`, with a `HostPty` or `--chrome` on `P30`/`P32`,
for SERVO-stall alone until a project can jam the carriage (MaD #298;
embsim `MIGRATING-MAD.md` step 11).

## How MaD uses it

| Crate | Role |
|---|---|
| `embsim-board`, `embsim-models`, `embsim-core` | Nets, device models, virtual clock, PTY |
| `p2iss` / `p2core` (`SIL/`) | The P2 image, executed instruction by instruction, as a board component |
| `models` (`SIL/models/`) | MaD physics: gantry, sample, strain gauge |
| `mad-catalog` (`SIL/mad-catalog/`) | MaD's kinds: the Edge carrier and the DS2 add-on from their netlists, the ISS as the P2's core, the machine |
| `mad-runner` (`SIL/mad-runner/`) | The embsim command over MaD's kinds, which `embsim check` and `embsim run` build and run for the project files; the e2e's board is `embsim run mad-cosim.toml` |
| `MaDSim` | The `mad-emulator` binary: ISS, bench, and host PTY or Chrome; it runs SERVO-stall alone (`make e2e-stall`), until a project can jam the carriage (MaD #298) |

The dependency graph is acyclic — no generic crate depends on a project crate.
See the [SIL emulator](../how-it-works/sil-emulator.md) page for the diagram.

!!! note "One emulator per process"
    The virtual clock and the host PTY are process-global. Run multiple
    processes to run multiple instances.
