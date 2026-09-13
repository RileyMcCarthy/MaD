#!/usr/bin/env python3
"""One-instruction silicon probe: capture P2-EVAL I/O, replay on p2core.

A fixed stub (`hwtest/probe.spin2`) loads `{encoding, prefix, D, S, C, Z, hub}`
from a mailbox, executes prefix+op in cog 1, and prints a DUMP. `--capture`
patches that mailbox per case, RAM-loads onto a P2-EVAL, and writes
`hwtest/golden/probe.txt` plus the stub binary. `cargo test --test silicon_probe`
interprets the same patched image in p2core.

Usage:
  python3 tools/hw_probe.py --capture     # P2-EVAL; writes goldens
  python3 tools/hw_probe.py --iss         # p2core vs committed goldens
  python3 tools/hw_probe.py --case add_reg
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import pty
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CRATE = Path(__file__).resolve().parents[1]
PROBE_C = CRATE / "hwtest" / "probe.c"
PROBE_WORKER = CRATE / "hwtest" / "probe_worker.spin2"
GOLDEN_DIR = CRATE / "hwtest" / "golden"
GOLDEN_TXT = GOLDEN_DIR / "probe.txt"
GOLDEN_BIN = GOLDEN_DIR / "probe.binary"
PIO = Path.home() / ".platformio" / "packages"
DEFAULT_PORT = os.environ.get("P2_PORT", "/dev/cu.usbserial-PLX6ZJLYQ")
BAUD = "230400"
MAGIC = bytes.fromhex("0df055aa010bdec0")  # $AA55F00D $C0DE0B01 LE
DREG = 0x1E0
SREG = 0x1E1
SCRATCH = "scratch"


def flexspin() -> Path:
    root = PIO / "toolchain-flexcc"
    for sub in ("macos-amd64", "linux-amd64", "windows-amd64"):
        name = "flexspin.exe" if sub.startswith("windows") else "flexspin"
        p = root / "bin" / sub / name
        if p.is_file():
            return p
    return root / "bin" / "macos-amd64" / "flexspin"


def loadp2_bin() -> Path:
    system = platform.system()
    sub = {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}.get(system, "macos")
    name = "loadp2.exe" if system == "Windows" else "loadp2"
    return PIO / "tool-loadp2" / "bin" / sub / name


def s1(op7: int, d: int, s: int, *, i: int = 0, c: int = 0, z: int = 0) -> int:
    return (
        (0xF << 28)
        | (op7 << 21)
        | (c << 20)
        | (z << 19)
        | (i << 18)
        | ((d & 0x1FF) << 9)
        | (s & 0x1FF)
    )


def setq_imm(n: int) -> int:
    return (0xF << 28) | (0b1101011 << 21) | (1 << 18) | ((n & 0x1FF) << 9) | 0x28


def augs(imm23: int) -> int:
    return (0xF << 28) | (0b11110 << 23) | (imm23 & 0x7FFFFF)


def augd(imm23: int) -> int:
    return (0xF << 28) | (0b11111 << 23) | (imm23 & 0x7FFFFF)


def case(
    name: str,
    enc: int,
    *,
    din: int | str = 0,
    sin: int = 0,
    pre: int = 0,
    flags: int = 0,
    hub_in: tuple[int, int, int, int] = (0, 0, 0, 0),
) -> dict:
    return {
        "name": name,
        "enc": enc,
        "pre": pre,
        "din": din,
        "sin": sin,
        "flags": flags,
        "hub_in": hub_in,
    }


def build_cases() -> list[dict]:
    out: list[dict] = [
        case("add_reg", s1(8, DREG, SREG), din=2, sin=3),
        case("add_imm", s1(8, DREG, 4, i=1), din=2),
        case("shl_msb", s1(3, DREG, 1, i=1, c=1), din=0x80000000),
        case("shl_one", s1(3, DREG, 1, i=1, c=1), din=1),
        case("encod_zero", s1(60, DREG, SREG, c=1), din=0xFFFFFFFF, sin=0),
        case("encod_msb", s1(60, DREG, SREG, c=1), din=0, sin=0x80000000),
        case("getbyte0", s1(71, DREG, SREG, c=0, z=0), din=0xFFFFFFFF, sin=0x11223344),
        case("getbyte1", s1(71, DREG, SREG, c=0, z=1), din=0xFFFFFFFF, sin=0x11223344),
        case("getbyte2", s1(71, DREG, SREG, c=1, z=0), din=0xFFFFFFFF, sin=0x11223344),
        case("getbyte3", s1(71, DREG, SREG, c=1, z=1), din=0xFFFFFFFF, sin=0x11223344),
        case("getnib0", s1(66, DREG, SREG, c=0, z=0), din=0xFFFFFFFF, sin=0x12345678),
        case("getnib3", s1(66, DREG, SREG, c=1, z=1), din=0xFFFFFFFF, sin=0x12345678),
        case("setword0", s1(73, DREG, SREG, c=0, z=0), din=0xFFFFFFFF, sin=0xAABBCCDD),
        case("setword1", s1(73, DREG, SREG, c=0, z=1), din=0xFFFFFFFF, sin=0xAABBCCDD),
        case("getword", s1(73, DREG, SREG, c=1, z=0), din=0xFFFFFFFF, sin=0xAABBCCDD),
        case("mov_reg", s1(48, DREG, SREG), din=0, sin=0xA5A5A5A5),
        case("muxc_c1", s1(44, DREG, SREG), din=0, sin=0xFFFF, flags=1),
        case("muxc_c0", s1(44, DREG, SREG), din=0xFFFF, sin=0x00FF, flags=0),
        case("muxz_z1", s1(46, DREG, SREG), din=0, sin=0xFFFF, flags=2),
        case("muxz_z0", s1(46, DREG, SREG), din=0xFFFF, sin=0x00FF, flags=0),
        case(
            "setq_fill",
            s1(99, 0, DREG, z=1),
            pre=setq_imm(2),
            din=SCRATCH,
            hub_in=(1, 2, 3, 4),
        ),
        case("augs_add", s1(8, DREG, 0, i=1), pre=augs(1), din=1),
        case("augd_mov", s1(48, 0, SREG, z=1), pre=augd(1), sin=0),
        case(
            "altd_add",
            s1(8, 0, 5, i=1),
            pre=s1(76, DREG, 0, i=1, z=1),
            din=0x1E1,
            sin=10,
        ),
        case(
            "alts_add",
            s1(8, DREG, 0),
            pre=s1(76, SREG, 0, i=1, c=1),
            din=10,
            sin=DREG,
        ),
    ]
    seen = {c["name"] for c in out}
    keys = {
        (c["enc"], c["pre"], c["din"], c["sin"], c["flags"], c["hub_in"]) for c in out
    }
    for spec in decode_sweep_cases():
        k = (spec["enc"], spec["pre"], spec["din"], spec["sin"], spec["flags"], spec["hub_in"])
        if spec["name"] in seen or k in keys:
            continue
        out.append(spec)
        seen.add(spec["name"])
        keys.add(k)
    return out


def decode_sweep_cases() -> list[dict]:
    cmd = [
        "cargo",
        "run",
        "--release",
        "-q",
        "-p",
        "p2core",
        "--example",
        "probe_encodings",
    ]
    print("+", " ".join(cmd), flush=True)
    proc = subprocess.run(cmd, cwd=str(CRATE.parent), capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit("probe_encodings failed")
    out: list[dict] = []
    for raw in proc.stdout.splitlines():
        line = raw.strip()
        if not line.startswith("{"):
            continue
        o = json.loads(line)
        enc = int(o["enc"], 16)
        op = o["op"]
        name = f"swp_{op}_{o['enc']}"
        if o.get("hub"):
            out.append(case(name, enc, din=SCRATCH, hub_in=(1, 2, 3, 4)))
            continue
        out.append(case(name, enc, din=0x80000000, sin=1))
        out.append(case(f"{name}_b", enc, din=2, sin=3))
    return out


_CASES: list[dict] | None = None


def all_cases() -> list[dict]:
    global _CASES
    if _CASES is None:
        _CASES = build_cases()
        print(f"probe cases: {len(_CASES)}", flush=True)
    return _CASES


def mailbox_off(image: bytes) -> int:
    i = image.find(MAGIC)
    if i < 0:
        sys.exit("probe mailbox magic not found in image")
    return i


def patch_image(image: bytes, spec: dict) -> bytes:
    buf = bytearray(image)
    off = mailbox_off(image)
    din = spec["din"]
    if din == SCRATCH:
        din = off + 32
    fields = [
        (8, spec["enc"]),
        (12, spec["pre"]),
        (16, din),
        (20, spec["sin"]),
        (24, spec["flags"]),
        (28, 0),
    ]
    for rel, val in fields:
        buf[off + rel : off + rel + 4] = int(val).to_bytes(4, "little")
    for i, val in enumerate(spec["hub_in"]):
        buf[off + 32 + i * 4 : off + 36 + i * 4] = int(val).to_bytes(4, "little")
    buf[off + 60 : off + 64] = (0).to_bytes(4, "little")  # done
    return bytes(buf)


def flexcc() -> Path:
    root = PIO / "toolchain-flexcc"
    for sub in ("macos-amd64", "linux-amd64", "windows-amd64"):
        name = "flexcc.exe" if sub.startswith("windows") else "flexcc"
        p = root / "bin" / sub / name
        if p.is_file():
            return p
    return root / "bin" / "macos-amd64" / "flexcc"


def write_worker_header(worker_bin: Path, header: Path) -> None:
    data = worker_bin.read_bytes()
    if len(data) % 4:
        data += b"\x00" * (4 - len(data) % 4)
    longs = [
        int.from_bytes(data[i : i + 4], "little") for i in range(0, len(data), 4)
    ]
    lines = [
        "/* generated from probe_worker.spin2 — do not edit */",
        "#pragma once",
        "#include <stdint.h>",
        f"static uint32_t probe_worker[{len(longs)}] = {{",
    ]
    for i in range(0, len(longs), 4):
        chunk = ", ".join(f"0x{v:08X}u" for v in longs[i : i + 4])
        lines.append(f"    {chunk},")
    lines.append("};")
    lines.append("")
    header.write_text("\n".join(lines), encoding="utf-8")


def compile_probe(out: Path) -> None:
    build = CRATE / "hwtest" / "build"
    build.mkdir(parents=True, exist_ok=True)
    worker_bin = build / "probe_worker.bin"
    header = build / "probe_worker.h"
    spin = flexspin()
    cmd = [str(spin), "-2", "-c", "-o", str(worker_bin), str(PROBE_WORKER)]
    print("+", " ".join(cmd), flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        sys.exit(f"flexspin worker failed ({proc.returncode})")
    write_worker_header(worker_bin, header)

    cc = flexcc()
    inc = PIO / "toolchain-flexcc" / "include"
    cmd = [
        str(cc),
        "-2",
        "-O1",
        "-DP2_TARGET_MHZ=160",
        f"-I{inc}",
        f"-I{build}",
        "-o",
        str(out),
        str(PROBE_C),
    ]
    print("+", " ".join(cmd), flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        sys.exit(f"flexcc failed ({proc.returncode})")
    print(f"compiled {out} ({out.stat().st_size} bytes)", flush=True)


def parse_dump(text: str) -> dict | None:
    dump = None
    hub = None
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if line.startswith("DUMP "):
            parts = line.split()
            if len(parts) >= 6:
                dump = parts[1:]
        elif line.startswith("HUB "):
            parts = line.split()
            if len(parts) >= 5:
                hub = parts[1:]
    if not dump:
        return None
    return {
        "enc": int(dump[0], 16),
        "d": int(dump[1], 16),
        "s": int(dump[2], 16),
        "c": int(dump[3], 10),
        "z": int(dump[4], 10),
        "hub": [int(x, 16) for x in (hub or ["0"] * 4)[:4]],
    }


def run_iss(binary: Path) -> dict:
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
        "END",
        "80000000",
    ]
    print("+", " ".join(cmd), flush=True)
    proc = subprocess.run(cmd, cwd=str(CRATE.parent), capture_output=True, text=True)
    got = parse_dump(proc.stdout)
    if got is None:
        sys.stderr.write(proc.stderr)
        sys.stderr.write(proc.stdout)
        sys.exit("ISS produced no DUMP")
    return got


def run_hw(binary: Path, port: str, timeout_s: float = 15.0) -> dict:
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
                    if b"END" in raw:
                        time.sleep(0.15)
                        break
            except (BlockingIOError, OSError):
                pass
            if proc.poll() is not None:
                break
            time.sleep(0.02)
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
    got = parse_dump(text)
    if got is None:
        sys.stderr.write(text)
        sys.exit("hardware produced no DUMP")
    return got


def format_case_block(spec: dict, out: dict, mailbox: int) -> str:
    din = spec["din"]
    if din == SCRATCH:
        din = mailbox + 32
    hub_in = ",".join(f"{v:08x}" for v in spec["hub_in"])
    hub_out = ",".join(f"{v:08x}" for v in out["hub"])
    return "\n".join(
        [
            f"CASE {spec['name']}",
            (
                f"IN  enc={spec['enc']:08x} pre={spec['pre']:08x} "
                f"din={int(din):08x} sin={spec['sin']:08x} flags={spec['flags']} "
                f"hub={hub_in}"
            ),
            (
                f"OUT d={out['d']:08x} s={out['s']:08x} "
                f"c={out['c']} z={out['z']} hub={hub_out}"
            ),
        ]
    )


def write_golden(blocks: list[str], binary: Path) -> None:
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(binary, GOLDEN_BIN)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = [
        "# One-instruction silicon probe. Each CASE is (encoding, in) → silicon out.",
        "# Source: hwtest/probe.c + hwtest/probe_worker.spin2",
        f"# Captured: {stamp}",
        "# Recapture: python3 tools/hw_probe.py --capture",
        "",
        *blocks,
        "",
    ]
    GOLDEN_TXT.write_text("\n".join(body), encoding="utf-8")
    print(f"wrote {GOLDEN_TXT} ({len(blocks)} cases)", flush=True)
    print(f"wrote {GOLDEN_BIN} ({GOLDEN_BIN.stat().st_size} bytes)", flush=True)


def parse_golden(path: Path = GOLDEN_TXT) -> list[dict]:
    if not path.is_file():
        sys.exit(f"missing {path}; capture with: python3 tools/hw_probe.py --capture")
    cases: list[dict] = []
    cur: dict | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("CASE "):
            cur = {"name": line.split(None, 1)[1]}
            cases.append(cur)
        elif line.startswith("IN ") and cur is not None:
            for tok in line[3:].split():
                k, _, v = tok.partition("=")
                if k == "hub":
                    cur["hub_in"] = tuple(int(x, 16) for x in v.split(","))
                elif k == "flags":
                    cur[k] = int(v, 10)
                else:
                    cur[k] = int(v, 16)
        elif line.startswith("OUT ") and cur is not None:
            out = {}
            for tok in line[4:].split():
                k, _, v = tok.partition("=")
                if k == "hub":
                    out["hub"] = [int(x, 16) for x in v.split(",")]
                elif k in ("c", "z"):
                    out[k] = int(v, 10)
                else:
                    out[k] = int(v, 16)
            cur["out"] = out
    return cases


def dump_eq(a: dict, b: dict) -> bool:
    return (
        a["d"] == b["d"]
        and a["s"] == b["s"]
        and a["c"] == b["c"]
        and a["z"] == b["z"]
        and a["hub"] == b["hub"]
    )


def resolve_din(spec: dict, mailbox: int) -> int:
    din = spec["din"]
    if din == SCRATCH:
        return mailbox + 32
    return int(din)


def pty_read_until(master: int, buf: bytearray, marker: bytes, deadline: float) -> None:
    while time.time() < deadline:
        try:
            chunk = os.read(master, 4096)
            if chunk:
                buf.extend(chunk)
                if marker in buf:
                    return
        except (BlockingIOError, OSError):
            pass
        time.sleep(0.01)
    raise TimeoutError(buf.decode("latin1", "replace")[-500:])


def start_hw_session(binary: Path, port: str):
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
    buf = bytearray()
    try:
        pty_read_until(master, buf, b"READY", time.time() + 12)
    except TimeoutError as e:
        proc.terminate()
        os.close(master)
        sys.exit(f"hardware did not print READY\n{e}")
    return proc, master, buf


def session_query(master: int, buf: bytearray, spec: dict, mailbox: int) -> dict:
    din = resolve_din(spec, mailbox)
    h = spec["hub_in"]
    line = (
        f"GO {spec['enc']:08x} {spec['pre']:08x} {din:08x} {spec['sin']:08x} "
        f"{spec['flags']} {h[0]:08x} {h[1]:08x} {h[2]:08x} {h[3]:08x}\r\n"
    )
    os.write(master, line.encode("ascii"))
    start = len(buf)
    pty_read_until(master, buf, b"HUB ", time.time() + 6)
    time.sleep(0.05)
    try:
        while True:
            chunk = os.read(master, 4096)
            if not chunk:
                break
            buf.extend(chunk)
    except (BlockingIOError, OSError):
        pass
    text = buf[start:].decode("latin1", "replace")
    got = parse_dump(text)
    if got is None:
        sys.exit(f"no DUMP for {spec['name']}:\n{text}")
    return got


def stop_hw_session(proc, master: int) -> None:
    try:
        os.write(master, b"QUIT\r\n")
        time.sleep(0.2)
    except OSError:
        pass
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
    os.close(master)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--capture", action="store_true")
    ap.add_argument("--iss", action="store_true")
    ap.add_argument("--case", action="append", default=[])
    ap.add_argument("--port", default=DEFAULT_PORT)
    args = ap.parse_args()

    want = set(args.case)
    specs = [c for c in all_cases() if not want or c["name"] in want]
    if not specs:
        sys.exit(f"no cases match {want}")

    rc = 0
    if args.capture:
        with tempfile.TemporaryDirectory(prefix="p2probe-") as td:
            stub = Path(td) / "probe.binary"
            compile_probe(stub)
            raw = stub.read_bytes()
            moff = mailbox_off(raw)
            proc, master, buf = start_hw_session(stub, args.port)
            blocks = []
            try:
                for spec in specs:
                    print(f"=== {spec['name']} silicon ===", flush=True)
                    hw = session_query(master, buf, spec, moff)
                    print(
                        f"  d={hw['d']:08x} s={hw['s']:08x} c={hw['c']} z={hw['z']} hub={hw['hub']}"
                    )
                    blocks.append(format_case_block(spec, hw, moff))
            finally:
                stop_hw_session(proc, master)
            write_golden(blocks, stub)
        return rc

    if not GOLDEN_BIN.is_file():
        sys.exit("no golden binary; capture with: python3 tools/hw_probe.py --capture")
    goldens = parse_golden()
    if want:
        goldens = [g for g in goldens if g["name"] in want]
    raw = GOLDEN_BIN.read_bytes()
    with tempfile.TemporaryDirectory(prefix="p2probe-iss-") as td:
        for g in goldens:
            spec = {
                "name": g["name"],
                "enc": g["enc"],
                "pre": g["pre"],
                "din": g["din"],
                "sin": g["sin"],
                "flags": g["flags"],
                "hub_in": g["hub_in"],
            }
            patched = Path(td) / f"{g['name']}.binary"
            patched.write_bytes(patch_image(raw, spec))
            print(f"=== {g['name']} ISS ===", flush=True)
            iss = run_iss(patched)
            want_out = g["out"]
            if dump_eq(iss, want_out):
                print(f"MATCH {g['name']}")
            else:
                print(f"MISMATCH {g['name']}")
                print(f"  iss     d={iss['d']:08x} s={iss['s']:08x} c={iss['c']} z={iss['z']} hub={iss['hub']}")
                print(
                    f"  silicon d={want_out['d']:08x} s={want_out['s']:08x} "
                    f"c={want_out['c']} z={want_out['z']} hub={want_out['hub']}"
                )
                rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
