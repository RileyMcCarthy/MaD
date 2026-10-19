//! The ISS as the core inside embsim's P2 package: [`P2IssCore`].
//!
//! [`crate::P2Iss`] is a component on no board, declaring the pins its lists
//! name. [`P2IssCore`] is the same machine — the same [`p2core::Machine`],
//! the same `NetPins` bus — as an [`embsim_boards::p2::P2Core`], so
//! it fills a module's processor slot (`U100` on the P2-EC32MB) inside
//! [`embsim_boards::p2::P2Package`]. The package declares the 86 pins, holds
//! the core until the chip can run (its START gate), and hands it
//! [`P2Pads`]; the core takes all 64 pads and reads every one.
//!
//! # A pad's role is the guest's
//!
//! No list says what a pin is. Every pad is on its net, and what it presents
//! follows from what the guest wrote:
//!
//! | The guest's mode word and `DIR` | The pad |
//! |---|---|
//! | no smart mode, `DIR` set | its `OUT` bit through the mode word's drive strength, high at its bank's supply ([`BankSupplies::pad_drive`]) |
//! | `DIR` clear, or a smart input mode | released |
//! | `P_ASYNC_TX` with `P_OE` | the line's idle mark until the first byte, then a [`SerialLevelBridge`] framing at the rate the pin's bit period and the guest's clock give |
//! | `P_ASYNC_RX` | read by a deframer at the rate its bit period and the guest's clock give; `RDPIN` takes its bytes |
//! | `P_TRANSITION` or `P_NCO_FREQ` with `P_OE` | a step train, one periodic drive per rate change ([`crate::pulse`]) |
//! | `P_PULSE` and the sync-serial modes | the synchronous-serial hardware pumped over virtual time ([`p2core::SmartBus`]), so the module's flash and card share `P58`–`P61` as they do on the board |
//!
//! A pad whose published drive is strong (under [`WEAK_DRIVE_OHMS`]) reads
//! its own `OUT`; every other pad reads its net (`p2core::Board::sensed`,
//! the strong-mask rule). Nothing straps a pin from here: the board's
//! resistors and switches do (`S301` on the P2-EC32MB).
//!
//! # The guest's clock
//!
//! The chip comes up on its RC oscillator and runs on whatever its `HUBSET`
//! clock word selects. The core keeps the map from the guest's clock count
//! to virtual time as segments: the first anchored at the package's START
//! instant ([`P2Core::start`]) at [`RCFAST_HZ`], and one more at every clock
//! word, at the rate [`clock_hz`] decodes from the word and the crystal the
//! package reads on `XI` ([`P2Pads::on_crystal`]). Each word is reported to
//! the package ([`P2Pads::set_clock_mode`]), whose `XI` mode depends on it.
//! A word that derives the clock from a crystal that does not reach `XI`
//! stops the guest until one does. Hub `$14`, where a program records the
//! rate it believes it set, plays no part: the ROM keeps other data there.
//!
//! # Time
//!
//! As in [`crate::P2Iss`], the engine leads: each wake runs the guest up to
//! the engine's instant, and a guest that drives a pad yields at once so
//! the net resolves before it reads anything back. A pad change is stamped
//! with the wake's instant, which is at or after the guest's own.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use embsim_board::uart::{UartDecoder, UartFraming};
use embsim_board::{
    AttachError, ComponentNetIo, Drive, Level, PinHandle, SerialLevelBridge, TheveninDrive,
    WakeGate, WakeHandler, WEAK_DRIVE_OHMS,
};
use embsim_boards::p2::{
    BankSupplies, P2Core, P2Pads, P2ResetState, PadDrive, NUM_BANKS, PADS_PER_BANK,
};
use embsim_core::virtual_clock;
use p2core::board::PIN_TX as DEBUG_TX;
use p2core::{Board, Machine, PinBus, PinMode, SdCard};

use crate::pulse::PulseDriver;
use crate::{pin_name, NetPins, P2IssHandle, Shared, TxLink, EDGE_QUEUE_MAX, SLICE_NS};

/// The internal RC oscillator the chip comes up on, nominal: Parallax states
/// 20 MHz for RCFAST, which silicon runs anywhere in 20–24 MHz (the figure
/// `embsim_p2_qemu::RCFAST_HZ` takes).
pub const RCFAST_HZ: u64 = 20_000_000;

/// The slow internal oscillator (`%SS` = `%01`), nominal.
pub const RCSLOW_HZ: u64 = 20_000;

/// The system clock a `HUBSET` clock word selects, given the crystal on
/// `XI`, or `None` when the source it selects does not run.
///
/// `%0000_000E_DDDD_DDMM_MMMM_MMMM_PPPP_CCSS` (P2X8C4M64P Datasheet, "System
/// Clock", p. 18): `%SS` picks RCFAST, RCSLOW, the crystal or the PLL; the
/// PLL runs the crystal through `/(D+1)`, `*(M+1)` and a final divider,
/// `%1111` the VCO direct and anything else `/((P+1)*2)`. `XI` runs only
/// with `%CC` ≠ `%00` and the PLL only with that and `%E` set (the `%SS`
/// notes), so a word that selects either without them has no clock; nor
/// does one that derives the clock from a crystal that does not reach `XI`.
/// The same decode as `embsim_p2_qemu::clock_hz`, which this crate does not
/// depend on.
pub fn clock_hz(word: u32, crystal_hz: Option<u64>) -> Option<u64> {
    if !source_runs(word) {
        return None;
    }
    match word & 0b11 {
        0b00 => Some(RCFAST_HZ),
        0b01 => Some(RCSLOW_HZ),
        0b10 => crystal_hz,
        _ => {
            let crystal_hz = crystal_hz?;
            let d = u64::from((word >> 18) & 0x3F) + 1;
            let m = u64::from((word >> 8) & 0x3FF) + 1;
            let p = (word >> 4) & 0xF;
            let pdiv = if p == 0xF { 1 } else { (u64::from(p) + 1) * 2 };
            Some((crystal_hz * m / d / pdiv).max(1))
        }
    }
}

