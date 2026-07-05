# Hardware

MaD's electronics are open-source PCBs designed in [KiCad](https://www.kicad.org/),
under `Hardware/`. CI generates manufacturing files (Gerbers, BOM, interactive
BOM, 3D models) for each board.

## EdgeBoard — main controller

The **EdgeBoard** is the heart of the machine. It hosts the **Propeller 2**
microcontroller, the servo/stepper driver interface, and all I/O: encoder,
endstops, the door interlock and ESD safety chain, the SD card, and the host
USB-serial link.

![The MaD EdgeBoard](../assets/img/edgeboard.png){ width=560 }

## DS2 Addon — force-gauge interface

The **DS2 Addon** is a piggyback board for the DS2 force gauge. It conditions the
strain-gauge bridge and provides the analog voltage that the firmware reads
through the **ADS122U04** ADC.

![The DS2 Addon board](../assets/img/ds2addon.png){ width=420 }

## Manufacturing files

Each board's KiCad project is in its folder (`Hardware/EdgeBoard/`,
`Hardware/DS2Addon/`). To explore or modify a design, open the `.kicad_pro` in
KiCad. Production outputs are produced automatically by the
[hardware CI job](../dev/ci-cd-and-releases.md) and published on hardware release
tags (`hardware-v*`).

!!! note "Hardware docs are a work in progress"
    Detailed connector pinouts, assembly notes, and a bill of materials are being
    added. The board READMEs in the repo
    ([EdgeBoard](https://github.com/RileyMcCarthy/MaD/blob/main/Hardware/EdgeBoard/readme.md),
    [DS2 Addon](https://github.com/RileyMcCarthy/MaD/blob/main/Hardware/DS2Addon/readme.md))
    track current status.
