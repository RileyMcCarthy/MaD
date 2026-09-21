//! A MaD board: the debug UART plus an SD card on the P2's SPI smart pins.
//!
//! Pin roles were read off the firmware's own traffic rather than assumed
//! (see `examples/pinlog.rs`), and match `sdmm.cc`'s smart-pin SPI routines:
//!
//! | pin | role | how the firmware drives it                     |
//! |-----|------|------------------------------------------------|
//! | 58  | DO   | `wxpin #7\|32` (8 bits, sample on rising), `rdpin` |
//! | 59  | DI   | `wxpin #31` (32 bits), `wypin` data            |
//! | 60  | CS   | plain GPIO (`wrpin cfg=0`), driven via DIRB/OUTB |
//! | 61  | CLK  | `wypin n` generates n clocks — the transfer trigger |
//! | 62  | TX   | async serial out (the debug console)            |
//! | 63  | RX   | async serial in                                 |
//!
//! A transfer is: set the receive width, queue transmit data, then clock it.
//! Clocking is what actually moves bytes, so [`Board::wypin`] on the clock pin
//! is where the SPI exchange happens.

use crate::NUM_COGS;
use std::collections::VecDeque;

use crate::flash::{SpiFlash, FLASH_CLK, FLASH_CS, FLASH_DI, FLASH_DO};
use crate::sdcard::SdCard;
use crate::smartbus::SmartBus;
use crate::smartpin::{PinMode, SmartPin};
use crate::spi::SpiShift;
use crate::PinBus;

pub const PIN_DO: u8 = 58;
pub const PIN_DI: u8 = 59;
pub const PIN_CS: u8 = 60;
pub const PIN_CLK: u8 = 61;
pub const PIN_TX: u8 = 62;
pub const PIN_RX: u8 = 63;
/// The MaD protocol link to the host (`HW_PIN_RPI_*`), 2,000,000 baud.
pub const PIN_PROTO_TX: u8 = 55;
pub const PIN_PROTO_RX: u8 = 53;

/// `P_OE` in a `WRPIN` mode word: the bit that makes a smart pin drive its
/// pad. Without it the pin is configured but still an input.
const P_OE: u32 = 0x40;