/// Whether a clock word's source is the crystal, directly or through the
/// PLL.
const fn derives_from_crystal(word: u32) -> bool {
    matches!(word & 0b11, 0b10 | 0b11)
}

/// Whether the source a clock word selects runs at all (the datasheet's
/// `%SS` notes, p. 18).
const fn source_runs(word: u32) -> bool {
    let xi_on = (word >> 2) & 0b11 != 0;
    let pll_on = (word >> 24) & 1 == 1;
    match word & 0b11 {
        0b10 => xi_on,
        0b11 => xi_on && pll_on,
        _ => true,
    }
}

/// One constant-rate stretch of the guest's clock: from a clock count, at
/// the virtual nanosecond it corresponds to, at a rate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Segment {
    from_clocks: u64,
    from_ns: u64,
    hz: u64,
}

/// The guest's clock count against virtual time, piecewise.
#[derive(Debug, Clone)]
pub(crate) struct GuestClock {
    segments: Vec<Segment>,
    /// The clock word last applied.
    word: u32,
    /// The crystal the package last delivered on `XI`.
    crystal_hz: Option<u64>,
    /// The crystal the current segment was decoded with.
    clocked_crystal_hz: Option<u64>,
    /// The word selects a source that does not run (or a crystal that does
    /// not reach `XI`): no clock, no instructions.
    stalled: bool,
}

impl GuestClock {
    fn new() -> Self {
        Self {
            segments: vec![Segment {
                from_clocks: 0,
                from_ns: 0,
                hz: RCFAST_HZ,
            }],
            word: 0,
            crystal_hz: None,
            clocked_crystal_hz: None,
            stalled: false,
        }
    }

    /// Anchor clock 0 at `start_ns`: the START instant.
    fn anchor(&mut self, start_ns: u64) {
        if let Some(first) = self.segments.first_mut() {
            first.from_ns = start_ns;
        }
    }

    /// The rate the guest runs at now.
    pub(crate) fn hz(&self) -> u64 {
        self.segments.last().map_or(RCFAST_HZ, |s| s.hz)
    }

    /// The virtual instant the current rate took effect: the START instant
    /// until the guest's first clock word.
    fn set_at_ns(&self) -> u64 {
        self.segments.last().map_or(0, |s| s.from_ns)
    }

    /// The virtual instant of clock count `clocks`.
    pub(crate) fn clocks_to_ns(&self, clocks: u64) -> u64 {
        let segment = self
            .segments
            .iter()
            .rev()
            .find(|s| s.from_clocks <= clocks)
            .or(self.segments.first())
            .copied()
            .expect("at least the reset segment");
        let run = u128::from(clocks.saturating_sub(segment.from_clocks)) * 1_000_000_000u128
            / u128::from(segment.hz.max(1));
        u64::try_from(run)
            .unwrap_or(u64::MAX)
            .saturating_add(segment.from_ns)
    }

    /// The least clock count whose instant is at or past `ns`, in the
    /// current segment: the horizon a wake at `ns` runs the guest to.
    fn ns_to_clocks_ceil(&self, ns: u64) -> u64 {
        let s = *self.segments.last().expect("the reset segment");
        if ns <= s.from_ns {
            return s.from_clocks;
        }
        let num = u128::from(ns - s.from_ns) * u128::from(s.hz);
        s.from_clocks
            .saturating_add(u64::try_from(num.div_ceil(1_000_000_000)).unwrap_or(u64::MAX))
    }

    /// The guest set `word` at clock count `at`: start a segment there at
    /// the rate it selects with `crystal_hz`, or stall.
    fn set_word(&mut self, word: u32, at: u64, crystal_hz: Option<u64>, now_ns: u64) {
        self.crystal_hz = crystal_hz;
        let was_stalled = self.stalled;
        self.word = word;
        self.clocked_crystal_hz = crystal_hz;
        self.retime(word, at, if was_stalled { Some(now_ns) } else { None });
    }

    /// The crystal on `XI` is `crystal_hz` at `now_ns`, the guest at clock
    /// count `now_clocks`: a clock derived from it starts a segment at the
    /// new rate, and a guest stalled for it runs again from `now_ns`.
    fn set_crystal(&mut self, crystal_hz: Option<u64>, now_clocks: u64, now_ns: u64) {
        self.crystal_hz = crystal_hz;
        if self.clocked_crystal_hz == crystal_hz {
            return;
        }
        self.clocked_crystal_hz = crystal_hz;
        if !derives_from_crystal(self.word) {
            return;
        }
        let from = if self.stalled { Some(now_ns) } else { None };
        self.retime(self.word, now_clocks, from);
    }

    fn retime(&mut self, word: u32, at: u64, from_ns: Option<u64>) {
        match clock_hz(word, self.crystal_hz) {
            Some(hz) => {
                let from_ns = from_ns.unwrap_or_else(|| self.clocks_to_ns(at));
                tracing::info!(
                    word = format_args!("{word:#010x}"),
                    hz,
                    crystal_hz = self.crystal_hz,
                    at,
                    from_ns,
                    "p2iss: clock set"
                );
                self.stalled = false;
                // The map stays ordered by clock count: a word set by a cog
                // whose clock lags the last segment's start takes effect
                // there.
                let last = *self.segments.last().expect("the reset segment");
                let at = at.max(last.from_clocks);
                let from_ns = from_ns.max(last.from_ns);
                self.segments.push(Segment {
                    from_clocks: at,
                    from_ns,
                    hz,
                });
            }
            None => {
                tracing::warn!(
                    word = format_args!("{word:#010x}"),
                    crystal_hz = self.crystal_hz,
                    "p2iss: the clock word selects a source that does not run, or a crystal \
                     that does not reach XI; the guest has no clock and stalls until one does"
                );
                self.stalled = true;
            }
        }
    }
}

