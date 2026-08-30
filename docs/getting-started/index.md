# Getting Started

There are two ways to get going with MaD, depending on who you are.

<div class="grid cards" markdown>

-   :material-account-wrench: **I want to run tests**

    ---

    You have a MaD machine (or just want to explore the app). No installation —
    everything runs in the browser.

    [:octicons-arrow-right-24: For operators](operators.md)

-   :material-laptop: **I want to build / develop**

    ---

    Build the firmware, run the app from source, or run the simulation test rig.

    [:octicons-arrow-right-24: Developer guide](../dev/index.md)

</div>

## Before you start

The control app is **Chromium-only** (Chrome or Edge on desktop) because it
relies on the Web Serial and File System Access browser APIs. Check the
[requirements & browser support](requirements.md) page first if you are unsure.

## The 60-second version

1. Open the app: **<https://rileymccarthy.github.io/MaD/app/>** in Chrome or Edge.
2. Plug the machine into your computer over USB and power it on.
3. Go to **Connect**, click **Connect device**, and pick the serial port.
4. Open **Firmware** and check the version. A board that has never been
   programmed shows **Connected** but never **Responding** — flash it here
   first.
5. Watch live data on the **Live** screen, or build and run a test.

The full, screenshot-led walkthrough is in [For operators](operators.md).
