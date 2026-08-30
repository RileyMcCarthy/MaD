//! Smart-pin configuration, decoded rather than ignored.
//!
//! A P2 smart pin is configured by three writes: `WRPIN` sets the mode word,
//! `WXPIN` its parameter, `WYPIN` supplies data. A model that only watches
//! `WYPIN` — taking the byte and discarding the rest — is a shim: it works, and
//! it cannot see a wrong `clkfreq`, a wrong bit period, or a driver that
//! programmed the wrong mode entirely. Those are exactly the bugs an ISS exists
//! to catch, since the native backend never executes a `WRPIN` at all.
//!
//! So this decodes the configuration. It does **not** simulate individual bit
//! edges: the models on the other side consume bytes at a declared rate
//! (embsim's `StreamRole::ByteSink { baud_hz }`), so edges would be
//! re-serialised at that boundary and the fidelity thrown away. Carrying the
//! derived rate keeps the check — a wrong `clkfreq` produces a baud that
//! disagrees with the peer's — without paying for an edge storm.
//!
//! Clocked protocols are different and are not handled here: SD SPI is driven
//! by an explicit clock count (`WYPIN n` on the clock pin *is* the transfer),
//! so it is already bit-exact in [`crate::board`].

/// Mode-word bits that select the smart-pin function (`%MMMMM` plus its low
/// bit). `P_OE` and the analog/drive fields live above this.
const MODE_MASK: u32 = 0x3F;
/// Output enable, ORed into the mode word by the firmware.
pub const P_OE: u32 = 0x40;

/// The smart-pin functions this model understands.
///
/// Values are the P2's, cross-checked against the flexcc toolchain's
/// `smartpins.h` and against what the firmware actually programs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinMode {
    /// Not configured.
    Off,
    /// `P_PULSE` — used here as the SD SPI clock generator.
    Pulse,
    /// `P_TRANSITION` — the stepper pulse train.
    Transition,
    /// `P_NCO_FREQ` — continuous square wave.
    NcoFreq,
    /// `P_QUADRATURE` — the servo encoder.
    Quadrature,
    /// `P_SYNC_TX` / `P_SYNC_RX` — SD SPI data pins.
    SyncTx,
    SyncRx,
    /// `P_ASYNC_TX` / `P_ASYNC_RX` — the debug console and protocol link.
    AsyncTx,
    AsyncRx,
    /// A mode this model does not implement. Kept rather than silently
    /// ignored so a diagnostic can report it.
    Unknown(u32),
}

impl PinMode {
    fn from_cfg(cfg: u32) -> Self {
        if cfg == 0 {
            return PinMode::Off;
        }
        match cfg & MODE_MASK {
            0x08 => PinMode::Pulse,
            0x0A => PinMode::Transition,
            0x0C => PinMode::NcoFreq,
            0x16 => PinMode::Quadrature,
            0x38 => PinMode::SyncTx,
            0x3A => PinMode::SyncRx,
            0x3C => PinMode::AsyncTx,
            0x3E => PinMode::AsyncRx,
            other => PinMode::Unknown(other),
        }
    }

    /// True for the asynchronous serial modes, whose `X` carries a bit period.
    pub fn is_async_serial(self) -> bool {
        matches!(self, PinMode::AsyncTx | PinMode::AsyncRx)
    }
}

/// One smart pin's configuration.
#[derive(Debug, Clone, Copy, Default)]
pub struct SmartPin {
    /// Last `WRPIN` mode word.
    pub cfg: u32,
    /// Last `WXPIN` parameter.
    pub x: u32,
}

impl SmartPin {
    pub fn mode(&self) -> PinMode {
        PinMode::from_cfg(self.cfg)
    }

    /// Whether the firmware enabled the output driver.
    pub fn output_enabled(&self) -> bool {
        self.cfg & P_OE != 0
    }

    pub fn is_configured(&self) -> bool {
        self.cfg != 0
    }

    /// Clocks per bit, from `X[31:16]`.
    pub fn bit_period(&self) -> u32 {
        self.x >> 16
    }

    /// Bits per frame, from `X[4:0] + 1` — 8 for a normal byte.
    pub fn frame_bits(&self) -> u32 {
        (self.x & 0x1F) + 1
    }

    /// The baud rate this pin is actually programmed for.
    ///
    /// This is the check the shim could not make: the rate is *derived* from
    /// the bit period the firmware computed and the clock frequency it
    /// recorded, so a wrong `clkfreq` shows up here as a wrong baud rather
    /// than as bytes that look fine.
    pub fn baud_hz(&self, clkfreq: u32) -> Option<u32> {
        if !self.mode().is_async_serial() {
            return None;
        }
        match self.bit_period() {
            0 => None,
            period => Some(clkfreq / period),
        }
    }
}

/// Whether `actual` is within `tolerance_pct` of `nominal`.
///
/// Bit periods are integers, so an exact match is not expected: 2,000,000 baud
/// at 160 MHz is 80 clocks exactly, but 230,400 is 694.4 and rounds to 694,
/// giving 230,547.
pub fn baud_matches(actual: u32, nominal: u32, tolerance_pct: f64) -> bool {
    let diff = (actual as f64 - nominal as f64).abs();
    diff / nominal as f64 * 100.0 <= tolerance_pct
}
