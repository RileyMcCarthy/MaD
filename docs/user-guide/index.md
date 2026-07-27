# User Guide

This guide covers every screen of the **MaD control app**
([Control](https://rileymccarthy.github.io/MaD/app/)), with screenshots
captured from the live application.

The app is organised as a sidebar of screens:

| Screen | What it's for |
|---|---|
| [Connect](connecting.md) | Choose a baud rate and connect to the machine over USB |
| [Live](live-monitoring.md) | Real-time readouts, machine state, and live charts |
| [Live → controls](manual-control.md) | Enable motion, jog, home, and zero the machine |
| [Samples](sample-profiles.md) | Create/edit sample profiles (material limits & dimensions) |
| [Motion Profiles](motion-profiles.md) | Build the move sequence a test runs |
| [Test Runs](running-a-test.md) | Run a test and track it in the history table |
| [Test Runs → View](test-history-and-analysis.md) | Download data and analyse a finished run |
| [Settings](settings-and-data.md) | Data folder + machine configuration |
| [Firmware](firmware-and-diagnostics.md) | Firmware version and diagnostics export |

The status bar at the top of every screen shows the connection state, the
firmware version, a **Responding** indicator, and a global **STOP** control.

!!! info "A monitor, not a safety device"
    Throughout these guides, remember that the **machine is the safety
    authority**: it has a hardware e-stop and its own sensors, and runs tests
    autonomously from its SD card. The app monitors and commands the machine, but
    losing the app never halts a running test. See
    [the machine](../how-it-works/the-machine.md) for the safety model.

If something isn't working, jump to [Troubleshooting](troubleshooting.md).
