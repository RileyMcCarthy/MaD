//! `DIRA`/`DIRB` and `OUTA`/`OUTB` are per-cog; the pad sees the OR.
//!
//! Mirroring them globally let any cog's write erase every other cog's. In
//! this firmware the debug console (P62) and the SD card (P58..P61) share
//! `DIRB`, and a `DEBUG_*` print issues ~327,000 `DIRB` writes in 30 seconds
//! with the SD bits clear. Each one made `dir_of(P59)` read low, which
//! `Board::dir_out_changed` forwards as `set_tx_livened(false)` — a *reset* of
//! the sync-serial transmit shifter. When one landed between `sdmm.cc`'s
//! `dirh PIN_DI` and its clock burst, the loaded `$FE` data token was wiped
//! and the card was clocked `$FF` instead, so it discarded the whole 512-byte
//! block and the write failed. Intermittently, because it depended on a print
//! landing inside that window.
//!
//! The firmware knows the rule and says so at `dev_nvram.c:462`: "The P2 ORs
//! pin DIR/OUT across all 8 cogs".

use p2core::{Board, PinBus, SdCard};

/// `DIRB` bit for a pin in the upper bank.
fn bit(pin: u8) -> u32 {
    1u32 << (pin - 32)
}

const DIRB: u16 = 0x1FB;
const OUTB: u16 = 0x1FD;

#[test]
fn one_cogs_dir_write_does_not_release_another_cogs_pin() {
    let mut board = Board::new(SdCard::blank(4096));

    // Cog 5 (the LOGGER) drives the SD pins.
    board.dir_out_changed(5, DIRB, bit(58) | bit(59) | bit(60) | bit(61));
    assert!(board.dir_of(59), "the SD data pin is driven");

    // Cog 3 prints to the console on P62 — its own DIRB has none of the SD
    // bits, exactly as the trace showed (`DIRB=0x40000000`).
    board.dir_out_changed(3, DIRB, bit(62));

    assert!(
        board.dir_of(59),
        "a console print must not release the SD data pin"
    );
    assert!(board.dir_of(61), "nor the SD clock");
    assert!(board.dir_of(62), "and the console's own pin is driven too");
}

#[test]
fn releasing_a_pin_only_takes_effect_when_every_cog_has_released_it() {
    let mut board = Board::new(SdCard::blank(4096));

    board.dir_out_changed(5, DIRB, bit(59));
    board.dir_out_changed(3, DIRB, bit(59));
    assert!(board.dir_of(59), "both cogs drive it");

    board.dir_out_changed(3, DIRB, 0);
    assert!(board.dir_of(59), "one cog releasing is not enough");

    board.dir_out_changed(5, DIRB, 0);
    assert!(!board.dir_of(59), "released once no cog drives it");
}

#[test]
fn out_levels_are_or_ed_across_cogs_too() {
    let mut board = Board::new(SdCard::blank(4096));

    board.dir_out_changed(5, DIRB, bit(59));
    board.dir_out_changed(5, OUTB, bit(59));
    assert_eq!(board.output_level(59), Some(true), "cog 5 drives it high");

    // Another cog's unrelated OUTB write must not pull it low.
    board.dir_out_changed(2, OUTB, bit(62));
    assert_eq!(
        board.output_level(59),
        Some(true),
        "an unrelated cog's OUT write must not change this pin"
    );
}

/// `DRVH`/`DRVL` must not glitch the pin they drive.
///
/// The instruction sets `DIR` and `OUT` together, but each register write
/// publishes to the pins separately. Writing `DIR` first drives the pad for one
/// instant with the *previous* `OUT` level — a spurious edge every peripheral on
/// that net sees. Committing the drive-enabling write last removes it.
#[test]
fn driving_a_pin_high_never_publishes_a_low_first() {
    use p2core::{decode, Machine, Op};

    // A real unconditional `drvh` out of the firmware image. Its pin comes
    // from a register, so the test just puts the pin number there — no need to
    // hand-assemble an encoding.
    let img = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../Firmware/MaDCore/.pio/build/propeller2_debug/program"
    ))
    .expect("firmware image");
    let drvh = (0x400..img.len() - 4)
        .step_by(4)
        .map(|a| u32::from_le_bytes([img[a], img[a + 1], img[a + 2], img[a + 3]]))
        .find(|&w| decode(w).map(|d| (d.op, d.cond, d.l)) == Some((Op::Drvh, 0xF, false)))
        .expect("the image contains an unconditional drvh with a register pin");
    let d_reg = decode(drvh).expect("decodes").d;

    const PIN: u32 = 59;

    /// Records every level published for the pin the `drvh` targets.
    #[derive(Default)]
    struct Spy {
        dir: u32,
        out: u32,
        seen: Vec<Option<bool>>,
        pin: u8,
    }
    impl PinBus for Spy {
        fn dir_out_changed(&mut self, _cog: usize, reg: u16, value: u32) {
            // Whichever bank this pin lives in.
            let (dreg, oreg) = if self.pin < 32 { (0x1FA, 0x1FC) } else { (0x1FB, 0x1FD) };
            if reg == dreg {
                self.dir = value;
            } else if reg == oreg {
                self.out = value;
            } else {
                return;
            }
            let bit = 1u32 << (self.pin & 31);
            self.seen.push(if self.dir & bit != 0 {
                Some(self.out & bit != 0)
            } else {
                None
            });
        }
    }

    let pin = PIN as u8;

    let mut m = Machine::new(&[0u8; 4096], Spy { pin, ..Spy::default() });
    m.cogs[0].running = true;
    m.cogs[0].regs[usize::from(d_reg)] = PIN;
    m.hub[0x400..0x404].copy_from_slice(&drvh.to_le_bytes());
    m.cogs[0].pc = 0x400;
    m.step(1).expect("runs");

    assert!(
        !m.pins.seen.contains(&Some(false)),
        "drvh must never publish the pin driven LOW; saw {:?}",
        m.pins.seen
    );
    assert_eq!(
        m.pins.seen.last(),
        Some(&Some(true)),
        "and it ends up driven high"
    );
}
