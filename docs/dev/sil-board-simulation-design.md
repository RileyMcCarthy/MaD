# Design: Netlist-grounded board simulation for SIL

**Status:** design accepted (2026-07-11, revised after adversarial review); Phase 0 implemented
**Scope:** MaD-side view — system architecture, decision record, integration and phasing. The generic engine design lives upstream in [`SIL/embsim/BOARD_ENGINE.md`](https://github.com/RileyMcCarthy/embsim).

## Motivation

Today the SIL machine is hand-assembled in `SIL/MaDSim/src/wiring.rs`: Rust model
objects soldered together with callbacks and file descriptors. That wiring encodes
what we *meant* the hardware to be, not what the PCBs *are* — so an entire class of
real-world failures is invisible to simulation by construction.

The July 2026 force-gauge bring-up made that cost concrete. Every blocking bug was
found on the bench with a multimeter and a logic analyzer; the table below shows
what a netlist-grounded simulation reproduces, **with the specific engine
mechanism that fires** (each row was adversarially traced through the engine
spec):

| Real bring-up bug | Hand-wired SIL | Netlist-grounded SIL — mechanism |
|---|---|---|
| ADS122U04 `~RESET` floating (net has exactly one pin) → chip never responds | invisible | **caught**: build-time resolution pass reports `FloatingSense` to the chip model, whose datasheet behavior is silence |
| AVDD unpowered (analog domain isolated on PCB) → POR never releases | invisible | **caught**: VDDA net has no `PowerOut` source → `PowerNetUnsourced`; model's `PowerIn` sees domain down |
| TX/RX crossed in the harness | invisible | **caught**: stream routing finds producer-facing-producer through the collapsed 47 Ω series Rs → `StreamMismatch` (+ `Contention` on the fought net; mid-rail voltage available from the Thevenin solve) |
| JP1/JP2 solder jumpers open → ADC inputs floating, wild readings | invisible | **caught**: source-free analog cluster solves to `Floating`; ADC model applies its declared floating-input noise policy (deterministic signature the regression asserts) |
| PGA common-mode range at gain 128 | invisible | **caught**: load-cell transducer contributes parameterized bridge-leg resistors to the cluster; MNA yields absolute AIN voltages; range check lives in the ADC model, reading gain/mux from its own firmware-written registers |
| UART auto-stream byte rotation | found on bench; protocol model then extended (RDATA/manual mode) and now regression-covers the fix | same — the byte-*drop trigger* is out of scope at byte-pipe fidelity in both columns; `stream_drop` fault injection exercises loss-handling paths |

The bug class that burns us is **connectivity and power-domain truth** — exactly
what the KiCad schematics already encode.

## Decision record: SPICE vs netlist + chip models

**Decision: netlist-structural simulation with behavioral chip models and a
lightweight quasi-static analog solver. No SPICE engine in the core.**

The deciding observations:

1. **The dichotomy is partly false.** Vendors do not publish SPICE models for
   digital-heavy mixed-signal parts (there is no SPICE model of the ADS122U04's
   UART state machine). Behavioral Rust chip models must be written either way;
   SPICE could only ever cover the passives.
2. **Our passives don't need SPICE.** The analog content of these boards is a
   Wheatstone bridge (resistor algebra — the bridge itself is the off-board load
   cell, contributed to the solver as parameterized legs), RC filters
   (closed-form single-pole), dividers and pull-ups (algebra). Quasi-static
   nodal analysis recomputed on input change answers every question these
   circuits pose, deterministically, orders of magnitude faster than transient
   SPICE.
3. **SIL runs near-real-time.** Playwright drives a real UI build (currently the
   frozen legacy Electron app; the shipped WASM app has its own emulator harness
   in `Software/MaDWasmControl/e2e/`) over a PTY while firmware makes ~1 kHz ADC
   round-trips against the virtual clock. Lockstep SPICE transient across
   seconds of virtual time is a 10–1000× wall-clock cost with no additional
   bug-catching power for this hardware.
4. **Escape hatch preserved at zero cost.** The analog cluster solver sits behind
   a trait; a SPICE backend is a future additional implementation, not a rewrite.
   We revisit only if a bench bug appears that quasi-static + closed-form-RC math
   cannot express. Until then, no ngspice dependency, no cluster-marking syntax.

## Architecture: component-centric SIL

The architectural inversion: **the firmware is not the center of the simulation.
The P2 is one component among peers.** A simulated *system* is:

```
System
├── Board "EdgeBoard"    netlist → parts: P2Component(firmware.a), inverters,
│                        isolators, transceivers, regulators, LEDs, connectors…
├── Board "DS2Addon"     netlist → parts: ADS122U04, series Rs, decoupling Cs,
│                        solder jumpers, connectors (the bridge itself is the
│                        off-board load cell, modeled as a transducer plant)
├── Harness "machine"    EdgeBoard J? ↔ DS2Addon J1, pin-to-pin  (or "bench")
└── Plants               gantry, sample, load-cell physics — attached at
                         transducer components (the only part a netlist
                         cannot express)
```

`wiring.rs` shrinks to: the system description (which boards, which harness,
which scenario overrides) plus the physics plant models.

### The P2 as a component

The P2 component's **boundary is its pins**; its internals are:

1. **The firmware image** — `libfirmware.a` built by `pio run -e native_emulator`,
   entered via `mad_begin()` on a component-owned thread.
2. **The silicon peripherals** — embsim's serial/GPIO/pulse/encoder/i2c
   emulations, today process-global channel tables, becoming fields of the P2
   component instance (they live inside the silicon on the real part). This
   dissolves the emulator-side half of the single-instance constraint; the
   firmware's own C statics still limit one P2-running-a-given-image per
   process. The trampoline-routing consequences are an embsim `CONTRACT.md`
   revision — see the engine doc.
3. **The pin facade** — the HAL channel → physical pin map, read from the
   firmware's own compiled HAL config tables (see Phase 0), so the component's
   pinout is derived from the same data that runs on hardware. A pin-config vs
   PCB mismatch becomes a visible SIL failure, exactly as it would be on the
   bench.

Behavioral granularity stays at the HAL level (a serial channel is a byte pipe
attached to pins — with routing through the board's series resistors derived
from the netlist — not a bit-timed shift register). If a bug class ever demands
bit-level timing, that is a peripheral-internal upgrade behind the same pin
interface.

### The P2 Edge Module gap

The EdgeBoard netlist contains the **socket** (`P2_EDGE_MODULE_SOCKET`), not the
P2 Edge Module that plugs into it — the module is a separate Parallax product
(its own PCB: P2 chip, boot flash, LDOs, pull-ups, and on the EC32MB variant,
PSRAM). The baseline plan folds the module into the P2 component (chip pin ≡
edge finger, module internals behavioral). That assumption is **known to hide
real failure classes we have already hit**: the boot-flash/SD bus sharing on
P58–61 is module-internal wiring (it cost us the silent flash-boot failure in
bring-up), and the EC32MB variant keeps P40–P57 for its PSRAM and brings none
of them to its card edge, so the RPI serial pins (P53/P55) the debug build used
until the Edge v0.3 pin move (below) had no path to the chip. Module choice is a pin-validity question the
simulation should enforce.

Parallax publishes the module schematics (PDF for both variants; their EDA
source is DipTrace, not KiCad). Upgrade path, in increasing fidelity:

1. **Pin-map + reservation table** (cheap, phase 3): the module as a behavioral
   component with an authoritative finger↔chip-pin map and per-variant
   reservation list transcribed from the product guide. Catches the
   reserved-pin and shared-bus *conflict* class.
2. **Module-as-board** (full): transcribe the module schematic (~a few dozen
   parts) into a committed netlist, diff-checked against the published PDF
   revision; the P2 *chip* becomes the true MCU component boundary, flash/LDOs/
   pull-ups become registry parts, and socket↔module mating is a generated
   1:1 80-finger harness. This makes flash-bus contention and module power
   domains simulable truths.

Sourcing for (2), decided: **export a netlist from Parallax's DipTrace sources
once** (DipTrace free tier + a small importer for its netlist dialect). Vendor
module netlists are one-time committed artifacts pinned to the module revision —
exempt from the CI-regeneration rule, which applies to boards we author in
`Hardware/`. Re-export only if the machine's module is ever revised.

**The machine uses the EC32MB variant**, and auditing the EdgeBoard netlist
against its reservation table (P40–P57 = PSRAM) already produced a real
finding before any engine exists: the EdgeBoard wires reserved pins — isolator
IC2's outputs drive P52/P53 and its inputs take P54/P55 (the RPI serial path,
matching `HW_PIN_RPI_RX/TX` = 53/55 as they then were), and header J24 fans
out P40–P47. None of
these lines reaches the chip: the EC32MB has no card-edge finger for P40–P57
(fingers 55, 56, 59–67 and 69–77 are no-connects; read: the header of embsim's
`boards/netlists/p2_ec32mb.net`, transcribed from Parallax's Rev B schematic).
So a Pi on J4 cannot talk to the firmware, and the debug build's MAIN channel
on P53/P55 ran on the PSRAM's own pins: a host on J4 received nothing
(measured on #278's first round, before the route below). The phase-3 tier-1
gate is that the reservation table reproduces exactly this finding.

**The route, decided (2026-10-21).** The user's decision: the app reaches the
firmware over the carrier's debug header J1 (P62/P63, RESn on J1.3), with the
**production** build (pio env `propeller2`), through a Prop Plug. The app
flashes over J1 (`Software/Control/README.md`, "Firmware flashing", which
covers flashing only). That build's MAIN channel receives on P63 and
transmits on P62 at 2,000,000 baud (`HW_pins.h`, `HAL_serial_config.c`),
and J1's P62/P63 go straight to the
socket's fingers 50 and 49 (`mad_edge.net`). `SIL/mad.toml` and its three
twins put the host there, the production image in the module's flash, and
nothing on J4; `SIL/mad-catalog/tests/mad.rs` holds the protocol round trip
over J1. The debug build stays where a run needs its log on P62 or its MAIN
channel on a bare chip's P30/P32 (P53/P55 before the move below;
`mad-emulator`, the `p2core`/`p2iss` suites, `mad-catalog/tests/boot.rs`).
Two other ways out were not taken then: a plain P2-EC module in J3 (the
socket symbol names it; embsim has no `p2-ec` kind or netlist), and moving
the debug build's MAIN channel, which needs a carrier change too, since J4's
RPI_RX/RPI_TX reach only IC2.

**The debug build's MAIN moved (2026-10-25, MaD #309).** The Edge carrier
v0.3 puts IC2's carrier side on P29–P32, pins the EC32MB brings to fingers
11–8 (read: `p2_ec32mb.net`), and the debug build's MAIN channel follows:
P30 receives from IC2's OUTC (pin 5) and P32 drives its INA (pin 3) (read:
the v0.3 netlist exported from `Hardware/EdgeBoard/KiCad`; `HW_pins.h`).
`mad-emulator` and the `p2core`/`p2iss` suites put the host on P30/P32. The
SIL's `mad_edge.net` is still the carrier before v0.3, IC2 on P52–P55, so
what this section finds about J4 holds for the project files' board until
that netlist is refreshed. The production build's MAIN is unchanged, on
P62/P63.

