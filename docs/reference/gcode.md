# G-code reference

Motion profiles are compiled to a small G-code dialect, uploaded to the machine's
SD card, and played back by the firmware. The trailing **`G122`** is the firmware
contract for "test complete".

| Code | Meaning | Parameters |
|---|---|---|
| `G0` | Rapid move | `X<pos>` `F<feedrate>` |
| `G1` | Linear move | `X<pos>` `F<feedrate>` |
| `G2` | Clockwise arc | (executed as a dwell by the firmware) |
| `G3` | Counter-clockwise arc | (executed as a dwell by the firmware) |
| `G4` | Dwell (pause) | `P<milliseconds>` |
| `G28` | Home axis | — |
| `G90` | Absolute positioning | — |
| `G91` | Relative (incremental) positioning | — |
| `G122` | Stop / test complete | — |

- `X` is a position (absolute under `G90`) or a distance (relative under `G91`),
  in millimetres.
- `F` is the feed rate in mm/s.
- `P` is a dwell time in milliseconds.

## How the app generates it

The [motion-profile builder](../user-guide/motion-profiles.md) converts each move:

- **Linear** → `G1 X… F…` (preceded by `G90`/`G91` as the mode changes).
- **Dwell** → `G4 P…`.
- **Waveform** → expanded host-side into many small `G1` segments approximating the
  position-vs-time curve (so cyclic loading runs unattended from SD).

Every generated program ends with `G122`. You can inspect the exact output for any
profile with **Preview G-code** in the builder.

!!! note "Arcs"
    `G2`/`G3` remain valid *wire* codes (the protocol and firmware accept them, and
    the firmware executes them as a dwell), but the app's builder no longer
    generates arcs — the **Waveform** move replaced that use case.

In the protocol these map to the `GCode` enum
(`RAPID_MOVE=0, LINEAR_MOVE=1, CW_ARC=2, CCW_ARC=3, DWELL=4, HOME=28,
ABSOLUTE=90, INCREMENTAL=91`); see the [protocol messages](protocol-messages.md).
