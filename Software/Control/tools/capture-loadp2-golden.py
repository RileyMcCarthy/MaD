#!/usr/bin/env python3
"""Capture the exact byte stream `loadp2` transmits, by playing the P2 boot ROM.

Opens a PTY, runs loadp2 against it, and answers the two prompts the ROM would
answer ("\r\nProp_Ver G" to the autobaud probe, "." to the checksum request) so
loadp2 runs a complete download. Everything loadp2 writes is captured verbatim.

    capture-loadp2-golden.py <loadp2> <image> <out.bin> [loadp2 flags...]

Used by regen-loadp2-goldens.sh; see src/firmware/golden/README.md.
"""
import os, pty, subprocess, select, sys, time, tty

loadp2, image, out = sys.argv[1], sys.argv[2], sys.argv[3]
flags = sys.argv[4:]

master, slave = pty.openpty()
tty.setraw(master)
tty.setraw(slave)

# 115200 rather than the real 2 Mbaud: a PTY will not accept arbitrary rates,
# and the framing under test does not depend on the rate.
proc = subprocess.Popen(
    [loadp2, "-p", os.ttyname(slave), "-l", "115200", "-b", "115200", *flags, image],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
)

captured = bytearray()
answered = False
deadline = time.time() + 30
while time.time() < deadline:
    ready, _, _ = select.select([master], [], [], 0.25)
    if ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        captured += data
        if not answered and b"Prop_Chk 0 0 0 0" in bytes(captured):
            os.write(master, b"\r\nProp_Ver G")
            answered = True
        if captured.endswith(b"?"):
            os.write(master, b".")
    elif proc.poll() is not None:
        break

try:
    proc.wait(timeout=3)
except subprocess.TimeoutExpired:
    proc.kill()

noise = (proc.stdout.read().decode(errors="replace") if proc.stdout else "").strip()
if not captured:
    print(f"FAILED: loadp2 transmitted nothing. Its output was: {noise}", file=sys.stderr)
    sys.exit(1)

with open(out, "wb") as f:
    f.write(captured)
print(f"{os.path.basename(out)}: {len(captured)} bytes" + (f" (loadp2 said: {noise})" if noise else ""))