pub struct Board {
    pub card: SdCard,
    /// The boot flash, bit-banged by the ROM on P58-P61 (CLK/CS swapped from
    /// the card's). Empty unless [`Board::with_flash`] loads it — the firmware
    /// never touches flash at runtime, so a normal run leaves it absent and
    /// the ROM path unused.
    pub flash: SpiFlash,
    /// Bytes the firmware transmitted on the debug UART.
    pub console: Vec<u8>,
    /// Bytes queued for the firmware to receive on the debug UART.
    pub uart_rx: VecDeque<u8>,
    /// Bytes the firmware transmitted on the protocol link.
    pub proto_tx: Vec<u8>,
    /// Bytes queued for the firmware to receive on the protocol link.
    pub proto_rx: VecDeque<u8>,
    /// Decoded configuration per pin -- mode word and X, not just a flag.
    pub pins: [SmartPin; 64],
    /// Receive width in bits, from `WXPIN` on the DO pin.
    rx_bits: u32,
    /// Bytes the host queued to send, oldest first.
    tx: VecDeque<u8>,
    /// Byte-times the clock generator still owes. `xmit_mmc` starts the clocks
    /// for a whole frame and *then* feeds the remaining longwords, so the
    /// transfer must drain as data arrives rather than complete at the WYPIN.
    pending: u32,
    /// Bytes clocked in and not yet read, oldest first.
    ///
    /// Deliberately bytes rather than assembled words. SPI is byte-oriented —
    /// eight clocks move one byte, whatever width the receive pin is set to —
    /// and the driver programs that width *after* it starts the clocks:
    ///
    /// ```text
    ///     wypin   r, PIN_CLK          ' begin SPI clocks
    ///     wxpin   #31|32, PIN_DO      ' ...and only now, 32 bits
    /// ```
    ///
    /// Assembling a word at clock time would therefore use the *previous*
    /// transfer's width. Keeping raw bytes and assembling in [`Board::rdpin`]
    /// uses the width in force when the guest actually reads, which is what
    /// the hardware does: the shifter latches a word once `rx_bits` bits have
    /// arrived, and nothing is observable before the guest looks.
    rx_bytes: VecDeque<u8>,
    in_flag: [bool; 64],
    /// Raw WYPIN values seen on the DI pin, for bring-up.
    pub di_log: Vec<u32>,
    /// Bytes moved per pin, for cost measurement: how much traffic an
    /// edge-level transport would actually have to carry.
    pub byte_counts: [u64; 64],
    /// Carry async-serial bytes as individual bit edges rather than whole
    /// bytes. Set to measure what bit-level transport actually costs.
    pub edge_level: bool,
    /// Edge queue, standing in for the engine's event queue: each entry is
    /// `(virtual time, level)` for one transition.
    edges: VecDeque<(u64, bool)>,
    /// Edges processed, for cost accounting.
    pub edge_count: u64,
    /// Edge-load multiplier for cost measurement (1 = real serial traffic).
    pub edge_mult: u32,
    /// `DIRA`/`DIRB` as the guest last wrote them.
    /// `DIRA`/`DIRB` **per cog** — the pad sees the OR across all eight.
    dir_cog: [[u32; 2]; NUM_COGS],
    /// The OR of every cog's `DIR`, which is what the pad is driven by.
    dir: [u32; 2],
    /// `OUTA`/`OUTB` as the guest last wrote them.
    /// `OUTA`/`OUTB` per cog, OR-ed the same way.
    out_cog: [[u32; 2]; NUM_COGS],
    out: [u32; 2],
    /// Bit-level shift state for the SPI bus.
    ///
    /// Used when an adapter puts the bus on nets: the in-process
    /// [`SdCard`] above stays for standalone runs and unit tests, and the two
    /// never run at once — `p2iss` intercepts the SPI pins the same way it
    /// intercepts the serial ones.
    pub spi: SpiShift,
    /// The synchronous-serial smart-pin hardware, when the net adapter has
    /// enabled it. Roles (clock / TX / RX) are read from the mode words the
    /// firmware programs — the board no longer needs to be told "this is an
    /// SPI bus". Off by default, so a standalone run keeps the byte-routed SD
    /// path in [`Board::wypin`].
    pub smart_bus: SmartBus,
    use_smart_bus: bool,
    /// Which pins actually drive, cached: recomputed on `WRPIN` and on a
    /// `DIR`/`OUT` write rather than per `INA` read, which is hot.
    drive_mask: [u32; 2],
    /// Quadrature decode state, indexed by the A pin.
    quad: [Option<Quad>; 64],
    /// The level the outside world presents to each pin, `[0..31, 32..63]`.
    ///
    /// This is the half of the pin that `p2core` cannot know: a net resolved
    /// it. [`Board::set_input_level`] is how an adapter hands it over, and it
    /// is the only route by which anything outside can be *read* by the guest.
    in_ext: [u32; 2],
}

impl Default for Board {
    fn default() -> Self {
        Self::new(SdCard::blank(0))
    }
}

impl Board {
    pub fn new(card: SdCard) -> Self {
        Self {
            card,
            flash: SpiFlash::default(),
            console: Vec::new(),
            uart_rx: VecDeque::new(),
            proto_tx: Vec::new(),
            proto_rx: VecDeque::new(),
            pins: [SmartPin::default(); 64],
            rx_bits: 8,
            tx: VecDeque::new(),
            pending: 0,
            rx_bytes: VecDeque::new(),
            in_flag: [false; 64],
            di_log: Vec::new(),
            byte_counts: [0; 64],
            edge_level: false,
            edges: VecDeque::new(),
            edge_count: 0,
            edge_mult: 1,
            dir_cog: [[0; 2]; NUM_COGS],
            dir: [0; 2],
            out_cog: [[0; 2]; NUM_COGS],
            out: [0; 2],
            spi: SpiShift::new(),
            smart_bus: SmartBus::new(),
            use_smart_bus: false,
            drive_mask: [0; 2],
            quad: [None; 64],
            in_ext: [0; 2],
        }
    }

