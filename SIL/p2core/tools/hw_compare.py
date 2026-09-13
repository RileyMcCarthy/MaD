#!/usr/bin/env python3
"""Silicon oracle: capture a P2-EVAL console trace, replay it on p2core.

The FlexC program `hwtest/oracle.c` prints one architectural observation per
line (PASS/FAIL with the value silicon produced, plus CLKFREQ and RESULT).
`--capture` RAM-loads that program onto a real P2, saves the console and the
exact binary, and those two files are the golden. `cargo test` and `--iss`
then interpret that same binary in p2core and demand a line-for-line match,
so a p2core change is compared against hardware without the board.

Usage:
  python3 tools/hw_compare.py --capture   # P2-EVAL required; writes hwtest/golden/
  python3 tools/hw_compare.py --iss       # p2core vs committed golden (no board)
  python3 tools/hw_compare.py --verify-hw # reload the golden binary onto the P2
  python3 tools/hw_compare.py             # --iss, and --verify-hw if the port exists

Environment: P2_PORT overrides the default FTDI path.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import platform
import pty
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CRATE = Path(__file__).resolve().parents[1]
GOLDEN_DIR = CRATE / "hwtest" / "golden"
PIO = Path.home() / ".platformio" / "packages"
DEFAULT_PORT = os.environ.get("P2_PORT", "/dev/cu.usbserial-PLX6ZJLYQ")
BAUD = "230400"
REPORT = re.compile(r"^(P2CORE-HW|CLKFREQ |PASS |FAIL |RESULT |LOCKS|COGS|TIMED)")
PROGS = {
    "oracle": "oracle.c",
    "locks": "locks.c",
    "cogs": "cogs.c",
    "timed": "timed.c",
}


def pio_exe(package: str, *rel: str) -> Path:
    return PIO / package / Path(*rel)


def flexcc_bin() -> Path:
    root = PIO / "toolchain-flexcc"
    system = platform.system()
    subs = {
        "Darwin": ["macos-amd64"],
        "Linux": ["linux-amd64", "raspberry-pi"],
        "Windows": ["windows-amd64"],
    }.get(system, ["macos-amd64", "linux-amd64"])
    names = ["flexcc.exe", "flexcc"] if system == "Windows" else ["flexcc"]
    for sub in subs:
        for name in names:
            p = root / "bin" / sub / name
            if p.is_file():
                return p
    return root / "bin" / "macos-amd64" / "flexcc"


def loadp2_bin() -> Path:
    system = platform.system()
    sub = {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}.get(
        system, "macos"
    )
    name = "loadp2.exe" if system == "Windows" else "loadp2"
    return PIO / "tool-loadp2" / "bin" / sub / name


def flexcc_include() -> Path:
    return PIO / "toolchain-flexcc" / "include"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=False, **kw)


def compile_oracle(src: Path, out: Path) -> None:
    cc = flexcc_bin()
    inc = flexcc_include()
    if not cc.is_file():
        sys.exit(f"flexcc not found at {cc}")
    cmd = [
        str(cc),
        "-2",
        "-O1",
        "-DP2_TARGET_MHZ=160",
        f"-I{inc}",
        "-o",
        str(out),
        str(src),
    ]
    print("+", " ".join(cmd), flush=True)
    proc = run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        sys.exit(f"flexcc failed ({proc.returncode})")
    if not out.is_file():
        sys.exit(f"flexcc produced no binary at {out}")
    print(f"compiled {out} ({out.stat().st_size} bytes)", flush=True)


def report_lines(text: str) -> list[str]:
    lines = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if REPORT.match(line):
            lines.append(line)
    return lines


def read_golden(path: Path) -> list[str]:
    if not path.is_file():
        sys.exit(f"missing golden {path}; capture with: python3 tools/hw_compare.py --capture")
    lines = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        lines.append(line)
    if not lines:
        sys.exit(f"golden {path} has no report lines")
    return lines


def write_golden(lines: list[str], binary: Path, src: Path, txt: Path, bin_path: Path) -> None:
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(binary, bin_path)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = [
        "# Silicon console captured from a P2-EVAL.",
        f"# Source: {src.relative_to(CRATE)}",
        f"# Captured: {stamp}",
        "# Recapture: python3 tools/hw_compare.py --capture --prog <name>",
        "",
        *lines,
        "",
    ]
    txt.write_text("\n".join(body), encoding="utf-8")
    print(f"wrote {txt} ({len(lines)} lines)", flush=True)
    print(f"wrote {bin_path} ({bin_path.stat().st_size} bytes)", flush=True)


def run_iss(binary: Path) -> list[str]:
    cmd = [
        "cargo",
        "run",
        "--release",
        "-p",
        "p2core",
        "--example",
        "until",
        "--",
        str(binary),
        "RESULT",
        "50000000",
    ]
    print("+", " ".join(cmd), flush=True)
    proc = run(
        cmd,
        cwd=str(CRATE.parent),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.stderr.write(proc.stdout)
        sys.exit(f"ISS run failed ({proc.returncode})")
    lines = report_lines(proc.stdout)
    if not lines:
        sys.stderr.write(proc.stderr)
        sys.stderr.write(proc.stdout)
        sys.exit("ISS produced no oracle report")
    return lines


def run_hw(binary: Path, port: str, timeout_s: float = 20.0) -> list[str]:
    lp = loadp2_bin()
    if not lp.is_file():
        sys.exit(f"loadp2 not found at {lp}")
    if not Path(port).exists():
        sys.exit(f"serial port {port} is not present")
    cmd = [
        str(lp),
        "-p",
        port,
        "-b",
        BAUD,
        "-f",
        "160000000",
        "-PATCH",
        "-t",
        "-q",
        str(binary),
    ]
    print("+", " ".join(cmd), flush=True)
    # loadp2's terminal talks through a real tty; a pipe gets the banner and
    # never the UART bytes (see Software/Control/tools/hw_loadp2_pty.py).
    master, slave = pty.openpty()
    proc = subprocess.Popen(
        cmd,
        stdin=slave,
        stdout=slave,
        stderr=subprocess.PIPE,
        close_fds=True,
    )
    os.close(slave)
    os.set_blocking(master, False)
    raw = bytearray()
    deadline = time.time() + timeout_s
    try:
        while time.time() < deadline:
            try:
                chunk = os.read(master, 4096)
                if chunk:
                    raw.extend(chunk)
                    if b"RESULT" in raw:
                        time.sleep(0.2)
                        break
            except (BlockingIOError, OSError):
                pass
            if proc.poll() is not None:
                break
            time.sleep(0.02)
        else:
            sys.stderr.buffer.write(bytes(raw))
            err = proc.stderr.read() if proc.stderr else b""
            sys.stderr.buffer.write(err)
            sys.exit(f"hardware produced no RESULT within {timeout_s}s")
        try:
            while True:
                chunk = os.read(master, 4096)
                if not chunk:
                    break
                raw.extend(chunk)
        except (BlockingIOError, OSError):
            pass
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        os.close(master)
    text = raw.decode("latin1", "replace")
    lines = report_lines(text)
    if not lines:
        err = proc.stderr.read() if proc.stderr else b""
        sys.stderr.write(text)
        sys.stderr.buffer.write(err)
        sys.exit("hardware produced no oracle report")
    return lines


def print_report(title: str, lines: list[str]) -> None:
    print(f"--- {title} ---")
    for line in lines:
        print(line)


def diff(left_name: str, left: list[str], right_name: str, right: list[str]) -> int:
    if left == right:
        print(f"MATCH {len(left)} lines — {left_name} agrees with {right_name}")
        return 0
    print(f"MISMATCH — {left_name} vs {right_name}")
    n = max(len(left), len(right))
    for i in range(n):
        a = left[i] if i < len(left) else "<missing>"
        b = right[i] if i < len(right) else "<missing>"
        mark = "  " if a == b else "! "
        print(f"{mark}{left_name:8} {a}")
        print(f"{mark}{right_name:8} {b}")
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--prog",
        choices=sorted(PROGS),
        default="oracle",
        help="report program to capture/replay (oracle, locks, cogs)",
    )
    ap.add_argument(
        "--capture",
        action="store_true",
        help="run the oracle on a P2-EVAL and write hwtest/golden/",
    )
    ap.add_argument(
        "--iss",
        action="store_true",
        help="interpret the golden binary in p2core and diff against the golden console",
    )
    ap.add_argument(
        "--verify-hw",
        action="store_true",
        help="reload the golden binary onto the P2 and diff against the golden console",
    )
    ap.add_argument("--port", default=DEFAULT_PORT)
    args = ap.parse_args()
    src = CRATE / "hwtest" / PROGS[args.prog]
    golden_txt = GOLDEN_DIR / f"{args.prog}.txt"
    golden_bin = GOLDEN_DIR / f"{args.prog}.binary"

    do_capture = args.capture
    do_iss = args.iss or not (args.capture or args.verify_hw)
    do_hw = args.verify_hw or (
        not args.capture
        and not args.iss
        and Path(args.port).exists()
    )

    rc = 0
    if do_capture:
        with tempfile.TemporaryDirectory(prefix="p2core-hw-") as td:
            binary = Path(td) / f"{args.prog}.binary"
            compile_oracle(src, binary)
            hw_lines = run_hw(binary, args.port)
            print_report("silicon", hw_lines)
            if not any(l.startswith("RESULT 0 PASS") for l in hw_lines):
                sys.exit("silicon oracle did not PASS; golden not written")
            write_golden(hw_lines, binary, src, golden_txt, golden_bin)
            iss_lines = run_iss(golden_bin)
            print_report("ISS", iss_lines)
            rc |= diff("iss", iss_lines, "silicon", hw_lines)
        return rc

    if not golden_bin.is_file() or not golden_txt.is_file():
        sys.exit(
            f"no golden yet; capture with: python3 tools/hw_compare.py --capture --prog {args.prog}"
        )

    golden = read_golden(golden_txt)
    if do_iss:
        iss_lines = run_iss(golden_bin)
        print_report("ISS", iss_lines)
        rc |= diff("iss", iss_lines, "golden", golden)
    if do_hw:
        hw_lines = run_hw(golden_bin, args.port)
        print_report("silicon", hw_lines)
        rc |= diff("silicon", hw_lines, "golden", golden)
    return rc


if __name__ == "__main__":
    sys.exit(main())
