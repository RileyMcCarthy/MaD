# Troubleshooting

Common issues with the control app and how to resolve them.

## Connection

| Symptom | Likely cause & fix |
|---|---|
| **"Unsupported browser" screen** | You're not in a Chromium browser. Use Chrome or Edge on desktop — see [requirements](../getting-started/requirements.md). |
| **No port in the chooser** | The machine isn't powered or the USB-serial driver isn't installed. Check the cable, power, and (on Windows) the adapter driver. |
| **Connected but "Not responding"** | The port opened but the firmware isn't talking. Check the [baud rate](connecting.md) (default 2,000,000), confirm the machine is powered through its [power-up sequence](../how-it-works/the-machine.md#power-up-sequence), and that nothing else holds the port. |
| **Link drops randomly** | Loose USB, power dip, or the machine rebooted. Use **Reconnect**; the app auto-reconnects when the device replugs. |

## Motion

| Symptom | Likely cause & fix |
|---|---|
| **Jog does nothing** | Motion isn't enabled, or a **restriction** is active (endstop, door, tension). Check the State badges on [Live](live-monitoring.md). |
| **A move is rejected** | The target is outside the encodable / configured range, or the input was zero/blank. The app blocks out-of-range moves before sending them. |
| **A fault is shown** | Faults (e.g. `WATCHDOG`, `ESD_*`, `COG`) generally require a machine reboot. See the [faults reference](machine-states.md). |

## Tests

| Symptom | Likely cause & fix |
|---|---|
| **Test stops early** | The sample exceeded its **Max Force** or **Max Displacement** — by design. Check the [sample profile](sample-profiles.md) limits. |
| **Run stuck in "running"** | The firmware never reported completion (or the link dropped). Use **Mark done / Mark failed** on the history row; data may still be downloadable. |
| **Can't view a run** | You must **Download data** first; *View* appears once the run is *downloaded*. |
| **Profiles/runs missing** | The data folder's index may be stale — click **Rescan folder** in [Settings](settings-and-data.md). |

## Data folder

| Symptom | Likely cause & fix |
|---|---|
| **App asks to re-grant access** | The browser dropped the permission after a restart. Click **Grant access** in Settings. |
| **Saves fail** | Storage may be full or the grant was revoked. Errors appear as toasts; re-choose the folder. |

## Still stuck?

Export a diagnostics bundle from the [Firmware](firmware-and-diagnostics.md)
screen and open an issue on
[GitHub](https://github.com/RileyMcCarthy/MaD/issues). If you're developing, the
[SIL emulator](../dev/sil-testing.md) reproduces the full stack without hardware.
