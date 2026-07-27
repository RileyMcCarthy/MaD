#!/usr/bin/env python3
"""Read the machine profile by RAM-loading firmware with loadp2 and talking to
it through loadp2's terminal mode over a PTY (so loadp2 relays our raw protocol
bytes — a plain pipe did not). Proves firmware + protocol end-to-end while
loadp2 keeps the board running (no reopen).
"""
import os
import pty
import time
import struct
import subprocess

LOADP2 = os.path.expanduser("~/.platformio/packages/tool-loadp2/bin/macos/loadp2")
PROG = "/Users/rileymccarthy/Documents/MaD/Firmware/MaDCore/.pio/build/propeller2/program"
DEV = os.environ.get("MAD_SERIAL", "/dev/cu.usbserial-PLX6ZJLYQ")


def crc8(data):
    crc = 0
    for b in data:
        for _ in range(8):
            mix = (crc ^ b) & 1
            crc >>= 1
            if mix:
                crc ^= 0x8C
            b >>= 1
    return crc & 0xFF


def decode_profile(p):
    name = p[0:20].split(b"\x00", 1)[0].decode("latin1", "replace")
    v = struct.unpack_from("<11i", p, 20)
    keys = ["encoderStepsPerMM", "servoStepsPerMM", "forceGaugeNPerStep",
            "forceGaugeZeroOffset", "maxPosition", "maxVelocity", "maxAcceleration",
            "maxForceTensile_mN", "homingVelocity", "homingOffset", "jawOffset"]
    d = {"name": name}
    d.update(dict(zip(keys, v)))
    d["maxForceTensile_N"] = d["maxForceTensile_mN"] / 1000.0
    return d


def main():
    master, slave = pty.openpty()
    proc = subprocess.Popen(
        [LOADP2, "-p", DEV, "-b", "230400", "-t", "-q", PROG],
        stdin=slave, stdout=slave, stderr=subprocess.PIPE,
        close_fds=True,
    )
    os.close(slave)
    os.set_blocking(master, False)

    rx = bytearray()

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            try:
                chunk = os.read(master, 4096)
                if chunk:
                    rx.extend(chunk)
            except (BlockingIOError, OSError):
                pass
            time.sleep(0.01)

    print("[pty] loading firmware + entering terminal…")
    pump(3.0)
    print(f"[pty] after load: {len(rx)} bytes; tail={bytes(rx[-40:])!r}")

    print("[pty] sending read-machine-config requests…")
    for _ in range(5):
        try:
            os.write(master, bytes([0x55, 0x00, 0x02]))
        except OSError:
            break
        pump(0.4)

    try:
        proc.terminate()
    except Exception:
        pass

    data = bytes(rx)
    needle = bytes([0x55, 0x02, 0x02, 0x40, 0x00])
    i = data.find(needle)
    if i >= 0 and len(data) >= i + 5 + 64:
        payload = data[i + 5: i + 5 + 64]
        crc = data[i + 5 + 64] if len(data) > i + 5 + 64 else None
        ok = crc is not None and crc == crc8(payload)
        print(f"[pty] >>> machine-config frame found (crc {'OK' if ok else 'BAD'}) <<<")
        print("[pty] PROFILE:", decode_profile(payload))
    else:
        # Show whatever came back for diagnosis.
        print(f"[pty] no config frame. total={len(data)} bytes")
        print(f"[pty] hex tail: {data[-160:].hex()}")
        try:
            print(f"[pty] loadp2 stderr: {proc.stderr.read().decode('latin1','replace')[:300]}")
        except Exception:
            pass


if __name__ == "__main__":
    main()