    /// Queue bytes for the firmware to read on the protocol link.
    /// Serialise one byte into UART edges and consume them again.
    ///
    /// This is the work an edge-level transport does per byte: emit a start
    /// bit, eight data bits and a stop bit as timed transitions, push each
    /// through a queue, then reassemble. Measuring it directly beats guessing
    /// at the cost of "one event per edge".
    fn carry_as_edges(&mut self, pin: u8, byte: u8) -> u8 {
        let period = self.pins[pin as usize & 63].bit_period().max(1) as u64;
        let now = self.edge_count * period;

        // `edge_mult` stands in for the continuous signals (step train,
        // quadrature encoder) that a plain boot never exercises: it scales the
        // in-situ edge load so the cost clears the run-to-run noise floor,
        // through the real path rather than an isolated benchmark.
        for _ in 0..self.edge_mult {
            self.edges.push_back((now, false)); // start bit
            for i in 0..8u64 {
                self.edges
                    .push_back((now + (i + 1) * period, byte >> i & 1 != 0));
            }
            self.edges.push_back((now + 9 * period, true)); // stop bit
        }

        // Consume: reassemble the byte from the transitions, as a receiving
        // smart pin would.
        let mut out = 0u8;
        let mut idx = 0u32;
        while let Some((_t, level)) = self.edges.pop_front() {
            self.edge_count += 1;
            if (1..=8).contains(&idx) && level {
                out |= 1 << (idx - 1);
            }
            idx += 1;
        }
        out
    }

    pub fn send_protocol(&mut self, bytes: &[u8]) {
        self.proto_rx.extend(bytes.iter().copied());
    }

    /// Whether the firmware has configured this smart pin.
    pub fn is_configured(&self, pin: u8) -> bool {
        self.pins[pin as usize & 63].is_configured()
    }

    /// The decoded mode the firmware programmed onto a pin.
    pub fn mode_of(&self, pin: u8) -> PinMode {
        self.pins[pin as usize & 63].mode()
    }

    /// The mode the firmware configured this pin with, surviving a later
    /// `_pinclear`. See [`SmartPin::programmed_cfg`].
    pub fn programmed_mode_of(&self, pin: u8) -> PinMode {
        self.pins[pin as usize & 63].programmed_mode()
    }

    /// The baud rate a serial pin is actually programmed for, derived from the
    /// bit period the firmware computed and the clock frequency it recorded.
    pub fn baud_of(&self, pin: u8, clkfreq: u32) -> Option<u32> {
        self.pins[pin as usize & 63].baud_hz(clkfreq)
    }

    /// Modes the firmware programmed that this model does not implement.
    ///
    /// Surfaced rather than silently ignored: an unmodelled mode means the
    /// peripheral is not really being simulated.
    pub fn unmodelled_modes(&self) -> Vec<(u8, u32)> {
        (0..64u8)
            .filter_map(|p| match self.pins[p as usize].programmed_mode() {
                PinMode::Unknown(m) => Some((p, m)),
                _ => None,
            })
            .collect()
    }

    /// Everything the firmware printed to the debug UART.
    pub fn console(&self) -> String {
        String::from_utf8_lossy(&self.console).into_owned()
    }

    /// Exchange as many owed byte-times as there is data queued for.
    ///
    /// `fill` supplies bytes once the host's queue runs dry, which is how a
    /// pure receive works: the host clocks with the line idling high.
    fn drain(&mut self, fill: bool) {
        while self.pending > 0 && (fill || !self.tx.is_empty()) {
            let out = self.tx.pop_front().unwrap_or(0xFF);
            let got = self.card.xfer(out);
            self.rx_bytes.push_back(got);
            self.pending -= 1;
            self.in_flag[PIN_DO as usize] = true;
        }
    }

