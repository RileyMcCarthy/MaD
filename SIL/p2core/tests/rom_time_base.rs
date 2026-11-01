//! Board time on a chip booted from the ROM follows the clock it runs on.
//!
//! Out of reset a P2 runs on RCFAST, and hub `$14` is the ROM's scratch, not
//! a clock rate. The machine starts its clock map on the oscillator and moves
//! it at each clock word, carrying time on from the instant of the switch.

use p2core::{decode, ClockSource, Machine, NullPins, Op, RCFAST_HZ, RCSLOW_HZ};
use vibes_behaviour::{behaviour, expect, Test};

/// An 80 MHz PLL off a 20 MHz crystal: ×4, VCO direct, 15 pF loading.
const PLL_80: u32 = 0x0100_03FB;
const PLL_80_HZ: u32 = 80_000_000;

/// `augd #(v >> 9)`: the upper 23 bits of the next instruction's `#D`.
fn augd(v: u32) -> u32 {
    0xFF80_0000 | (v >> 9)
}

/// `waitx #D` (misc opcode %1101011, S = $1F), with `#D` augmented to 32 bits.
fn waitx(clocks: u32) -> [u32; 2] {
    [
        augd(clocks),
        0xF000_0000 | (0b110_1011 << 21) | (1 << 18) | ((clocks & 0x1FF) << 9) | 0x1F,
    ]
}

/// `hubset #D` (misc opcode %1101011, S = 0), with `#D` augmented.
fn hubset(word: u32) -> [u32; 2] {
    [
        augd(word),
        0xF000_0000 | (0b110_1011 << 21) | (1 << 18) | ((word & 0x1FF) << 9),
    ]
}

/// `jmp #$` in cog execution: the 20-bit relative branch, one long back from
/// the next instruction.
const JMP_HERE: u32 = 0xFD9F_FFFF;

/// A boot ROM made of `program`, which COG 0 runs from cog address 0.
fn rom(program: &[u32]) -> Vec<u8> {
    for &w in program {
        let op = decode(w).expect("every word decodes").op;
        assert!(
            matches!(op, Op::Augd | Op::Waitx | Op::Hubset | Op::Jmp),
            "{w:08X} decodes as {op:?}"
        );
    }
    program.iter().flat_map(|w| w.to_le_bytes()).collect()
}

fn record_clkfreq(m: &mut Machine<NullPins>, hz: u32) {
    m.hub[0x14..0x18].copy_from_slice(&hz.to_le_bytes());
}

#[test]
fn board_time_follows_the_clock_a_rom_boot_runs_on() {
    behaviour!(Test {
        id: "p2.rom-boot-clock-map",
        covers: Some("SIL/p2core/src/lib.rs#time_map"),
        given: "a chip booted from the ROM that waits 2 million clocks, selects its PLL with 80 MHz recorded as its rate, and waits 8 million more",
    });
    expect!(
        "rcfast",
        "the first wait takes 100 ms of board time: the chip comes out of reset on its 20 MHz internal fast oscillator"
    );
    expect!(
        "no-jump",
        "board time carries on from the instant the PLL was selected"
    );
    expect!(
        "recorded-rate",
        "the second wait also takes 100 ms: on the PLL, board time runs at the rate the program recorded for itself"
    );

    let program: Vec<u32> = [
        waitx(2_000_000).as_slice(),
        &hubset(PLL_80),
        &waitx(8_000_000),
        &[JMP_HERE],
    ]
    .concat();
    let mut m = Machine::with_boot_rom(&rom(&program), NullPins);
    // What a loaded flexcc image keeps at `$14`: the rate it selects.
    record_clkfreq(&mut m, PLL_80_HZ);

    assert_eq!(m.clock_source(), ClockSource::Oscillator(RCFAST_HZ));
    m.step(2).expect("the first wait runs");
    assert_eq!(m.clock_hz(), RCFAST_HZ);
    assert_eq!(m.now_us(), 100_000, "2,000,004 clocks at 20 MHz");

    let before = m.now_us();
    m.step(2).expect("the clock word is set");
    assert_eq!(m.clock_source(), ClockSource::Recorded);
    assert_eq!(m.clock_hz(), PLL_80_HZ);
    assert_eq!(m.now_us(), before, "the switch moves no time");

    m.step(2).expect("the second wait runs");
    assert_eq!(m.now_us(), 200_000, "8,000,004 more clocks at 80 MHz");
}

#[test]
fn a_run_across_a_slower_clock_stops_at_the_instant_asked_for() {
    behaviour!(Test {
        id: "p2.rom-boot-step-across-clock-change",
        covers: Some("SIL/p2core/src/lib.rs#step_until"),
        given: "a chip booted from the ROM that selects its 20 kHz slow oscillator and then spins idle, run to one second of board time",
    });
    expect!(
        "pauses-at-switch",
        "the run pauses at the instant the clock is switched, so pin traffic after it is stamped at the new rate"
    );
    expect!(
        "stops-on-time",
        "the run ends one second into board time, 20 thousand clocks of the slow oscillator after the switch"
    );

    let program: Vec<u32> = [hubset(1).as_slice(), &[JMP_HERE]].concat();
    let mut m = Machine::with_boot_rom(&rom(&program), NullPins);

    // The pass ends after the clock word, at its instant on the old clock:
    // 4 clocks of RCFAST.
    m.step_until(1_000_000).expect("the clock word runs");
    assert_eq!(m.clock_hz(), RCSLOW_HZ);
    assert_eq!(m.system_clocks(), 4, "the pass ran past the switch");

    // As a host does: step again until the deadline is reached.
    for _ in 0..8 {
        if m.now_us() >= 1_000_000 {
            break;
        }
        m.step_until(1_000_000).expect("the spin never traps");
    }
    assert_eq!(m.now_us(), 1_000_000, "clocks {}", m.system_clocks());
    assert!(
        m.system_clocks() <= 4 + 20_000 + 2,
        "the spin ran to {} clocks",
        m.system_clocks()
    );
}

#[test]
fn an_image_boot_keeps_the_rate_it_recorded_through_its_clock_words() {
    behaviour!(Test {
        id: "p2.image-boot-clock-map",
        covers: Some("SIL/p2core/src/lib.rs#time_map"),
        given: "a program started straight from hub with 80 MHz recorded as its rate, which selects the internal fast oscillator and waits 8 million clocks",
    });
    expect!(
        "recorded-rate",
        "the wait takes 100 ms of board time: a program the ROM has already handed over to is timed at the rate it recorded"
    );

    let program: Vec<u32> = [hubset(PLL_80 & !0b11).as_slice(), &waitx(8_000_000)].concat();
    let mut image = rom(&program);
    image.resize(0x18, 0);
    image[0x14..0x18].copy_from_slice(&PLL_80_HZ.to_le_bytes());
    let mut m = Machine::new(&image, NullPins);

    m.step(4).expect("the program runs");

    assert_eq!(m.clock_source(), ClockSource::Recorded);
    assert_eq!(m.now_us(), 100_000, "8,000,008 clocks at 80 MHz");
}