**Open: which image the machine runs.** The app as shipped flashes a
release's madEdge image by default, the `propeller2_debug` build
(`Software/Control/src/firmware/release.ts`, `pickFirmwareAsset`; the release
job in `.github/workflows/ci.yml`), whose protocol is on P53/P55 in every
release so far, which the EC32MB cannot reach (above; P30/P32 since the move
above); the single-port production build is the
release's `-release.bin`, which the app flashes only as a local file. The
bench has an FT232R attached, USB `0403:6001`, beside the P2-EVAL's FT231X
(measured: `ioreg`, 2026-10-21; what the FT232R is wired to is not known);
`0403:6001` is the id `mad-emulator` gives its host. If the machine runs the
madEdge image, the route needs revisiting: a released image's protocol reaches
the chip only on a module with fingers for P53/P55, such as the plain P2-EC
(inferred), and one built since the move reaches it on a v0.3 carrier's J4. If it runs the production image, the app's default asset would
need changing to match.

**IC14, the servo isolator.** IC14 (ISO6741DWR: STEP, DIR, ENA out to the
drive, SRDY back) has its secondary ground pins 9 and 15 on an unnamed net
with only C26 pin 2 on it, not on EN_GND (read: `mad_edge.net`,
`Net-(IC14-GND2_1)`; the PCB has the same pads on the same net). As drawn,
nothing IC14 drives reaches the drive, and its output to P5 gives its
default high whatever SRDY says (`SIL/mad-catalog/tests/mad.rs`, the at-rest
case). Whether the machine's carrier is bodged there is not known; the
project files keep the board as drawn.