/// What a [`P2IssCore`]'s bus keeps of its pads: the handles, what each
/// was last told, the bank supplies they drive at, and the guest's clock.
pub(crate) struct CorePads {
    banks: BankSupplies,
    handles: Vec<PinHandle>,
    /// What each pad was last told: `None` unknown (republish), `Some(None)`
    /// released, `Some(Some(drive))` a source.
    published: [Option<Option<TheveninDrive>>; 64],
    /// The `(level, mode word)` each pad was last published from, so an
    /// unchanged pad costs a compare.
    keys: [Option<(Option<bool>, u32)>; 64],
    /// Pads a transmit bridge or a step train drives: the publish below
    /// leaves them to it.
    owned: u64,
    /// Each bank's supply as its pads were last published against it.
    bank_bits: [u64; NUM_BANKS],
    pub(crate) clock: GuestClock,
    /// Said once: a pad was configured in a current-source drive mode.
    current_source_said: bool,
}

/// A bank whose supply has not been read.
const NO_SUPPLY: u64 = u64::MAX;

impl CorePads {
    fn new(banks: BankSupplies, handles: Vec<PinHandle>) -> Self {
        Self {
            banks,
            handles,
            // The package declares every pad released: a chip out of reset
            // floats every pin.
            published: [Some(None); 64],
            keys: [None; 64],
            owned: 0,
            bank_bits: [NO_SUPPLY; NUM_BANKS],
            clock: GuestClock::new(),
            current_source_said: false,
        }
    }

    /// What pad `pin` presents driving `out` with mode word `cfg`.
    fn drive_of(&mut self, pin: u8, cfg: u32, out: bool) -> Option<TheveninDrive> {
        match self.banks.pad_drive(pin, cfg, true, out) {
            PadDrive::Thevenin(drive) => Some(drive),
            PadDrive::Released => None,
            PadDrive::CurrentSource(mode) => {
                if !std::mem::replace(&mut self.current_source_said, true) {
                    tracing::warn!(
                        pin,
                        ?mode,
                        "p2iss: a pad was configured in a current-source drive mode, which the \
                         package does not map; the pad presents nothing to its net"
                    );
                }
                None
            }
        }
    }

    /// The pads whose drive, as last published, is strong: what reads its
    /// own `OUT`. A pad a bridge or a train drives is driven fast.
    fn strong_mask(&self) -> u64 {
        let mut mask = self.owned;
        for (pin, published) in self.published.iter().enumerate() {
            if let Some(Some(drive)) = published {
                if drive.impedance < WEAK_DRIVE_OHMS {
                    mask |= 1u64 << pin;
                }
            }
        }
        mask
    }

    /// Forget what the pads of every bank whose supply moved were told, so
    /// the next publish drives them at the new voltage.
    fn follow_supplies(&mut self) -> bool {
        let mut moved = false;
        for bank in 0..NUM_BANKS {
            let bits = self.banks.volts(bank).map_or(NO_SUPPLY, f64::to_bits);
            if bits != self.bank_bits[bank] {
                self.bank_bits[bank] = bits;
                for pin in bank * PADS_PER_BANK..(bank + 1) * PADS_PER_BANK {
                    self.keys[pin] = None;
                }
                moved = true;
            }
        }
        moved
    }
}

/// What a [`P2IssCore`] shares between its wake, its pad senses and its
/// handle, beyond what [`Shared`] already holds.
#[derive(Debug, Default)]
pub(crate) struct CoreShared {
    /// Receive pins, by the guest's mode word: bit *i* pad *i*.
    rx_mask: AtomicU64,
    /// Their deframers and the bytes they took off the wire.
    rx: Mutex<HashMap<u8, CoreRx>>,
    /// The crystal the package last delivered on `XI`, in hertz; 0 while
    /// nothing reaches the pin.
    crystal_hz: AtomicU64,
    /// The guest has no clock (see [`GuestClock::set_word`]).
    stalled: AtomicBool,
    /// The package held the core ([`P2Core::reset`]).
    held: AtomicBool,
    /// The reset inputs, as the package last delivered them.
    reset: Mutex<P2ResetState>,
    /// The START instant, once the package started the core.
    started_at_ns: Mutex<Option<u64>>,
    /// The instant of the slice wake already on the wheel.
    next_slice_ns: Mutex<Option<u64>>,
    /// The guest's clock rate, and the instant it took effect, as of the
    /// last wake: what a handle reads without waiting on the machine.
    clock_hz: AtomicU64,
    clock_set_at_ns: AtomicU64,
}

impl CoreShared {
    fn crystal(&self) -> Option<u64> {
        let hz = self.crystal_hz.load(Ordering::Relaxed);
        (hz != 0).then_some(hz)
    }
}

/// One receive pin: its deframer at the rate the guest programmed, and the
/// bytes it has taken off the wire that the guest has not read.
#[derive(Debug)]
pub(crate) struct CoreRx {
    decoder: UartDecoder,
    baud: u32,
    queue: VecDeque<u8>,
    /// The frame deadline already on the wheel.
    armed_ns: Option<u64>,
}

