# MaD EdgeBoard

The **EdgeBoard** is the main controller PCB for the MaD tensile tester. It hosts
the **Parallax Propeller 2** microcontroller and carries all of the machine's I/O.

![MaD EdgeBoard](Images/MaD_Edge.png)

## What's on the board

- **Propeller 2** microcontroller (the firmware in
  [`Firmware/MaDCore`](../../Firmware/MaDCore) runs here).
- **Servo / stepper driver interface** for the motion axis.
- **Encoder** input for position feedback.
- **Endstops** and the **door interlock** / ESD safety chain.
- **SD card** (tests run autonomously from G-code stored here).
- **Host USB-to-serial** link (2,000,000 baud) for the control app.
- Header for the [DS2 Addon](../DS2Addon/readme.md) force-gauge interface.

## Working with the design

This is a [KiCad](https://www.kicad.org/) project — open the `.kicad_pro` in this
folder to view or edit the schematic and layout.

Manufacturing outputs (Gerbers, BOM, interactive BOM, 3D models) are generated
automatically by the hardware CI job (KiBot) and published on `hardware-v*`
release tags. See the
[CI/CD docs](https://rileymccarthy.github.io/MaD/dev/ci-cd-and-releases/).

## Documentation

For how the board fits into the wider system, see the
[Hardware overview](https://rileymccarthy.github.io/MaD/how-it-works/hardware/) on
the documentation site.

> **Status:** detailed connector pinouts, a bill of materials, and assembly notes
> are still being written. Contributions welcome.
