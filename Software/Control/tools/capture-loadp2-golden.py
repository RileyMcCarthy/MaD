#!/usr/bin/env python3
"""Capture exactly what loadp2 transmits, by playing the P2 boot ROM on a PTY."""
import os, pty, subprocess, select, sys, time, json

LOADP2 = sys.argv[1]
IMAGE = sys.argv[2]
EXTRA = sys.argv[3:]

master, slave = pty.openpty()
slave_name = os.ttyname(slave)
import termios, tty
tty.setraw(master)
tty.setraw(slave)

proc = subprocess.Popen(
    [LOADP2, "-p", slave_name, "-l", "115200", "-b", "115200", *EXTRA, IMAGE],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
)

captured = bytearray()
answered_chk = False
deadline = time.time() + 25
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.25)
    if r:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        captured += data
        # Play the ROM: answer the autobaud probe once.
        if not answered_chk and b"Prop_Chk 0 0 0 0" in bytes(captured):
            os.write(master, b"\r\nProp_Ver G")
            answered_chk = True
        # Answer the checksum request.
        if captured.endswith(b"?"):
            os.write(master, b".")
    if proc.poll() is not None and not r:
        break

try:
    proc.wait(timeout=3)
except subprocess.TimeoutExpired:
    proc.kill()
out = proc.stdout.read().decode(errors="replace") if proc.stdout else ""

result = {
    "args": EXTRA,
    "loadp2_stdout": out.strip()[:2000],
    "total_bytes": len(captured),
    "capture_hex": captured.hex(),
}
print(json.dumps(result))