impl CoreRx {
    /// Close every frame due at `now_ns`, counting what it took.
    fn poll(&mut self, now_ns: u64, shared: &Shared) {
        while let Some(frame) = self.decoder.poll(now_ns) {
            match frame {
                Ok(byte) => {
                    shared.rx_bytes.fetch_add(1, Ordering::Relaxed);
                    self.queue.push_back(byte);
                }
                Err(error) => {
                    shared.rx_framing_errors.fetch_add(1, Ordering::Relaxed);
                    tracing::debug!(
                        ?error,
                        "p2iss: receive frame dropped (bad framing on the wire)"
                    );
                }
            }
        }
    }

    /// The frame deadline to arm, unless it is the one already armed.
    fn deadline_to_arm(&mut self) -> Option<u64> {
        let at = self.decoder.frame_deadline_ns()?;
        if self.armed_ns == Some(at) {
            return None;
        }
        self.armed_ns = Some(at);
        Some(at)
    }
}

/// The core's wakes, for a handle table that schedules through the
/// package's [`P2Pads`]: what [`SerialLevelBridge`] and the smart-pin pump
/// arm their wakes through.
struct PadWakes(P2Pads);

impl WakeGate for PadWakes {
    fn on_wake_ns(&self, handler: WakeHandler) {
        let handler = Mutex::new(handler);
        self.0
            .on_wake_ns(move |now| (handler.lock().expect("wake handler never poisoned"))(now));
    }

    fn schedule_at_ns(&self, at_ns: u64) {
        self.0.schedule_at_ns(at_ns);
    }

    fn schedule_every_ns(&self, period_ns: u64) {
        tracing::warn!(
            period_ns,
            "p2iss: a periodic wake inside the P2 package is not available; dropped"
        );
    }
}

/// The bus, as a core inside the package.
impl NetPins {
    /// Put every pad the guest changed on its net, at the strength its mode
    /// word configured and high at its bank's supply.
    pub(crate) fn publish_pads(&mut self) {
        if self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        let Some(core) = self.core.as_mut() else {
            return;
        };
        let mut changed = false;
        for pin in 0..64u8 {
            let i = usize::from(pin);
            if core.owned & (1u64 << i) != 0 {
                continue;
            }
            let smart = self.inner.pins[i];
            let mut level = self.inner.output_level(pin);
            // An asynchronous transmit pin the guest has enabled marks its
            // line from the moment it drives: the smart pin idles high, and
            // a receiver needs that mark to find the first start bit.
            if level.is_some() && smart.mode() == PinMode::AsyncTx {
                level = Some(true);
            }
            let key = (level, smart.cfg);
            if core.keys[i] == Some(key) {
                continue;
            }
            core.keys[i] = Some(key);
            let drive = level.and_then(|out| core.drive_of(pin, smart.cfg, out));
            if core.published[i] == Some(drive) {
                continue;
            }
            match drive {
                Some(drive) => core.handles[i].drive(Drive::Thevenin(drive)),
                None => core.handles[i].release(),
            }
            core.published[i] = Some(drive);
            changed = true;
        }
        if changed {
            let strong = core.strong_mask();
            self.inner.set_strong_mask(strong);
            // A pad changed: the guest yields before it reads any net back,
            // so whatever is on that net can answer first.
            self.net_yield = true;
        }
    }

    /// Take ownership of pad `pin` for a bridge or a train, or hand it back
    /// to the publish.
    fn set_owned(&mut self, pin: u8, owned: bool) {
        let Some(core) = self.core.as_mut() else {
            return;
        };
        let bit = 1u64 << (pin & 63);
        if owned {
            core.owned |= bit;
        } else if core.owned & bit != 0 {
            core.owned &= !bit;
            // Whatever the bridge or train left on the pad is unknown here.
            core.keys[usize::from(pin & 63)] = None;
            core.published[usize::from(pin & 63)] = None;
        }
        let strong = core.strong_mask();
        self.inner.set_strong_mask(strong);
    }

    /// A `WRPIN` on a core's pad: a pin leaving a train or a transmit mode
    /// goes back to the publish, and a receive pin gets its deframer.
    pub(crate) fn core_wrpin(&mut self, pin: u8, cfg: u32) {
        let p = pin & 63;
        let mode = self.inner.pins[usize::from(p)].mode();
        // A train stopped by `_pinclear` banks its count and keeps its pad
        // resting at the low phase; any other mode takes the pad back.
        let train = self
            .shared
            .pulse
            .lock()
            .expect("pulse map never poisoned")
            .get(&p)
            .cloned();
        if let Some(driver) = train {
            if !matches!(mode, PinMode::Transition | PinMode::NcoFreq) {
                driver.stop(virtual_clock::virtual_ns());
                if cfg != 0 {
                    self.shared
                        .pulse
                        .lock()
                        .expect("pulse map never poisoned")
                        .remove(&p);
                    self.set_owned(p, false);
                }
            }
        }
        if mode != PinMode::AsyncTx {
            let removed = self
                .shared
                .tx
                .lock()
                .expect("tx map never poisoned")
                .remove(&p)
                .is_some();
            if removed {
                self.set_owned(p, false);
            }
        }
        self.retune_rx(p);
        self.publish_pads();
    }

    /// Give a receive pin a deframer at the rate the guest programmed, or
    /// take it away from a pin that is no longer one.
    pub(crate) fn retune_rx(&mut self, pin: u8) {
        let p = pin & 63;
        let bit = 1u64 << p;
        let Some(core_shared) = self.core_shared.clone() else {
            return;
        };
        let smart = self.inner.pins[usize::from(p)];
        let mut rx = core_shared.rx.lock().expect("rx map never poisoned");
        if smart.mode() != PinMode::AsyncRx {
            if rx.remove(&p).is_some() {
                core_shared.rx_mask.fetch_and(!bit, Ordering::Relaxed);
            }
            return;
        }
        let clk = self.guest_clk();
        let Some(baud) = smart.baud_hz(clk).filter(|&b| b > 0) else {
            return;
        };
        match rx.get_mut(&p) {
            Some(existing) if existing.baud == baud => {}
            _ => {
                rx.insert(
                    p,
                    CoreRx {
                        decoder: UartDecoder::new(UartFraming::new_8n1(baud)),
                        baud,
                        queue: VecDeque::new(),
                        armed_ns: None,
                    },
                );
                core_shared.rx_mask.fetch_or(bit, Ordering::Relaxed);
            }
        }
    }

