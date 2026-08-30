# File formats

The app reads and writes three kinds of file in your
[data folder](settings-and-data.md): sample profiles (`.sp`), motion
profiles (`.mp`), and recorded test data (CSV).

## Sample profile — `.sp`

JSON describing a material's dimensions and test limits.

```json
{
  "maxForce": 10,
  "maxVelocity": 50,
  "maxDisplacement": 120,
  "sampleWidth": 10,
  "sampleThickness": 2,
  "serial": "PDMS-10A"
}
```

| Field | Unit | Meaning |
|---|---|---|
| `maxForce` | N | Test stops above this force |
| `maxVelocity` | mm/s | Velocity ceiling |
| `maxDisplacement` | mm | Test stops above this extension |
| `sampleWidth` | mm | Cross-section width (for stress) |
| `sampleThickness` | mm | Cross-section thickness (for stress) |
| `serial` | — | Sample / material identifier (also the profile's saved name) |

!!! note "`serial` stays on your computer"
    `serial` names and identifies the profile in the app and in your data folder.
    Only the five numeric limits are sent to the machine, so renaming a profile
    never changes how a test runs.

## Motion profile — `.mp`

JSON describing the test motion: a list of **sets**, each repeated `executions`
times, each containing ordered **moves**.

```json
{
  "name": "Cyclic Tension",
  "description": "Preload then 3 load/unload cycles",
  "sets": [
    {
      "name": "Preload",
      "executions": 1,
      "moves": [
        { "moveType": "linear", "absoluteOrRelative": "relative",
          "moveParameters": { "distance": 5, "velocity": 5 } }
      ]
    },
    {
      "name": "Cycle",
      "executions": 3,
      "moves": [
        { "moveType": "linear", "absoluteOrRelative": "relative",
          "moveParameters": { "distance": 20, "velocity": 10 } },
        { "moveType": "dwell", "absoluteOrRelative": "absolute",
          "moveParameters": { "time": 500 } },
        { "moveType": "linear", "absoluteOrRelative": "relative",
          "moveParameters": { "distance": -20, "velocity": 10 } }
      ]
    }
  ]
}
```

### Move parameters

`moveType` is `linear`, `dwell`, or `math` (waveform). The `moveParameters` object
carries whichever fields apply:

| Field | Used by | Meaning |
|---|---|---|
| `position` | linear (absolute) | Target position (mm) |
| `distance` | linear (relative) | Distance to move (mm) |
| `velocity` | linear | Feed rate (mm/s) |
| `time` | dwell | Hold time (ms) |
| `waveform` | math | `sine` |
| `amplitude`, `frequency`, `cycles`, `phase` | math | Waveform shape |

`absoluteOrRelative` is `absolute` or `relative` per move.

## Recorded data — CSV

Downloaded test data is CSV. Note the units: the machine records in **finer units**
than the app displays, so the numbers here are larger than what you see on screen.

```text
time_us,force_mN,position_um,setpoint_um
0,0,10000,10000
50000,114,10300,10300
...
```

| Column | Unit | Meaning |
|---|---|---|
| `time_us` | µs | Timestamp |
| `force_mN` | mN | Measured force |
| `position_um` | µm | Measured position |
| `setpoint_um` | µm | Commanded position |

The [run viewer](test-history-and-analysis.md) converts these to N
and mm and derives stress/strain. **Export** adds a metadata header (sample/motion
details) to the CSV.

!!! note "Saved vs. shared files"
    Inside your data folder, the app wraps each profile in a small record that
    tracks when it was created. The `.sp` / `.mp` files you **import and export**
    are just the plain profile shown above — which is what makes them easy to
    write by hand, email to a colleague, or keep in version control.