### Part classification (no separate "type file")

Every KiCad netlist component carries a `libsource` (lib + part). The **part
name** reliably encodes function class; the lib name is best-effort (real
exports from our boards contain empty lib names and `*-rescue` libs), so
classification keys on the part name with rescue-mangling normalized. Three
tiers (full rules in the engine doc):

1. **Auto-assigned**: `R*`/`C*`/`L*`/`LED`/`D_*` passives (values parsed:
   `47R`, `0.1uF`, `4k7`; two-terminal classes are pin-count-validated),
   `Conn*` boundaries, `Jumper*` stateful shorts (default from the name:
   `_NO`/`_Open` open, `_NC` closed — our boards use `Jumper_NO_Small`
   via a rescue lib and `Jumper_2_Open`/`Jumper_3_Open`), mechanical ignored.
2. **Registry lookup** for everything else — active parts come from custom
   *and* standard libraries alike. Measured on the real netlists: the DS2Addon
   needs one registry entry (`ADS122U04` → the existing protocol model, given
   rescue-lib-tolerant jumper matching); the EdgeBoard (168 components) needs
   **~17 part types**, several as explicit stubs: the `SN74LVC1G14` Schmitt
   inverter, seven isolator/optocoupler types (`VO2631`, `6N137`, `ISO6721B`,
   `ISO6731`, `ISO6740F`, `ISO6741`, `ISO6742`), the `AM26LS31`/`AM26LV32`
   RS-422 transceivers, `XL1509`/`UCC12040` regulators as power-domain sources,
   the `NSI50010` LED driver, `APM4953` and `2N3904` discretes, `SW_Push`, and
   `P2_EDGE_MODULE_SOCKET`. Most are one-line behaviors or stubs; the socket is
   the load-bearing one.