    /// Assemble one receive word from bytes already clocked in.
    ///
    /// `sdmm.cc` reads every word back with `rdpin` then `rev`, so the shifter
    /// hands over bit-reversed data. (32-bit reads then `movbyts #$1b` to
    /// endian-swap, which needs no help from us.)
    fn take_word(&mut self) -> u32 {
        let per_word = (self.rx_bits / 8).max(1) as usize;
        let mut chunk: u32 = 0;
        for _ in 0..per_word {
            let got = self.rx_bytes.pop_front().unwrap_or(0xFF);
            chunk = (chunk << 8) | got as u32;
        }
        chunk.reverse_bits()
    }

    /// Clock `bits` bits through the card.
    ///
    /// The exchange happens here rather than at the read, because the guest
    /// polls `testp PIN_DO` *before* `rdpin` and would spin forever if nothing
    /// arrived until it read. Only the byte movement is eager; the word the
    /// guest sees is assembled later, by [`Board::take_word`].
    fn clock(&mut self, bits: u32) {
        self.pending += (bits / 8).clamp(1, 4096);
        // Only exchange what the host has already queued; the rest drains as
        // `xmit_mmc` feeds it, or fills with idles when a read is attempted.
        self.drain(false);
    }
}

impl Board {
    /// Enable the synchronous-serial smart-pin model, so `WRPIN`/`WYPIN`/`RDPIN`
    /// on sync pins drive [`Board::smart_bus`] instead of the byte-routed SD
    /// path. The net adapter turns this on; standalone runs leave it off.
    pub fn enable_smart_bus(&mut self) {
        self.use_smart_bus = true;
    }

    /// The pin the firmware programmed as the sync-serial clock, if any — the
    /// pin the adapter must pump.
    pub fn smart_clock_pin(&self) -> Option<u8> {
        self.smart_bus.clock_pin()
    }

    /// Whether the sync clock still owes transitions.
    pub fn smart_clock_busy(&self) -> bool {
        self.smart_bus.busy()
    }

    /// Emit one sync-clock transition, sampling the RX pin's current input and
    /// advancing the shifter. Returns the clock's new level, or `None` when the
    /// burst is done.
    pub fn advance_smart_clock(&mut self) -> Option<bool> {
        if let Some(rx) = self.smart_bus.rx_pin() {
            let level = self.input_level(rx);
            self.smart_bus.set_rx_input(level);
        }
        self.smart_bus.advance_clock()
    }

    /// Preload the boot flash and return the board.
    pub fn with_flash(mut self, image: Vec<u8>) -> Self {
        self.flash = SpiFlash::with_image(image);
        self
    }

    /// Present `level` to `pin` from outside.
    ///
    /// A pin the guest is driving ignores this — a real P2 reads its own
    /// output back on `INA`/`INB` when `DIR` is set — so an adapter may call
    /// this unconditionally for every pin on a net without having to know
    /// which direction the firmware chose.
    pub fn set_input_level(&mut self, pin: u8, level: bool) {
        let (bank, bit) = bank_bit(pin);
        if level {
            self.in_ext[bank] |= bit;
        } else {
            self.in_ext[bank] &= !bit;
        }
        // Per-edge, because this is the single-transition entry point: a
        // quadrature pair advances one Gray state at a time, and folding two
        // edges together before decoding turns a legal step into a slip.
        self.step_quadrature();
    }

    /// Present many levels at once: bit *i* of `levels` is pin *i*, and only
    /// the pins set in `mask` are touched.
    ///
    /// The bulk form exists because an adapter republishes every net it owns
    /// on every slice, and per-pin calls would put a loop on the hot path.
    pub fn set_input_levels(&mut self, mask: u64, levels: u64) {
        for bank in 0..2 {
            let shift = bank * 32;
            let m = (mask >> shift) as u32;
            let v = (levels >> shift) as u32;
            self.in_ext[bank] = (self.in_ext[bank] & !m) | (v & m);
        }
        self.step_quadrature();
    }

