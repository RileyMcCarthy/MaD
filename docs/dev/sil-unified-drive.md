# One drive type — scope

**Goal:** a component has exactly one way to put a signal on a net. Everything
that crosses a wire is a `Drive`, resolved by the resolver, and nothing routes
around it.

Follow-on to [`sil-lossless-net-transport.md`](sil-lossless-net-transport.md),
which said this and then only did half of it:

> Two encodings, both lossless, both drives on a net, chosen by which is exact
> for the signal. **Nothing else.**

`Level` landed (embsim #37–#39). `Periodic` did not — the step clock is still a
parallel channel with its own routing pass, its own `StreamRole`, and its own
`pulse_tx`/`on_pulse` surface. This scope closes that.

Numbers here are measured or read out of the code; every claim cites where it
came from. An adversarial audit of the proposal (47 agents, four lenses, every
claimed obstacle handed to a separate agent told to refute it) produced **no
surviving obstacle** — but it did correct several of this document's original
estimates, which are given below as measured rather than guessed.

## What still bypasses the net

The pulse channel, and it bypasses harder than the byte route did.

A `StreamRole::PulseSource` pin **contributes no drive of its own**. The pulse
bridge holds a `PulseTx` and never sets the pin's electrical state; the only
`set_drive` calls in `board/src/mcu.rs` are the GPIO bridge (1191, 1212). The
train rides `pulse_routes`, gated only by `route_is_signal_capable`.

Consequences, all currently true:

- A step line fought by a stuck-low driver **shows nothing**. The waveform is
  not a source, so it cannot contend.
- The channel works only because something *else* sources the net — a pull-up,
  an isolator output — since `route_is_signal_capable` refuses to deliver on a
  `Floating` net.
- `mcu.rs`'s own comment says a step pin "also holds a resolvable idle level".
  It does not. That comment is false today and should go regardless.

Same shape as the byte route: the net decides reachability, the payload goes
around the resolution.

## The interface

```rust
enum Drive {
    /// One resolved level.
    Level    { thevenin: TheveninDrive },
    /// A square wave: two levels and the schedule that alternates them.
    Periodic { hi: TheveninDrive, lo: TheveninDrive, segment: PulseSegment },
}
```

The original sketch proposed `rate_hz: f64`. That is **wrong**, and why is the
most important constraint here.

## The constraint: the rate is not just a rate

`PulseSegment` is `{ emitted, freq_hz, total, since_us }` — a rate *plus
accounting* — and `emitted_at` is pure integer arithmetic
(`peripherals/src/pulse_out.rs:119`):

```rust
let elapsed = now_us.saturating_sub(self.since_us);
let grown = self.emitted.saturating_add(
    elapsed.saturating_mul(u64::from(self.freq_hz)) / 1_000_000);
match self.total { Some(total) => grown.min(total), None => grown }
```

That is the same arithmetic `HAL_pulseOut_run` hands the firmware. An `f64`
rate would replace exact integer accounting with float integration and
reintroduce drift into the one path that currently has none. The rate is
already `u32` everywhere it exists (`pulse_out.rs:393`, `:434`), so keeping it
integral costs nothing.

**What each field is actually for** — this is sharper than "the count":

- `since_us` — **load-bearing**. The anchor is what makes a relayed segment
  self-describing, and what lets a consumer fold up to exactly the instant the
  successor segment began.
- `total` — **load-bearing**. The ceiling of a finite move. Without it a move
  stops on a wake instead of on a count.
- `emitted` — *not* needed for delta-folding; `stepper_motor::fold`
  (`models/src/machine/stepper_motor.rs:538`) only ever takes differences. It is
  needed for two other things: **agreement across observers** (it is banked once
  at the source, so N sinks plus the isolator plus `pulse_out::emitted()` all
  derive the identical integer rather than each truncating its own), and **late
  joiners**.

The late-joiner point resolves in the proposal's favour, but only because
`Periodic` carries the segment. Today `pulse_state` replays the last train to a
sink that registers afterwards (`engine.rs:1706`). Under drives, `on_sense`
already delivers the current state once at registration — so a late sink still
gets the absolute count, *provided the state carries it*. Carry `rate_hz` alone
and a late joiner starts from zero.

`board/tests/isolation_bridge.rs:927` pins the whole property:

```rust
assert_eq!(received.last().pulses.emitted, published,
           "the relayed count is the source's own, verbatim");
```

So `Periodic` carries the segment. A drive is allowed to be a rich value — the
point of unification is that it goes through the resolver, not that it is
scalar.

`PulseSegment` itself is **not** deleted by this work: it lives in
`embsim_peripherals::pulse_out` and board only re-exports it
(`component.rs:29`). The peripheral needs it for its firmware-facing API
regardless of what the wire does.

## What resolution has to learn

**`NetState` gains a periodic projection:**

```rust
Periodic { hi: Level, lo: Level, segment: PulseSegment }
```

Resolution rules, and which are genuinely ambiguous:

| against | answer | ambiguous? |
|---|---|---|
| a static drive, same impedance | `Contention` — a sustained fight for half of every cycle | no |
| a pull-up (10 kΩ vs 25 Ω) | follows the square wave | no |
| another `Periodic`, different rate | `Contention` | no |
| another `Periodic`, same rate **and phase** | agrees — one square wave | **yes**: phase is not modeled today |

The last row is a decision, not a discovery. `since_us` and `freq_hz` make phase
derivable, but two sources agreeing by construction is a wiring situation the
reference machine does not have, and `Contention` is the safe answer until
something needs otherwise. Write the decision down where the resolver makes it.

**Escalation works.** `ClusterSolver` is pure and stateless
(`board/src/cluster.rs:150`):

```rust
fn solve(&self, cluster: &Cluster, inputs: &ClusterInputs) -> ClusterSolution;
```

`ClusterInputs` is just `{ sources: Vec<ClusterSource> }`, so "solve twice, once
per phase" is two calls with two source lists and no interface change. Not
transient analysis — the existing quasi-static solve, run twice, for escalated
clusters only.

**The sense change gate needs a rule.** `same_state` (`engine.rs:1148`) decides
whether to deliver a sense. A periodic state is time-varying, so "changed" must
mean *the segment changed* — compared by identity, `since_us` included — not
*the instantaneous level changed*. Otherwise every bit of virtual time is a
change and the engine emits one event per edge, which is exactly what the rate
representation exists to avoid.

## The consequence worth deciding deliberately

**The isolator stops being a pure pass-through.**

`Iso67xx::apply_train` (`models/src/isolation/iso67xx.rs:769`) forwards a
segment without touching it, and its docs say why: *"it carries its own anchor
and accumulated count, so forwarding it neither re-bases nor double-counts."*

Under a `Periodic` drive the isolator presents its **own** drive on the output
pin, anchored at the instant it re-drove. And its output already depends on the
far-side rail (`desired_drive`, `iso67xx.rs:729`), so any supply wobble that
changes the rail re-drives the channel — and would re-anchor the phase. A pure
pass-through becomes a re-origination.

This is fixable (forward the received segment verbatim as the drive's payload
rather than re-anchoring), but it must be *decided* rather than discovered, and
`isolation_bridge.rs`'s verbatim-count assertion is the test that catches
getting it wrong.

## Cost

**A `Periodic` drive is still one command per rate change.** The 918 ns/edge
argument against per-edge step trains is untouched; nothing here makes a step
clock emit edges. `isolation_bridge.rs`'s load-bearing assertion —

```rust
assert_eq!(slow.1, fast.1,
    "engine cost must be identical at a hundredfold higher rate");
```

— survives: cost stays independent of rate.

**But a rate change gets more expensive, and here is the measurement.** Today
`pulse_update` (`engine.rs:1511`) is a route lookup plus delivery. Every *drive*
runs `apply_ready_drives` → `resolve_and_publish` (`engine.rs:1570`), which
resolves every net and walks every net for change detection. Probed on the real
isolation rig, four changes on the STEP endpoint:

| path | records per change |
|---|---|
| level (drive) | **14** |
| train (pulse update) | **2** |

So roughly 7× per rate change. That is bounded and rare — four rate changes per
move profile — and the engine already pays exactly this cost far more often for
serial levels on the same board. But `RELAY_EVENT_CEILING`
(`isolation_bridge.rs:822`, currently `32`) will need re-measuring. **Raise it
with the number and the reason**; a ceiling that moves without explanation stops
being a guard.

## What gets deleted

| gone | where |
|---|---|
| `StreamRole` — the whole type | `component.rs:66` |
| `PulseTx`, `ComponentNetIo::pulse_tx` / `on_pulse` | `component.rs:418`, `:515` |
| `Command::{PulseUpdate, RegisterPulseSink}`, `PulseCallback` | `engine.rs:247`, `:197` |
| `Resolver::route_pulses`, `PulseRouteSpec` | `engine.rs:1060`, `:475` |
| `LivePulseRoute`, `pulse_routes`, `pulse_subs`, `pulse_state` | `engine.rs:1295`, `:1322` |
| `pulse_update`, `deliver_pulse_to`, `route_is_signal_capable` | `engine.rs:1508`, `:1554` |
| `PinDecl::stream` and its build-time validation | `component.rs`, `system.rs` |
| `ChannelRole` — an isolator channel becomes just a channel | `iso67xx.rs` |
| `Finding::StreamMismatch` — two `Periodic` drives is `Contention` | `diagnostics.rs` |

`StreamRole` disappearing is the tell that this is the right shape: the type
exists only to name channels that bypass the resolver. When there are none, it
has nothing to name.

## Blast radius — measured, not estimated

A probe variant was added to `NetState` and `cargo check --workspace
--all-targets` run to a fixpoint.

**Exactly seven sites fail to compile**, all one-line additions:

| site | what |
|---|---|
| `board/src/net.rs:147` | `level_of` |
| `board/src/event_log.rs:237` | `state_form` |
| `models/src/isolation/mod.rs:220`, `:265` | `supply_up`, `threshold_level` |
| `models/src/machine/mod.rs:110` | `digital_level` |
| `models/src/ads122u04_component.rs:217` | `supply_ok` |
| `board/tests/machine_parts/mod.rs:196` | `level_of` |

**The hazard is the opposite of the intuition.** Every *other* `NetState` match
already has a wildcard and compiles silently, taking a defensible-looking wrong
path:

- `node_volts` in `nsi50010.rs:254`, `vo2631.rs:268`, `npn_switch.rs:213` —
  `_ => None`, so the device reads as off.
- `rail_volts` (`isolation/mod.rs:235`) — `_ => nominal`, so a periodic rail
  silently reports its nominal voltage.
- `contact_volts` (`end_switch.rs:351`) — inherits the same.

None of those is *wrong* for a periodic net (a square wave has no single
operating point, and "no level, hold the last value" is the established
contract), but each is a silent decision. **Audit the wildcards explicitly**;
the compiler will not.

**MaD is unaffected.** `SIL/MaDSim/src/wiring.rs:265` hand-wires the carriage
off the peripheral bank directly (`pulse_out.on_progress`), and
`system_description.rs:53` says so: *"GPIO, encoder, and pulse-out stay
hand-wired."* Nothing under `SIL/MaDSim` or `SIL/models` mentions `PulseTrain`,
`on_pulse`, `pulse_tx`, `StreamRole`, or `bridge_pulse_out`. No MaD PR beyond a
submodule bump.

Consumers are therefore exactly: `board/src/mcu.rs`,
`models/src/machine/stepper_motor.rs`, `models/src/isolation/iso67xx.rs`, and
the tests `board/tests/{pulse_bridge, pulse_bridge_stepped, carriage_seam,
isolation_bridge}.rs`.

## Order of work

Each step leaves the workspace green.

1. **`NetState::Periodic` + resolution**, with no producer yet: the variant, the
   rules above, `same_state` on segment identity, the two-phase escalated solve,
   and `level_of` returning `None`. Add the seven arms; audit the six wildcards.
   Nothing behaves differently, because nothing emits one.
2. **`Drive::Periodic` and `set_drive`**, so a component can emit one. A step
   line resolves for the first time here, and a fought step line reports
   `Contention` — the fidelity this whole exercise is for.
3. **Migrate the pulse bridge and the isolator** off `pulse_tx`/`on_pulse`.
   Decide the isolator's forward-verbatim rule explicitly. Re-measure
   `RELAY_EVENT_CEILING` and raise it with the number.
4. **Delete the pulse channel** — the table above. `StreamRole` goes.
5. **`PulseSegment` to nanoseconds.** The last µs island after embsim #36.
   Deliberately last: mechanical, and would otherwise churn every step above.

## Risks

- **Count exactness is the whole game.** Every step must keep `emitted_at`
  integer and `isolation_bridge.rs`'s verbatim-count assertion passing. If a
  step needs that assertion relaxed, the step is wrong.
- **The isolator's transparency is a decision now.** See above. A re-anchoring
  relay would pass most tests and quietly desynchronise the carriage.
- **Silent wildcards.** Six `NetState` matches will accept the new variant
  without complaint. Prefer explicit arms over relying on the compiler.
- **The event-cost ceiling will move** (measured ~7× per rate change). Expected;
  re-measure rather than assume. The property to defend is *independence from
  rate*, not the absolute number.
- **Phase.** Declaring same-rate `Periodic` drives `Contention` is a choice.
- **Expect one unplanned prerequisite.** Steps 2b, 4a and 4b of the transport
  scope were each a mechanism the bypass had been hiding. This removes the last
  bypass; the pattern says something the pulse route was routing around will
  turn out not to work. The audit found no *obstacle*, which is not the same as
  finding no *surprise*.
