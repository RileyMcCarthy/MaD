# Tests and data

## Run test is refused

| Message or symptom | Cause and fix |
|---|---|
| A red firmware banner is showing | The app won't start a test on firmware it can't talk to. See [Firmware problems](firmware.md). |
| Nothing to select in **New test** | No profiles saved yet. Create a [sample profile](../user-guide/sample-profiles.md) and a [motion profile](../user-guide/motion-profiles.md), or use **Import .sp / .mp**. |
| The test starts and ends at once | A [fault](faults.md) is showing, so motion can't be enabled. Check the Live screen. |
| A waveform is refused | The machine won't run a waveform it can't deliver at the amplitude asked (too fast for the machine's velocity or acceleration limit). Lower the frequency or amplitude; the motion profile editor shows the peak velocity. |

## A test stops early

| Toast | Cause |
|---|---|
| *Test stopped: sample limit exceeded* | The sample reached **Max force** or **Max displacement** from its sample profile. This is the limit doing its job; raise it if it was too tight. |
| *Test aborted: motion disabled* | Motion was switched off: **STOP**, **Disable motion**, or a [fault](faults.md). The Fault badge on Live shows which, if it is still present. |
| *Test aborted: waveform refused* | The machine could not deliver a waveform in the program. |

## A run is stuck in *running*

![History with a run still marked running](../assets/screenshots/test-runs-history.png)

The app never saw the machine report the test finished, usually because the
link dropped or the tab was closed while it ran. The machine has finished; only
the record is stale.

Check **Live** shows `Test: idle`, then use **Mark done** (or **Mark failed**)
on the row. **Download data** still works.

## A run can't be viewed

**View** appears once the run is *downloaded*. Click **Download data** first.

## Download data fails

- The machine must be connected and responding.
- The recording is on the machine's SD card. If the card was removed or
  replaced, the data is gone from the machine.

## Runs or profiles are missing

The History table is built from an index file in the data folder. If you
switched folders or changed files outside the app, click **Settings → Rescan
folder** to rebuild it from the files that are there.

## Data folder

| Symptom | Cause and fix |
|---|---|
| The app asks for the folder when it opens | First run, or the browser forgot the folder. Click **Choose data folder** and pick the same one: your files are still in it. |
| *The browser needs your permission again* | Chrome re-asks after a restart. Click the **Allow** button. |
| Saves fail with an error toast | The disk is full, the folder was moved or deleted, or permission was withdrawn. Choose the folder again in **Settings**. |

![The data folder prompt](../assets/screenshots/data-folder-gate.png){ width=520 }

## Numbers in the CSV look too large

The raw CSV on disk uses the machine's units (µs, mN, µm). **Export CSV** and
the run viewer use s, N and mm. See
[File formats](../user-guide/file-formats.md).
