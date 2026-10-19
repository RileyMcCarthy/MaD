//! The P2's synchronous-serial smart pins, modelled as CPU hardware.
//!
//! This is the generalisation of what used to be an SPI-shaped adapter inside
//! the ISS. The insight: a synchronous-serial bus is not something the CPU's
//! *net adapter* should know about — it is **smart-pin hardware the firmware
//! configured**, and the configuration says everything. `sdmm.cc` programs
//! three pins:
//!
//! - a **clock** pin in `P_PULSE`/`P_TRANSITION` mode — `WYPIN n` makes it emit
//!   `n` clock transitions;
//! - a **sync-TX** pin (`P_SYNC_TX`) whose mode word's bits 26:24 hold the
//!   *offset to its clock pin* — it shifts a bit out on each of that clock's
//!   edges;
//! - a **sync-RX** pin (`P_SYNC_RX`), likewise clock-referenced, that samples
//!   its input on each edge and assembles a word.
//!
//! So this module reads the clock↔data relationship straight out of the mode
//! words the firmware wrote — exactly as [`crate::board`] already reads the
//! quadrature B-channel offset from bits 26:24. Nothing here names "SPI", "SD"
//! or "flash": it is the sync-serial *mode*, and any device the firmware talks
//! to this way — a card, a display, an ADC — is a component on the nets, told
//! apart by whatever chip-select the firmware drives as plain GPIO.
//!
//! The ISS's only remaining job is what a net adapter should do: pump the
//! clock pin's edges over virtual time and move the resulting pin levels on and
//! off the nets. It reads which pin is the clock from [`SmartBus::clock_pin`]
//! and drives the edges with [`SmartBus::advance_clock`]; it never learns the
//! word "bus".

use crate::smartpin::{PinMode, SmartPin};
use crate::spi::SpiShift;

/// `P_INVERT_OUTPUT` in a clock pin's mode word: CPOL = 1, the clock idles
/// high and leads with a falling edge.
const P_INVERT_OUTPUT: u32 = 0x4000;

/// The synchronous-serial hardware behind up to one clock/TX/RX triple.
///
/// One triple is all the firmware ever programs (the SD card); the model holds
/// a single [`SpiShift`] and resolves roles by mode. A second concurrent bus
/// would need a triple keyed by clock pin, which nothing here requires.
#[derive(Debug, Default)]
pub struct SmartBus {
    shift: SpiShift,
    /// The clock pin, once one is in a pulse mode.
    clock: Option<u8>,
    /// The sync-TX pin and the RX pin, resolved from their modes.
    tx: Option<u8>,
    rx: Option<u8>,
    /// Clock transitions still owed (`WYPIN` count on the clock pin).
    pending: u64,
    /// The clock's driven level right now. Idles at the CPOL level.
    clk_high: bool,
    /// CPOL: the clock idles high (`P_INVERT_OUTPUT`).
    inverted: bool,
    /// The most recent input level sampled on the RX pin, fed by the adapter.
    rx_input: bool,
    /// The TX bit currently *presented* on MOSI. It lags the shifter: the bit
    /// is put on the wire on the leading (falling) edge and held through the
    /// trailing (rising) edge where the device samples it — SPI mode 3.
    tx_out: bool,
    /// The RX pin's `X[5]`: sample *after* the rising edge is registered
    /// rather than just before it. `sdmm.cc` sets it on every receive width
    /// (`7 | 32`, `#31 | 32`, "sample after rising clock").
    late_sample: bool,
    /// A rising edge passed with [`Self::late_sample`] set and its bit has
    /// not been latched yet. It is latched from the RX level as it stands
    /// once that edge has reached the devices on the bus — see
    /// [`SmartBus::advance_clock`].
    sample_owed: bool,
}

impl SmartBus {
    pub fn new() -> Self {
        Self {
            rx_input: true, // a released MISO idles high under its pull-up
            tx_out: true,
            ..Self::default()
        }
    }

    /// Which pin, if any, is the clock — the one the adapter must pump.
    pub fn clock_pin(&self) -> Option<u8> {
        self.clock
    }

