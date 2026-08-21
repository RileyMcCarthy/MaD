# Golden wire traces from the real `loadp2`

Each `.bin` here is the **exact byte stream the reference `loadp2` transmitted**
for one image and one mode, captured off a PTY while a script played the part of
the P2 boot ROM. `../conformance.test.ts` asserts our TypeScript loader emits the
same bytes.

This is the strongest evidence we have that the loader is correct: it compares
against the implementation people actually flash P2s with, rather than against
our own reading of the protocol. A fake boot ROM written by the same author as
the loader can only prove the loader agrees with itself.

The test reads these files and nothing else — no `loadp2`, no network, no
toolchain, no hardware. Captured from **loadp2 0.078**.

| case         | image  | why it's here                                  |
| ------------ | ------ | ---------------------------------------------- |
| `tiny4`      | 4 B    | single long, smallest legal image              |
| `chunk128`   | 128 B  | exactly one 128-byte chunk, no partial tail    |
| `partial300` | 300 B  | two full chunks plus a 44-byte remainder       |
| `exact1024`  | 1024 B | eight chunks, exact multiple — off-by-one trap |

`.ram.bin` is `loadp2 -SINGLE` (checksum handshake, ends `?` → `.`).
`.flash.bin` is `loadp2 -SINGLE -FLASH` (flash stub prepended, ends `~`).

Test images are generated rather than stored: byte `i` is `(i * 7) & 0xff`.

There is deliberately no routine job that re-derives these. The protocol they
capture is the Propeller 2's mask-ROM boot loader — it is fixed in silicon, so
there is nothing to drift against.

## Adding a case

Only needed to cover an image shape the four above don't. Build `loadp2` from
source:

```bash
git clone --depth 1 https://github.com/totalspectrum/loadp2 && cd loadp2
printf 'unsigned char flash_stub_bin[]={0};\nunsigned int flash_stub_bin_len=0;\n' > flash_stub.h
cc -O1 -o loadp2_posix loadp2.c osint_linux.c loadelf.c u9fs/*.c -I. -Iu9fs
```

The released macOS binary cannot be pointed at a PTY: `osint_linux.c` calls
`IOSSIOSPEED` under `#ifdef MACOSX`, which fails on a PTY at any rate, so
`serial_init` bails with `failure setting speed`. Compiling without `-DMACOSX`
takes the plain termios path, which a PTY accepts — the protocol code is
identical either way. `flash_stub.h` is normally produced by a spin2 compiler
and is referenced only by the two-stage `-FLASH` path, which the single-stage
loads captured here never reach, so a stub is fine.

Then capture, and add the case to `CASES` in `../conformance.test.ts`:

```bash
python3 -c "open('img.bin','wb').write(bytes(((i*7)&0xff) for i in range(SIZE)))"
tools/capture-loadp2-golden.py ./loadp2_posix img.bin NAME.ram.bin   -SINGLE
tools/capture-loadp2-golden.py ./loadp2_posix img.bin NAME.flash.bin -SINGLE -FLASH
```
