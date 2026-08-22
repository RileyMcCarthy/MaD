# Motion profiles

A **motion profile** defines what the machine *does* during a test — a sequence
of moves, grouped into repeatable **sets**. You build it on the **Motion
Profiles** screen.

![The Motion Profiles builder](../assets/screenshots/04-motion-profiles.png)

## Structure

A motion profile has a **name** and **description**, and contains one or more
**sets**. Each set has:

- a **name**,
- an **executions** count (how many times the set repeats),
- and an ordered list of **moves**.

Both **sets** and **moves** are **drag-reorderable** (grab the handle on the
left). You can add and delete sets and moves freely.

## Move types

| Type | Parameters | What it does |
|---|---|---|
| **Linear** | position/distance + velocity | A controlled pull or return. *Absolute* uses a target position; *relative* uses a distance from the current position. |
| **Dwell** | time (ms) | Hold position for a fixed time. |
| **Waveform** | centre, amplitude, frequency, cycles | A smooth sine oscillation about the centre, for cyclic / fatigue loading. |

Each move has an **absolute / relative** selector, which also renames the waveform's centre field: **Centre** is a position when absolute, **Centre offset** a distance from where the machine already is when relative.

For the **Waveform** move, the
app shows the live **peak velocity** and **duration**, and warns you if it would
exceed the machine's velocity limit. The machine generates the oscillation
itself, so long cyclic runs continue unattended.

## Preview the motion

Click **Preview G-code** to see a distance-vs-time chart of exactly what the
machine will do, along with the instructions that will be sent:

![G-code preview](../assets/screenshots/05-gcode-preview.png)

This is a good habit before running an unfamiliar profile — the chart makes an
accidental over-long pull or an inverted direction obvious at a glance.

## Saving, loading, importing

- **Save Motion Profile** stores it in your [data folder](settings-and-data.md);
  it then appears in the **Load saved profile…** dropdown.
- You can also **Save / Load individual Sets**, so a reusable set (e.g. a cyclic
  block) can be shared across profiles.
- **Import** loads a profile from a `.mp` file — see [file formats](file-formats.md).
