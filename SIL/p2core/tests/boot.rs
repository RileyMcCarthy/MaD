//! Boot and slice-B acceptance tests against the real firmware image.
//!
//! These skip (rather than fail) when the artifact is absent, so the crate
//! still tests standalone. Build it with:
//!
//! ```text
//! cd Firmware/MaDCore && pio run -e propeller2_debug
//! ```

use std::path::PathBuf;

use p2core::{Board, Machine, SdCard, SmartPins};

/// `_main` in the hubexec image, cross-checked against `program.p2asm`
/// (`_main` opens with `mov arg01,#0` / `call #__getiolock_1727`).
const MAIN_HUB_ADDR: u32 = 0x10274;

/// Remove ANSI SGR escape sequences from captured console text.
///
/// The debug macro emits the colour immediately before the timestamp, so
/// `\x1b[32m0.001` is a single whitespace-delimited token that will not parse
/// as a float.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for e in chars.by_ref() {
                if e.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn image() -> Option<Vec<u8>> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../Firmware/MaDCore/.pio/build/propeller2_debug/program");
    std::fs::read(p).ok()
}

#[test]
fn boot_trampoline_reaches_main() {
    let Some(img) = image() else {
        eprintln!("skipping: propeller2_debug/program not built");
        return;
    };
    let mut m = Machine::new(&img, SmartPins::default());

    let mut reached = false;
    for _ in 0..2_000 {
        if m.cogs[0].pc == MAIN_HUB_ADDR {
            reached = true;
            break;
        }
        if m.step(1).is_err() {
            break;
        }
    }
    assert!(
        reached,
        "cog 0 did not reach _main (${MAIN_HUB_ADDR:05X}); stopped at ${:05X}",
        m.cogs[0].pc
    );
}

#[test]
fn clock_setup_records_clkfreq() {
    let Some(img) = image() else {
        eprintln!("skipping: propeller2_debug/program not built");
        return;
    };
    let mut m = Machine::new(&img, SmartPins::default());
    for _ in 0..200 {
        if m.step(1).is_err() {
            break;
        }
    }
    // The kernel writes `_clkfreq` to hub $14 before calling _main
    // (program.p2asm:26, `wrlong ##160000000, #20`).
    assert_eq!(
        m.clkfreq(),
        160_000_000,
        "clkfreq at hub $14 should be the image's _clkfreq, not the P2's max"
    );
}

#[test]
fn all_zero_word_is_nop_not_ret_ror() {
    // Regression: an all-zero word decodes as ROR under the `_RET_` condition
    // unless NOP is special-cased, which returns through an empty stack and
    // spins at $0 forever.
    let d = p2core::decode(0).expect("zero word decodes");
    assert_eq!(d.op.mnemonic(), "nop");
    assert_eq!(d.cond, 15, "NOP must not carry the _RET_ condition");
}

#[test]
fn augd_decodes_as_well_as_augs() {
    // Regression: keying the AUG table on `op >> 4` matched AUGS only, so
    // every AUGD in the clock-setup sequence came back undecoded.
    assert_eq!(p2core::decode(0xFF000002).unwrap().op.mnemonic(), "augs");
    assert_eq!(p2core::decode(0xFF808003).unwrap().op.mnemonic(), "augd");
}

#[test]
fn hub_write_with_l_bit_decodes() {
    // Regression: bit 19 is the L (D-is-literal) mode bit for `operand_lsp`,
    // not WZ, so `wrlong ##160000000, #20` failed to decode.
    let d = p2core::decode(0xFC6C0014).expect("wrlong with L set decodes");
    assert_eq!(d.op.mnemonic(), "wrlong");
    assert!(d.l, "L bit should be set");
}

