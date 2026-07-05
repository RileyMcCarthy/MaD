#!/usr/bin/env python3
"""Hardware read (and optional save) of the machine profile via pyserial.

Single held-open connection with explicit DTR control so we can tell apart:
  - does merely opening the port reset the board?  (banner appears pre-pulse)
  - does an explicit DTR pulse reset it?           (banner appears post-pulse)
  - does the flash-booted firmware answer the protocol? (machine-config frame)

Read request frame  = [0x55, 0x00, cmd]
DATA reply frame    = [0x55, 0x02, cmd, len_lo, len_hi, <payload>, crc8(maxim)]
Write request frame = [0x55, 0x01, cmd, len_lo, len_hi, <payload>, crc8]; ACK = [0x55,0x01,cmd], NACK = [0x55,0x00,cmd]

  MAD_SERIAL=/dev/cu.usbserial-XXXX python3 tools/hw_pyserial_readsave.py [--save]
"""
import os
import sys
import time
import struct
import fcntl
import array

import serial

# macOS: this PL2303 ignores the termios baud (stty 230400 -> stays 9600), so
# force the true line rate via IOSSIOSPEED, exactly like loadp2 does.
IOSSIOSPEED = 0x80085402  # _IOW('T', 2, speed_t=unsigned long, 8 bytes)


def force_baud(ser, baud):
    buf = array.array("Q", [baud])  # 8-byte unsigned long
    fcntl.ioctl(ser.fileno(), IOSSIOSPEED, buf, True)

DEV = os.environ.get("MAD_SERIAL", "/dev/cu.usbserial-PLX6ZJLYQ")
BAUD = int(os.environ.get("MAD_BAUD", "230400"))
DO_SAVE = "--save" in sys.argv

CMD_READ_STATE = 1
CMD_READ_MACHINE_CONFIG = 2
CMD_READ_FIRMWARE_VERSION = 3
CMD_WRITE_MACHINE_CONFIG = 0  # machine_configuration_write command_id


def crc8(data: bytes) -> int:
    crc = 0
    for b in data:
        for _ in range(8):
            mix = (crc ^ b) & 0x01
            crc >>= 1
            if mix:
                crc ^= 0x8C
            b >>= 1
    return crc & 0xFF


def drain(ser, seconds):
    # Read directly (blocking up to ser.timeout); do NOT rely on in_waiting,
    # which this PL2303 macOS driver does not implement (always 0).
    end = time.time() + seconds
    buf = bytearray()
    while time.time() < end:
        chunk = ser.read(256)
        if chunk:
            buf += chunk
    return bytes(buf)


def find_frame(buf, cmd, payload_len):
    needle = bytes([0x55, 0x02, cmd, payload_len & 0xFF, (payload_len >> 8) & 0xFF])
    i = buf.find(needle)
    if i < 0:
        return None
    payload = buf[i + 5 : i + 5 + payload_len]
    if len(payload) < payload_len:
        return None
    crc = buf[i + 5 + payload_len] if len(buf) > i + 5 + payload_len else None
    ok = crc is not None and crc == crc8(payload)
    return payload, ok


def decode_profile(p):
    name = p[0:20].split(b"\x00", 1)[0].decode("latin1", "replace")
    vals = struct.unpack_from("<11i", p, 20)
    keys = [
        "encoderStepsPerMM", "servoStepsPerMM", "forceGaugeNPerStep",
        "forceGaugeZeroOffset", "maxPosition", "maxVelocity", "maxAcceleration",
        "maxForceTensile_mN", "homingVelocity", "homingOffset", "jawOffset",
    ]
    d = {"name": name}
    d.update(dict(zip(keys, vals)))
    d["maxForceTensile_N"] = d["maxForceTensile_mN"] / 1000.0
    return d


def encode_profile(d):
    buf = bytearray(64)
    name = d["name"].encode("latin1")[:20]
    buf[0 : len(name)] = name
    struct.pack_into(
        "<11i", buf, 20,
        d["encoderStepsPerMM"], d["servoStepsPerMM"], d["forceGaugeNPerStep"],
        d["forceGaugeZeroOffset"], d["maxPosition"], d["maxVelocity"], d["maxAcceleration"],
        d["maxForceTensile_mN"], d["homingVelocity"], d["homingOffset"], d["jawOffset"],
    )
    return bytes(buf)