    /// A `WYPIN` on a core's pad that is not a sync-serial pin.
    pub(crate) fn core_wypin(&mut self, pin: u8, y: u32) {
        let p = pin & 63;
        let smart = self.inner.pins[usize::from(p)];
        match smart.mode() {
            PinMode::Transition | PinMode::NcoFreq if smart.output_enabled() => {
                self.ensure_train(p);
                self.start_pulse(p, y);
                self.inner.wypin(p, y);
            }
            PinMode::AsyncTx => self.core_transmit(p, y),
            _ => self.inner.wypin(p, y),
        }
    }

    /// A step train on pad `pin`, driving through the pad's own ports.
    fn ensure_train(&mut self, pin: u8) {
        if self
            .shared
            .pulse
            .lock()
            .expect("pulse map never poisoned")
            .contains_key(&pin)
        {
            return;
        }
        let cfg = self.inner.pins[usize::from(pin)].cfg;
        let Some(core) = self.core.as_mut() else {
            return;
        };
        let (Some(hi), Some(lo)) = (
            core.drive_of(pin, cfg, true),
            core.drive_of(pin, cfg, false),
        ) else {
            tracing::warn!(
                pin,
                "p2iss: a step train on a pad whose bank has no supply presents nothing"
            );
            return;
        };
        let handle = core.handles[usize::from(pin)].clone();
        self.shared
            .pulse
            .lock()
            .expect("pulse map never poisoned")
            .insert(pin, Arc::new(PulseDriver::with_ports(pin, handle, hi, lo)));
        self.set_owned(pin, true);
    }

    /// One byte on an asynchronous transmit pin: framed at the rate the
    /// pin's bit period and the guest's clock give, through the pad's ports.
    fn core_transmit(&mut self, pin: u8, y: u32) {
        if pin == DEBUG_TX {
            // The console tap: every byte the guest hands its debug pin,
            // whatever the wire then makes of it.
            self.inner.console.push(y as u8);
        }
        if self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        let Some(io) = self.io.clone() else {
            return;
        };
        let clk = self.guest_clk();
        let Some(baud) = self.inner.baud_of(pin, clk).filter(|&b| b > 0) else {
            tracing::debug!(
                pin,
                "p2iss: a byte on a transmit pin with no bit period; dropped"
            );
            return;
        };
        let cfg = self.inner.pins[usize::from(pin)].cfg;
        let fresh = {
            let tx = self.shared.tx.lock().expect("tx map never poisoned");
            match tx.get(&pin) {
                None => true,
                // A new rate takes the line once the old one is quiet.
                Some(link) => link.baud_hz != baud && link.bridge.tx_idle(),
            }
        };
        if fresh {
            let Some(core) = self.core.as_ref() else {
                return;
            };
            let banks = core.banks.clone();
            let handle = core.handles[usize::from(pin)].clone();
            let bridge = SerialLevelBridge::new(
                UartFraming::new_8n1(baud),
                handle,
                io,
                Arc::clone(&self.shutdown),
            )
            .with_ports(move |level| {
                match banks.pad_drive(pin, cfg, true, level == Level::High) {
                    PadDrive::Thevenin(drive) => Some(drive),
                    PadDrive::Released | PadDrive::CurrentSource(_) => None,
                }
            });
            bridge.idle();
            self.shared
                .tx
                .lock()
                .expect("tx map never poisoned")
                .insert(
                    pin,
                    TxLink {
                        bridge: Arc::new(bridge),
                        baud_hz: baud,
                    },
                );
            self.set_owned(pin, true);
        }
        self.shared.tx_bytes.fetch_add(1, Ordering::Relaxed);
        if let Some(link) = self
            .shared
            .tx
            .lock()
            .expect("tx map never poisoned")
            .get(&pin)
        {
            link.bridge.transmit(&[y as u8]);
        }
    }

    /// `RDPIN` on a receive pin: its oldest byte in bits 31:24, where an
    /// async-RX smart pin leaves it. `None` for a pin that is not one.
    pub(crate) fn core_rdpin(&mut self, pin: u8) -> Option<(u32, bool)> {
        let core_shared = self.core_shared.as_ref()?;
        if core_shared.rx_mask.load(Ordering::Relaxed) & (1u64 << (pin & 63)) == 0 {
            return None;
        }
        let mut rx = core_shared.rx.lock().expect("rx map never poisoned");
        let byte = rx.get_mut(&(pin & 63))?.queue.pop_front();
        Some((byte.map_or(0, |b| u32::from(b) << 24), false))
    }

    /// `TESTP` on a receive pin: a byte is waiting. The autobaud pins `P0`
    /// and `P1` read the programming UART's (`P63`) when they are no
    /// receive pins of their own, as the ROM's `SETSE1` measurement expects.
    pub(crate) fn core_testp(&self, pin: u8) -> Option<bool> {
        let core_shared = self.core_shared.as_ref()?;
        let mask = core_shared.rx_mask.load(Ordering::Relaxed);
        let waiting = |p: u8| {
            core_shared
                .rx
                .lock()
                .expect("rx map never poisoned")
                .get(&p)
                .is_some_and(|rx| !rx.queue.is_empty())
        };
        let p = pin & 63;
        if mask & (1u64 << p) != 0 {
            return Some(waiting(p));
        }
        if (p == 0 || p == 1) && mask & (1u64 << 63) != 0 && waiting(63) {
            return Some(true);
        }
        None
    }
}

