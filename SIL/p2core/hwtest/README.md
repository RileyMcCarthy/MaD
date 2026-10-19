# Silicon vs p2core

Silicon is the spec. p2core must match it. Goldens are `(binary, console)`
pairs captured from a P2-EVAL; `cargo test` replays them with no board.

The generic parse/diff lives in **embsim-cpu-oracle**. This directory is the
P2 adapter: FlexC/Spin programs, loadp2, encodings.

## Programs

| Program | What silicon prints | Capture | Replay |
|---|---|---|---|
| `oracle.c` | Named ALU/GETBYTE/SETQ/float checks | `hw_compare.py --capture --prog oracle` | `--test silicon_oracle` |
| `probe.c` | One-instruction `DUMP` (decoder-table sweep) | `hw_probe.py --capture` | `--test silicon_probe` / `--test probe_coverage` |
| `locks.c` | Lock pool (`_locknew` / `_locktry`) | `hw_compare.py --capture --prog locks` | `--test silicon_reports` |
| `cogs.c` | Two cogs, hub mailbox | `hw_compare.py --capture --prog cogs` | `--test silicon_reports` |
| `timed.c` | GETCT/WAITX cycle deltas | `hw_compare.py --capture --prog timed` | `--test silicon_reports` / `--test op_coverage` |

`P2_PORT` overrides the default FTDI (`/dev/cu.usbserial-PLX6ZJLYQ`).

```
cd SIL/p2core
python3 tools/hw_probe.py --capture
python3 tools/hw_compare.py --capture --prog locks
python3 tools/hw_compare.py --capture --prog cogs
cargo test -p p2core --test silicon_probe --test silicon_oracle --test silicon_reports
```

## Probe

Host cog prints `READY` and accepts `GO enc pre din sin flags h0 h1 h2 h3`
so many encodings share one `loadp2`. If the mailbox encoding is already
patched (non-zero), it still runs oneshot `DUMP`/`END` for ISS replay.

Prefix slot: `SETQ`, `AUGS`/`AUGD`, `ALTD`/`ALTS`. The rest of the corpus is
generated from `p2core::probe_encodings()` — every decoder-table slot the
trampoline can retire. `cargo test -p p2core --test probe_coverage` fails if
a probe-safe `Op` has no silicon golden.

```
cargo run -p p2core --example probe_encodings -- --stats
cargo run -p p2core --example probe_encodings -- --coverage hwtest/golden/probe.txt
```

Every `Op` is in a bucket (`p2core::op_bucket`). Probe, prefix, locks, cogs,
and timed (GETCT/WAITX) must have silicon goldens (`--test op_coverage`).

WAITX on silicon: `getct; waitx N; getct` delta is **N+4** (two GETCTs and
the WAITX instruction at 2 clocks each, plus N extra). p2core matches that
exactly. Pin/FIFO/CORDIC/control remain later programs.

**Open:** `LOC`, streamer (`XINIT`/`SETXFRQ`/`WAITXFI`), and transition-pin
`WYPIN` now run the loadp2 flash stub on the ISS, but have no P2-EVAL golden.
Capture plan: [#109](https://github.com/RileyMcCarthy/MaD/issues/109).

**Open:** `QSQRT` has no P2-EVAL golden. p2core returns the floor root of
the 64-bit `{S, D}` (`tests/cordic_sqrt.rs`), which is what FlexC's `sqrtf`
expects, but no capture shows silicon rounds down. The capture to add to
`oracle.c`: one integer `qsqrt` with a non-zero S, and `sqrtf(0.786667f)`.

**Open:** `QROTATE` with a non-zero `SETQ` has no P2-EVAL golden. p2core
rotates the signed point `(D, Q)` by S with f64 trig, exact on quarter turns
and truncated toward zero elsewhere (`tests/cordic_rotate.rs`), but no capture
shows how silicon's CORDIC rounds (or how it handles a result past the i32
range). The capture to add to `oracle.c`: `setq y` / `qrotate x, angle` /
`getqx` / `getqy` for a few signed (x, y) pairs at 0, 90, 180 and 45 degrees.

## Record format (probe)

```
CASE add_reg
IN  enc=... pre=... din=... sin=... flags=... hub=...
OUT d=... s=... c=... z=... hub=...
```

Parsed by `embsim_cpu_oracle::parse_records`.
