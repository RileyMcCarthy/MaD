---
applyTo: "Protocol/MaDProtocol.yaml"
---

Protocol wire schema. Full conventions: `docs/coding-guidelines/protocol-yaml.md`.

**CRITICAL — the wire format is append-only.** Never reorder or insert enum variants,
struct fields, or union variants: it silently breaks firmware↔UI↔SIL compatibility. Flag
any reorder/insert, and any breaking change not paired with a `protocol_version` bump.
All three targets (C / TS / Rust) must be regenerated after any change.

Also flag: numeric fields missing a `unit`, and casing-convention deviations. The
generator's validator enforces the mechanical rules (id uniqueness, packing budget, etc.)
— don't re-report those.