/// The P2 instruction-set simulator as the core of a P2 package.
///
/// It boots the way silicon does: the 16 KB boot ROM at the top of hub,
/// cog 0 running it, and everything else arriving over the pads — on the
/// P2-EC32MB, stage-1 and the program off the module's flash, as the
/// module's `S301` straps say. There is no way to put a program straight
/// into hub RAM.
pub struct P2IssCore {
    shared: Arc<Shared>,
    core_shared: Arc<CoreShared>,
    machine: Arc<Mutex<Machine<NetPins>>>,
    shutdown: Arc<AtomicBool>,
}

impl std::fmt::Debug for P2IssCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("P2IssCore").finish_non_exhaustive()
    }
}

impl P2IssCore {
    /// A chip with nothing in hub but `rom`, the boot ROM, cog 0 running it
    /// from its first long.
    pub fn with_boot_rom(rom: &[u8]) -> Self {
        let shutdown = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let core_shared = Arc::new(CoreShared::default());
        let mut board = Board::new(SdCard::blank(0));
        // The flash and the card are the board's, on the nets: the bus pumps
        // the synchronous-serial smart pins over virtual time.
        board.enable_smart_bus();
        let mut bus = NetPins::new(board, Vec::new(), Arc::clone(&shared));
        bus.shutdown = Arc::clone(&shutdown);
        bus.core_shared = Some(Arc::clone(&core_shared));
        let mut machine = Machine::with_boot_rom(rom, bus);
        // A clock word ends the pass, so the guest is retimed before it runs
        // on at the new rate.
        machine.yield_on_clock_word = true;
        Self {
            shared,
            core_shared,
            machine: Arc::new(Mutex::new(machine)),
            shutdown,
        }
    }

    /// A view that outlives handing this core to a package and a `System`.
    pub fn handle(&self) -> P2IssHandle {
        P2IssHandle {
            shared: Arc::clone(&self.shared),
            machine: Arc::clone(&self.machine),
            core: Some(Arc::clone(&self.core_shared)),
        }
    }
}

impl Drop for P2IssCore {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
    }
}

impl P2Core for P2IssCore {
    fn attach(&mut self, pads: P2Pads) -> Result<(), AttachError> {
        // Every pad: its handle, and a handle table over all 64 whose wakes
        // go through the package, for the bridges and the pump.
        let mut entries = Vec::with_capacity(64);
        let mut handles = Vec::with_capacity(64);
        for pin in 0..64u8 {
            let handle = pads.pad(pin)?;
            entries.push((pin_name(pin).to_string(), handle.clone()));
            handles.push(handle);
        }
        let io =
            ComponentNetIo::from_entries(entries).with_wake_gate(Arc::new(PadWakes(pads.clone())));
        {
            let mut machine = self.machine.lock().expect("machine never poisoned");
            machine.pins.io = Some(io);
            machine.pins.core = Some(Box::new(CorePads::new(pads.bank_supplies(), handles)));
        }

        // Every pad reads its net: the guest may test any of them. A sense
        // with no level — a floating or fought net, a voltage in the pad's
        // dead band — holds the last level rather than inventing one.
        for pin in 0..64u8 {
            let shared = Arc::clone(&self.shared);
            let core_shared = Arc::clone(&self.core_shared);
            let shutdown = Arc::clone(&self.shutdown);
            let arm = pads.clone();
            let bit = 1u64 << pin;
            pads.on_pad_sense(pin, move |level| {
                if shutdown.load(Ordering::Relaxed) {
                    return;
                }
                let Some(level) = level else {
                    return;
                };
                {
                    let mut queue = shared.edges.lock().expect("edge queue never poisoned");
                    if queue.len() >= EDGE_QUEUE_MAX {
                        shared.edges_dropped.fetch_add(1, Ordering::Relaxed);
                    } else {
                        queue.push_back((pin, level == Level::High));
                    }
                }
                if core_shared.rx_mask.load(Ordering::Relaxed) & bit == 0 {
                    return;
                }
                let now = virtual_clock::virtual_ns();
                let deadline = {
                    let mut rx = core_shared.rx.lock().expect("rx map never poisoned");
                    let Some(rx) = rx.get_mut(&pin) else {
                        return;
                    };
                    rx.decoder.on_level(level, now);
                    rx.poll(now, &shared);
                    rx.deadline_to_arm()
                };
                if let Some(at) = deadline {
                    arm.schedule_at_ns(at);
                }
            })?;
        }

        // The crystal is the rate the board delivers on XI. A guest stalled
        // on a clock derived from it runs again when it arrives.
        {
            let core_shared = Arc::clone(&self.core_shared);
            let arm = pads.clone();
            pads.on_crystal(move |hz| {
                core_shared
                    .crystal_hz
                    .store(hz.unwrap_or(0), Ordering::Relaxed);
                if core_shared.stalled.load(Ordering::Relaxed) {
                    arm.schedule_at_ns(virtual_clock::virtual_ns().saturating_add(1));
                }
            });
        }
        // The reset inputs, as information: the package's START gate is what
        // holds the guest on them.
        {
            let core_shared = Arc::clone(&self.core_shared);
            pads.on_reset(move |state| {
                *core_shared.reset.lock().expect("reset never poisoned") = state;
            });
        }

        {
            let machine = Arc::clone(&self.machine);
            let shared = Arc::clone(&self.shared);
            let core_shared = Arc::clone(&self.core_shared);
            let shutdown = Arc::clone(&self.shutdown);
            let arm = pads.clone();
            pads.on_wake_ns(move |now| {
                wake(&machine, &shared, &core_shared, &shutdown, &arm, now);
            });
        }
        // The first wake, at once: the package holds it until its START
        // gate opens, so it lands at the START instant.
        pads.schedule_at_ns(1);
        Ok(())
    }

