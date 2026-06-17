"""Cross-language wire conformance for the thermostat example protocol.

A single Python vector set is rendered into C, Rust, and TypeScript drivers
(see render.py). Each driver encodes every vector, prints `<label> <hex>`, and
self-checks decode(encode(v)) -> re-encode round-trips. The test asserts the
three languages emit byte-identical wire for every vector AND that none reported
a round-trip mismatch — a single source of truth enforced across all backends.

This exercises far more than examples/verify.sh's three fixed values: packed and
aligned layouts, scale + offset-binary, plain and remap enums (including the
index != value case the example never tested), all union variants, nested
structs, fixed arrays, strings, and optional present/absent.
"""

import os

import pytest
from _harness import pivot_by_label, run_all

PROTOEMB_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
THERMOSTAT = os.path.join(PROTOEMB_ROOT, "examples", "thermostat.yaml")
PREFIX = "Thermostat"

# All vectors must agree across C/Rust/TS. (Aligned scaled fields like
# `Schedule.slots` once diverged because C/Rust ignored `scale`; the generator's
# aligned path now applies it — see SCALED_ALIGNED_VECTORS below for the lock-in.)
SCALED_ALIGNED_VECTORS = {"sched_named", "sched_full"}  # Schedule.slots, scale 10

# (label, struct, value) — value shapes follow render.py's field-type dispatch.
VECTORS = [
    # Reading: packed scalars with scale + offset-binary, at range extremes.
    ("reading_min", "Reading", {"temp": -40, "humidity": 0}),
    ("reading_max", "Reading", {"temp": 85, "humidity": 100}),
    ("reading_mid", "Reading", {"temp": 23, "humidity": 44}),
    ("reading_zero", "Reading", {"temp": 0, "humidity": 50}),

    # Datum: a uint nibble + the Sample tagged union, every variant.
    ("datum_temp_lo", "Datum", {"channel": 0, "value": ("temperature", -40)}),
    ("datum_temp_hi", "Datum", {"channel": 15, "value": ("temperature", 85)}),
    ("datum_humid", "Datum", {"channel": 3, "value": ("humidity", 55)}),
    ("datum_fan_off", "Datum", {"channel": 1, "value": ("fan", "OFF")}),
    ("datum_fan_low", "Datum", {"channel": 2, "value": ("fan", "LOW")}),
    ("datum_fan_high", "Datum", {"channel": 4, "value": ("fan", "HIGH")}),
    # AUTO: remap value 9 != wire index 3 — the case examples/verify.sh skips.
    ("datum_fan_auto", "Datum", {"channel": 5, "value": ("fan", "AUTO")}),

    # ZoneState: plain enum, remap enum, scaled setpoint, bool, nested Reading.
    ("zone_lo", "ZoneState", {"mode": "OFF", "fan": "OFF", "setpoint": 0,
                              "occupied": False, "current": {"temp": -40, "humidity": 0}}),
    ("zone_hi", "ZoneState", {"mode": "AUTO", "fan": "AUTO", "setpoint": 40,
                              "occupied": True, "current": {"temp": 85, "humidity": 100}}),
    ("zone_mid", "ZoneState", {"mode": "HEAT", "fan": "HIGH", "setpoint": 21,
                               "occupied": True, "current": {"temp": 23, "humidity": 44}}),

    # Schedule: aligned layout, string (empty / partial / full-15), int16[8] array.
    ("sched_empty", "Schedule", {"name": "", "slots": [0] * 8, "active": False}),
    ("sched_named", "Schedule", {"name": "weekday",
                                 "slots": [0, 10, -40, 85, 20, -5, 100, -100], "active": True}),
    ("sched_full", "Schedule", {"name": "abcdefghijklmno",  # 15 chars + NUL fills [16]
                                "slots": [1, 2, 3, 4, 5, 6, 7, 8], "active": True}),

    # SensorPacket: optional bool + optional nested struct, present and absent.
    ("pkt_absent", "SensorPacket", {"id": 5, "reading": {"temp": 23, "humidity": 44},
                                    "fault": None, "zone": None}),
    ("pkt_fault_false", "SensorPacket", {"id": 0, "reading": {"temp": -40, "humidity": 0},
                                         "fault": False, "zone": None}),
    ("pkt_full", "SensorPacket", {
        "id": 31, "reading": {"temp": 85, "humidity": 100}, "fault": True,
        "zone": {"mode": "COOL", "fan": "LOW", "setpoint": 20, "occupied": True,
                 "current": {"temp": 0, "humidity": 50}}}),
]


@pytest.fixture(scope="module")
def outputs(tmp_path_factory):
    """Generate the codec to every target and run each available driver once.

    Returns {lang: [lines]} for whichever toolchains exist; missing toolchains
    are simply absent so the test can decide whether enough languages ran.
    """
    work = str(tmp_path_factory.mktemp("thermostat_conf"))
    return run_all(THERMOSTAT, PREFIX, VECTORS, work)


def test_at_least_two_languages_available(outputs):
    # Conformance is meaningless with one backend; require a cross-check.
    assert len(outputs) >= 2, (
        f"need >=2 toolchains for conformance, ran: {sorted(outputs)}"
    )


def test_no_roundtrip_mismatch(outputs):
    for lang, lines in outputs.items():
        bad = [ln for ln in lines if ln.endswith("ROUNDTRIP_MISMATCH")]
        assert not bad, f"{lang} round-trip failures: {bad}"


def test_every_vector_emitted(outputs):
    labels = {lbl for lbl, _s, _v in VECTORS}
    for lang, lines in outputs.items():
        got = {ln.split(" ", 1)[0] for ln in lines}
        assert got == labels, f"{lang} emitted {got ^ labels} unexpectedly"


def test_wire_is_byte_identical_across_languages(outputs):
    # Pivot to {label: {lang: hex}} and assert one distinct hex per label.
    langs = sorted(outputs)
    by_label = pivot_by_label(outputs)

    mismatches = []
    for label, per_lang in sorted(by_label.items()):
        distinct = set(per_lang.values())
        if len(distinct) != 1:
            mismatches.append(f"{label}: " + ", ".join(
                f"{lg}={per_lang[lg]}" for lg in langs if lg in per_lang))
    assert not mismatches, "wire divergence:\n" + "\n".join(mismatches)


def test_aligned_scaled_field_agrees_across_languages(outputs):
    """Lock-in for the aligned-scale fix: the `Schedule.slots` vectors (aligned,
    scale 10, non-zero values) must be byte-identical across every language. This
    used to diverge because C/Rust ignored `scale` in the aligned path."""
    by_label = pivot_by_label(outputs)
    for label in SCALED_ALIGNED_VECTORS:
        per_lang = by_label[label]
        assert len(set(per_lang.values())) == 1, (
            f"{label} diverges: " + ", ".join(f"{lg}={h}" for lg, h in sorted(per_lang.items()))
        )
