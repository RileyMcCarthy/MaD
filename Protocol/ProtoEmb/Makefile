# ProtoEmb — self-contained test + build orchestration.
#
# The whole library tests itself with `make test`, with no dependency on the
# surrounding MaD monorepo. Layers:
#   test-generator   pytest over core/generate.py (schema math, layout, validation)
#   test-conformance pytest cross-language wire conformance (C == Rust == TS)
#   test-rust        cargo test for the framing + runtime crates
#   verify           the example round-trip script (examples/verify.sh)
#
# Requires on PATH: python3 (+ pyyaml, jinja2, pytest), cc, rustc/cargo, and for
# the TypeScript leg tsc (or npx) + node. Missing TS/JS toolchains skip the TS
# conformance leg rather than fail.

PYTHON  ?= python3
PYTEST  ?= $(PYTHON) -m pytest
PYTEST_FLAGS ?= -q
# Unset ELECTRON_RUN_AS_NODE: when it leaks from a VSCode/Electron shell it breaks
# the node-driven TypeScript conformance leg.
RUN_PYTEST = env -u ELECTRON_RUN_AS_NODE $(PYTEST) $(PYTEST_FLAGS)

.PHONY: test test-generator test-conformance test-rust test-framing test-runtime \
        verify setup clean

## Run the full suite.
test: test-generator test-conformance test-rust

## Install Python test dependencies (generator deps + pytest).
setup:
	$(PYTHON) -m pip install -r tests/requirements.txt

## Unit-test the code generator.
test-generator:
	$(RUN_PYTEST) tests/generator

## Cross-language wire conformance (generates, compiles C/Rust/TS, diffs wire).
test-conformance:
	$(RUN_PYTEST) tests/conformance

## Rust crate tests (both are path crates; no shared workspace here).
test-rust: test-framing test-runtime

test-framing:
	cargo test --manifest-path framing/Cargo.toml

test-runtime:
	cargo test --manifest-path runtime/Cargo.toml

## The example generate + round-trip + conformance shell check.
verify:
	./examples/verify.sh

clean:
	rm -rf framing/target runtime/target
	find tests -name '__pycache__' -type d -prune -exec rm -rf {} +
	find . -name '.pytest_cache' -type d -prune -exec rm -rf {} +