    /// The START instant: clock 0 is anchored at the current virtual
    /// nanosecond, so the guest's first instruction runs at the instant the
    /// chip could.
    fn start(&mut self) {
        let now = virtual_clock::virtual_ns();
        if let Some(core) = self
            .machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .core
            .as_mut()
        {
            core.clock.anchor(now);
        }
        *self
            .core_shared
            .started_at_ns
            .lock()
            .expect("start never poisoned") = Some(now);
        tracing::info!(
            start_ns = now,
            "p2iss: START; the guest's clock counts from here"
        );
    }

    /// Held by the package — a brownout without a reset: the guest runs no
    /// further, and its pads keep what they last published.
    fn reset(&mut self) {
        self.core_shared.held.store(true, Ordering::Relaxed);
        tracing::info!("p2iss: held by the package; the guest runs no further");
    }
}

/// One wake of the core: run the guest to the engine's instant, then pace
/// the wire.
fn wake(
    machine: &Mutex<Machine<NetPins>>,
    shared: &Shared,
    core_shared: &CoreShared,
    shutdown: &AtomicBool,
    arm: &P2Pads,
    now: u64,
) {
    if shutdown.load(Ordering::Relaxed) || core_shared.held.load(Ordering::Relaxed) {
        return;
    }
    {
        let mut machine = machine.lock().expect("machine never poisoned");
        drain_edges(&mut machine, shared);
        let clocks = machine.system_clocks();
        let crystal = core_shared.crystal();
        let Some(core) = machine.pins.core.as_mut() else {
            return;
        };
        core.clock.set_crystal(crystal, clocks, now);
        if core.clock.stalled {
            // No clock, no instructions; the crystal's arrival re-arms.
            core_shared.stalled.store(true, Ordering::Relaxed);
            return;
        }
        core_shared.stalled.store(false, Ordering::Relaxed);
        if core.follow_supplies() {
            machine.pins.publish_pads();
        }
        let horizon = machine
            .pins
            .core
            .as_ref()
            .map_or(0, |core| core.clock.ns_to_clocks_ceil(now));
        if let Err(trap) = machine.step_until_clocks(horizon) {
            tracing::error!(%trap, "p2iss: the guest trapped; it will not run again");
            *shared.trap.lock().expect("trap slot never poisoned") = Some(trap.to_string());
            shutdown.store(true, Ordering::Relaxed);
            return;
        }
        let mut retimed = false;
        if let Some((word, at)) = machine.take_clock_word() {
            // The package's XI mode follows the word, and answers with the
            // crystal before this returns.
            arm.set_clock_mode(word);
            let crystal = core_shared.crystal();
            if let Some(core) = machine.pins.core.as_mut() {
                core.clock.set_word(word, at, crystal, now);
                core_shared
                    .stalled
                    .store(core.clock.stalled, Ordering::Relaxed);
            }
            retimed = true;
        }
        if let Some(core) = machine.pins.core.as_ref() {
            shared.guest_now_ns.store(
                core.clock.clocks_to_ns(machine.system_clocks()),
                Ordering::Relaxed,
            );
            core_shared
                .clock_hz
                .store(core.clock.hz(), Ordering::Relaxed);
            core_shared
                .clock_set_at_ns
                .store(core.clock.set_at_ns(), Ordering::Relaxed);
        }
        let stalled = core_shared.stalled.load(Ordering::Relaxed);
        let running = machine.cogs.iter().any(|c| c.running);
        if running && !stalled && (retimed || machine.system_clocks() < horizon) {
            // Short of the instant: the guest drove a pad (the net resolves
            // first) or set its clock (the horizon is read again at the new
            // rate). Go on at this instant.
            shared.net_yields.fetch_add(1, Ordering::Relaxed);
            arm.schedule_at_ns(now);
        }
        // The synchronous-serial pump: one clock edge if a burst is running,
        // with the freshest input on the receive pin.
        drain_edges(&mut machine, shared);
        if let Some(at) = machine.pins.service_smart_clock(now) {
            arm.schedule_at_ns(at);
        }
    }
    // Every live transmit bridge clocks its own next bit and arms its own
    // next wake.
    {
        let tx = shared.tx.lock().expect("tx map never poisoned");
        for link in tx.values() {
            let _ = link.bridge.service(now);
        }
    }
    // Close any receive frame whose tail carried no transition.
    let deadlines: Vec<u64> = {
        let mut rx = core_shared.rx.lock().expect("rx map never poisoned");
        rx.values_mut()
            .filter_map(|rx| {
                rx.poll(now, shared);
                rx.deadline_to_arm()
            })
            .collect()
    };
    for at in deadlines {
        arm.schedule_at_ns(at);
    }
    // The idle cadence: one slice wake on the wheel at a time.
    let mut next = core_shared
        .next_slice_ns
        .lock()
        .expect("slice never poisoned");
    if next.is_none_or(|at| at <= now) {
        let at = now.saturating_add(SLICE_NS);
        *next = Some(at);
        arm.schedule_at_ns(at);
    }
}

/// Replay every transition the nets resolved since the last look, in order,
/// before the guest reads a pin.
fn drain_edges(machine: &mut Machine<NetPins>, shared: &Shared) {
    let mut queue = shared.edges.lock().expect("edge queue never poisoned");
    for (pin, level) in queue.drain(..) {
        machine.pins.inner.set_input_level(pin, level);
    }
}

impl P2IssHandle {
    /// The START instant the package started the core at, once it has; for
    /// a [`crate::P2Iss`], always `None`.
    pub fn started_at_ns(&self) -> Option<u64> {
        let core = self.core.as_ref()?;
        *core.started_at_ns.lock().expect("start never poisoned")
    }

