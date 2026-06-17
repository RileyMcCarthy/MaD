# Specifications

| Parameter | Range |
|---|---|
| Strain rate | 0 – 2 m/s |
| Force measurement | 1 – 10 N |
| Gauge length | 10 – 150 mm |
| Strain length | 0 – 500 mm |
| Data rate | 1000 samples/sec |
| Target cost | < $4,000 |

MaD is a **uniaxial tensile testing machine** optimised for **low-modulus
elastomeric and biologic materials**. It is portable, spray-resistant, and
user-modifiable.

## Telemetry

- The firmware samples force and position internally at ~1 kHz; the app polls the
  latest **sample at ~100 Hz** and **machine state at ~1 Hz** over the serial
  link (see the [protocol priority model](../how-it-works/protocol.md#priority-model)).
- Recorded test data is logged to the machine's SD card and downloaded as CSV.

## Interfaces

- **Host link:** USB-to-serial, **230400 baud** by default.
- **Control app:** any Chromium browser (Web Serial), no installation.
- **Storage:** SD card on the machine; results mirrored to a folder on the host.

See [machine configuration](../user-guide/machine-configuration.md) for the
per-machine calibration values, and [sample profiles](../user-guide/sample-profiles.md)
for per-test limits.
