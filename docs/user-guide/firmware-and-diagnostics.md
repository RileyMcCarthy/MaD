# Firmware & diagnostics

The **Firmware** screen shows the firmware version reported by the connected
machine, lets you update that firmware, and exports a diagnostics bundle for
troubleshooting.

![The Firmware / About screen](../assets/screenshots/09-firmware.png)

## Firmware version

When the machine is connected and responding, its **firmware version** is shown
here (and in the status bar). If it shows nothing, the firmware isn't responding —
see [Troubleshooting](troubleshooting.md).

## Updating the firmware

The app programs the Propeller 2 over the same USB connection it uses for
control. There is nothing to install.

### What you need

- A cable to the board's **Debug/Programming header (J1)** — the 4-pin header
  fitted to every EdgeBoard, wired pin 1→4 as `P62 / P63 / RESn / GND`.
- A USB-serial adapter that **drives RESn from DTR**, such as a Parallax Prop
  Plug. The app resets the chip that way to reach its boot ROM.

On production hardware the control link and the programming link are the same
connection, so if you can already talk to the machine, you can already program it.

!!! danger "The isolated Raspberry Pi link cannot program the board"
    The isolated link on P53/P55 has **no reset line**, so flashing over it will
    not work no matter what else is correct. Use the J1 header.

### What flashing does

The Propeller 2 boots from its SPI flash, so an update writes there and takes
effect immediately: the board reboots into the new firmware and stays on it
through power cycles.

This is the only mode the app offers. The chip can also run firmware straight
from RAM without writing it, which is useful when bringing up a board, but that
copy disappears at the next reset — as an update it would look like it worked
and then silently revert. That path lives in the `hw:flash` developer CLI
instead.

### Doing the update

1. **Connect to the machine** as usual, and note the version shown under
   **Current firmware** so you can confirm the change afterwards.
2. **Get the firmware file.** Releases are published on the project's GitHub
   releases page as `MaD-Firmware-<version>-release.bin`. There is also a
   `-debug` build, which moves the protocol link to different pins and is meant
   for bench work — for normal use, take the **release** file.
3. On the **Firmware** screen, click **Choose file** and pick the `.bin`. The app
   shows its size and roughly how long the transfer will take — a few seconds for
   a typical image.
4. Check the **Target** shown is the machine you mean to program, then click
   **Write to flash** and confirm the prompt.
5. The status line walks through *Resetting the board and waking its boot ROM…*,
   then *Uploading… n%*, then *Finishing…*.
6. When it completes, confirm the version under **Current firmware** is the one
   you just installed.

!!! tip "Bench setups with two adapters"
    The **Target** line names the port that will be programmed. On production
    hardware there is only one and the app picks it. If several serial devices
    are attached it will refuse to guess and ask you to choose, because the
    browser only sees USB vendor and product IDs — two identical adapters are
    indistinguishable to it. **Use a different port** lets you set it explicitly,
    and the choice is remembered.

### If it doesn't work

- **Nothing happens, or it fails while resetting** — the adapter probably isn't
  driving RESn from DTR, or you're on the isolated Raspberry Pi link. Check you're
  on J1 with a Prop Plug or equivalent.
- **It fails partway through the upload** — retry. The board holds the previous
  firmware until a write completes, so a failed attempt leaves it as it was.
  If it keeps failing, power-cycle the machine and try again.
- **The version doesn't change after a flash** — the machine may have rebooted
  into the previous image. Power-cycle it, reconnect, and check again.

## Diagnostics export

Click **Download diagnostics** to save a file recording what the app has been
doing — connections, errors, timeouts, and rejected commands — plus some
performance counters. It contains **no test data**, so it's safe to attach when
reporting a problem.

!!! info "Updating the app"
    The app and the firmware update separately. When a new version of the **app**
    is published, the status bar shows an **Update ready** button. It is applied
    only when you click it **and** are idle and disconnected — the app will never
    reload itself mid-test.
