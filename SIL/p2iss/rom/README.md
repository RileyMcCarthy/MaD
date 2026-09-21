# The P2 boot ROM, for the ISS

`rom_booter_v33k.spin2` is Parallax's published boot-ROM source
([`ROM_Booter_v33k.spin2`](https://github.com/parallaxinc/propeller/blob/master/resources/FPGA%20Examples/ROM_Booter_v33k.spin2),
FPGA-era, permissively published), trimmed so flexspin can assemble it:

- everything from the first hub-resident `orgh` onward is dropped — the SD
  second-stage, TAQOZ and the debug monitor are written in PNut-only dialect
  (`L0` locals, out-of-range `loc`s) and are not part of the boot decision
  this simulation exercises;
- the two `jmp #@_start_sdcard` sites fall through to `try_serial` instead;
- the TAQOZ/monitor serial escape hatches (`ESC`, `Ctrl-D`) loop back to the
  serial read; and `DEBUG`, which modern flexspin lexes as a keyword, is
  renamed `DEBUGX`.

What remains is the entire boot path proper: the RNG seeding, the cog/LUT
self-load, the pull-up decision tree on P59/P60/P61, the bit-banged SPI-flash
loader with its `"Prop"` checksum, and the serial loader.

`stage1.spin2` is this repository's second-stage flash loader — the 1 KB the
ROM loads, verifies and launches. See `p2iss/src/flashimage.rs` for the flash
layout it consumes.

Rebuild both with `make bootrom` (uses the pinned toolchain's flexspin; the
ROM binary is the `$FC000` tail of the assembled image).
