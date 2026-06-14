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

echo ""
echo "ALL TARGETS OK — ProtoEmb generated a complete C/Rust/TS codec for a"
echo "non-MaD protocol (custom prefix, multiple nodes, remap enum, nested"
echo "structs, fixed-count arrays, optional fields, packed + aligned)."
