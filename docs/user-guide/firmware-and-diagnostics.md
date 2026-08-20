# Firmware & diagnostics

The **Firmware** screen shows the firmware version reported by the connected
machine and lets you export a diagnostics bundle for troubleshooting.

![The Firmware / About screen](../assets/screenshots/09-firmware.png)

## Firmware version

When the machine is connected and responding, its **firmware version** is shown
here (and in the status bar). If it shows nothing, the firmware isn't responding —
see [Troubleshooting](troubleshooting.md).

## Diagnostics export

Click **Download diagnostics** to save a file recording what the app has been
doing — connections, errors, timeouts, and rejected commands — plus some
performance counters. It contains **no test data**, so it's safe to attach when
reporting a problem.

!!! info "Updating the app"
    When a new version of the app is published, the status bar shows an **Update
    ready** button. The update is applied only when you click it **and** are idle
    and disconnected — the app will never reload itself mid-test.

## Flashing firmware

!!! warning "Not available in the browser"
    Updating the **firmware on the machine** needs a desktop tool that a browser
    can't run, so it isn't something you can do from this app. It's covered in the
    [developer guide](../dev/building-firmware.md).
