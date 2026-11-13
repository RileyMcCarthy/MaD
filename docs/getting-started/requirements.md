# What you need

MaD Control runs entirely in your browser. There is nothing to install and no
server to set up.

## Checklist

- **Chrome or Edge on a desktop computer** (Windows, macOS or Linux).
- **Two USB serial adapters** on the machine's controller, one per port:

    | Port | Adapter | Where it plugs in | Used for |
    |---|---|---|---|
    | **Control port** | A USB-serial adapter (FTDI or similar) | The controller's secondary serial, P30/P32: header **J4** on the Edge carrier; on a P2-EVAL bench, adapter TX → P30, adapter RX ← P32, grounds joined | Everything day to day: live data, jogging, calibration, tests |
    | **Programming port** | A Parallax Prop Plug | The **Debug/Programming header J1** (`P62 / P63 / RESn / GND`), or the P2-EVAL's own USB | Flashing firmware only |

    Both can stay plugged in. [Power up and connect](connect.md#the-two-ports)
    explains why there are two.

- **A folder on your computer** for sample profiles, motion profiles and test
  results. The app asks for it the first time it opens.
- **A known weight** (ideally several, up to at least 20% of the load cell's
  capacity) for the [load cell calibration](machine-setup.md#4-calibrate-the-load-cell).

Most adapters work out of the box on macOS and Linux. Windows may need the
adapter's USB-serial driver.

## Browser support

| Browser | Supported | Notes |
|---|---|---|
| Google Chrome (desktop) | :material-check: Yes | Recommended |
| Microsoft Edge (desktop) | :material-check: Yes | Chromium-based |
| Brave / other Chromium | :material-check: Usually | Web Serial must be enabled |
| Firefox | :material-close: No | No Web Serial API |
| Safari | :material-close: No | No Web Serial API |
| Mobile browsers | :material-close: No | No Web Serial API |

The app talks to the machine with the **Web Serial API** and saves results with
the **File System Access API**. Only Chromium implements both. In any other
browser the app shows an "unsupported browser" screen.

## Installing as an app (optional)

Chrome and Edge offer to **install** MaD Control as a standalone window (an
icon in the address bar, or **⋮ → Cast, save, and share → Install page as
app…**). Installed or not, it behaves the same. When a new version is published
the status bar shows **Update ready**; it is applied only when you click it
while disconnected, so the app never reloads during a test.

![Status bar offering an app update](../assets/screenshots/status-update-ready.png)

Next: [Power up and connect](connect.md).