/// Slice B: the firmware initialises its serial smart pins and transmits.
///
/// `__system___txraw` (program.p2asm:25805) polls `rdpin #62 wc` — C means
/// BUSY, not ready — then `drvl #62` / `wypin local01, #62`. WYPIN is the real
/// hardware interface an async-TX smart pin receives its byte through, so this
/// exercises the whole path from `DEBUG_INFO` down to the pin.
#[test]
fn firmware_transmits_its_startup_banner() {
    let Some(img) = image() else {
        eprintln!("skipping: propeller2_debug/program not built");
        return;
    };
    let mut m = Machine::new(&img, SmartPins::default());
    m.step(50_000_000).expect("no trap");

    assert!(
        m.pins.mode[62] != 0,
        "firmware never configured the TX smart pin"
    );
    let text = m.pins.console();
    assert!(
        text.contains("Starting MaD"),
        "startup banner missing from {} transmitted bytes",
        m.pins.tx_bytes(62).len()
    );
    // The debug logger emits file/line/function, so a real log line landed too.
    assert!(
        text.contains("dev_nvram.c"),
        "expected a DEBUG log line with its source file"
    );
}

/// The SD card is absent, so the firmware must take its documented
/// mount-failure path rather than spinning on the SPI smart pin.
#[test]
fn absent_sd_card_takes_the_failure_path() {
    let Some(img) = image() else {
        eprintln!("skipping: propeller2_debug/program not built");
        return;
    };
    let mut m = Machine::new(&img, SmartPins::default());
    m.step(200_000_000).expect("no trap");

    let text = m.pins.console();
    assert!(
        text.contains("failed to mount sd card"),
        "expected the mount-failure path"
    );
    assert!(
        text.contains("Using failsafe records"),
        "expected the failsafe-records path, got:\n{text}"
    );
}

/// The soft-float path works, so formatted numbers are sane.
///
/// Regression: the P2's shifts set C to the last bit shifted out and `ENCOD`
/// sets C from `S != 0`. Leaving those flags untouched left integer behaviour
/// perfect but corrupted every float the firmware computes — the log's
/// `HAL_time_getUs() / 1000000.0f` timestamp printed 155128140.000 seconds.
/// MaD's force and position maths is float, so this was never cosmetic.
#[test]
fn soft_float_produces_sane_timestamps() {
    let Some(img) = image() else {
        eprintln!("skipping: propeller2_debug/program not built");
        return;
    };
    let mut m = Machine::new(&img, SmartPins::default());
    m.step(200_000_000).expect("no trap");

    // Strip ANSI colour codes: the debug macro emits the colour immediately
    // before the timestamp, so `\x1b[32m0.001` is one whitespace-delimited
    // token and will not parse as a float.
    let raw = m.pins.console();
    let text = strip_ansi(&raw);
    let stamps: Vec<f64> = text
        .split_whitespace()
        .filter(|w| w.contains('.'))
        .filter_map(|w| w.parse::<f64>().ok())
        .collect();
    assert!(!stamps.is_empty(), "no timestamps found in the console");

    // Virtual time is a few seconds; a broken float path printed 1.5e8.
    let elapsed_s = m.now_us() as f64 / 1e6;
    for t in &stamps {
        assert!(
            *t <= elapsed_s + 1.0,
            "timestamp {t} exceeds elapsed virtual time {elapsed_s:.3}s -- soft float is wrong"
        );
    }
}


/// FlexC tags pointers and relies on the hub masking them.
///
/// `$015E8` builds `$0004B8A0 | $02D00000` with an `augs`/`or` pair and hands
/// the tagged value straight to `rdbyte`. Silicon ignores the upper bits, so
/// the ISS must too -- `strict_hub` would call this out-of-range, which is why
/// it is off by default and documented as a bring-up aid rather than a check.
#[test]
fn tagged_pointers_are_masked_to_the_hub_map() {
    let Some(img) = image() else {
        return;
    };
    let mut m = Machine::new(&img, SmartPins::default());
    assert!(!m.strict_hub, "strict_hub must default off: it false-positives on tagged pointers");
    m.step(200_000_000).expect("tagged pointers must not trap");
}