    /// Advance every quadrature channel to the phase its pins now show.
    ///
    /// Counting on *observed phase* rather than on edges is deliberate: the
    /// engine delivers one net change at a time, so A and B arrive separately
    /// and an edge-triggered decoder would have to know which of the two it
    /// was looking at. Comparing whole phases needs neither.
    fn step_quadrature(&mut self) {
        for a_pin in 0..64u8 {
            let Some(mut q) = self.quad[a_pin as usize] else {
                continue;
            };
            let phase = gray_phase(self.pin_state(a_pin), self.pin_state(q.b_pin));
            match q.phase.replace(phase) {
                // First observation seeds, never counts.
                None => {}
                Some(previous) => match (phase + 4 - previous) % 4 {
                    0 => {}
                    1 => q.count = q.count.wrapping_add(1),
                    3 => q.count = q.count.wrapping_sub(1),
                    // Both channels changed between observations. Real
                    // hardware cannot do that, so the direction is
                    // unrecoverable; hold the count rather than guess.
                    _ => q.slips = q.slips.saturating_add(1),
                },
            }
            self.quad[a_pin as usize] = Some(q);
        }
    }

    /// The level `pin` actually shows: what the guest drives, or what the
    /// outside presents.
    fn pin_state(&self, pin: u8) -> bool {
        let (bank, bit) = bank_bit(pin);
        self.sensed(bank) & bit != 0
    }

    /// The free-running count of the quadrature channel on `a_pin`.
    pub fn quadrature_count(&self, a_pin: u8) -> Option<i32> {
        self.quad[a_pin as usize & 63].map(|q| q.count)
    }

    /// Undecodable two-state jumps seen on the channel at `a_pin`.
    ///
    /// Worth asserting is zero: a harness that skips phases produces a
    /// plausible-looking but wrong position.
    pub fn quadrature_slips(&self, a_pin: u8) -> u32 {
        self.quad[a_pin as usize & 63].map_or(0, |q| q.slips)
    }

    /// Whether the guest has `DIR` set on `pin`.
    pub fn dir_of(&self, pin: u8) -> bool {
        let (bank, bit) = bank_bit(pin);
        self.dir[bank] & bit != 0
    }

    /// The level the outside world is presenting to `pin`.
    pub fn input_level(&self, pin: u8) -> bool {
        let (bank, bit) = bank_bit(pin);
        self.in_ext[bank] & bit != 0
    }

    /// What the guest is driving on `pin`, or `None` if the pin is an input.
    pub fn output_level(&self, pin: u8) -> Option<bool> {
        // A clock or sync-TX pin is driven by the smart-pin hardware, not by
        // DIR/OUT — its level is whatever the shifter and clock generator hold.
        if self.use_smart_bus {
            if self.smart_bus.clock_pin() == Some(pin & 63) {
                return Some(self.smart_bus.clock_level());
            }
            if self.smart_bus.tx_pin() == Some(pin & 63) {
                return Some(self.smart_bus.tx_level());
            }
        }
        let (bank, bit) = bank_bit(pin);
        (self.drive_mask[bank] & bit != 0).then(|| self.out[bank] & bit != 0)
    }

    /// Whether `pin` drives its net.
    ///
    /// `DIR` alone is not the answer once a smart pin is configured. On the P2
    /// `DIR` *enables* a smart pin; whether it drives the pad is the `P_OE`
    /// bit in its mode word. A quadrature or async-receive pin has `DIR` set
    /// and is an **input** — treating it as a driver puts the P2 in contention
    /// with whatever is actually driving that net, which is exactly what the
    /// board diagnostics reported for the encoder channels.
    fn recompute_drive_mask(&mut self) {
        for bank in 0..2 {
            let mut mask = self.dir[bank];
            for bit in 0..32 {
                let smart = self.pins[bank * 32 + bit];
                if smart.mode() != PinMode::Off && smart.cfg & P_OE == 0 {
                    mask &= !(1u32 << bit);
                }
            }
            self.drive_mask[bank] = mask;
        }
    }

