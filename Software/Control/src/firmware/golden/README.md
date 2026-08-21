# Golden wire captures from the real `loadp2`

Each `.hex` file is the **exact byte stream the reference `loadp2` transmits**
for one image and one mode, captured off a PTY while a script played the part
of the P2 boot ROM. `conformance.test.ts` asserts our TypeScript loader emits
the same bytes, so a regression in framing, chunking, or checksum arithmetic
fails CI without needing `loadp2` or hardware present.

This is the strongest evidence we have that the loader is correct: it compares
against the implementation everyone actually flashes P2s with, not against our
own understanding of the protocol.

| case         | image size | why it's here                                  |
| ------------ | ---------- | ---------------------------------------------- |
| `tiny4`      | 4 B        | single long, smallest legal image              |
| `chunk128`   | 128 B      | exactly one 128-byte chunk, no partial tail    |
| `partial300` | 300 B      | two full chunks plus a 44-byte remainder       |
| `exact1024`  | 1024 B     | eight chunks, exact multiple — off-by-one trap |

`.ram.hex` is `loadp2 -SINGLE` (checksum handshake, ends `?` → `.`).
`.flash.hex` is `loadp2 -SINGLE -FLASH` (flash stub prepended, ends `~`).

## Regenerating

Only needed if the loader protocol itself changes — which means `loadp2`
changed, which is rare. Requires a local `loadp2` build:

```bash
git clone --depth 1 https://github.com/totalspectrum/loadp2 && cd loadp2
printf 'unsigned char flash_stub_bin[]={0};\nunsigned int flash_stub_bin_len=0;\n' > flash_stub.h
cc -O1 -o loadp2_posix loadp2.c osint_linux.c loadelf.c u9fs/*.c -I. -Iu9fs
```

The stock macOS binary cannot be used: `osint_linux.c` calls `IOSSIOSPEED`
under `#ifdef MACOSX`, which always fails on a PTY. Building without
`-DMACOSX` takes the plain termios path, which a PTY accepts. The protocol
code being compared is identical either way.

Then capture with `tools/capture-loadp2-golden.py` (see its header) and
regenerate our side with `tools/capture-loader-bytes.mts`.

Test images are generated, not stored — byte `i` is `(i * 7) & 0xff`. See
`conformance.test.ts`.
