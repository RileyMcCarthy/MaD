# What MaD claims to do

This is the table of contents of the behaviour ledger. Each heading is a
capability, ending in the test-id areas it owns; the paragraph under it says
what that capability is *for*, written for whoever uses the machine. The rows
in `behaviours.jsonl` are the evidence for these paragraphs, and the PR report
groups them under these headings in this order — so put what the operator sees
first and the plumbing last. `node Vibes/bin/vibes.mjs preview` renders the
whole ledger under these headings; `vibes lint` refuses a test-id area no
heading here claims.

## Talking to the machine `control/session`

The app drives the machine over a USB serial link from the browser, one
command at a time, each acknowledged or refused, with the live sample and the
machine state read periodically in between. Programs go up and results come
down in chunks; a chunk the machine refuses is retried and then given up on,
and a run that only half-uploaded its program is never mistaken for a whole
one. Every command is named in the log by what it does, and a crash of the
background worker that owns the link reaches the screen as text rather than
as silence.

## Live view and manual control `control/live` `control/jog`

While connected the operator sees force and position as they happen, the last
minute of them on a chart, and the machine's state, faults and restrictions
as badges. "Responding" means a sample arrived recently; an unplugged cable
clears the machine state, while a disconnect the operator asked for is not an
error. Jogging moves the gantry by a chosen preset increment.

## Motion profile authoring `control/profile` `control/profiles` `control/ui`

A test is authored as a motion profile — sets of moves, pauses and cyclic
waveforms (sine or triangle, with optional holds at the peaks and a skewed
loading/unloading split) — and previewed before it runs. The profile becomes
the G-code program the machine executes, with a header, the moves and a stop;
a waveform becomes one canned cycle. Profiles and sample descriptions are
saved to and loaded from files (`.sp` sample profiles, JSON motion sets),
tolerating a partial file and refusing a malformed one, and sets can be
reordered in the editor.

## G-code from the app `control/gcode`

The app builds and checks the G-code it sends: linear moves, arcs, pauses,
homing, stop and waveform commands, each with its fields inside the range the
machine can encode, and anything else refused before it leaves the browser.
Absolute moves are offset by the configured gauge length so the operator
works in sample coordinates; relative moves are distances and are left alone.
A comment never changes a command. A waveform the machine could not run is
refused at authoring time, where a refusal costs nothing.

## Test run lifecycle `firmware/test-run`

A test starts when the operator asks and motion is on, runs its program to the
end-of-test command, and finishes when both the program and the gantry are
done. Starts and jogs are accepted only while the machine is idle. A refused
start, a program that cannot be opened, the operator stopping, motion going
off and a sample limit each end the run in a way the operator is told about,
and the machine is ready to start again after every one of them. At most four
jogs wait in line.

## Machine safety state `firmware/control`

Motion is off until the operator enables it, and stays off while any fault
stands: a stopped processor core, a stalled supervised loop, a silent load
cell or motor drive, lost emergency-stop power, tension above the frame's
maximum. Faults are reported in a fixed priority so the operator sees the most
fundamental cause first. With motion on, a physical limit — an endstop, the
door, frame tension — or, during a test, the sample's own force or extension
limit restricts the machine to a safe speed and names the reason. A
restriction never outranks a fault, and a request to stop is never refused.

## Command handling `firmware/bridge`

Every request from the app is answered by the machine: enable or disable
motion, jog, start a named test (stopping a session still busy first), zero
the gauge length and the force, load a sample profile, save the machine
configuration. Each is acknowledged only when the machine actually did it and
refused when the machine turned it down, so the app's picture of the machine
is never ahead of the machine. State reports carry the current fault,
restriction, test and motion flags; firmware built without a version stamp
reports version zero.

## Test monitoring and data logging `firmware/monitor`

