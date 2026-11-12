# User Guide

One page per screen of **MaD Control**
([open the app](https://rileymccarthy.github.io/MaD/app/)). New to the machine?
Start with [Getting Started](../getting-started/index.md).

The app is a sidebar of screens:

| Screen | What it's for | Guide |
|---|---|---|
| **Connect** | Open the serial link to the machine | [Connecting](connecting.md) |
| **Live** | Readouts, machine state, manual controls, live charts | [Live monitoring](live-monitoring.md) · [Manual control](manual-control.md) |
| **Sample profiles** | Specimen dimensions and test limits | [Sample profiles](sample-profiles.md) |
| **Motion profiles** | The move sequence a test runs | [Motion profiles](motion-profiles.md) |
| **Test runs** | Start a test; history; results | [Running a test](running-a-test.md) · [Test history & analysis](test-history-and-analysis.md) |
| **Firmware** | Installed and recommended firmware; flashing | [Firmware](firmware-and-diagnostics.md) |
| **About** | App version, documentation links, bug reports | [Reporting a bug](firmware-and-diagnostics.md#reporting-a-bug) |
| **Settings** | Data folder, machine configuration, calibration | [Settings & data](settings-and-data.md) · [Machine configuration](machine-configuration.md) · [Motor calibration](motor-calibration.md) · [Load cell calibration](load-cell-calibration.md) |

## The status bar

Every screen has the status bar at the top:

![The status bar](../assets/screenshots/status-connected.png)

| Element | Meaning |
|---|---|
| Dot and label | **Disconnected**, **Connecting…**, or **Connected** with the port and the firmware version |
| **Responding** / **Not responding** | Whether the firmware has answered in the last moments |
| **Reconnect** | Shown after the link is lost unexpectedly |
| **Update ready** | A new version of the app is downloaded; click it while disconnected to apply |
| **STOP** | Disables all motion immediately. A software stop, not the hardware emergency stop. |

Under it, a banner appears whenever the app and the firmware don't match. See
[Firmware problems](../troubleshooting/firmware.md).

!!! info "The machine is the safety authority"
    The machine has a hardware emergency stop and its own sensors, and runs
    tests from its SD card without the app. Losing the app never stops a
    running test. See the
    [safety model](../how-it-works/the-machine.md#safety-model).

Something not working? [Troubleshooting](../troubleshooting/index.md).
