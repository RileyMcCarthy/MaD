# Lossless net transport — scope

**Goal:** nothing bypasses the net. Every pin carries a waveform that is exactly
lossless for the signal on it, so one interface serves every peripheral we ever
add, and electrical faults — contention, a floating pin, a missing pull-up —
become expressible rather than unrepresentable.

This is a scope, not a design doc: it says what has to change, what must *not*
change, what it costs, and in what order. Numbers here are measured, not
estimated; the harness is `SIL/embsim/board/tests/net_edge_cost.rs`.

## What actually bypasses the net today

Less than it looks. The net already resolves Thevenin drives into
`Driven`/`Pulled`/`Contention`/`Floating` states, with the cluster solver behind
an impedance-escalation rule — `net.rs` opens with *"one mechanism, digital as a
projection"*, and that part is done.

The bypass is **`StreamRole::Producer` / `Consumer { baud_hz }`**. For those, the
net decides *reachability* — who is connected to whom — but the payload is
routed as whole bytes and never becomes a level. A UART byte crossing that path
cannot experience contention, cannot be corrupted by a fighting driver, and
cannot notice that the line was floating.

The surface is three source files plus tests:

| file | role |
|------|------|
| `board/src/component.rs` | defines `StreamRole`, `stream_tx`, `on_byte` |
| `board/src/mcu.rs` | bridges firmware serial channels to stream pins |
| `models/src/ads122u04_component.rs` | the one real peripheral consuming bytes |

## What must NOT be "fixed"

`StreamRole::PulseSource` / `PulseSink` carry a step clock as a **rate**, not as
edges. This looks like a bypass and is not one: the signal is still on a net, and
for a periodic signal a `(rate, duration)` segment is *exactly* lossless — a
consumer integrating `frequency × time` gets the identical answer it would get
from counting edges.

Converting it to per-edge would be a straight regression, and embsim's own
rationale already says why:

> 8192 steps/mm — a single mm/s of carriage speed is 8192 edges/s… a realistic
> 50 mm/s traverse is over 400 k engine events per second, for a signal whose
> consumer only ever reconstructs `frequency × time` from them.

At the measured cost below that is **0.35 s of wall time per simulated second**
for the step clock alone.

## The interface

Two encodings, both lossless, both drives on a net, chosen by which is exact for
the signal:

```rust
enum Drive {
    /// One resolved level. A single edge.
    Level    { thevenin: TheveninDrive },
    /// A square wave. Exactly lossless for a periodic signal; a counter
    /// integrating rate x duration gets the same answer as counting edges.
    Periodic { hi: TheveninDrive, lo: TheveninDrive, rate_hz: f64 },
}
```

Nothing else. Bytes are not a drive — they are what a *decoder* produces from a
sequence of levels.

## Measured budget

Per edge, through the engine (`net_edge_cost.rs`, release, 200 k edges):

| | ns/edge |
|---|---|
| enqueue (drive side) | 33 |
| resolve + sense delivery | 835 |
| **total** | **868** |

≈ 1.15 M edges/s through the single resolver thread.

Against a 10 s baseline for ~1100 s of simulated time:

| signal | edges | added | verdict |
|--------|-------|-------|---------|
| all serial links | 3.1 M | 2.7 s | **affordable** |
| + step train @ 100k steps/s | 661 M | 574 s | **not affordable** |

So: serial moves onto levels now; the step train stays a rate. That is not a
compromise on losslessness — both encodings are exact.

## The part that was not obvious

**A microsecond cannot hold a bit.** The engine's timebase was microseconds,
which is exactly one order of magnitude short:

| link | baud | bit period |
|---|---|---|
| host protocol | 2,000,000 | **500 ns** |
| debug console | 230,400 | 4.34 µs |
| force gauge | 115,200 | 8.68 µs |

Eight 2 Mbaud bits fit inside one microsecond, so a µs timer wheel collapses a
whole byte to a single instant — a synthesized waveform would be one edge, not
ten. *Bytes* fit in µs (10 bits at 2 Mbaud is 5 µs), which is why nothing
noticed until edges were on the table.

This was not in the original list and had to be done first: embsim PR #36 makes
`virtual_ns` the counter, keeps every microsecond call as an exact wrapper, and
carries the timer wheel, stream pacer and stepped-advance path in nanoseconds.
Nothing outside the timebase changed behaviour.

## The other part that is not obvious

**Native mode has no bit timing.** In the native backend the firmware calls
`HAL_serial_transmitData` and a *byte* appears; there is no shifter, no bit
period, nothing to put on a wire. The ISS is the opposite — it executes
`WYPIN` against a smart pin whose mode and bit period we already decode.

So making native mode stop bypassing the net requires the MCU component to
**synthesise** edges: take the byte, take `SerialChannelConfig::baud`, and emit
levels at that rate in virtual time. That is new machinery and it is the largest
single piece of this work. It is also the piece that makes the goal real rather
than cosmetic — without it, "nothing bypasses the net" would be true only in ISS
mode.

## Order of work

Each step leaves both backends green.