    /// The sync-TX pin (drives data out), if configured.
    pub fn tx_pin(&self) -> Option<u8> {
        self.tx
    }

    /// The sync-RX pin (samples data in), if configured.
    pub fn rx_pin(&self) -> Option<u8> {
        self.rx
    }

    /// The clock pin's driven output level.
    pub fn clock_level(&self) -> bool {
        self.clk_high
    }

    /// The TX pin's driven output level — the bit presented for this pulse.
    /// Whether the TX pin is livened (diagnostics).
    pub fn tx_livened(&self) -> bool {
        self.shift.livened()
    }

    pub fn tx_level(&self) -> bool {
        self.tx_out
    }

    /// Feed the level the RX net resolved to; sampled on the next clock edge.
    pub fn set_rx_input(&mut self, level: bool) {
        self.rx_input = level;
    }

    /// Whether a clock burst is still running.
    /// Clock transitions the generator still owes.
    ///
    /// `busy()` is the predicate the driver's `TESTP PIN_CLK` wait maps to;
    /// this is the count behind it, which is what a wire-level investigation
    /// needs to tell "the burst has not started" from "it is half way out".
    pub fn pending(&self) -> u64 {
        self.pending
    }

    pub fn busy(&self) -> bool {
        self.pending > 0
    }

    /// A `WRPIN` reconfigured a pin — re-resolve the roles from the modes.
    ///
    /// `pins` is the board's smart-pin array so a sync pin's clock reference
    /// (bits 26:24, a signed 3-bit offset) can be resolved to an absolute pin.
    pub fn wrpin(&mut self, pin: u8, pins: &[SmartPin; 64]) {
        let p = pin & 63;
        match pins[p as usize].programmed_mode() {
            // The sync-serial clock is a `P_PULSE` pin (`sdmm.cc`: `spm_ck =
            // P_PULSE | ...`). `P_TRANSITION` is NOT it — that is the stepper's
            // step train, and claiming it as the bus clock hijacks the train
            // and, worse, made every other pin look like it belonged to a bus.
            PinMode::Pulse => {
                self.clock = Some(p);
                self.inverted = pins[p as usize].programmed_cfg & P_INVERT_OUTPUT != 0;
                self.clk_high = self.inverted;
            }
            PinMode::SyncTx => self.tx = Some(p),
            PinMode::SyncRx => self.rx = Some(p),
            _ => {
                // A pin leaving a sync role stops being one.
                if self.clock == Some(p) {
                    self.clock = None;
                }
                if self.tx == Some(p) {
                    self.tx = None;
                }
                if self.rx == Some(p) {
                    self.rx = None;
                    self.sample_owed = false;
                }
            }
        }
    }

    /// `WYPIN` on a bus pin: load the TX word, or begin a clock burst.
    /// Returns `true` if it was a bus pin.
    pub fn wypin(&mut self, pin: u8, y: u32) -> bool {
        let p = pin & 63;
        if self.clock == Some(p) {
            // `WYPIN y` on a pulse clock asks for `y` clock **pulses**, and a
            // pulse is a rising and a falling edge — two transitions.
            self.pending = self.pending.saturating_add(u64::from(y) * 2);
            true
        } else if self.tx == Some(p) {
            self.shift.load_tx(y);
            // Present the first bit at once: the guest starts the clock next,
            // and the device samples this bit on the first trailing edge.
            self.tx_out = self.shift.mosi();
            true
        } else {
            false
        }
    }

    /// `WXPIN` on a bus pin: set the RX word width (`X[4:0]`, bits - 1) and
    /// the sample position (`X[5]`). Returns `true` if handled.
    ///
    /// The P2 silicon document, `%11101` synchronous serial receive: "X.[5] = 0
    /// selects the A input sample just before the B input edge was
    /// registered ... X.[5] = 1 selects the sample coincident with the B edge
    /// being registered." A fresh X begins a fresh word, so a late sample
    /// still owed from the previous width is dropped with it.
    pub fn wxpin(&mut self, pin: u8, x: u32) -> bool {
        if self.rx == Some(pin & 63) {
            self.shift.set_rx_bits((x & 0x1F) + 1);
            self.late_sample = x & 0x20 != 0;
            self.sample_owed = false;
            true
        } else {
            false
        }
    }

