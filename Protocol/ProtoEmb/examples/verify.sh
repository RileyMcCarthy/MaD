#!/usr/bin/env bash
# Generate the non-MaD `thermostat` example in all three target languages and
# verify each compiles / typechecks / round-trips. Proves ProtoEmb is generic:
# nothing about MaD leaks into the generator or runtime.
#
# Requires: python3 (+ pyyaml, jinja2), a C compiler, rustc, and tsc on PATH.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
core="$here/.."
schema="$here/thermostat.yaml"
templates="$core/core/templates"
gen="$core/core/generate.py"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

echo "== generating thermostat into $out =="
for t in c rs ts; do
  python3 "$gen" --schema "$schema" --target "$t" --output "$out/$t" --templates "$templates"
done

echo "== C: compile generated codec =="
cc -std=c11 -Wall -Wextra -c "$out/c/thermostat.c" -o "$out/c/thermostat.o" -I "$out/c"
echo "   ok"

echo "== Rust: rustc --test (built-in round-trip + facade tests) =="
rustc --edition 2021 --test "$out/rs/thermostat.rs" -o "$out/rs/test_bin"
"$out/rs/test_bin"

echo "== TypeScript: tsc --noEmit typecheck =="
tsc_flags=(--noEmit --strict --skipLibCheck --target es2020 --lib es2020,dom)
if command -v tsc >/dev/null 2>&1; then
  tsc "${tsc_flags[@]}" "$out/ts/thermostat.ts"
else
  npx --yes -p typescript tsc "${tsc_flags[@]}" "$out/ts/thermostat.ts"
fi
echo "   ok"

echo "== Conformance: C / Rust / TS must produce byte-identical wire output =="
# Each dumper encodes the same fixed values and prints hex; the three outputs
# must match exactly — a single source of truth enforced across all backends.
cp "$here/conformance/dump.c" "$out/c/dump.c"
cc -std=c11 -Wall -I "$out/c" "$out/c/thermostat.c" "$out/c/dump.c" -o "$out/c/dump"
"$out/c/dump" > "$out/c.hex"

cp "$here/conformance/dump.rs" "$out/rs/dump.rs"
rustc --edition 2021 "$out/rs/dump.rs" -o "$out/rs/dump" 2>/dev/null
"$out/rs/dump" > "$out/rs.hex"

cp "$here/conformance/dump.ts" "$out/ts/dump.ts"
tsc_bin() { if command -v tsc >/dev/null 2>&1; then tsc "$@"; else npx --yes -p typescript tsc "$@"; fi; }
tsc_bin --target es2020 --module commonjs --moduleResolution node --skipLibCheck --outDir "$out/ts/js" "$out/ts/dump.ts"
node "$out/ts/js/dump.js" > "$out/ts.hex"

if diff "$out/c.hex" "$out/rs.hex" >/dev/null && diff "$out/c.hex" "$out/ts.hex" >/dev/null; then
  echo "   ok — C == Rust == TS:"; sed 's/^/     /' "$out/c.hex"
else
  echo "   MISMATCH:"; echo "C:"; cat "$out/c.hex"; echo "Rust:"; cat "$out/rs.hex"; echo "TS:"; cat "$out/ts.hex"
  exit 1
fi

echo ""
echo "ALL TARGETS OK — ProtoEmb generated a complete, wire-conformant C/Rust/TS"
echo "codec for a non-MaD protocol (custom prefix, multiple nodes, remap enum,"
echo "nested structs, arrays, optional fields, tagged unions, packed + aligned)."