/// Multi-cog bring-up: the cog manager starts the whole machine.
///
/// `REP D,S` repeats D instructions S times. With the operands swapped the
/// block ran one instruction long, so an FCACHE'd loop executed its trailing
/// `_ret_` every iteration, popping the call stack until it underflowed and
/// returned to the address after `call #_main` — ending the program before any
/// worker cog started.
#[test]
fn cog_manager_starts_the_other_cogs() {
    let Some(img) = image() else {
        return;
    };
    let mut m = Machine::new(&img, SmartPins::default());
    m.step(400_000_000).expect("no trap");

    let running = m.cogs.iter().filter(|c| c.running).count();
    assert!(
        running > 1,
        "expected the cog manager to start workers; only {running} cog(s) running"
    );
    let text = strip_ansi(&m.pins.console());
    assert!(
        text.contains("Monitor cog init"),
        "expected the cog manager to announce startup"
    );
}


/// SIL readiness: the firmware boots to a fully-populated machine.
///
/// All eight cogs run and every peripheral the machine needs has its smart
/// pins configured -- the force gauge UART (0/2), the servo encoder (9), the
/// protocol link to the host (53/55 at 2,000,000 baud), the SD SPI (58-61) and
/// the debug console (62/63). That is the point at which a host-side test can
/// start driving the protocol.
#[test]
fn boots_to_a_fully_configured_machine() {
    let Some(img) = image() else {
        return;
    };
    let mut m = Machine::new(&img, Board::new(SdCard::blank(32 * 1024 * 1024)));
    m.step(400_000_000).expect("no trap");

    let running = m.cogs.iter().filter(|c| c.running).count();
    assert_eq!(running, 8, "expected all eight cogs running");

    for (pin, what) in [
        (0u8, "force-gauge RX"),
        (2, "force-gauge TX"),
        (53, "protocol RX"),
        (55, "protocol TX"),
        (62, "debug TX"),
    ] {
        assert!(
            m.pins.is_configured(pin),
            "{what} (pin {pin}) was never configured"
        );
    }
}

/// The full SIL loop: a host request in, a structured protocol response out.
///
/// Frames are `[SYNC, frameType, command, ...]` per the generated runtime
/// (`protoemb_runtime.c`), so asking for the firmware version is
/// `[0x55, READ, PROTOEMB_MSG_READ_FIRMWARE_VERSION]`. The reply carries the
/// version string, which is what makes this a round trip rather than an echo.
#[test]
fn firmware_answers_a_protocol_request() {
    let Some(img) = image() else {
        return;
    };
    let mut m = Machine::new(&img, Board::new(SdCard::blank(32 * 1024 * 1024)));

    // Let the machine finish booting before asking it anything.
    m.step(200_000_000).expect("no trap during boot");
    let before = m.pins.proto_tx.len();

    const SYNC: u8 = 0x55;
    const FRAME_READ: u8 = 0x00;
    const MSG_READ_FIRMWARE_VERSION: u8 = 3;
    m.pins.send_protocol(&[SYNC, FRAME_READ, MSG_READ_FIRMWARE_VERSION]);
    m.step(200_000_000).expect("no trap while answering");

    let reply = &m.pins.proto_tx[before..];
    assert!(
        !reply.is_empty(),
        "firmware sent nothing back on the protocol link"
    );

    let sync = reply
        .iter()
        .position(|&b| b == SYNC)
        .expect("no frame sync in the reply");
    let frame = &reply[sync..];
    assert!(frame.len() >= 3, "reply truncated: {frame:02X?}");
    assert_eq!(
        frame[2], MSG_READ_FIRMWARE_VERSION,
        "reply is for the wrong command: {frame:02X?}"
    );

    // The payload carries the version string, so the response is real data
    // rather than a bare ack.
    let text = String::from_utf8_lossy(frame);
    assert!(
        text.contains("0.0.0"),
        "expected a version string in the payload, got {frame:02X?}"
    );
}
