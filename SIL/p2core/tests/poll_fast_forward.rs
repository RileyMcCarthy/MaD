//! A cog polling a *pin* must not be carried past the end of the slice.
//!
//! The idle-poll fast-forward advances a confirmed poller to "the next instant
//! anything it can observe might change". For a cog waiting on hub RAM or a
//! lock that is another cog's clock, because only another cog can write those.
//! A **pin** is different: the outside world drives it, and the outside world's
//! next chance is the end of the current slice.
//!
//! Following another cog's clock alone is therefore wrong for a pin wait. A
//! peer parked on a long `WAITX` still counts as running while its clock sits
//! arbitrarily far ahead, so the poller was jumped straight to it — past every
//! instant in between at which a peripheral would have answered. `GETCT` reads
//! the stepped cog's own clock, so the driver's receive timeout then expired
//! having sampled the pin barely at all. On the force-gauge link that surfaced
//! as an ADC that had "gone quiet" for a full second, once per second, which
//! faulted the machine and killed any running test.

use p2core::{decode, Machine, NullPins, Op};

/// `testp #pin wc` — misc opcode %1101011, S = $40 selects TESTP, C written.
/// `OperandTestp` takes its immediate-D flag from bit 18.
fn testp_wc(pin: u32) -> u32 {
    0xF000_0000 | (0b110_1011 << 21) | (1 << 20) | (1 << 18) | ((pin & 0x1FF) << 9) | 0x40
}

/// `jmp #$-1` — the 20-bit relative branch `jmp #$` is -4; one instruction
/// earlier in hub is -8.
const JMP_BACK_ONE: u32 = 0xFD9F_FFF8;

/// Hub address of the two-instruction poll loop.
const LOOP_AT: usize = 0x400;

/// Clock frequency `Machine` assumes when the guest has not recorded one.
const HZ: u64 = 160_000_000;

/// A cog parked by `WAITX` keeps `running` set with its clock far ahead. 100 ms
/// is the scale a real one reaches between 1 kHz scheduler ticks.
const PARKED_AHEAD: u64 = HZ / 10;

fn polling_machine() -> Machine<NullPins> {
    let mut m = Machine::new(&[0u8; 4096], NullPins);
    for (k, w) in [testp_wc(20), JMP_BACK_ONE].iter().enumerate() {
        let a = LOOP_AT + 4 * k;
        m.hub[a..a + 4].copy_from_slice(&w.to_le_bytes());
    }
    m.cogs[0].pc = LOOP_AT as u32;
    m.cogs[0].running = true;
    m
}

#[test]
fn the_encodings_are_what_they_claim() {
    assert_eq!(decode(testp_wc(20)).expect("testp decodes").op, Op::Testp);
    assert_eq!(decode(JMP_BACK_ONE).expect("jmp decodes").op, Op::Jmp);
}

#[test]
fn a_pin_poll_is_not_carried_past_the_slice_by_a_parked_peer() {
    let mut m = polling_machine();
    // A peer that is running but parked far in the future, as `WAITX` leaves it.
    m.cogs[1].running = true;
    m.cogs[1].clocks = PARKED_AHEAD;

    let deadline_us = 1_000u64;
    m.step_until(deadline_us)
        .expect("the poll loop never traps");

    let deadline_clocks = deadline_us * HZ / 1_000_000;
    assert!(
        m.cogs[0].clocks <= deadline_clocks,
        "a pin poll was carried to {} clocks, past the slice deadline of {} \
         (the parked peer sits at {}); the engine cannot change a pin before \
         the slice ends, so nothing it could observe happened in between",
        m.cogs[0].clocks,
        deadline_clocks,
        PARKED_AHEAD,
    );
}

#[test]
fn a_pin_poll_still_fast_forwards_to_the_slice_deadline() {
    // The clamp must bound the jump, not remove it: skipping the spin is what
    // keeps an idle guest cheap, and the loop below would otherwise cost one
    // interpreted iteration per two clocks.
    let mut m = polling_machine();
    m.cogs[1].running = true;
    m.cogs[1].clocks = PARKED_AHEAD;

    let deadline_us = 1_000u64;
    m.step_until(deadline_us)
        .expect("the poll loop never traps");

    let deadline_clocks = deadline_us * HZ / 1_000_000;
    assert_eq!(
        m.cogs[0].clocks, deadline_clocks,
        "a confirmed pin poller should land exactly on the slice deadline"
    );
}
