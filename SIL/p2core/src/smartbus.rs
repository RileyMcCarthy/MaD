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

    /// `WXPIN` on a bus pin: set the RX word width. Returns `true` if handled.
    pub fn wxpin(&mut self, pin: u8, x: u32) -> bool {
        if self.rx == Some(pin & 63) {
            self.shift.set_rx_bits((x & 0x1F) + 1);
            true
        } else {
            false
        }
    }

    /// `RDPIN` on a bus pin: take the assembled RX word. `None` if not a bus
    /// pin (the caller falls through).
    pub fn rdpin(&mut self, pin: u8) -> Option<u32> {
        (self.rx == Some(pin & 63)).then(|| self.shift.take_rx().unwrap_or(0))
    }

    /// `TESTP` on a bus pin: RX-ready, TX-buffer-empty, or clock-idle.
    pub fn testp(&self, pin: u8) -> Option<bool> {
        let p = pin & 63;
        if self.rx == Some(p) {
            Some(self.shift.rx_ready())
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
    pub fn advance_clock(&mut self) -> Option<bool> {
        if self.pending == 0 {
            return None;
        }
        self.pending -= 1;
        self.clk_high = !self.clk_high;
        if self.clk_high {
            // Trailing (rising) edge: the device's bit is stable, latch it,
            // then move the shifter on so the next bit is ready to present.
            self.shift.sample_rx(self.rx_input);
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
    use crate::smartpin::SmartPin;

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