During a test the machine watches the sample's force and extension against
the loaded sample profile and reports a limit the moment it is exceeded. It
also writes every new load-cell reading to the SD card as a row of force,
position, target and elapsed time in sample coordinates, so a crash or power
loss part-way through loses nothing already measured. Logging opens when the
test starts, retries a file that would not open, keeps writing for a short
tail after the test ends, and closes cleanly so the next test starts fresh.
Live outputs stay in machine coordinates; the sample frame subtracts the
gauge zeros.

## Sample coordinates `firmware/gauge`

The operator can zero the gauge length and zero the force at any point in a
session, independently of each other. From then on sample extension is travel
since that zero — negative when the jaws close past it, which is compression —
and sample force is the change in load since its zero, while machine position
and machine force remain the raw encoder and load-cell readings.

## Motion program execution `firmware/motion`

The machine runs its G-code program one move at a time from a fixed-size
queue: linear moves at a feedrate, rapid moves, dwells that hold for their
period, homing that seeks the upper endstop and backs off, and cyclic
waveforms handed whole to the motor drive. Absolute and incremental modes
resolve targets the way the program wrote them. A move completes when the
drive reports arrival — a waveform the drive refuses completes at once — and
disabling or aborting motion stops the drive and drops whatever was queued.
The published setpoint is the drive's live profile position, so a tracking
error shows in the data.

## G-code as the machine reads it `firmware/fw-gcode`

The machine parses each G-code line into a command number, a target position
in micrometres, a speed and a pause in milliseconds: millimetres converted,
omitted fields zero, unsupported words ignored, a repeated field last-wins,
and nothing carried over from the previous line. The end-of-test command is
recognised only as an exact line, so a near miss can never end a test early.

## Force measurement `firmware/load-cell` `firmware/ads122`

Force comes from a load cell read through the ADS122U04 converter over a
serial link. The driver configures and verifies the converter at start, then
fetches each 24-bit conversion on request and scales it by the cell's rated
capacity, sensitivity, tare and polarity into millinewtons. The cell is ready
once it has answered; a missed reading is tolerated, a run of misses past the
retry budget restarts the converter, and a cell that never comes back is
reported unready so the machine can fault. A stale byte on the link, or a link
that never goes quiet, can neither desynchronise nor hang the reading.

## Position feedback `firmware/encoder`

Gantry position is read from the servo encoder and scaled between steps and
micrometres by the configured steps per millimetre; the origin can be
redefined by writing a position, and a scale of zero is treated as one.

## Motor drive — closed-loop servo `firmware/servo`