    /// The pin state one bank actually reads: what the guest drives where
    /// `DIR` is set, and what the outside presents everywhere else.
    fn sensed(&self, bank: usize) -> u32 {
        let driven = self.drive_mask[bank];
        (driven & self.out[bank]) | (!driven & self.in_ext[bank])
    }
}

/// One quadrature channel, as the P2's `%10110` smart pin keeps it.
#[derive(Debug, Clone, Copy)]
struct Quad {
    /// The B channel, `A + dif` where `dif` came from the mode word.
    b_pin: u8,
    /// Free-running signed count. `HAL_encoder_value` reads this and adds its
    /// own offset, so it must not reset — `HAL_encoder_set` moves the offset,
    /// never the pin.
    count: i32,
    /// Last Gray phase, or `None` until the first observation. A first
    /// observation seeds the detector and must not count, or attaching to a
    /// net mid-revolution would invent a step.
    phase: Option<u8>,
    /// Two-state jumps seen: both channels changed between observations.
    ///
    /// Counted rather than logged, because `p2core` has no dependencies and
    /// because a count is assertable. A non-zero value means the harness is
    /// delivering phases too coarsely to decode — the reading is not merely
    /// noisy, its direction is unrecoverable.
    slips: u32,
}

/// Gray phase for an `(A, B)` pair.
///
/// Matches `embsim`'s encoder model and MCU decoder exactly — `(0,0) → 0,
/// (1,0) → 1, (1,1) → 2, (0,1) → 3`. A different mapping here would still
/// count, but backwards, which is the kind of disagreement that only shows up
/// as a machine driving itself into an endstop.
fn gray_phase(a: bool, b: bool) -> u8 {
    match (a, b) {
        (false, false) => 0,
        (true, false) => 1,
        (true, true) => 2,
        (false, true) => 3,
    }
}

/// Split a pin number into its `[0..31] / [32..63]` bank and bit mask.
fn bank_bit(pin: u8) -> (usize, u32) {
    let p = pin & 63;
    ((p >= 32) as usize, 1u32 << (p & 31))
}

impl PinBus for Board {
    /// A queued smart-pin clock burst is a transfer the CPU cannot advance by
    /// spinning: the edges come from the board's own pump.
    fn external_transfer_busy(&self) -> bool {
        self.use_smart_bus && self.smart_bus.busy()
    }

    fn ina(&self) -> u32 {
        self.sensed(0)
    }

    fn inb(&self) -> u32 {
        self.sensed(1)
    }

    fn dir_out_changed(&mut self, cog: usize, reg: u16, value: u32) {
        // $1FA/$1FB are DIRA/DIRB, $1FC/$1FD are OUTA/OUTB.
        match reg {
            0x1FA => self.dir_cog[cog & (NUM_COGS - 1)][0] = value,
            0x1FB => self.dir_cog[cog & (NUM_COGS - 1)][1] = value,
            0x1FC => self.out_cog[cog & (NUM_COGS - 1)][0] = value,
            0x1FD => self.out_cog[cog & (NUM_COGS - 1)][1] = value,
            _ => return,
        }
        // The pad is the OR across cogs, so one cog writing its own `DIRB`
        // cannot clear a pin another cog is driving. Mirroring these globally
        // let a `DEBUG_*` print on P62 — 327k `DIRB` writes in 30 s, all with
        // the SD bits clear — reset the SD card's transmit shifter mid-block,
        // and the data token went out as `$FF`.
        self.dir[0] = self.dir_cog.iter().fold(0, |a, d| a | d[0]);
        self.dir[1] = self.dir_cog.iter().fold(0, |a, d| a | d[1]);
        self.out[0] = self.out_cog.iter().fold(0, |a, o| a | o[0]);
        self.out[1] = self.out_cog.iter().fold(0, |a, o| a | o[1]);
        self.recompute_drive_mask();
        if self.use_smart_bus {
            // A `DIR` change on the sync-TX pin is `xmit_mmc`'s reset/liven
            // bracket, not a direction change.
            if let Some(tx) = self.smart_bus.tx_pin() {
                self.smart_bus.set_tx_livened(tx, self.dir_of(tx));
            }
        }

        // Drive the boot flash from its pins, instantly. The ROM bit-bangs it
        // with plain pin ops and samples MISO within microseconds, faster than
        // a net could resolve — so the flash answers here, on the board's own
        // pins, the moment they change. `output_level` reads what the guest is
        // driving; `pin_state` folds in direction.
        if self.flash.present() {
            let cs_high = self.pin_state(FLASH_CS);
            self.flash.set_selected(!cs_high);
            let clk = self.pin_state(FLASH_CLK);
            let di = self.pin_state(FLASH_DI);
            self.flash.clock(clk, di);
            self.set_input_level(FLASH_DO, self.flash.miso());
        }

        // OUTB bit 28 is pin 60 (CS). SPI selects on CS low.
        if reg == 0x1FD {
            let cs_high = value & (1 << (PIN_CS - 32)) != 0;
            self.card.set_selected(!cs_high);
        }
        // DIRB bit 27 is pin 59 (DI). `xmit_mmc` brackets every transfer with
        // `dirl PIN_DI` precisely to "reset tx smartpin, clears excess data",
        // and it relies on that: it feeds whole longwords but clocks an exact
        // byte count, so a 6-byte command leaves two bytes in the shifter that
        // must never reach the card. Holding them would put them on MOSI at
        // the head of the next transfer.
        if reg == 0x1FB && value & (1 << (PIN_DI - 32)) == 0 {
            self.tx.clear();
        }
    }