3. **Hard error on unknown parts.** A missing model fails system construction,
   with an explicit per-board stub list for genuinely don't-care parts. Never
   silently ignore.

**DNP policy:** this repo marks do-not-populate parts with `value = "X"`; the
engine treats those (and KiCad's native `dnp` attribute, when present) as
absent. Solder jumpers are present but stateful, overridable per scenario.

### Harness files — the only hand-maintained wiring

Three links connect firmware to a peripheral chip; two are derived:

| Link | Source of truth |
|---|---|
| HAL channel → P2 pin | firmware HAL config tables (Phase 0), read from `libfirmware.a` |
| P2 pin → board net | EdgeBoard netlist (`P2_EDGE_MODULE_SOCKET` pin map) |
| **board ↔ board** | **harness file** — no schematic describes the cable loom |

The harness file is small data (TOML), one per physical setup. Bench-rig
endpoints that source power declare it, which is how a strap makes a power
domain live:

```toml
# harness/bench.toml — P2-EVAL bring-up rig
[[connect]]
from = "P2EVAL.P0"                # bare MCU-pin endpoints allowed for bench rigs
to   = "DS2Addon.J1.4"            # silk "TX"
[[connect]]
from = "P2EVAL.3V3"
kind = "power(3.3V)"              # sources the domain — this is the AVDD strap
to   = "DS2Addon.J2.1"
# …
```

Harness errors are a real-world failure mode (the crossed TX/RX cost a bench
day); deliberately broken harnesses are checked in as regression fixtures, with
the engine's `StreamMismatch`/`Contention`/`FloatingSense` findings as the
assertion targets. Grounds are connected explicitly — the engine never merges
same-named nets across boards.

## Phasing

**Phase 0 — HAL config/implementation split** (firmware-only, standalone value)
Extract the per-channel config tables (`HAL_serial_channelConfig`, GPIO,
encoder, pulse-out) from `src/HAL/P2/*.c` into **data-only** translation units
(`src/HAL/Config/*.c` — no HAL function definitions, no P2 intrinsics, so they
compile natively without colliding with the emulator's Rust HAL trampolines),
with **external linkage**, unique `HAL_`-prefixed names, and
`__attribute__((used))`; struct definitions to `HAL/Include`; the units added
to the base `build_src_filter` so both targets compile them. The P2
implementations consume them unchanged. The emulator reads the table *values*
from `libfirmware.a` itself (symbol + DWARF layout over the archive's data
sections — the linker never extracts data-only archive members into the
process image, so the archive is the readable source of truth), with a
build-time check that the table symbols are present in the archive. Side effect: the
emulator's *default* pacing comes from the firmware's own table instead of an
independent guess — `MAD_SIM_BAUD` remains as an explicit test override (the
low-baud session-regression test and instant-TX playground mode depend on
overriding the firmware's 2 Mbaud).
*Gate:* both P2 and native targets build; SIL boots and the force path runs;
CI table-presence check green.

**Phase 1 — `embsim-board` + DS2Addon pilot**
Netlist parser (version-gated), `Component` trait, single-writer net engine
with Thevenin drive resolution, cluster MNA v1, stream routing, part registry;
minimal two-node system: P2 component + DS2Addon board + bench harness.
*Gate:* the force path works as today (happy-path Playwright equivalence),
**and** three bench-bug scenarios reproduce as SIL regression tests:
floating-`~RESET` (via `pin_detach` on the pull-up once the board rev adds R10,
or stock netlist for pre-R10 boards), AVDD-unstrapped (harness without the
power connect), and crossed TX/RX (swapped harness fixture).

**Phase 2 — net semantics hardening + peripheral ownership**
Power-domain volts everywhere, contention/ambiguous-level diagnostics
completeness, jumper/DNP scenario overrides, fault algebra
(`pin_detach`/`pin_short`/`net_stuck`/`value_override`/`stream_drop`); embsim
peripherals move from process globals into the P2 component instance
(CONTRACT.md revision upstream).

**Phase 3 — EdgeBoard + machine harness**
Hierarchical-sheet netlist ingestion, the ~17-entry EdgeBoard registry (mostly
stubs), machine harness file; `wiring.rs` reduced to system description + plant
models. CI regenerates netlists from `Hardware/` (committed, diff-checked) so
simulation cannot drift from the schematics.

## Testing strategy

- **Engine unit tests** (upstream, embsim): netlist parsing fixtures per KiCad
  major, net-state truth tables including impedance-escalation boundaries, MNA
  hand-checks (bridge, dividers, source-free singular clusters), stream-routing
  cases.
- **Scenario regression tests** (MaD): each real bring-up bug becomes a named
  scenario asserting the specific engine finding and the model-level failure
  signature (silent ADC, POR-held chip, `StreamMismatch`).
- **Equivalence gate** (migration safety): phase 1 must keep force-path
  behavior equivalent to the current hand-wired path for the happy-path
  Playwright suite.

## Upstream split (embsim is a standalone repo)

| Lands upstream (embsim) | Lands in MaD |
|---|---|
| `embsim-board` crate: netlist parser, `Component` trait, net engine, cluster solver, stream routing, registry + fault-algebra mechanisms | Part registry *entries* (ADS122U04 → model, EdgeBoard actives/stubs) |
| Auto-classification of standard part classes | Board netlist exports (`Hardware/` → committed artifacts) |
| MCU-as-component pattern + CONTRACT.md revision | Harness files (bench, machine, broken-fixture variants) |
| Peripheral de-globalization | Plant models + system description (`wiring.rs` successor) |
| SymbolResolver value-read path in memory-inspect | HAL/Config data-only TUs (Phase 0, firmware) |

Per repo policy: engine changes are committed and pushed upstream first (embsim
CI gates), then MaD bumps the submodule pin.

## Decisions (were open questions)

1. **Netlist artifacts: regenerate in CI + diff-check against committed
   exports** for boards authored in `Hardware/` — schematic changes appear as
   reviewable netlist diffs in PRs. Vendor netlists (P2 Edge Module) are
   one-time committed artifacts pinned to a module revision.
2. **Fault injection is test-only** — no trace-viewer surface initially.
3. *(still open)* Bench-rig boards (P2-EVAL): trivial board definition vs raw
   MCU-pin harness endpoints — the design allows both; pick when phase 1 lands.
4. **EdgeBoard actives get real behavioral models only where they add
   bug-catching value at negligible runtime cost**; the default is a gated-wire
   stub. Latency rule of thumb: nothing on a net-resolution path may block or
   add per-event work beyond O(cluster) — a model that needs its own thread or
   timers must justify itself with a concrete failure class it catches.
5. **The machine uses the P2 Edge Module EC32MB.** Consequences: the
   reservation table (P40–P57) is mandatory in phase 3 tier 1 and already
   surfaces a real EdgeBoard conflict (RPI serial via IC2 + J24 on reserved
   pins — see "The P2 Edge Module gap"); the module netlist comes from a
   one-time DipTrace export.
