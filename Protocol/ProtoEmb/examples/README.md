# ProtoEmb examples

A standalone, **non-MaD** protocol that exercises the full ProtoEmb feature set,
to demonstrate (and regression-test) that the generator and runtime are generic.

## `thermostat.yaml`

A smart-thermostat protocol that uses:

- a custom library **prefix** (`Thermostat`) — multiple ProtoEmb protocols can
  coexist in one codebase
- multiple **nodes** (`hub`, `sensor`)
- a plain **enum** (`Mode`) and a **remap enum** with sparse values (`FanCmd`)
- **nested structs** (`ZoneState.current: Reading`, `SensorPacket.reading`)
- a **fixed-count array** (`Schedule.slots: int16[8]`)
- **optional fields** (`SensorPacket.fault`, `SensorPacket.zone`)
- both **packed** (bit-level) and **aligned** (byte-level) encodings
- the generated **typed facade** (`Inbound::decode_data` / `decodeData`)

## Verify

```bash
./verify.sh
```

Generates the protocol into C, Rust, and TypeScript and checks each one
compiles / typechecks / round-trips. Nothing MaD-specific is required.
