---
applyTo: "Software/Control/src/**"
---

TypeScript / React conventions for the control app.

The app (`Software/Control/src`) uses only Web Serial + File System Access, and
test-only fakes live in `e2e/`, never in `src/`. Focus on what `tsc`
and ESLint can't decide:
- `exactOptionalPropertyTypes` / null-vs-undefined semantics the compiler doesn't enforce
  (omit the key, don't assign `undefined`);
- `interface`-vs-`type` and enum-vs-string-union modelling;
- error shape by layer (throw vs `{ success, error }`), and whether an `any` is a
  legitimate boundary (Comlink/varargs) or laziness.

Don't re-report `tsc` or ESLint errors.
