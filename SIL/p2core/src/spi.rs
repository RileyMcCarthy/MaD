//! The P2's synchronous-serial pins, one bit at a time.
//!
//! [`crate::Board`] can exchange whole bytes with an in-process
//! [`crate::SdCard`], which is enough to boot and cheap to run. It is also a
//! **byte route**: the transfer happens the instant the guest clocks the bus,
//! so nothing between the two ends can be modelled. A pull-up on MISO, a
//! second device sharing the bus behind a different chip select, the driver
//! switching from bit-banging to smart-pin mode mid-sequence — none of it
//! exists, because there are no bits and no time.
//!
//! This is the other half: shift registers that move exactly one bit per clock
//! edge, so an adapter can put the bus on real nets and let a card or a flash
//! chip answer as a component.
//!
//! # Wire order, matched to the byte path
//!
//! Both directions are bit-reversed relative to the word, and not arbitrarily:
//! the P2's sync-serial shifters are LSB-first, which is why `xmit_mmc`
//! pre-applies `rev`/`movbyts` before `WYPIN`. The byte path expresses the
//! same thing as `word.reverse_bits()` on the way out and
//! `chunk.reverse_bits()` on the way in; this shifts one bit at a time and
//! lands on identical words, which
//! [`crate::board::tests`] asserts directly rather than by inspection.

/// Shift state for one synchronous-serial bus.
#[derive(Debug, Default)]
pub struct SpiShift {
    /// Transmit **shift** register. The P2 sends this LSB-first.
    tx: u32,
    /// Bits still unsent from `tx`.
    tx_left: u32,
    /// Transmit **buffer**: the next word, queued while the shifter drains.
    ///
    /// The P2's synchronous transmitter is two registers deep, and `xmit_mmc`
    /// depends on it — the driver's "continuous mode" loop writes the next
    /// longword and then spins on `TESTP PIN_DI` for the buffer to empty. A
    /// one-register model loses every word but the last, and the bus carries
    /// nothing but idle ones.
    tx_buf: Option<u32>,
    /// Whether the pin is livened (`DIRH`). While it is reset (`DIRL`) a
    /// `WYPIN` loads the shifter directly; once livened it loads the buffer.
    livened: bool,
    /// Receive accumulator, filled MSB-first as bits arrive.
    rx: u32,
    /// Bits accumulated so far.
    rx_have: u32,
    /// How many bits make a word, from `WXPIN` on the receive pin.
    rx_want: u32,
    /// The most recently completed word, if one is waiting.
    ///
    /// **One word, not a queue.** The P2's synchronous receiver is a shifter
    /// plus a single holding register: a word that completes before the last
    /// was read overwrites it, and `IN` simply means "a word is there". A
    /// queue looks harmless and is not — clocks the driver sends for other
    /// reasons (the 64 dummy pulses at init, the clocks that carry a command
    /// *out*) all complete receive words too, and a queue hands every one of
    /// them back. `TESTP` then reads true when nothing has arrived, the driver
    /// stops waiting for the bus, and it fires burst after burst into a
    /// transfer that has not happened yet.
    rx_word: Option<u32>,
    /// Clock edges seen, for cost accounting and assertions.
    pub edges: u64,
    /// Times the transmit register was loaded — a `WYPIN` on the data pin.
    pub loads: u64,
    /// Times a receive word was taken — a `RDPIN` on the receive pin.
    pub takes: u64,
}

impl SpiShift {
    pub fn new() -> Self {
        Self {
            rx_want: 8,
            ..Default::default()
        }
    }

    /// Set the receive word width (`WXPIN` low five bits are `bits - 1`).
    ///
    /// Also restarts the bit counter: on the hardware a fresh X begins a fresh
    /// word, and the driver leans on that to realign byte boundaries when it
    /// switches between 8- and 32-bit reads — bits sampled *during* the
    /// preceding transmit burst would otherwise carry into the first read.
    pub fn set_rx_bits(&mut self, bits: u32) {
        self.rx_want = bits.clamp(1, 32);
        self.rx = 0;
        self.rx_have = 0;
    }

    /// `DIRH`/`DIRL` on the transmit pin.
    ///
    /// `DIRL` is a **reset**, and the driver uses it as one: `xmit_mmc` opens
    /// and closes with `dirl PIN_DI // reset tx smartpin, clears excess data`.
    pub fn set_livened(&mut self, livened: bool) {
        if !livened {
            self.tx = 0;
            self.tx_left = 0;
            self.tx_buf = None;
        }
        self.livened = livened;
    }

    /// Load the transmit path (`WYPIN` on the DI pin).
    ///
    /// Where it lands depends on `DIR`, exactly as the hardware does: into the
    /// shifter while the pin is reset, into the buffer once it is livened.
    pub fn load_tx(&mut self, word: u32) {
        if self.livened && self.tx_left > 0 {
            self.tx_buf = Some(word);
        } else {
            self.tx = word;
            self.tx_left = 32;
        }
        self.loads += 1;
    }

    /// Whether the pin is livened.
    pub fn livened(&self) -> bool {
        self.livened
    }

    /// Whether the transmit buffer will accept another word — what
    /// `TESTP PIN_DI` reports, and what `xmit_mmc`'s inner loop spins on.
    pub fn tx_buffer_empty(&self) -> bool {
        self.tx_buf.is_none()
    }

    /// The level the DI pin presents right now.
    ///
    /// An exhausted shifter idles **high**, which is what a released MOSI line
    /// does and what `rcvr_mmc` relies on when it clocks `$FF` to read.
    pub fn mosi(&self) -> bool {
        if self.tx_left == 0 {
            return true;
        }
        self.tx & 1 != 0
    }

    /// Shift one bit out — the clock edge on which data changes.
    pub fn advance_tx(&mut self) {
        if self.tx_left > 0 {
            self.tx >>= 1;
            self.tx_left -= 1;
        }
        // An emptied shifter reloads from the buffer without losing a bit
        // time, which is what "continuous mode" means.
        if self.tx_left == 0 {
            if let Some(next) = self.tx_buf.take() {
                self.tx = next;
                self.tx_left = 32;
            }
        }
    }

    /// Sample one bit in — the clock edge on which data is latched.
    pub fn sample_rx(&mut self, level: bool) {
        self.rx = (self.rx << 1) | u32::from(level);
        self.rx_have += 1;
        if self.rx_have >= self.rx_want {
            // `reverse_bits` puts the first wire bit where the byte path puts
            // it, so a word assembled here is indistinguishable from one
            // assembled from whole bytes.
            self.rx_word = Some(self.rx.reverse_bits());
            self.rx = 0;
            self.rx_have = 0;
        }
    }

    /// Take a completed word (`RDPIN` on the DO pin).
    pub fn take_rx(&mut self) -> Option<u32> {
        self.takes += 1;
        self.rx_word.take()
    }

    /// Whether a word is waiting — the DO pin's IN flag.
    pub fn rx_ready(&self) -> bool {
        self.rx_word.is_some()
    }

    /// Drop everything buffered (`AKPIN` on the receive pin clears it).
    pub fn clear_rx(&mut self) {
        self.rx_word = None;
        self.rx = 0;
        self.rx_have = 0;
    }
}
