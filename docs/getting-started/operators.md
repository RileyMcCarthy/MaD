# For operators — your first test

This is a guided walkthrough for someone with a MaD machine who wants to connect
and run a test for the first time. It uses the browser control app — there is
nothing to install.

!!! tip "Just exploring?"
    You can open the app and click through every screen without a machine
    connected. To see live data and run tests you'll need a MaD machine (or the
    [SIL emulator](../dev/sil-testing.md), which is how the screenshots below were
    produced).

## 1. Open the app

In **Chrome or Edge**, go to:

**<https://rileymccarthy.github.io/MaD/app/>**

If you see an "unsupported browser" message, you are not in a Chromium browser —
see [requirements](requirements.md).

## 2. Power on and connect

1. Power the machine on (see the
   [power-up sequence](../how-it-works/the-machine.md#power-up-sequence)) and
   connect it to your computer over USB.
2. In the app, open **Connect** in the sidebar.
3. Leave the **baud rate** at the default (**2,000,000**) and click **Connect
   device**. Your browser shows a serial-port chooser — pick the machine's port.

When connected, the status bar turns green and shows **Connected** with a
**Responding** badge once the firmware starts streaming data:

![Connected state on the Connect screen](../assets/screenshots/01b-connect-connected.png)

[:octicons-arrow-right-24: More on connecting](../user-guide/connecting.md)

!!! tip "Check the firmware version once you're connected"
    Open **Firmware** in the sidebar — it shows what the machine is running. If
    it's older than the current release, you can update it from the app; see
    [Keeping the firmware up to date](#keeping-the-firmware-up-to-date) at the end
    of this page. You don't have to do this before your first test.

## 3. Watch live data

Open **Live**. You'll see real-time readouts (machine and sample force/position),
the machine **state** (faults, restrictions, motion, test), manual **controls**,
and a live **force & position** chart:

![The Live monitoring screen](../assets/screenshots/02-live.png)

To move the gantry by hand, click **Enable motion**, set a jog distance and
speed, and use **+ Jog up** / **− Jog down**. You can also **Home**, **Zero
force**, and **Zero length** here.

[:octicons-arrow-right-24: Live monitoring](../user-guide/live-monitoring.md) ·
[Manual control](../user-guide/manual-control.md)

## 4. Set up a test

A test combines two things:

1. A **sample profile** — your material's dimensions and safety limits
   (max force, max displacement, width, thickness). Create it on the **Samples**
   screen. [:octicons-arrow-right-24: Sample profiles](../user-guide/sample-profiles.md)
2. A **motion profile** — what the machine should *do*: a sequence of moves
   (linear pulls, dwells, cyclic waveforms) grouped into repeatable sets. Build it
   on the **Motion Profiles** screen.
   [:octicons-arrow-right-24: Motion profiles](../user-guide/motion-profiles.md)

!!! note "Choose a data folder first"
    On the **Settings** screen, click **Choose folder** and pick a folder on your
    computer. Profiles and results are saved there. You only do this once.
    [:octicons-arrow-right-24: Settings & data](../user-guide/settings-and-data.md)

## 5. Run it

Open **Test Runs**. In the **New Test** card, pick your saved sample and motion
profiles, optionally **Preview G-code**, then click **Run Test**. The run appears
in the **History** table and updates to *completed* on its own when the machine
finishes:

![The Test Runs screen with history](../assets/screenshots/06-test-runs.png)

!!! warning "The machine is the safety authority"
    MaD runs tests **autonomously from its SD card** and is protected by its own
    **hardware e-stop and sensors**. Closing the browser tab or losing the USB
    link does **not** stop a running test — the app simply reconnects to keep
    monitoring it. The red **STOP** button in the app is a convenience that
    disables motion; it is *not* a substitute for the hardware e-stop.

## 6. Review the results

Back in **Test Runs**, click **Download data** on a finished run to pull the CSV
off the machine, then **View** to see the analysis — force vs time, position
(actual / setpoint / expected), and a stress–strain curve:

[:octicons-arrow-right-24: Test history & analysis](../user-guide/test-history-and-analysis.md)

## Keeping the firmware up to date

The machine runs its own firmware, updated separately from the app. You can
program it from the browser over the same USB connection you already use for
control — there's no separate tool to install.

!!! warning "New capability — try RAM mode first"
    Browser flashing is newly added and hasn't yet been confirmed against a
    physical board. Do your first update with the machine on the bench rather than
    before a run, and start with **Load into RAM** — it's the reversible mode, and
    a power cycle undoes it.

### Before you start

Flashing needs the **Debug/Programming header (J1)** and an adapter that drives
RESn from DTR, such as a Parallax Prop Plug — that's how the app resets the chip
to reach its boot ROM. On production hardware this is the same connection you
use for control, so if the machine is talking to the app, it can be programmed.

The isolated Raspberry Pi link has no reset line and **cannot** program the board.

### First-time update

1. Open **Firmware** and note the version under **Current firmware**.
2. Download the latest `MaD-Firmware-<version>-release.bin` from the project's
   GitHub releases page. (The `-debug` build is for bench work — take the
   **release** one.)
3. Select **Load into RAM**, choose the file, and click **Load into RAM**. This
   runs the new firmware without writing anything permanent.
4. Reconnect and check the machine behaves as expected.
5. Once you're satisfied, repeat with **Write to flash** to make it permanent.

### Staying current

Check the version on the **Firmware** screen against the latest release now and
then — there's no automatic notification for firmware. A good habit is to check
whenever you update the app, since the two travel together.

Because RAM mode is non-destructive, it's a cheap way to try a new build before
committing it to flash.

[:octicons-arrow-right-24: Full firmware & diagnostics guide](../user-guide/firmware-and-diagnostics.md)

---

That's the full loop: **connect → profile → run → analyse**. The
[User Guide](../user-guide/index.md) covers every screen in detail.
