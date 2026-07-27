#!/usr/bin/env python3
"""Find the serial-control-line reset that boots this board from flash.

Tries DTR and RTS, both polarities, and reports which sequence yields the
firmware boot banner ("Starting MaD Board"). One open per attempt.
"""
import os
import time
import serial

DEV = os.environ.get("MAD_SERIAL", "/dev/cu.usbserial-PLX6ZJLYQ")
BAUD = int(os.environ.get("MAD_BAUD", "230400"))


def drain(ser, seconds):
    end = time.time() + seconds
    buf = bytearray()
    while time.time() < end:
        n = ser.in_waiting
        if n:
            buf += ser.read(n)
        else:
            time.sleep(0.01)
    return bytes(buf)


def attempt(line, run_level, label):
    """line: 'dtr' or 'rts'. run_level: the value that means RUN (not reset)."""
    ser = serial.Serial()
    ser.port = DEV
    ser.baudrate = BAUD
    ser.rtscts = False
    ser.dsrdtr = False
    ser.timeout = 0.1
    # Start in RUN state on both lines so neither pins reset.
    ser.dtr = True
    ser.rts = True
    ser.open()
    # Put the chosen line into RUN, the other to True (inactive-ish).
    setattr(ser, line, run_level)
    setattr(ser, "rts" if line == "dtr" else "dtr", True)
    time.sleep(0.1)
    ser.reset_input_buffer()
    # Pulse to the RESET state and back to RUN.
    setattr(ser, line, not run_level)
    time.sleep(0.05)
    setattr(ser, line, run_level)
    boot = drain(ser, 1.8)
    ser.close()
    hit = b"Starting MaD Board" in boot
    print(f"[{label}] bytes={len(boot)} banner={'YES' if hit else 'no'}  {boot[:50]!r}")
    return hit


def main():
    print(f"sweeping reset lines on {DEV} @ {BAUD}")
    tries = [
        ("dtr", True, "DTR run=True, pulse low"),
        ("dtr", False, "DTR run=False, pulse high"),
        ("rts", True, "RTS run=True, pulse low"),
        ("rts", False, "RTS run=False, pulse high"),
    ]
    for line, run_level, label in tries:
        if attempt(line, run_level, label):
            print(f"\n>>> WORKING RESET: {label} ({line}) <<<")
            return
    print("\n>>> no banner from any reset polarity — flash boot not happening <<<")


if __name__ == "__main__":
    main()
