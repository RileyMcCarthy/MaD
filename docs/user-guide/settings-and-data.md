# Settings & data

The **Settings** screen is where you choose where the app stores your data, and
where you read/write the [machine configuration](machine-configuration.md).

![The Settings screen](../assets/screenshots/08-settings.png)

## The data folder

The app saves sample profiles, motion profiles, sets, and test results to a
**folder on your computer** that you choose.

- Click **Choose folder** and pick (or create) a folder. The app remembers it
  across reloads — you grant access once.
- The current folder is shown as **Current: …**. Use **Change folder** to switch.
- If the browser needs you to re-confirm access after a restart, a **Grant
  access** prompt appears — click it.

### How data is organised

Inside the folder you'll find separate subfolders for sample profiles, motion
profiles, sets, and test runs — each test run keeping its record alongside its
CSV. There's also a small index file the app uses to find things quickly.

!!! tip "Rescan folder"
    The index is just a cache, and it can be rebuilt at any time. If runs don't
    show up after switching folders or editing files outside the app, click
    **Rescan folder** to regenerate it from what's actually on disk.

### Test naming

New runs are numbered automatically: the next name is one more than the highest
existing numeric name in the folder, so switching folders can't silently
overwrite earlier results.

!!! info "Why a browser can't 'open in Finder'"
    A web app can't open your OS file explorer or read arbitrary paths — it only
    has access to the folder you explicitly granted. That's a browser security
    boundary, not a missing feature.

## Machine configuration

The lower part of Settings reads and writes the machine's stored calibration and
limits — covered in [Machine configuration](machine-configuration.md).

## Keeping your data safe

When you choose a folder, the app also asks the browser not to clear its stored
data. If anything goes wrong saving — access denied, disk full — you'll get a
notification rather than a silent failure. Your results live in your own folder,
so they're yours to back up and move like any other files.