    fn wrpin(&mut self, pin: u8, cfg: u32) {
        let p = pin as usize & 63;
        // AKPIN is literally `WRPIN #1,S`, so a cfg of 1 is an acknowledge --
        // `rcvr_mmc` opens with `akpin PIN_DO` to clear the rx buffer. Treating
        // it as a mode write would wipe the pin's sync-serial configuration.
        if cfg == 1 {
            self.in_flag[p] = false;
            self.rx_bytes.clear();
            if self.use_smart_bus {
                self.smart_bus.akpin(pin);
            }
            return;
        }
        self.pins[p].cfg = cfg;
        if cfg != 0 {
            self.pins[p].programmed_cfg = cfg;
        }
        // `%10110` with the B channel's offset in bits 26:24, as
        // `HAL_encoder_start` writes it: `P_QUADRATURE | ((dif & 7) << 24)`.
        // The offset is a signed 3-bit field, so B can be below A.
        self.recompute_drive_mask();
        if self.use_smart_bus {
            self.smart_bus.wrpin(pin, &self.pins);
        }
        self.quad[p] = match self.pins[p].mode() {
            PinMode::Quadrature => {
                let dif = ((cfg >> 24) & 0x7) as u8;
                let dif = if dif & 0x4 != 0 {
                    (dif as i8) - 8
                } else {
                    dif as i8
                };
                Some(Quad {
                    b_pin: (p as i8).wrapping_add(dif) as u8 & 63,
                    // A reconfigure restarts the channel: real hardware zeroes
                    // its counter on `_pinstart`, and the HAL's own offset is
                    // what carries a homed position across.
                    count: 0,
                    phase: None,
                    slips: 0,
                })
            }
            _ => None,
        };
        self.in_flag[p] = cfg != 0;
    }

    fn wxpin(&mut self, pin: u8, x: u32) {
        if self.use_smart_bus && self.smart_bus.wxpin(pin, x) {
            self.pins[pin as usize & 63].x = x;
            return;
        }
        self.pins[pin as usize & 63].x = x;
        if pin == PIN_DO {
            // %1IIIII where the low five bits are (bits - 1); bit 5 selects
            // sampling after the rising clock edge.
            self.rx_bits = (x & 0x1F) + 1;
        }
        self.in_flag[pin as usize & 63] = true;
    }

