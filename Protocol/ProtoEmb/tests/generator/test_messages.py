"""Message enrichment: command-frame inference, priority defaults, semantic
classification, request scalars, and READ/WRITE command sorting."""

from protoemb_testkit import field, message, process, schema, struct

# A trivial payload struct reused as request/response across these cases.
PAYLOAD = {"P": struct(field("x", "uint8"))}


def proc(messages, **extra):
    return process(schema(structs=PAYLOAD, messages=messages,
                          nodes=["dev"], **extra))["messages"]


def test_periodic_message_is_read_low_priority():
    m = proc({"telemetry": message(command_id=0, period_ms=1000, response="P")})["telemetry"]
    assert m["_command_frame"] == "read"
    assert m["_is_periodic"] and m["_semantic"] == "periodic"
    assert m["_priority"] == "low"          # periodic defaults to low priority


def test_plain_query_response_without_request_is_read():
    m = proc({"get": message(command_id=2, response="P")})["get"]
    assert m["_command_frame"] == "read"
    assert m["_semantic"] == "query"
    assert m["_priority"] == "high"         # non-periodic defaults to high


def test_command_with_request_payload_is_write():
    m = proc({"set": message(command_id=0, request="P")})["set"]
    assert m["_command_frame"] == "write"
    assert m["_has_request_payload"]
    assert m["_semantic"] == "command"


def test_explicit_command_frame_overrides_inference():
    # A response+no-request would infer READ; force it to WRITE.
    m = proc({"act": message(command_id=5, response="P", command_frame="write")})["act"]
    assert m["_command_frame"] == "write"
    assert m["_command_frame_explicit"]


def test_async_message_without_command_id():
    m = proc({"evt": message(response="P")})["evt"]
    assert m["_is_async"] and m["_semantic"] == "async"
    assert m["_command_frame"] is None      # no command id -> no wire frame kind


def test_request_scalar_bool_counts_as_payload():
    m = proc({"toggle": message(command_id=1, request="bool")})["toggle"]
    assert m["_request_scalar"] == "bool"
    assert m["_has_request_payload"]
    assert m["_command_frame"] == "write"


def test_request_scalar_none_has_no_payload():
    m = proc({"ping": message(command_id=1, request="none", response="P")})["ping"]
    assert m["_request_scalar"] == "none"
    assert m["_has_request_payload"] is False
    assert m["_command_frame"] == "read"    # no request payload + response -> read


def test_read_and_write_lists_sorted_by_command_id():
    data = process(schema(structs=PAYLOAD, nodes=["dev"], messages={
        "r1": message(command_id=2, response="P"),
        "r0": message(command_id=0, response="P", command_frame="read"),
        "w1": message(command_id=1, request="P"),
        "w0": message(command_id=0, request="P"),
    }))
    reads = [m["_command_id"] for m in data["runtime_read_messages"]]
    writes = [m["_command_id"] for m in data["runtime_write_messages"]]
    assert reads == sorted(reads)
    assert writes == sorted(writes)


def test_payload_struct_is_linked():
    m = proc({"get": message(command_id=0, response="P")})["get"]
    assert m["_payload_struct"] is not None
    assert m["_payload_struct"]["_name"] == "P"