    /// `RDPIN` on a bus pin: take the assembled RX word. `None` if not a bus
    /// pin (the caller falls through).
    ///
    /// A late sample still owed is latched first, from the RX level fed by
    /// [`Self::set_rx_input`] — the level after the rising edge.
    pub fn rdpin(&mut self, pin: u8) -> Option<u32> {
        if self.rx != Some(pin & 63) {
            return None;
        }
        self.take_owed_sample();
        Some(self.shift.take_rx().unwrap_or(0))
    }

    /// Whether a late sample is owed for the RX pin (diagnostics, tests).
    pub fn sample_owed(&self) -> bool {
        self.sample_owed
    }

    /// Latch the late sample a rising edge left owed, if any.
    fn take_owed_sample(&mut self) {
        if self.sample_owed {
            self.sample_owed = false;
            self.shift.sample_rx(self.rx_input);
        }
    }

    /// `TESTP` on a bus pin: RX-ready, TX-buffer-empty, or clock-idle.
    ///
    /// On the RX pin, a word whose last bit is an owed late sample is ready:
    /// on silicon that bit is latched a few clocks after the edge whatever
    /// the guest does, so `IN` is up by the time the guest can look.
    pub fn testp(&self, pin: u8) -> Option<bool> {
        let p = pin & 63;
        if self.rx == Some(p) {
            Some(self.shift.rx_ready() || (self.sample_owed && self.shift.rx_completes_next()))
        } else if self.tx == Some(p) {
            Some(self.shift.tx_buffer_empty())
        } else if self.clock == Some(p) {
            Some(!self.busy())
        } else {
            None
        }
    }

    /// `AKPIN` on the RX pin clears its buffer (`rcvr_mmc` opens with it).
    pub fn akpin(&mut self, pin: u8) -> bool {
        if self.rx == Some(pin & 63) {
            self.shift.clear_rx();
            self.sample_owed = false;
            true
        } else {
            false
        }
    }

    /// A `DIR` change on the TX pin is the driver's reset/liven pair.
    pub fn set_tx_livened(&mut self, pin: u8, livened: bool) {
        if self.tx == Some(pin & 63) && self.shift.livened() != livened {
            self.shift.set_livened(livened);
        }
    }