def read_config(ser, label):
    ser.reset_input_buffer()
    for _ in range(6):
        ser.write(bytes([0x55, 0x00, CMD_READ_MACHINE_CONFIG]))
        ser.flush()
        rx = drain(ser, 0.4)
        res = find_frame(rx, CMD_READ_MACHINE_CONFIG, 64)
        if res:
            payload, ok = res
            prof = decode_profile(payload)
            print(f"[{label}] machine profile (crc {'OK' if ok else 'BAD'}): {prof}")
            return prof
    print(f"[{label}] no machine-config reply")
    return None


def main():
    ser = serial.Serial()
    ser.port = DEV
    ser.baudrate = BAUD
    ser.bytesize = serial.EIGHTBITS
    ser.parity = serial.PARITY_NONE
    ser.stopbits = serial.STOPBITS_ONE
    ser.rtscts = False
    ser.dsrdtr = False
    ser.timeout = 0.1
    # Open in the RUN state (DTR/RTS high). If reset is active-low this avoids
    # pinning the board in reset (the earlier bug).
    ser.dtr = True
    ser.rts = True
    ser.open()
    try:
        force_baud(ser, BAUD)
        print(f"[baud] forced {BAUD} via IOSSIOSPEED")
    except Exception as e:
        print(f"[baud] IOSSIOSPEED failed: {e}")
    ser.dtr = True
    ser.rts = True

    no_reset = os.environ.get("MAD_NO_RESET") == "1"
    if no_reset:
        print("[open] no-reset mode: assuming firmware already running (e.g. just RAM-loaded)")
        pre = drain(ser, 0.4)
        print(f"[open] passive bytes: {len(pre)}  {pre[:40]!r}")
    else:
        # Reset pulse assuming active-low: drop to reset, back to run.
        print("[reset] pulsing DTR low→high…")
        ser.dtr = False
        time.sleep(0.05)
        ser.dtr = True
        boot = drain(ser, 1.8)
        print(f"[reset] bytes after DTR pulse: {len(boot)}  {boot[:60]!r}")
        if b"Starting MaD Board" in boot:
            print("[reset] >>> boot banner seen <<<")

    original = read_config(ser, "read")

    if DO_SAVE and original:
        stamp = ("RW-" + original["name"])[:20]
        mod = dict(original)
        mod["name"] = stamp
        print(f"[save] writing name -> {stamp!r}")
        payload = encode_profile(mod)
        frame = bytes([0x55, 0x01, CMD_WRITE_MACHINE_CONFIG, 64, 0]) + payload + bytes([crc8(payload)])
        ser.reset_input_buffer()
        ser.write(frame)
        ser.flush()
        ack = drain(ser, 0.8)
        is_ack = bytes([0x55, 0x01, CMD_WRITE_MACHINE_CONFIG]) in ack
        is_nack = bytes([0x55, 0x00, CMD_WRITE_MACHINE_CONFIG]) in ack
        print(f"[save] reply: {ack[:30]!r}  -> {'ACK' if is_ack else 'NACK' if is_nack else 'NONE'}")
        # Firmware persists to SD on save and asks for reboot; reset to reload.
        ser.dtr = True; time.sleep(0.05); ser.dtr = False
        drain(ser, 1.8)
        after = read_config(ser, "verify")
        persisted = bool(after and after["name"] == stamp)
        print(f"[save] persisted: {'YES' if persisted else 'NO'}")
        # Restore original name.
        print(f"[restore] writing name -> {original['name']!r}")
        payload = encode_profile(original)
        frame = bytes([0x55, 0x01, CMD_WRITE_MACHINE_CONFIG, 64, 0]) + payload + bytes([crc8(payload)])
        ser.reset_input_buffer(); ser.write(frame); ser.flush()
        drain(ser, 0.8)
        ser.dtr = True; time.sleep(0.05); ser.dtr = False
        drain(ser, 1.8)
        read_config(ser, "restored")

    ser.close()


if __name__ == "__main__":
    main()
