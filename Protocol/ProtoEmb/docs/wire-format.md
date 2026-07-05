# ProtoEmb wire format

This is the on-wire contract a ProtoEmb protocol speaks. It has two layers: the
**frame** (transport framing + integrity) and the **payload** (struct
encoding). The frame layer is implemented twice today — in the Rust
`protoemb-framing` crate (host) and in the generated C runtime (device) — and
both must agree with this document.

## 1. Frame layer

All multi-byte frame fields are little-endian. Every frame begins with a sync
byte `0x55`.

```text
READ request:   [0x55] [0x00] [CMD]
WRITE request:  [0x55] [0x01] [CMD] [LEN_LO] [LEN_HI] [DATA…] [CRC8]
NACK response:  [0x55] [0x00] [CMD]
ACK response:   [0x55] [0x01] [CMD]
DATA response:  [0x55] [0x02] [CMD] [LEN_LO] [LEN_HI] [DATA…] [CRC8]
NOTIFICATION:   [0x55] [0x03] [0x00] [LEN_LO] [LEN_HI] [DATA…] [CRC8]
```

- **Type byte** is direction-overloaded: `0x00` = READ (host→device) or NACK
  (device→host); `0x01` = WRITE or ACK; `0x02` = DATA; `0x03` = NOTIFICATION.
- **LEN** is a 16-bit payload length; payloads are capped at `MAX_PAYLOAD`
  (default 4096).
- **CRC8** is CRC-8/MAXIM (poly `0x8C`, reflected) over `DATA` only.
- The streaming parser resynchronises by scanning for `0x55`; there is no
  byte-stuffing, so integrity rests on the CRC plus a clean stream.

`command` (`CMD`) selects a message. READ and WRITE command-id spaces are
independent; a DATA frame's command identifies which response payload it
carries (the generator enforces that DATA-producing command ids are unique).

## 2. Payload layer (struct encoding)

A struct is either `packed` (bit-level, no padding) or `aligned` (byte-level,
fixed C-type sizes). Both produce a **fixed wire size** known at generation
time (`*_WIRE_SIZE`). Fields are laid out in declaration order.

### Scalars

- **Integers** use the field's declared width (aligned) or a bit count derived
  from `min`/`max`×`scale`, or an explicit `bits:` (packed).
- **`scale`** maps physical units to integer wire steps. In TS the codec
  multiplies/divides by `scale`; in C/Rust the in-memory struct already holds
  the scaled integer (so `scale` is applied by accessors / by the caller).
  `raw_storage: true` makes this explicit and generates `set*/get*` helpers.
- **`min`** shifts to offset-binary so the full bit range is usable for signed
  or non-zero-based ranges.
- A fractional `scale` is only valid on a `float` field.

### Enums

A plain enum is encoded as its variant **index** in `ceil(log2(count))` bits. A
`remap: true` enum has sparse semantic **values**; the wire still carries the
compact index, with generated index↔value tables (a dense array, or a sorted
table + binary search when the value span is large and sparse).

### Composite (this work)

- **Nested struct** (`type: OtherStruct`): the child's layout is inlined at the
  parent's offset. Parent and child must share an encoding.
- **Array** (`count: N`): `N` consecutive elements of the field type. Wire size
  = `N × element_size`. Elements may be scalars, enums, bools, or nested
  structs.
- **Optional** (`optional: true`): a 1-bit (packed) / 1-byte (aligned) presence
  flag precedes the always-allocated value. If the flag is clear the value is
  ignored on decode (`None` / `null` / `*_present == false`). Cannot combine
  with `count` or `string`.
- **Tagged union** (a top-level `unions:` type used as a field): a discriminant
  tag (`ceil(log2(N))` bits packed / 1 byte aligned) followed by a payload
  region sized to the **largest** variant, so the wire size stays fixed. Decode
  reads the tag and interprets the payload as that variant. Emitted as a C
  tagged struct, a Rust enum, and a TS discriminated union (`{ tag, value }`).
  Variants are scalars/enums/bools (struct variants are future work).

### Strings

A `string` is a fixed `max_length`-byte field, NUL-padded, decoded up to the
first NUL.

## 3. Versioning

`protocol_version` is emitted as a constant in every target. It is **not**
currently part of the frame; a version handshake / frame field is future work.
