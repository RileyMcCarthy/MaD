# Requirements & browser support

The MaD control app is a **frontend-only Progressive Web App**. It needs no
backend, no Electron, and no installation — but it does depend on two modern
browser APIs that are currently only available in Chromium-based browsers.

## Browser support

| Browser | Supported | Notes |
|---|---|---|
| Google Chrome (desktop) | :material-check: Yes | Recommended |
| Microsoft Edge (desktop) | :material-check: Yes | Chromium-based |
| Brave / other Chromium | :material-check: Usually | Web Serial must be enabled |
| Firefox | :material-close: No | No Web Serial API |
| Safari | :material-close: No | No Web Serial API |
| Mobile browsers | :material-close: No | No Web Serial API |

!!! info "Why Chromium-only?"
    The app talks to the machine with the **Web Serial API** and stores results
    with the **File System Access API**. Both are implemented in Chromium but not
    (yet) in Firefox or Safari. If you open the app in an unsupported browser it
    shows an "unsupported browser" screen rather than failing silently.

## What you need

- **A Chromium browser** on a desktop OS (Windows, macOS, or Linux).
- **A MaD machine** connected over **USB** (it presents as a USB-to-serial
  device). Most adapters work out of the box on macOS and Linux; Windows may need
  the USB-serial driver for your adapter.
- **An empty folder** on your computer (optional but recommended) where the app
  will save sample profiles, motion profiles, and test results. You grant access
  to this folder once; the app remembers it.

There is nothing to download — the app is served over HTTPS from GitHub Pages,
which is also why Web Serial and File System Access are allowed (both require a
secure context).

## Connecting hardware

The machine communicates at **2,000,000 baud** by default. The app lets you choose a
different baud rate on the [Connect](../user-guide/connecting.md) screen, but the
default matches the firmware out of the box.

Power the machine on **before** connecting in the app — see the
[power-up sequence](../how-it-works/the-machine.md#power-up-sequence).

## Installing as an app (optional)

Because it is a PWA, Chrome/Edge will offer to **install** MaD Control as a
standalone desktop app (an icon in the address bar, or **⋮ → Cast, save, and
share → Install page as app…**). Installed or not, it behaves identically and
updates itself when a new version is published — though it will never reload
mid-test; updates are deferred until you are idle and disconnected.