    fn wypin(&mut self, pin: u8, y: u32) {
        self.byte_counts[pin as usize & 63] += 1;
        if self.use_smart_bus && self.smart_bus.wypin(pin, y) {
            self.in_flag[pin as usize & 63] = true;
            return;
        }
        match pin {
            PIN_TX => {
                let b = if self.edge_level {
                    self.carry_as_edges(pin, y as u8)
                } else {
                    y as u8
                };
                self.console.push(b);
            }
            PIN_PROTO_TX => {
                let b = if self.edge_level {
                    self.carry_as_edges(pin, y as u8)
                } else {
                    y as u8
                };
                self.proto_tx.push(b);
            }
            PIN_DI => {
                if self.di_log.len() < 64 {
                    self.di_log.push(y);
                }
                // The TX shifter sends LSB-first, which is why `xmit_mmc`
                // pre-applies `rev` + `movbyts` before WYPIN. Reversing the
                // whole word here recovers the wire order: a CMD0 frame whose
                // first long reaches us as $00000002 goes out as 40 00 00 00.
                let wire = y.reverse_bits();
                for i in (0..4).rev() {
                    self.tx.push_back((wire >> (i * 8)) as u8);
                }
                self.drain(false);
            }
            PIN_CLK => {
                // Clocking is the transfer: y counts clock edges, so it moves
                // y/8 bytes. The 80 dummy clocks at init are 10 bytes; an
                // 8-clock burst is the single-byte exchange `rcvr_mmc` uses.
                self.clock(y);
            }
            _ => {}
        }
        self.in_flag[pin as usize & 63] = true;
    }

    fn rdpin(&mut self, pin: u8) -> (u32, bool) {
        let p = pin as usize & 63;
        self.byte_counts[p] += 1;
        self.in_flag[p] = false;
        if self.use_smart_bus {
            if let Some(word) = self.smart_bus.rdpin(pin) {
                return (word, false);
            }
        }
        let v = match pin {
            PIN_DO => {
                // A read with clocks still owed means a pure receive: the host
                // is clocking with its line idle.
                let per_word = (self.rx_bits / 8).max(1) as usize;
                if self.rx_bytes.len() < per_word {
                    self.drain(true);
                }
                self.take_word()
            }
            // `HAL_serial_recieveByte` takes the byte from bits 31:24, which is
            // where an async-RX smart pin leaves it.
            PIN_RX => self
                .uart_rx
                .pop_front()
                .map(|b| (b as u32) << 24)
                .unwrap_or(0),
            PIN_PROTO_RX => self
                .proto_rx
                .pop_front()
                .map(|b| (b as u32) << 24)
                .unwrap_or(0),
            // A quadrature pin's Z is its accumulated count, read as a signed
            // 32-bit value by `HAL_encoder_value`.
            _ if self.quad[p].is_some() => self.quad[p].expect("just checked").count as u32,
            _ => 0xFF,
        };
        // C reports BUSY; nothing here ever is.
        (v, false)
    }

    fn testp(&self, pin: u8) -> bool {
        // An async RX pin reports "a byte is waiting", not "an operation
        // finished". Reporting every configured pin as ready would make
        // `HAL_serial_recieveByte` read an endless stream of zero bytes.
        match pin {
            PIN_RX => return !self.uart_rx.is_empty(),
            PIN_PROTO_RX => return !self.proto_rx.is_empty(),
            _ => {}
        }
        if self.use_smart_bus {
            if let Some(ready) = self.smart_bus.testp(pin) {
                return ready;
            }
        }
        let p = pin as usize & 63;
        // A pin with no smart-pin mode is plain GPIO, and `TESTP` reads its
        // *level*, not an IN flag. This is the path the firmware's own GPIO
        // driver takes — `HAL_GPIO_getActive` is `_pinr(pin)`, which compiles
        // to `TESTP` — so reporting a flag here makes every endstop, ESD line
        // and ready signal read inactive no matter what is on the wire.
        if self.pins[p].mode() == PinMode::Off {
            return self.pin_state(pin);
        }
        self.in_flag[p] || self.pins[p].is_configured()
    }

    fn akpin(&mut self, pin: u8) {
        if self.use_smart_bus && self.smart_bus.akpin(pin) {
            return;
        }
        self.in_flag[pin as usize & 63] = false;
    }
}