    /// The crystal the package last delivered on `XI`, for a core.
    pub fn crystal_hz(&self) -> Option<u64> {
        self.core.as_ref()?.crystal()
    }

    /// The rate the guest's clock runs at, by its clock word and the
    /// crystal, as of the last wake: for a core, once it has run. A
    /// [`crate::P2Iss`] reports `None` (it times the guest from hub `$14`).
    pub fn clock_hz(&self) -> Option<u64> {
        let hz = self.core.as_ref()?.clock_hz.load(Ordering::Relaxed);
        (hz != 0).then_some(hz)
    }

    /// The virtual instant the guest's current clock rate took effect: its
    /// last clock word's, or the START instant before its first. For a
    /// core, once it has run.
    pub fn clock_set_at_ns(&self) -> Option<u64> {
        self.clock_hz()?;
        Some(self.core.as_ref()?.clock_set_at_ns.load(Ordering::Relaxed))
    }

    /// Whether the guest has no clock: its clock word selects a source that
    /// does not run, or a crystal that does not reach `XI`.
    pub fn stalled(&self) -> bool {
        self.core
            .as_ref()
            .is_some_and(|core| core.stalled.load(Ordering::Relaxed))
    }

    /// Whether the package held the core (a brownout without a reset).
    pub fn held(&self) -> bool {
        self.core
            .as_ref()
            .is_some_and(|core| core.held.load(Ordering::Relaxed))
    }

    /// The reset inputs as the package last delivered them, for a core.
    pub fn reset(&self) -> Option<P2ResetState> {
        let core = self.core.as_ref()?;
        Some(*core.reset.lock().expect("reset never poisoned"))
    }

    /// The trap that stopped the guest, if one has.
    pub fn trap(&self) -> Option<String> {
        self.shared
            .trap
            .lock()
            .expect("trap slot never poisoned")
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibes_behaviour::{behaviour, expect, Test};

    /// flexspin's 160 MHz word for a 20 MHz crystal: `%CC` = `%10`, the PLL
    /// on, `D` 0, `M` 7, the VCO direct.
    const PLL_160: u32 = 0x0100_07FB;

    #[test]
    fn the_pll_multiplies_the_crystal() {
        behaviour!(Test {
            id: "p2iss.clock-pll-from-crystal",
            covers: Some("SIL/p2iss/src/package.rs#clock_hz"),
            given: "a clock word that selects the PLL with the crystal input and the PLL on, \
                    multiplying by eight with no divider, and a 20 MHz crystal on XI",
        });
        expect!(
            "rate",
            "the chip's clock is 160 MHz, eight times the crystal"
        );
        expect!(
            "rc-with-the-same-settings",
            "the same word selecting the RC oscillator runs the chip at 20 MHz with no crystal \
             at all"
        );
        assert_eq!(clock_hz(PLL_160, Some(20_000_000)), Some(160_000_000));
        assert_eq!(clock_hz(PLL_160 & !0b11, None), Some(RCFAST_HZ));
    }

    #[test]
    fn a_pll_with_no_crystal_has_no_clock() {
        behaviour!(Test {
            id: "p2iss.clock-pll-without-crystal",
            covers: Some("SIL/p2iss/src/package.rs#clock_hz"),
            given: "a clock word that selects the PLL with the crystal input on, while nothing \
                    reaches XI",
        });
        expect!(
            "no-clock",
            "the chip has no clock, so the guest runs no instructions"
        );
        assert_eq!(clock_hz(PLL_160, None), None);
    }

    #[test]
    fn a_word_whose_source_does_not_run_has_no_clock() {
        behaviour!(Test {
            id: "p2iss.clock-xi-off",
            covers: Some("SIL/p2iss/src/package.rs#clock_hz"),
            given: "a clock word that selects the PLL while it leaves the crystal input off, \
                    with a 20 MHz crystal on XI",
        });
        expect!(
            "no-clock",
            "the chip has no clock: the datasheet runs the PLL only with the crystal input on"
        );
        // %SS = PLL with %CC = %00: XI is ignored.
        assert_eq!(clock_hz(0x0100_07F3, Some(20_000_000)), None);
    }

    #[test]
    fn the_clock_map_counts_from_the_start_instant_and_each_word() {
        behaviour!(Test {
            id: "p2iss.clock-map",
            covers: Some("SIL/p2iss/src/package.rs#GuestClock"),
            given: "a chip started at 5.5 ms on its 20 MHz RC oscillator, whose program switches \
                    to the 160 MHz PLL once 200 000 clocks have run",
        });
        expect!(
            "from-start",
            "clock count zero is the start instant, and each clock before the switch lasts 50 ns"
        );
        expect!(
            "after-switch",
            "the switch takes effect at the instant its clock count was reached, 15.5 ms, and \
             each clock after it lasts 6.25 ns"
        );
        let mut clock = GuestClock::new();
        clock.anchor(5_500_000);
        // 20 MHz: a clock is 50 ns.
        assert_eq!(clock.clocks_to_ns(0), 5_500_000);
        assert_eq!(clock.clocks_to_ns(20), 5_501_000);
        assert_eq!(clock.ns_to_clocks_ceil(5_501_000), 20);
        clock.set_word(PLL_160, 200_000, Some(20_000_000), 0);
        assert_eq!(clock.hz(), 160_000_000);
        // 200 000 clocks at 20 MHz is 10 ms; 160 clocks at 160 MHz is 1 µs.
        assert_eq!(clock.clocks_to_ns(200_000), 15_500_000);
        assert_eq!(clock.clocks_to_ns(200_160), 15_501_000);
        assert_eq!(clock.ns_to_clocks_ceil(15_501_000), 200_160);
    }
}