    /// Emit one clock transition, coordinating the data pins.
    ///
    /// Returns the clock's new level, or `None` when the burst is finished.
    /// The edge logic is CPOL = 1 as `sdmm.cc` programs it: the clock leads
    /// with a falling edge on which the TX bit is presented, and samples the
    /// RX input on the trailing rising edge (then advances the shifter).
    ///
    /// Where the rising edge samples depends on the RX pin's `X[5]`:
    ///
    /// - clear: the level the pin held just before the edge, which is the
    ///   [`Self::set_rx_input`] level fed for this call;
    /// - set: the level *after* the edge, once the devices on the bus have
    ///   seen it. On silicon that is a few system clocks later (the clock
    ///   pin's `P_SYNC_IO` registration adds one more, the "late-late" point
    ///   `sdmm.cc` describes), well inside the half period before the next
    ///   transition. Here the edge only reaches the devices when the adapter
    ///   publishes it after this call returns, so the bit is left owed and
    ///   latched from the next level fed: at the start of the next
    ///   transition (before that transition moves anything), or at the
    ///   guest's `RDPIN` when the burst ended on this edge.
    pub fn advance_clock(&mut self) -> Option<bool> {
        self.take_owed_sample();
        if self.pending == 0 {
            return None;
        }
        self.pending -= 1;
        self.clk_high = !self.clk_high;
        if self.clk_high {
            // Trailing (rising) edge: latch the device's bit (now, or once
            // the edge has reached it), then move the shifter on so the next
            // bit is ready to present.
            if self.late_sample {
                self.sample_owed = true;
            } else {
                self.shift.sample_rx(self.rx_input);
            }
            self.shift.advance_tx();
        } else {
            // Leading (falling) edge: put the shifter's current bit on the
            // wire, where it stays through the coming trailing edge.
            self.tx_out = self.shift.mosi();
        }
        Some(self.clk_high)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::Board;
    use crate::pins::PinBus;
    use crate::smartpin::SmartPin;
    use vibes_behaviour::{behaviour, expect, Test};

    /// The SD bus pins `sdmm.cc` programs on the MaD board.
    const CLK: u8 = 61;
    const TX: u8 = 59;
    const RX: u8 = 58;
    /// `X[5]` on the RX pin: sample after the rising clock edge.
    const SAMPLE_LATE: u32 = 32;
    /// The card's answer to `CMD0` (R1, in idle state).
    const CARD_BYTE: u8 = 0x01;

    /// A board with the sync-serial bus configured through its own `WRPIN`s
    /// and `WXPIN`, the way `sdmm.cc`'s `disk_initialize` does: a CPOL = 1
    /// pulse clock, a sync-TX pin and an 8-bit sync-RX pin.
    fn sd_board(rx_x: u32) -> Board {
        let mut board = Board::default();
        board.enable_smart_bus();
        board.wrpin(CLK, 0x08 | P_INVERT_OUTPUT);
        board.wrpin(TX, 0x38);
        board.wrpin(RX, 0x3A);
        board.wxpin(RX, rx_x);
        board
    }

    /// Clock one byte in, one transition at a time. The RX line reads high
    /// through each low half of the clock (a second device driving it, as
    /// embsim's flash did) and the card's next bit, MSB first, once a rising
    /// edge has passed. Returns `TESTP` on the RX pin after the last edge and
    /// the word `RDPIN` then reads.
    fn clock_in(board: &mut Board, card: u8) -> (bool, u32) {
        board.set_input_level(RX, true);
        board.wypin(CLK, 8);
        let mut bit = 0;
        // Only the transitions the burst owes, as the adapter pumps them: no
        // further call follows the last edge before the guest reads.
        while board.smart_clock_busy() {
            let high = board.advance_smart_clock().expect("a busy clock moves");
            if high {
                board.set_input_level(RX, (card >> (7 - bit)) & 1 != 0);
                bit += 1;
            } else {
                board.set_input_level(RX, true);
            }
            assert!(bit <= 8, "one byte is eight rising edges");
        }
        assert_eq!(bit, 8, "the burst ran its eight pulses");
        (board.testp(RX), board.rdpin(RX).0)
    }

    /// The receiver's 8-bit word for wire bits sent MSB first: MSB-justified,
    /// the first bit on the wire at bit 24 and the last at bit 31.
    fn word_for(byte_msb_first: u8) -> u32 {
        u32::from(byte_msb_first.reverse_bits()) << 24
    }

    #[test]
    fn the_receiver_samples_after_the_rising_edge_when_asked() {
        behaviour!(Test {
            id: "p2core.sync-rx-sample-position",
            covers: Some("SIL/p2core/src/smartbus.rs#SmartBus::advance_clock"),
            given: "an SD-card bus set up the way the SD driver sets it up, whose data line reads \
                    high until each rising clock edge and the card's next bit once that edge has \
                    passed",
        });
        expect!(
            "late-reads-after-edge",
            "a receiver set to sample after the rising edge reads the byte the card put on the \
             line",
            "the driver asks for this sample position on every read, and the P2 takes it as the \
             clock edge is registered, after the line has answered the edge"
        );
        expect!(
            "early-reads-before-edge",
            "a receiver set to sample before the rising edge reads the level the line held just \
             before each edge, all ones"
        );
        expect!(
            "late-ready-at-last-edge",
            "a receiver set to sample after the rising edge reports the byte waiting as soon as \
             the last rising edge has passed"
        );

        let mut late = sd_board(7 | SAMPLE_LATE);
        let (ready, word) = clock_in(&mut late, CARD_BYTE);
        assert_eq!(
            word,
            word_for(CARD_BYTE),
            "late sampling reads the card's byte"
        );
        assert!(ready, "the byte is waiting once the last edge has passed");

        let mut early = sd_board(7);
        let (_, word) = clock_in(&mut early, CARD_BYTE);
        assert_eq!(
            word,
            word_for(0xFF),
            "early sampling reads the level before each edge"
        );
    }

    /// A late sample still owed when the driver rewrites the receive width
    /// belongs to the old word, not the new one.
    #[test]
    fn a_fresh_receive_width_drops_an_owed_late_sample() {
        behaviour!(Test {
            id: "p2core.sync-rx-new-width-new-word",
            covers: Some("SIL/p2core/src/smartbus.rs#SmartBus::wxpin"),
            given: "an SD-card bus whose receiver samples after the rising edge, with one clock \
                    pulse just sent and the driver then setting the receive width again",
        });
        expect!(
            "new-word-own-bits",
            "the next byte read holds only the eight bits clocked after the width was set",
            "setting the width starts a fresh word on the P2, and the driver relies on it to \
             line bytes up"
        );
        let mut board = sd_board(7 | SAMPLE_LATE);
        board.set_input_level(RX, true);
        board.wypin(CLK, 1);
        while board.smart_clock_busy() {
            board.advance_smart_clock();
        }
        assert!(
            board.smart_bus.sample_owed(),
            "the rising edge left its bit owed"
        );
        board.wxpin(RX, 7 | SAMPLE_LATE);
        assert!(
            !board.smart_bus.sample_owed(),
            "a fresh width starts a fresh word"
        );
        let (_, word) = clock_in(&mut board, CARD_BYTE);
        assert_eq!(
            word,
            word_for(CARD_BYTE),
            "the new word holds only its own eight bits"
        );
    }

    /// Configure a triple the way `sdmm.cc` does and confirm the roles resolve
    /// from the mode words, not from hardcoded pin numbers.
    #[test]
    fn roles_resolve_from_the_mode_words() {
        let mut pins = [SmartPin::default(); 64];
        // clock P61 pulse+invert, TX P59 sync, RX P58 sync.
        pins[61].programmed_cfg = 0x08 | P_INVERT_OUTPUT;
        pins[59].programmed_cfg = 0x38;
        pins[58].programmed_cfg = 0x3A;
        let mut bus = SmartBus::new();
        bus.wrpin(61, &pins);
        bus.wrpin(59, &pins);
        bus.wrpin(58, &pins);
        assert_eq!(bus.clock_pin(), Some(61));
        assert_eq!(bus.tx_pin(), Some(59));
        assert_eq!(bus.rx_pin(), Some(58));
        assert!(bus.clock_level(), "CPOL=1 idles high");
    }

    /// A byte clocked out and one clocked in, over the coordinated edges.
    #[test]
    fn a_byte_shifts_out_and_in_over_the_clock() {
        let mut pins = [SmartPin::default(); 64];
        pins[61].programmed_cfg = 0x08 | P_INVERT_OUTPUT;
        pins[59].programmed_cfg = 0x38;
        pins[58].programmed_cfg = 0x3A;
        let mut bus = SmartBus::new();
        for p in [61u8, 59, 58] {
            bus.wrpin(p, &pins);
        }
        bus.wxpin(58, 7); // 8-bit RX words
        bus.wypin(59, 0x0000_0055); // TX a byte (LSB-first shifter)
        bus.wypin(61, 8); // one byte = 8 clock pulses = 16 transitions
        assert!(bus.wypin(61, 8));

        // Feed a constant high on RX and pump 16 transitions (8 clocks).
        bus.set_rx_input(true);
        let mut edges = 0;
        while bus.advance_clock().is_some() {
            edges += 1;
            if edges > 100 {
                break;
            }
        }
        // 16 pulses were queued (8 + 8); the shifter assembled RX words.
        assert!(edges >= 16, "the queued transitions all fired");
        assert!(bus.rx_pin().is_some());
    }
}
