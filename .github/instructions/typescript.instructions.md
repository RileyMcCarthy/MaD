---
applyTo: "Software/MaDWasmControl/src/**,Software/MaDControl/src/**"
---

TypeScript / React. Full conventions: `docs/coding-guidelines/typescript.md`.

The shipped app (`Software/MaDWasmControl/src`) uses only Web Serial + File System Access
— no Electron, and test-only fakes live in `e2e/`, never in `src/`. Focus on what `tsc`
and ESLint can't decide:
- `exactOptionalPropertyTypes` / null-vs-undefined semantics the compiler doesn't enforce
  (omit the key, don't assign `undefined`);
- `interface`-vs-`type` and enum-vs-string-union modelling;
- error shape by layer (throw vs `{ success, error }`), and whether an `any` is a
  legitimate boundary (Comlink/varargs) or laziness.

Don't re-report `tsc` or ESLint errors.
