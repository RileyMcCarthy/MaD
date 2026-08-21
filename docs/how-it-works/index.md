# How It Works

MaD is a full stack, from steel to pixels. This section explains each layer and
how they connect.

```mermaid
flowchart TB
    user["Operator"] --> app
    subgraph host["Computer (browser)"]
        app["Control app<br/>Control"]
    end
    subgraph machine["MaD machine"]
        fw["Firmware<br/>(Propeller 2, C)"]
        periph["Motor · force gauge ·<br/>encoder · endstops · SD"]
    end
    app <-->|"Web Serial · ProtoEmb"| fw
    fw <--> periph
    periph --> sample["Sample under test"]
```

Start with the [system overview](overview.md) for the end-to-end data flow, then
dive into any layer:

<div class="grid cards" markdown>

-   [:material-engine: **The machine**](the-machine.md) — power-up, operating modes, and the safety state machine
-   [:material-chip: **Firmware**](firmware.md) — layered C on the 8-core Propeller 2
-   [:material-transit-connection-variant: **Communication protocol**](protocol.md) — the ProtoEmb binary wire format
-   [:material-web: **The control app**](control-app.md) — Web Serial + WASM in a worker
-   [:material-test-tube: **SIL emulator**](sil-emulator.md) — running the real firmware with no hardware
-   [:material-developer-board: **Hardware**](hardware.md) — the PCBs

</div>