1. **Land the measurement harness upstream** so the budget above is reproducible
   and regressions in engine throughput are visible. *(embsim #34)*
2. **UART codec in embsim** — one shared framer/deframer (start, 8 data,
   stop, LSB-first, at a declared bit period). Not per-model; every byte-oriented
   peripheral uses the same one. *(embsim #35)*
   - 2b. **Nanosecond virtual time** — unplanned, and a prerequisite for step 3
     rather than an improvement to it. See "The part that was not obvious"
     above. *(embsim #36)*
3. **MCU component: byte → level synthesis on TX**, level → byte framing on RX,
   behind a flag. Both paths live; the flag exists only so step 4 can land
   without a flag day. *(embsim #37 — `McuBuilder::serial_on_levels`)*
4. **Migrate `ads122u04_component`** off `stream_tx`/`on_byte` onto level pins
   plus the codec. It is the only real consumer, and it already models its own
   pin facade, so this is where the design gets validated. *(embsim #38)*
   - It was. Two engine defects the byte path had been hiding, neither planned:
     a level did not survive a **series resistor** (the projection took its
     level from the cluster's *power* source, so a signal-driven cluster read
     `Pulled(High)` whichever way the driver pointed — every frame arrived as
     `0xFF` through the DS2Addon's 47 Ω ESD resistors); and virtual time could
     **outrun a wake that had already been requested**, because a `ScheduleAt`
     still behind the command drain's batch cap is a deadline the wheel cannot
     see. The second is the nastier one: the rest of a byte then clocks out at
     a single instant. Scheduling is now a control plane with its own queue,
     drained in full; only drives are capped.
5. **Delete `StreamRole::Producer`/`Consumer`** and the flag. After this, bytes
   cannot cross a net without becoming levels. *(embsim #39 — ~1500 lines net
   gone, including the routing pass, the paced queue, `StreamTx`, `on_byte`,
   `EngineEvent::StreamByte` and `Finding::StreamOverrun`.)*
   - Both isolator models collapse to plain level repeaters: their UART
     channels only existed so the engine could derive a route across the
     barrier.
   - `Scenario::stream_drop` goes with the route it injected into. **Stated
     capability loss**: there is no level-era equivalent yet — a contending
     driver breaks every byte rather than a chosen one. An edge-level fault
     injector is the honest replacement if the targeted knob is wanted back.
   - The determinism suite trades its two byte cases for one `serial_levels`
     golden: 146 records of drives, resolutions, senses and wakes on the
     8680 ns bit grid, which pins the bit clock itself.
6. **p2core drives levels directly.** *(`SIL/p2iss` — a new crate.)* The ISS
   already decodes mode and bit period (`p2core/src/smartpin.rs`), so its async
   pins emit `Level` drives natively rather than handing over bytes — no
   synthesis needed on this side. `protocol_on_levels.rs` asserts the firmware's
   version reply arrives as decoded frames *and* that the wire clocks at the
   rate the firmware programmed (2,000,000 baud = 80 clocks at 160 MHz), not
   one the test supplied.
   - **The slice is not the cadence.** At a 1 µs guest slice, boot needed 1.5 M
     wakes; at 100 µs it boots in half a second of wall time. It can be coarse
     because it only governs how long an *idle* machine waits to notice it has
     something to say — once a link is clocking, its own bit wakes land on the
     same handler and step the guest every bit period. Guest and virtual time
     end up agreeing to the microsecond.
   - **The receive side must be polled, not just sensed.** A frame whose tail
     carries no transition closes only on its deadline, and every burst ends
     that way. Sensing alone dropped the last byte of every request — 2 of 3
     bytes arriving, which looked like a framing bug and was not.
   - **The peer's hand-rolled bit clock reintroduced the late-wake bug**
     `SerialLevelBridge` already fixes. It uses the bridge now; the codec is
     checked against something it did not produce in embsim's own
     `serial_levels.rs`, which is the right place for that independence.

Steps 1–5 are embsim changes and land upstream first, then get pinned here.
Step 6 is a MaD change and rides the pin bump.

## Explicitly out of scope

- **Per-edge pulse trains.** Measured infeasible; `Periodic` is already exact.
- **Real SPICE transient in the loop.** The quasi-static MNA solver is the right
  granularity per edge; transient analysis is milliseconds per run and belongs
  offline for validating a subcircuit.
- **Engine optimisation.** 33 ns enqueue against 835 ns resolve-and-deliver says
  the headroom is downstream — batching drives per iteration, skipping re-resolve
  when the driver *set* is unchanged, inlining single-driver nets. Getting that
  to ~50 ns would make per-edge step trains viable. Worth knowing, not worth
  doing until something needs it.

## What this keeps turning up

Each step has cost one unplanned prerequisite, and the pattern is the same
every time: **the byte path routed around a mechanism, so nobody found out the
mechanism was wrong.** A microsecond timebase, a level that stops at a
resistor, a scheduler that can deliver a requested wake late — all fine for
bytes moving milliseconds apart, all fatal for bits 8.68 µs apart.

Step 5 broke the streak, and the reason is worth noting: it was a *deletion*.
Nothing new had to work, so nothing new could be discovered to be broken.

Step 6 resumed it, but the surprises changed character: no engine mechanism was
wrong this time. All three were *adapter* mistakes — a slice chosen for the
wrong reason, a poll that was never written, a peer that re-implemented a clock
someone had already got right. That is what running out of bypasses looks like:
the remaining bugs are in the code you just wrote, not in the ground beneath it.

**All six steps are done.** What remains is the follow-on scope,
[`sil-unified-drive.md`](sil-unified-drive.md) — the pulse channel is the last
thing that still routes around the resolver.

## Risks

- **Native synthesis changes native-mode timing.** Bytes that used to appear
  instantly will now occupy a bit period each. That is more correct, and it will
  move existing timing-sensitive tests. Expect churn in the SIL suite at step 3.
- **RX overrun becomes possible** — which is the point (the firmware's
  lock-free SPSC queue and burst-drain fix exist because overruns are real), but
  tests that never saw one may start failing legitimately.
- **The codec is a correctness surface.** Bit order and framing are exactly the
  details that have cost the most time in the ISS; the codec needs its own tests
  against known-good captures, not just round-trip tests against itself.
