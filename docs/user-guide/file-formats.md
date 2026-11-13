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
        { "moveType": "linear",
          "moveParameters": { "position": 5, "velocity": 5, "time": 0 } }
      ]
    },
    {
      "name": "Cycle",
      "executions": 3,
      "moves": [
        { "moveType": "math",
          "moveParameters": { "position": 0, "velocity": 0, "time": 0,
                              "waveform": "sine", "amplitude": 10, "frequency": 0.25 } },
        { "moveType": "dwell",
          "moveParameters": { "position": 0, "velocity": 0, "time": 500 } }
      ]
    }
  ]
}
```

### Move parameters

`moveType` is `linear`, `dwell`, or `math` (waveform). Every move carries
`position`, `velocity` and `time` (0 where unused); a `math` move adds the
fields for its waveform:

| Field | Used by | Meaning |
|---|---|---|
| `position` | linear, sigmoid | Where the move ends (mm, absolute: sample extension from zero length) |
| `velocity` | linear, sigmoid | Speed (mm/s) |
| `time` | dwell | Hold time (ms) |
| `waveform` | math | `sine` (the default when absent), `sigmoid` or `chirp` |
| `amplitude` | sine, chirp | Peak deviation (mm); its sign is the direction it sets off in |
| `frequency` | sine, chirp | Sine: cycles per second (Hz). Chirp: the frequency it starts at |
| `endFrequency` | chirp | The frequency it sweeps to (Hz) |
| `duration` | chirp | How long the sweep takes (s), rounded to whole cycles |
| `acceleration` | sigmoid | Peak acceleration (mm/s²) |

Every position is absolute. A file with the old fields (`absoluteOrRelative`,
`distance`, `cycles`, `phase`, `centre`, `dwellHigh`, `dwellLow`, `skew`, or a `triangle`
waveform) is **refused** on load, import and run, with a message naming the
move; rebuild it in [Motion profiles](motion-profiles.md).

## Recorded data — CSV

Downloaded test data is CSV. Note the units: the machine records in **finer units**
than the app displays, so the numbers here are larger than what you see on screen.

```text
time_us,force_mN,position_nm,setpoint_nm
0,0,10000000,10000000
50000,114,10300000,10300000
...
```

| Column | Unit | Meaning |
|---|---|---|
| `time_us` | µs | Timestamp |
| `force_mN` | mN | Measured force |
| `position_nm` | nm | Measured position |
| `setpoint_nm` | nm | Where the motion trajectory put the carriage at that moment (the **Machine Setpoint** readout) |

The [run viewer](test-history-and-analysis.md) converts these to N
and mm and derives stress/strain. **Export CSV** adds a metadata header (sample/motion
details) to the CSV.

!!! note "Saved vs. shared files"
    Inside your data folder, the app wraps each profile in a small record that
    tracks when it was created. The `.sp` / `.mp` files you **import and export**
    are just the plain profile shown above — which is what makes them easy to
    write by hand, email to a colleague, or keep in version control.