The gantry is driven by a servo loop that treats the encoder as the truth. It
starts disabled and parked at the encoder, takes position commands at a speed
(an invalid speed takes the drive's maximum) and speed commands, reports
arrival when it lands on target and a stall when commanded motion produces
none. Point-to-point moves track their trapezoidal trajectory to within a
micron across the machine's speeds, distances and 3000 mm of travel. Cyclic
waveforms — sine or triangle, with holds at either peak and a skewed
loading/unloading split — are generated inside the drive from phase, so they
track to a micron, end a whole number of cycles back at centre with no drift,
keep their period exactly, and are refused outright when the machine cannot
deliver the acceleration or the holds do not fit the period.

## Motor drive — open-loop stepper `firmware/stepper`

The alternative drive, selected at build time, steps the motor without an
encoder: it stages a target and a rate, emits a pulse train clockwise or
counter-clockwise, counts the pulses it has sent as its position, and stops on
disable, on stop, or when the pulse train reports the move done.

## Notifications `firmware/notify`

The machine queues messages for the operator — message, info, warning, error,
success — and delivers them in order, each kept until the app has taken it
and cut to fit a toast.

## Serial link to the app `firmware/serial` `firmware/protocol`

The machine talks to the app over a full-duplex serial port at 2,000,000
baud. Bytes are taken from the wire in arrival order and sent in the order
they were queued. A frame carries a command, a payload and a checksum; a frame
with a bad checksum, one that stops part-way and times out, or noise ahead of
one is discarded without disturbing the next. Every write is acknowledged or
refused by echoing its command, a read answers with its payload, and a
notification arrives unsolicited.

## Wire format `control/codec` `firmware/protoemb` `firmware/enum`

Both sides encode every record — machine configuration, sample profile,
moves, waveforms, live and stored samples, machine state — to the byte layout
generated from one protocol schema, so a value round-trips through either
codec unchanged and the codes for faults, restrictions, notifications and
G-code numbers mean the same thing at both ends.

## Readings and labels as the operator sees them `control/mapping` `control/units` `control/labels`

Wire records are shown in engineering units — newtons, millimetres, seconds —
converted exactly from the millinewtons, micrometres and microseconds on the
wire, and back. Every fault and restriction the machine can report has a
badge and a longer hint, spelled to match the machine's own names.

## Test results and analysis `control/sample` `control/export` `control/analysis`

A downloaded run's samples decode from the machine's binary rows into a raw
CSV and into engineering units, skipping a malformed row. A series can be
read at any time by interpolation, and the moment motion started is found
from position. Stress and strain follow from force, extension, gauge length
and the sample's cross-section (none when the section is zero); the expected
motion is rebuilt from the program for comparison; and the export CSV names
the run and omits what the run did not have.

## Saved runs and the data folder `control/storage`

Runs, motion sets and history live in a folder the operator chooses on their
own disk. Runs created at the same moment all land, with distinct consecutive
names; the history list rebuilds from the files if it is lost; updating one
run leaves its siblings untouched; and a saved set is never overwritten
without asking.

## Firmware loading `control/flash`

The app loads firmware into the Propeller 2 over the same serial port. It
picks the remembered adapter, or asks when the choice is ambiguous, resets
the chip, detects the boot ROM version, and streams the image to RAM or — with
the flash-boot stub prepended — to flash, byte for byte what the reference
loader sends. Empty, oversize and misaligned images are refused before
anything is sent; dropped bytes, a silent chip and a cancel each end the load
cleanly and leave the port closed, even when the port itself hangs.

## Diagnostics and bug reports `control/diag`

Everything that happens in a session goes into a crash log: every level, from
both the page and the background worker, in wall-clock order, with values
sanitised (paths to basenames, bytes to counts, secrets redacted) and bounded
so it can never grow without limit; the last of the raw serial traffic is kept
in a fixed window too. From that the app writes a triage verdict — never
connected, connected but silent, undecodable traffic, and so on — and files a
bug report to GitHub with the crash log attached and the operator's own words
kept whole, using a token whose access it checks first and never lets into a
log.

## On-card storage `firmware/sd` `firmware/nvram`

The SD card holds the machine profile between power cycles and the data of
every test. A write session creates missing directories, queues fixed-size
records and lands them all on close; a read delivers records from any offset
and says when the file is exhausted; a file that will not open is remembered
as failed until the next open clears it; and a channel busy writing refuses a
read.

## Processor core supervision `firmware/cog` `firmware/watchdog`

The controller's work is spread across the Propeller 2's cores, each started
with a stack guard and expected to keep checking in. A core that stops
running, a corrupted stack guard, or a supervised loop that goes three seconds
without checking in is a fault the operator sees, and a loop that resumes is
forgiven.

## Firmware building blocks `firmware/firmware` `firmware/timer` `firmware/queue`

One-shot timers, elapsed-time checks and 64-bit multiply-then-divide that stay
correct across the 32-bit clock wrap, and a fixed-capacity queue: the parts
everything above is built from.

## End-to-end scenario catalogue and motion accuracy checks `control/matrix` `control/motion`

The catalogue of scenarios the end-to-end suite drives against the simulated
machine — jogs, linear moves, force slack, link loss, waveforms — is generated
pairwise from its factors so every pair of settings is covered, is
deterministic, and names only scenarios that exist. Recorded motion is judged
against the commanded profile: a missed target, a rate error of one percent
or an amplitude error of two microns is visible.

## Simulated gantry (SIL) `sil/gantry`

The software-in-the-loop model of the gantry the end-to-end suite runs
against: the first position report is the baseline, travel is taken up by the
configured engagement slack before the sample extends, and tension runs
toward smaller position.
