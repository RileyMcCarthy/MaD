#!/usr/bin/env python3
"""Extract flexcc's own mnemonic for every hub address, as a decoder oracle.

`program.p2asm` is the listing the real compiler emitted for the exact image the
ISS runs, which makes it the one instruction-level oracle available offline --
the P2 RTL is not public and spinsim's FPGA-golden corpus needs the network.

Reconstructing addresses means tracking `orgh` (hub origin), `org` (a cog block,
still stored contiguously in hub), `orgf` (pad to a cog long), and two things
that are easy to miss:

  * a `##` operand is ONE listing line but TWO assembled words (an AUG prefix
    then the instruction);
  * flexspin INDENTS some labels (`popregs_`, FCACHE labels), so tokens must be
    filtered against the authoritative mnemonic set or every later address
    shifts by one long.

Verified anchors: $400 `_ret_ mov`, $404 `entry: cmp ptra,#0`, $804 `call #_main`
(cog $100 after `orgf 256`).

Usage: python3 tools/gen_golden.py [path/to/program.p2asm]
Writes tests/golden/hub_mnemonics.txt (gitignored; regenerate after a rebuild).
"""

import re
import sys
from pathlib import Path

CRATE = Path(__file__).resolve().parent.parent
DEFAULT_LST = CRATE / "../../Firmware/MaDCore/.pio/build/propeller2_debug/program.p2asm"
OUT = CRATE / "tests" / "golden" / "hub_mnemonics.txt"

COND = re.compile(r"^(?:if_[a-z_]+|_ret_)\s+")
DIRECTIVES = {"alignl", "alignw", "fit", "res", "con", "dat", "pub", "pri", "file"}
WIDTH = {"long": 4, "byte": 1, "word": 2}


def known_mnemonics() -> set:
    """The authoritative mnemonic set, from the same table the decoder uses."""
    src = (CRATE / "vendor" / "parseUtils.ts").read_text(encoding="utf-8")
    names = set(re.findall(r"eAsmcode\.ac_(\w+)", src))
    names.update({"nop", "ret", "reta", "retb", "calla", "callb"})
    return names


MNEMONICS = known_mnemonics()


def num(tok: str):
    tok = tok.strip()
    if tok.startswith("$"):
        try:
            return int(tok[1:], 16)
        except ValueError:
            return None
    try:
        return int(tok)
    except ValueError:
        return None


def extract(lines):
    hub, cog_base, out = None, None, []
    for ln in lines:
        if not ln.strip() or ln.lstrip().startswith("'"):
            continue
        body = ln.strip()

        m = re.match(r"^orgh\s+(\S+)", body)
        if m and num(m.group(1)) is not None:
            hub = num(m.group(1))
            continue
        if re.match(r"^orgh\b", body):
            continue
        m = re.match(r"^orgf\s+(\S+)", body)
        if m and cog_base is not None and num(m.group(1)) is not None:
            hub = cog_base + num(m.group(1)) * 4
            continue
        if re.match(r"^org\b", body):
            cog_base = hub
            continue
        if not ln[:1].isspace():
            continue  # a label

        s = COND.sub("", body).strip()
        m = re.match(r"^(long|byte|word)\b(.*)", s)
        if m:
            rest = m.group(2).strip()
            count = 1
            if rest:
                rep = re.search(r"\[(\d+)\]", rest)
                count = int(rep.group(1)) if rep else rest.count(",") + 1
            if hub is not None:
                hub += WIDTH[m.group(1)] * count
            continue

        m = re.match(r"^([a-z][a-z0-9_]*)\b", s)
        if not m or m.group(1) in DIRECTIVES or m.group(1) not in MNEMONICS:
            continue
        if hub is None:
            continue
        mnemonic, operands = m.group(1), s[m.end():]
        if "##" in operands:
            first = operands.split(",", 1)[0]
            out.append((hub, "augd" if "##" in first else "augs"))
            hub += 4
        out.append((hub, mnemonic))
        hub += 4
    return out


def main() -> int:
    lst = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_LST
    if not lst.exists():
        print(f"missing {lst}; build with: pio run -e propeller2_debug", file=sys.stderr)
        return 1
    rows = extract(lst.read_text(encoding="utf-8", errors="replace").splitlines())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as f:
        for addr, mnemonic in rows:
            f.write(f"{addr:06X} {mnemonic}\n")
    print(f"{len(rows)} hub instructions -> {OUT.relative_to(CRATE)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
