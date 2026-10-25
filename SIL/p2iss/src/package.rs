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
//! | `P_ASYNC_RX` | read by a deframer at the rate its bit period and the guest's clock give; the pin holds one byte (below, "Receive") |
//! | `P_TRANSITION` or `P_NCO_FREQ` with `P_OE` | a step train, one periodic drive per rate change ([`crate::pulse`]); a `WRPIN` to any other mode banks its count and hands the pad back to the word, so `_pinclear` (`DIRL`, `WRPIN #0`) releases it |
//! | `P_PULSE` and the sync-serial modes, `DIR` set | the synchronous-serial hardware ([`p2core::SmartBus`]), clocked on the guest's own clock, so the module's flash and card share `P58`–`P61` as they do on the board; with `DIR` clear, or once the word is cleared, released |
//!
//! A pad whose published drive is strong (under [`WEAK_DRIVE_OHMS`]) reads
//! its own `OUT`; every other pad reads its net (`p2core::Board::sensed`,
//! the strong-mask rule). Nothing straps a pin from here: the board's
//! resistors and switches do (`S301` on the P2-EC32MB).
//!
//! Two known gaps. The pads ignore `P_INVERT_OUTPUT` in a logic-mode word
//! (`BankSupplies::pad_drive` reads only the drive fields), so the 15 kΩ
//! pull-up flexspin's `sdmm.cc` sets on the card's data-out pin, `OUT` low
//! and inverted, presents as a pull-down; the sync-serial clock's own
//! inversion is the bus model's and is right. And `TESTP` on `P0` or `P1`
//! reads "a byte is waiting on `P63`" while neither is a receive pin of its
//! own, which is what the ROM's serial loader measures its autobaud with:
//! the pins' measurement modes are not modelled, so the serial boot inside
//! the package rests on that shortcut until they are.
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
//! # Time: the guest leads, and each change waits for its own instant
//!
//! A wake runs the guest forward from its own clock, at most [`SLICE_NS`]
//! past the engine's instant, the cogs in the order of their clocks. The
//! moment an instruction does something outside the chip — drives or
//! releases a pad, writes a pin's mode word, hands a byte to a transmit pin,
//! starts or stops a step train, sets the clock — the pass ends after that
//! instruction, and what it did waits, as a batch, for the instant the
//! instruction ran at: the clock count of its cog once it had run, through
//! the clock map. The wake that lands on that instant carries it out, so
//! every change is stamped at the guest's own instant and never at a
//! wake's (embsim `DESIGN.md` rule 3), and arms the next wake at the same
//! instant, so the engine resolves what the change drove, and delivers any
//! answer (a flash presenting its next bit), before the guest runs on.
//! Two wakes a change: the boot's flash clock, an edge every few hundred
//! nanoseconds, lands each edge on a nanosecond of its own.
//!
//! The synchronous-serial clock is the guest's too: its next edge is a
//! clock count the pass stops at, and the edge is carried out at its
//! instant like any other change. What the nets present comes the other
//! way at the instant they resolve, so a guest that runs ahead reads a
//! change up to one slice late; a guest that drives a pad and reads the
//! answer back reads it before its next instruction.
//!
//! # Receive: one byte, landed in the guest's present
//!
//! An asynchronous receive pin holds one byte, as silicon's does
//! ([`crate::RxPin`]): a byte lands in `Z` and raises `IN`, `RDPIN` or
//! `AKPIN` lowers `IN`, and a byte that lands while the last is unread
//! overwrites it, counted ([`P2IssHandle::rx_overruns`]). At 2 Mbaud and
//! 160 MHz the next byte comes 800 clocks after the last.
//!
//! *When* a byte lands is this route's own question, because the guest
//! leads. The deframer closes a frame at the engine's instant, and by then
//! the guest has usually run past it, by up to a slice. Landing each byte at
//! the instant its frame closed would put it in the guest's past: a burst
//! that came in while the guest was ahead would land all at once when the
//! guest next looks, every byte but the last overwritten — overruns no
//! receiver could have avoided. Serving them from a queue, as this route
//! once did, hides the overruns a slow receiver does have. So a byte whose
//! frame closed at `t` lands at:
//!
//! - when the byte before it has been read (or there is none): `t`, or the
//!   guest's present if the guest is past `t`;
//! - while the byte before it is unread (still on its way, or landed and
//!   not read): no closer to that byte than the wire put them — its landing
//!   plus the gap between the two frames — and again not in the guest's
//!   past.
//!
//! The guest's present is where its clock stood at the end of the last wake,
//! the slowest running cog's, through the clock map: it runs on from there
//! once the engine reaches it. So a late burst is shifted whole into the
//! guest's present with the wire's spacing kept, and the shift lasts until
//! the guest has read everything, not the run. An overrun is then the
//! guest's own read gap: a byte it left unread for longer than the next one
//! took on the wire, as on silicon. A guest behind the engine sees every
//! byte at its own instant. The price is latency, at most the guest's lead:
//! a byte read up to a slice late, never one lost or kept that silicon would
//! not.
//!
//! The pin answers `TESTP` and `RDPIN` as of the executing cog's clock
//! ([`PinBus::set_clock`]), and a cog spinning on the pin is not
//! fast-forwarded past a byte landing ([`PinBus::next_pin_change`]).

use std::collections::{BTreeMap, VecDeque};
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
use crate::{pin_name, NetPins, P2IssHandle, RxPin, Shared, TxLink, EDGE_QUEUE_MAX, SLICE_NS};

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

/// Something an instruction did outside the chip, carried out at the
/// instant it ran at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoreOp {
    /// A pad's drive changed (`DIR`, `OUT`, a shifter's first bit): put it
    /// on its net.
    Publish,
    /// A `WRPIN`: the pad plays the role its new mode word gives it.
    Wrpin { pin: u8, cfg: u32 },
    /// A `WXPIN` on a receive pin: its deframer's rate.
    Wxpin { pin: u8 },
    /// A `WYPIN` that starts or retunes a step train, or hands a byte to a
    /// transmit pin.
    Wypin { pin: u8, y: u32 },
    /// A `WYPIN` that starts a burst on the sync-serial clock pin.
    BurstStart,
    /// The clock word a `HUBSET` set, and the clock count it set it at.
    ClockWord { word: u32, at: u64 },
    /// The sync-serial clock's next transition.
    PumpEdge,
}

/// What one instant holds: the ops of one instruction, or one clock edge.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Batch {
    at_ns: u64,
    at_clocks: u64,
    ops: Vec<CoreOp>,
}

/// The sync-serial clock running on the guest's clock: the clock count its
/// next transition falls on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Pump {
    next_edge_clocks: u64,
}

/// What a [`P2IssCore`]'s bus keeps of its pads: the handles, what each
/// was last told, the bank supplies they drive at, the guest's clock, and
/// the changes waiting for their instants.
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
    /// What the instruction now running did outside, in order.
    ops: Vec<CoreOp>,
    /// Changes waiting for their instants, earliest first. The guest does
    /// not run while one waits, so nothing it does next can come before it.
    pending: VecDeque<Batch>,
    /// The sync-serial clock, while a burst runs.
    pump: Option<Pump>,
    /// Pads the guest may have moved since the last publish; a pad whose
    /// key is unknown is published whatever this says.
    dirty: u64,
    /// Every pad may have moved: a `WRPIN` can hand the bus's clock or
    /// transmit role from one pin to another.
    dirty_all: bool,
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
            ops: Vec::new(),
            pending: VecDeque::new(),
            pump: None,
            dirty: 0,
            dirty_all: false,
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
    /// Their deframers and holding registers, in pin order.
    rx: Mutex<BTreeMap<u8, CoreRx>>,
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
    /// The instant of the core's own wake already on the wheel: the next
    /// change's, or where the guest's clock got to.
    own_wake_ns: Mutex<Option<u64>>,
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

    /// Arm the core's own wake at `at`, unless it is the one on the wheel:
    /// one own wake at a time, so a burst of wakes at one instant cannot
    /// multiply it.
    fn arm(&self, pads: &P2Pads, at: u64) {
        {
            let mut own = self.own_wake_ns.lock().expect("own wake never poisoned");
            if *own == Some(at) {
                return;
            }
            *own = Some(at);
        }
        pads.schedule_at_ns(at);
    }

    /// The wake at `now` is under way: an own wake at or before it has been
    /// delivered, and its slot is free.
    fn consume(&self, now: u64) {
        let mut own = self.own_wake_ns.lock().expect("own wake never poisoned");
        if own.is_some_and(|at| at <= now) {
            *own = None;
        }
    }

    /// Bytes receive pin `pin` overwrote before the guest read them.
    pub(crate) fn rx_overruns(&self, pin: u8) -> u64 {
        self.rx
            .lock()
            .expect("rx map never poisoned")
            .get(&(pin & 63))
            .map_or(0, |rx| rx.pin.overruns)
    }
}

/// One receive pin: its deframer at the rate the guest programmed, its
/// holding register, and where the last byte it took off the wire lands.
#[derive(Debug)]
pub(crate) struct CoreRx {
    decoder: UartDecoder,
    baud: u32,
    /// The pin's one byte, and the bytes on their way to it, each stamped
    /// with the instant it lands (module docs, "Receive").
    pin: RxPin,
    /// The last byte sent on its way: the instant its frame closed, and the
    /// instant it lands.
    last: Option<(u64, u64)>,
    /// The frame deadline already on the wheel.
    armed_ns: Option<u64>,
}

impl CoreRx {
    fn new(baud: u32) -> Self {
        Self {
            decoder: UartDecoder::new(UartFraming::new_8n1(baud)),
            baud,
            pin: RxPin::default(),
            last: None,
            armed_ns: None,
        }
    }

    /// Close every frame due at `now_ns`, counting what it took, and send
    /// each byte on its way to the register, the guest's clock standing at
    /// `guest_ns`.
    fn poll(&mut self, now_ns: u64, guest_ns: u64, shared: &Shared) {
        while let Some(frame) = self.decoder.poll(now_ns) {
            match frame {
                Ok(byte) => {
                    shared.rx_bytes.fetch_add(1, Ordering::Relaxed);
                    self.arrive(byte, now_ns, guest_ns);
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

    /// Send `byte`, whose frame closed at `wire_ns`, on its way to the
    /// register, the guest's clock standing at `guest_ns`. Returns the
    /// instant it lands.
    fn arrive(&mut self, byte: u8, wire_ns: u64, guest_ns: u64) -> u64 {
        let at = self.landing_ns(wire_ns, guest_ns);
        self.pin.arriving.push_back((at, byte));
        at
    }

    /// The instant a byte whose frame closed at `wire_ns` lands, the guest's
    /// clock standing at `guest_ns` (module docs, "Receive"): its own
    /// instant or the guest's present, whichever is later, and while the
    /// byte before it is unread, no closer to that byte than the wire put
    /// them.
    fn landing_ns(&mut self, wire_ns: u64, guest_ns: u64) -> u64 {
        // The register as of the guest's present: whatever the guest has
        // run past has landed.
        self.pin.land_until(guest_ns);
        let before_read = self.pin.arriving.is_empty() && !self.pin.waiting;
        let at = match self.last {
            Some((wire, land)) if !before_read => land
                .saturating_add(wire_ns.saturating_sub(wire))
                .max(guest_ns),
            _ => wire_ns.max(guest_ns),
        };
        self.last = Some((wire_ns, at));
        at
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
/// package's [`P2Pads`]: what [`SerialLevelBridge`] arms its bit wakes
/// through. The core's one wake handler serves them all.
struct PadWakes(P2Pads);

impl WakeGate for PadWakes {
    fn on_wake_ns(&self, _handler: WakeHandler) {
        // `P2Pads` holds one handler, the core's, and every wake armed
        // through this table lands on it. A second registration would
        // replace the core's and stop the guest, so it is refused.
        tracing::error!(
            "p2iss: a wake handler registered through the core's pad table was refused; the \
             core's own handler serves every wake armed here"
        );
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
    /// The level pad `pin` presents by the guest's state, or `None` where
    /// it drives nothing. An asynchronous transmit pin the guest has
    /// enabled marks its line from the moment it drives: the smart pin
    /// idles high, and a receiver needs that mark to find the first start
    /// bit.
    fn core_level(&self, pin: u8) -> Option<bool> {
        let level = self.inner.pad_output(pin);
        if level.is_some() && self.inner.pins[usize::from(pin & 63)].mode() == PinMode::AsyncTx {
            return Some(true);
        }
        level
    }

    /// Record something the instruction now running does outside the chip;
    /// the pass ends after it, and it is carried out at its instant.
    pub(crate) fn core_op(&mut self, op: CoreOp) {
        let Some(core) = self.core.as_mut() else {
            return;
        };
        if op == CoreOp::Publish && core.ops.contains(&CoreOp::Publish) {
            return;
        }
        core.ops.push(op);
        self.net_yield = true;
    }

    /// After a write that can move the pads in `pins` (`DIR`, `OUT`, a
    /// shifter's first bit): any of them that would present something new
    /// is a change.
    pub(crate) fn core_note_pads(&mut self, pins: u64) {
        let Some(core) = self.core.as_ref() else {
            return;
        };
        let mut changed = 0u64;
        let mut left = pins & !core.owned;
        while left != 0 {
            let i = left.trailing_zeros() as usize;
            left &= left - 1;
            let pin = i as u8;
            if core.keys[i] != Some((self.core_level(pin), self.inner.pins[i].cfg)) {
                changed |= 1u64 << i;
            }
        }
        if changed != 0 {
            if let Some(core) = self.core.as_mut() {
                core.dirty |= changed;
            }
            self.core_op(CoreOp::Publish);
        }
    }

    /// Put every pad the guest changed on its net, at the strength its mode
    /// word configured and high at its bank's supply. Called at the instant
    /// the change was made.
    pub(crate) fn publish_pads(&mut self) {
        if self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        let Some(core) = self.core.as_mut() else {
            return;
        };
        let mut left = if std::mem::take(&mut core.dirty_all) {
            u64::MAX
        } else {
            let unknown = core
                .keys
                .iter()
                .enumerate()
                .filter(|(_, key)| key.is_none())
                .fold(0u64, |mask, (i, _)| mask | (1u64 << i));
            std::mem::take(&mut core.dirty) | unknown
        };
        core.dirty = 0;
        left &= !core.owned;
        let mut changed = false;
        while left != 0 {
            let i = left.trailing_zeros() as usize;
            left &= left - 1;
            let pin = i as u8;
            let key = (self.core_level(pin), self.inner.pins[i].cfg);
            let Some(core) = self.core.as_mut() else {
                return;
            };
            if core.keys[i] == Some(key) {
                continue;
            }
            core.keys[i] = Some(key);
            let drive = key.0.and_then(|out| core.drive_of(pin, key.1, out));
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
            self.refresh_strong();
        }
    }

    /// Tell the board which pads read their own `OUT`.
    fn refresh_strong(&mut self) {
        if let Some(core) = self.core.as_ref() {
            let strong = core.strong_mask();
            self.inner.set_strong_mask(strong);
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
        self.refresh_strong();
    }

    /// A `WRPIN` on a core's pad, at the instant the guest wrote it: a pin
    /// leaving a train or a transmit mode goes back to the publish, and a
    /// receive pin gets its deframer.
    fn core_wrpin(&mut self, pin: u8, cfg: u32) {
        let p = pin & 63;
        let mode = self.inner.pins[usize::from(p)].mode();
        // A train ends when its pin takes any other mode: the count it ran
        // is banked at this instant, and the pad is the mode word's again,
        // so `_pinclear` (`DIRL`, `WRPIN #0`) releases it and a later `DIR`
        // and `OUT` drive it as a plain pin.
        if !matches!(mode, PinMode::Transition | PinMode::NcoFreq) {
            let train = self
                .shared
                .pulse
                .lock()
                .expect("pulse map never poisoned")
                .remove(&p);
            if let Some(driver) = train {
                tracing::debug!(pin = p, cfg, "p2iss: a step train's pin left its mode");
                driver.stop(virtual_clock::virtual_ns());
                self.set_owned(p, false);
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
    }

    /// A `WXPIN` on a core's pad: a receive pin's bit period is its rate,
    /// from the instant the guest wrote it.
    pub(crate) fn core_wxpin(&mut self, pin: u8) {
        let p = pin & 63;
        let receives = self.inner.pins[usize::from(p)].mode() == PinMode::AsyncRx;
        let had = self
            .core_shared
            .as_ref()
            .is_some_and(|c| c.rx_mask.load(Ordering::Relaxed) & (1u64 << p) != 0);
        if receives || had {
            self.core_op(CoreOp::Wxpin { pin: p });
        }
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
            // A new rate is a new deframer; the register keeps its byte.
            Some(existing) => {
                existing.decoder = UartDecoder::new(UartFraming::new_8n1(baud));
                existing.baud = baud;
                existing.armed_ns = None;
            }
            None => {
                rx.insert(p, CoreRx::new(baud));
                core_shared.rx_mask.fetch_or(bit, Ordering::Relaxed);
            }
        }
    }

    /// A `WYPIN` on a core's pad, as the guest executes it: the smart pin
    /// takes the value at once, and what it does outside waits for the
    /// instruction's instant.
    pub(crate) fn core_wypin(&mut self, pin: u8, y: u32) {
        let p = pin & 63;
        if self.inner.smart_clock_pin() == Some(p) {
            // The clock pin owes `y` more pulses. A burst that is not
            // already running starts from this instruction's clock.
            self.inner.wypin(p, y);
            let idle = self.core.as_ref().is_some_and(|core| core.pump.is_none());
            if idle && self.inner.smart_clock_busy() {
                self.core_op(CoreOp::BurstStart);
            }
            return;
        }
        if self.inner.smart_bus.tx_pin() == Some(p) {
            // Loading the shifter presents its first bit on the pad.
            self.inner.wypin(p, y);
            self.core_note_pads(1u64 << p);
            return;
        }
        let smart = self.inner.pins[usize::from(p)];
        match smart.mode() {
            PinMode::Transition | PinMode::NcoFreq if smart.output_enabled() => {
                self.inner.wypin(p, y);
                self.core_op(CoreOp::Wypin { pin: p, y });
            }
            PinMode::AsyncTx => {
                if p == DEBUG_TX {
                    // The console tap: every byte the guest hands its debug
                    // pin, whatever the wire then makes of it.
                    self.inner.console.push(y as u8);
                }
                self.core_op(CoreOp::Wypin { pin: p, y });
            }
            _ => self.inner.wypin(p, y),
        }
    }

    /// A `WYPIN` on a train or transmit pin, at its instant.
    fn core_wypin_now(&mut self, pin: u8, y: u32) {
        let smart = self.inner.pins[usize::from(pin)];
        match smart.mode() {
            PinMode::Transition | PinMode::NcoFreq if smart.output_enabled() => {
                self.ensure_train(pin);
                self.start_pulse(pin, y);
            }
            PinMode::AsyncTx => self.core_transmit(pin, y),
            _ => {}
        }
    }

    /// Carry out one batch's ops at its instant, then put whatever they
    /// moved on the nets. A clock word is the wake's to apply.
    fn apply_core_ops(&mut self, ops: &[CoreOp], at_clocks: u64) {
        for op in ops {
            match *op {
                CoreOp::Publish | CoreOp::ClockWord { .. } => {}
                CoreOp::Wrpin { pin, cfg } => {
                    self.core_wrpin(pin, cfg);
                    if let Some(core) = self.core.as_mut() {
                        core.dirty_all = true;
                    }
                }
                CoreOp::Wxpin { pin } => self.retune_rx(pin),
                CoreOp::Wypin { pin, y } => self.core_wypin_now(pin, y),
                CoreOp::BurstStart => self.core_burst_start(at_clocks),
                CoreOp::PumpEdge => self.core_pump_edge(),
            }
        }
        self.publish_pads();
    }

    /// Half the sync-serial clock's period, in the guest's clocks: the
    /// clock pin's `X[15:0]` is its period.
    fn half_period_clocks(&self) -> Option<u64> {
        let pin = self.inner.smart_clock_pin()?;
        let x = self.inner.pins[usize::from(pin & 63)].x;
        Some((u64::from(x & 0xFFFF).max(2)) / 2)
    }

    /// A burst starts at clock count `at_clocks`, the `WYPIN`'s: its first
    /// transition comes half a period later.
    fn core_burst_start(&mut self, at_clocks: u64) {
        if !self.inner.smart_clock_busy() {
            return;
        }
        let Some(half) = self.half_period_clocks() else {
            return;
        };
        if let Some(core) = self.core.as_mut() {
            if core.pump.is_none() {
                core.pump = Some(Pump {
                    next_edge_clocks: at_clocks.saturating_add(half),
                });
            }
        }
    }

    /// One transition of the sync-serial clock, at its instant: the bus
    /// samples the receive pin's net as it stands, and the next transition
    /// is half a period on, or the burst is over.
    fn core_pump_edge(&mut self) {
        self.inner.advance_smart_clock();
        let bus = [self.inner.smart_clock_pin(), self.inner.smart_bus.tx_pin()]
            .into_iter()
            .flatten()
            .fold(0u64, |mask, pin| mask | (1u64 << (pin & 63)));
        let next = if self.inner.smart_clock_busy() {
            self.half_period_clocks()
        } else {
            None
        };
        if let Some(core) = self.core.as_mut() {
            core.dirty |= bus;
            core.pump = match (core.pump, next) {
                (Some(pump), Some(half)) => Some(Pump {
                    next_edge_clocks: pump.next_edge_clocks.saturating_add(half),
                }),
                _ => None,
            };
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
    /// pin's bit period and the guest's clock give, through the pad's ports,
    /// from this instant.
    fn core_transmit(&mut self, pin: u8, y: u32) {
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

    /// The virtual instant of the executing cog's clock
    /// ([`PinBus::set_clock`]), through the guest's clock map.
    fn core_now_ns(&self) -> u64 {
        self.core
            .as_ref()
            .map_or(0, |core| core.clock.clocks_to_ns(self.clock))
    }

    /// Run `f` on receive pin `pin`'s register as of the executing cog's
    /// clock: every byte stamped at or before it has landed. `None` for a
    /// pin that is not one.
    fn with_core_rx<T>(&self, pin: u8, f: impl FnOnce(&mut RxPin) -> T) -> Option<T> {
        let core_shared = self.core_shared.as_ref()?;
        let p = pin & 63;
        if core_shared.rx_mask.load(Ordering::Relaxed) & (1u64 << p) == 0 {
            return None;
        }
        let mut rx = core_shared.rx.lock().expect("rx map never poisoned");
        let rx = &mut rx.get_mut(&p)?.pin;
        if !rx.arriving.is_empty() {
            rx.land_until(self.core_now_ns());
        }
        Some(f(rx))
    }

    /// `RDPIN` on a receive pin: `Z`, its byte in bits 31:24, where an
    /// async-RX smart pin leaves it, and `IN` drops; read again with nothing
    /// new, it is the same byte. `None` for a pin that is not one.
    pub(crate) fn core_rdpin(&mut self, pin: u8) -> Option<(u32, bool)> {
        self.with_core_rx(pin, |rx| {
            rx.waiting = false;
            (u32::from(rx.held) << 24, false)
        })
    }

    /// `AKPIN` on a receive pin: `IN` drops. Whether it was one.
    pub(crate) fn core_acknowledge_rx(&self, pin: u8) -> bool {
        self.with_core_rx(pin, |rx| rx.waiting = false).is_some()
    }

    /// The earliest clock after `now` at which a core's receive pin changes
    /// by itself: a byte landing.
    pub(crate) fn core_next_pin_change(&self, now: u64) -> Option<u64> {
        let core = self.core.as_ref()?;
        self.core_shared
            .as_ref()?
            .rx
            .lock()
            .expect("rx map never poisoned")
            .values()
            .filter_map(|rx| rx.pin.arriving.front())
            .map(|&(at, _)| core.clock.ns_to_clocks_ceil(at))
            .filter(|&at| at > now)
            .min()
    }

    /// `TESTP` on a receive pin: a byte is waiting.
    ///
    /// A known gap, kept from [`crate::P2Iss`]: the autobaud pins `P0` and
    /// `P1`, while they are no receive pins of their own, read "a byte is
    /// waiting on `P63`", the programming UART. The ROM's serial loader
    /// measures the host's bit time on them with `SETSE1`; no net and no
    /// mode word gives this reading, and the measurement modes are not
    /// modelled, so a serial boot inside the package rests on it until they
    /// are.
    pub(crate) fn core_testp(&self, pin: u8) -> Option<bool> {
        let p = pin & 63;
        if let Some(waiting) = self.with_core_rx(p, |rx| rx.waiting) {
            return Some(waiting);
        }
        if (p == 0 || p == 1) && self.with_core_rx(63, |rx| rx.waiting) == Some(true) {
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
        // The flash and the card are the board's, on the nets: the bus
        // clocks the synchronous-serial smart pins on the guest's clock.
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
        // go through the package, for the bridges.
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
            // Out of reset every pad is released, so none reads its own
            // `OUT`.
            machine.pins.refresh_strong();
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
                    rx.poll(now, shared.guest_now_ns.load(Ordering::Relaxed), &shared);
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
                    core_shared.arm(&arm, virtual_clock::virtual_ns().saturating_add(1));
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
        self.core_shared.arm(&pads, 1);
        Ok(())
    }

    /// The START instant: clock 0 is anchored at the current virtual
    /// nanosecond, and the package's first wake lands on it, so the guest's
    /// first instruction runs at that instant and every change it makes is
    /// stamped from there.
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

/// One wake of the core: carry out the changes whose instant has come, or
/// run the guest forward to its next one; then pace the wire.
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
    core_shared.consume(now);
    {
        let mut machine = machine.lock().expect("machine never poisoned");
        drain_edges(&mut machine, shared);
        if let Some(next) = advance(&mut machine, shared, core_shared, shutdown, arm, now) {
            core_shared.arm(arm, next);
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
    }
    // Every live transmit bridge clocks its own next bit and arms its own
    // next wake, in pin order.
    {
        let tx = shared.tx.lock().expect("tx map never poisoned");
        for link in tx.values() {
            let _ = link.bridge.service(now);
        }
    }
    // Land every byte the guest has run past, so the overrun count is
    // current and a pin nothing reads holds one byte, not a backlog; then
    // close any receive frame whose tail carried no transition.
    let guest_ns = shared.guest_now_ns.load(Ordering::Relaxed);
    let deadlines: Vec<u64> = {
        let mut rx = core_shared.rx.lock().expect("rx map never poisoned");
        rx.values_mut()
            .filter_map(|rx| {
                rx.pin.land_until(guest_ns);
                rx.poll(now, guest_ns, shared);
                rx.deadline_to_arm()
            })
            .collect()
    };
    for at in deadlines {
        arm.schedule_at_ns(at);
    }
}

/// The guest's side of a wake at `now`. Returns the instant of the core's
/// next own wake, if it needs one.
fn advance(
    machine: &mut Machine<NetPins>,
    shared: &Shared,
    core_shared: &CoreShared,
    shutdown: &AtomicBool,
    arm: &P2Pads,
    now: u64,
) -> Option<u64> {
    let clocks = machine.system_clocks();
    let crystal = core_shared.crystal();
    let core = machine.pins.core.as_mut()?;
    core.clock.set_crystal(crystal, clocks, now);
    if core.follow_supplies() {
        // A bank's supply moved at this instant. Its pads are republished
        // now, unless a change of the guest's is waiting: that one has not
        // happened yet, so the supply's republish goes out with it.
        match core.pending.front_mut() {
            Some(batch) => batch.ops.push(CoreOp::Publish),
            None => machine.pins.publish_pads(),
        }
    }

    // The changes whose instant has come, in order.
    let applied = apply_due(machine, shared, core_shared, arm, now);
    let frontier = machine.system_clocks();
    let running = machine.cogs.iter().any(|c| c.running);
    let core = machine.pins.core.as_mut()?;
    if let Some(batch) = core.pending.front() {
        return Some(batch.at_ns);
    }
    if applied {
        // The engine resolves what they drove, and delivers any answer,
        // before the guest runs on: the next wake, at this same instant.
        return Some(now);
    }

    if core.clock.stalled {
        // No clock, no instructions; the crystal's arrival re-arms.
        core_shared.stalled.store(true, Ordering::Relaxed);
        return None;
    }
    core_shared.stalled.store(false, Ordering::Relaxed);
    if !running {
        return None;
    }
    if let Some(pump) = core.pump {
        if pump.next_edge_clocks <= frontier {
            // Every cog is past the sync-serial clock's next edge (one
            // waiting on a long `WAITX`, say): the edge is a change of its
            // own, at its instant.
            let due = pump.next_edge_clocks;
            core.pending.push_back(Batch {
                at_ns: core.clock.clocks_to_ns(due),
                at_clocks: due,
                ops: vec![CoreOp::PumpEdge],
            });
            return settle(machine, shared, core_shared, arm, now);
        }
    }
    let guest_ns = core.clock.clocks_to_ns(frontier);
    if guest_ns > now {
        // The guest is ahead; it goes on when the engine reaches it.
        return Some(guest_ns);
    }

    // THE GUEST LEADS: from its own clock, at most a slice past the engine,
    // and no further than the sync-serial clock's next edge.
    let mut horizon = core.clock.ns_to_clocks_ceil(now.saturating_add(SLICE_NS));
    if let Some(pump) = core.pump {
        horizon = horizon.min(pump.next_edge_clocks);
    }
    machine.pins.net_yield = false;
    if let Err(trap) = machine.step_until_clocks(horizon) {
        tracing::error!(%trap, "p2iss: the guest trapped; it will not run again");
        *shared.trap.lock().expect("trap slot never poisoned") = Some(trap.to_string());
        shutdown.store(true, Ordering::Relaxed);
        return None;
    }
    let yielded = machine.take_yield_clocks();
    let word = machine.take_clock_word();
    let frontier = machine.system_clocks();
    let core = machine.pins.core.as_mut()?;
    let mut ops = std::mem::take(&mut core.ops);
    if let Some((word, at)) = word {
        ops.push(CoreOp::ClockWord { word, at });
    }
    let op_clocks = (!ops.is_empty()).then(|| yielded.unwrap_or(frontier));
    if let Some(pump) = core.pump {
        // The clock's edge falls before whatever the pass stopped at.
        let due = pump.next_edge_clocks;
        if frontier >= due || op_clocks.is_some_and(|at| at >= due) {
            core.pending.push_back(Batch {
                at_ns: core.clock.clocks_to_ns(due),
                at_clocks: due,
                ops: vec![CoreOp::PumpEdge],
            });
        }
    }
    if let Some(at_clocks) = op_clocks {
        core.pending.push_back(Batch {
            at_ns: core.clock.clocks_to_ns(at_clocks),
            at_clocks,
            ops,
        });
    }
    if core.pending.is_empty() {
        // The horizon, or every cog waiting past it. Strictly forward, so
        // the engine never spins on one instant.
        return Some(core.clock.clocks_to_ns(frontier).max(now.saturating_add(1)));
    }
    settle(machine, shared, core_shared, arm, now)
}

/// The changes just queued: carry out any whose instant is at or before
/// `now` (only a cog that lagged the one ahead of it makes one), and name
/// the next own wake: the next change's instant, or this one again so the
/// engine resolves what was carried out before the guest runs on.
fn settle(
    machine: &mut Machine<NetPins>,
    shared: &Shared,
    core_shared: &CoreShared,
    arm: &P2Pads,
    now: u64,
) -> Option<u64> {
    let applied = apply_due(machine, shared, core_shared, arm, now);
    let core = machine.pins.core.as_mut()?;
    match core.pending.front() {
        Some(batch) => Some(batch.at_ns),
        None if applied => Some(now),
        None => None,
    }
}

/// Carry out every waiting batch whose instant is at or before `now`, in
/// order. Returns whether any was.
fn apply_due(
    machine: &mut Machine<NetPins>,
    shared: &Shared,
    core_shared: &CoreShared,
    arm: &P2Pads,
    now: u64,
) -> bool {
    let mut applied = false;
    loop {
        let Some(core) = machine.pins.core.as_mut() else {
            return applied;
        };
        if core.pending.front().is_none_or(|batch| batch.at_ns > now) {
            return applied;
        }
        let Some(batch) = core.pending.pop_front() else {
            return applied;
        };
        if batch.at_ns < now {
            tracing::trace!(
                at_ns = batch.at_ns,
                now,
                "p2iss: a change carried out after its instant (a cog that lagged)"
            );
        }
        for op in &batch.ops {
            if let CoreOp::ClockWord { word, at } = *op {
                // The package's XI mode follows the word, and answers with
                // the crystal before this returns.
                arm.set_clock_mode(word);
                let crystal = core_shared.crystal();
                core.clock.set_word(word, at, crystal, now);
                core_shared
                    .stalled
                    .store(core.clock.stalled, Ordering::Relaxed);
            }
        }
        machine.pins.apply_core_ops(&batch.ops, batch.at_clocks);
        // Each batch is one stop of the guest for a change outside.
        shared.net_yields.fetch_add(1, Ordering::Relaxed);
        applied = true;
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
        expect!("rate", "the chip runs at 160 MHz");
        assert_eq!(clock_hz(PLL_160, Some(20_000_000)), Some(160_000_000));
    }

    #[test]
    fn the_rc_oscillator_needs_no_crystal() {
        behaviour!(Test {
            id: "p2iss.clock-rc-without-crystal",
            covers: Some("SIL/p2iss/src/package.rs#clock_hz"),
            given: "a clock word that selects the fast RC oscillator, its crystal and PLL \
                    fields set for 160 MHz, while nothing reaches XI",
        });
        expect!(
            "rcfast",
            "the chip runs at the RC oscillator's nominal 20 MHz"
        );
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
        expect!("no-clock", "the chip has no clock");
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

    // ---- Receive: one byte, landed in the guest's present ----

    /// 2 Mbaud: a frame is 5 µs.
    const BYTE_NS: u64 = 5_000;

    /// A receive pin at 2 Mbaud, nothing yet off the wire.
    fn rx() -> CoreRx {
        CoreRx::new(2_000_000)
    }

    /// What the guest reads looking at the pin at `ns`: the byte waiting, if
    /// one is, acknowledged.
    fn read_at(rx: &mut CoreRx, ns: u64) -> Option<u8> {
        rx.pin.land_until(ns);
        std::mem::take(&mut rx.pin.waiting).then_some(rx.pin.held)
    }

    /// Three back-to-back bytes off the wire from 100 µs, while the guest's
    /// clock stands at 150 µs. Returns their landings.
    fn late_burst(rx: &mut CoreRx) -> [u64; 3] {
        let guest = 150_000;
        [0x11, 0x22, 0x33]
            .into_iter()
            .zip(0..)
            .map(|(byte, i)| rx.arrive(byte, 100_000 + i * BYTE_NS, guest))
            .collect::<Vec<_>>()
            .try_into()
            .expect("three bytes")
    }

    #[test]
    fn a_byte_the_guest_has_not_reached_lands_at_its_own_instant() {
        behaviour!(Test {
            id: "p2-package.rx-lands-at-frame-close",
            covers: Some("SIL/p2iss/src/package.rs#CoreRx"),
            given: "a byte coming off the wire into an asynchronous receive pin of the simulated \
                    chip at an instant the chip's program has not yet reached",
        });
        expect!(
            "own-instant",
            "the byte becomes readable at the instant its frame closed"
        );
        let mut rx = rx();
        assert_eq!(rx.arrive(0x55, 10_000, 1_000), 10_000, "own-instant");
    }

    #[test]
    fn a_late_burst_lands_in_the_guests_present_with_its_spacing() {
        behaviour!(Test {
            id: "p2-package.rx-late-burst-keeps-spacing",
            covers: Some("SIL/p2iss/src/package.rs#CoreRx"),
            given: "three back-to-back bytes, 5 microseconds apart, coming off the wire into an \
                    asynchronous receive pin while the simulated chip's program is already 50 \
                    microseconds past the first",
        });
        expect!(
            "first-at-present",
            "the first byte becomes readable at the instant the program has reached",
            "the simulator lets the chip run ahead of the rest of the board, so the program has \
             already run past the instant the byte came off the wire without seeing it, and can \
             only see the byte from where it is"
        );
        expect!(
            "spacing-kept",
            "each later byte becomes readable as long after the one before it as it came off the \
             wire after it"
        );
        let mut rx = rx();
        let [first, second, third] = late_burst(&mut rx);
        assert_eq!(first, 150_000, "first-at-present");
        assert_eq!(
            (second - first, third - second),
            (BYTE_NS, BYTE_NS),
            "spacing-kept"
        );
    }

    #[test]
    fn a_late_burst_read_promptly_loses_nothing() {
        behaviour!(Test {
            id: "p2-package.rx-late-burst-read-promptly",
            covers: Some("SIL/p2iss/src/package.rs#CoreRx"),
            given: "three back-to-back bytes that reached an asynchronous receive pin while the \
                    simulated chip's program was 50 microseconds ahead, each read by the program \
                    within a byte time of becoming readable",
        });
        expect!("all-read", "the program reads all three bytes, in order");
        expect!(
            "none-overwritten",
            "no byte is counted as overwritten",
            "a receiver that keeps up with the wire loses nothing, however far the simulator let \
             the program run ahead"
        );
        let mut rx = rx();
        let landings = late_burst(&mut rx);
        let read: Vec<Option<u8>> = landings
            .iter()
            .map(|&at| read_at(&mut rx, at + 1_000))
            .collect();
        assert_eq!(read, [Some(0x11), Some(0x22), Some(0x33)], "all-read");
        assert_eq!(rx.pin.overruns, 0, "none-overwritten");
    }

    #[test]
    fn a_late_burst_read_late_keeps_only_its_last_byte() {
        behaviour!(Test {
            id: "p2-package.rx-late-burst-read-late",
            covers: Some("SIL/p2iss/src/package.rs#CoreRx"),
            given: "three back-to-back bytes that reached an asynchronous receive pin while the \
                    simulated chip's program was 50 microseconds ahead, read by the program only \
                    once all three have become readable",
        });
        expect!("last-kept", "the program reads the third byte");
        expect!(
            "earlier-overwritten",
            "the first two bytes are counted as overwritten",
            "the pin holds a single byte, so a receiver that leaves it unread for longer than the \
             next byte takes on the wire loses it, as on the chip"
        );
        let mut rx = rx();
        let [.., third] = late_burst(&mut rx);
        assert_eq!(read_at(&mut rx, third + 1_000), Some(0x33), "last-kept");
        assert_eq!(rx.pin.overruns, 2, "earlier-overwritten");
    }

    #[test]
    fn the_delay_of_a_late_burst_ends_once_it_is_read() {
        behaviour!(Test {
            id: "p2-package.rx-delay-ends-when-read",
            covers: Some("SIL/p2iss/src/package.rs#CoreRx"),
            given: "a byte reaching an asynchronous receive pin at an instant the simulated \
                    chip's program has not yet reached, after a burst that became readable 50 \
                    microseconds late and was read in full",
        });
        expect!(
            "own-instant",
            "the byte becomes readable at the instant its frame closed",
            "once every earlier byte is read, a byte that becomes readable sooner can cost the \
             program nothing, so the delay a late burst took on does not outlast it"
        );
        let mut rx = rx();
        for at in late_burst(&mut rx) {
            assert!(read_at(&mut rx, at + 1_000).is_some(), "the burst is read");
        }
        assert_eq!(rx.arrive(0x44, 300_000, 170_000), 300_000, "own-instant");
    }

    #[test]
    fn a_byte_after_an_unread_one_keeps_the_wires_gap() {
        behaviour!(Test {
            id: "p2-package.rx-unread-byte-keeps-gap",
            covers: Some("SIL/p2iss/src/package.rs#CoreRx"),
            given: "a byte reaching an asynchronous receive pin 200 microseconds after one that \
                    became readable 50 microseconds late, while the simulated chip's program ran \
                    ahead, and that the program has not read",
        });
        expect!(
            "gap-kept",
            "the byte becomes readable 200 microseconds after the unread one did",
            "while the earlier byte is unread, the gap between the two decides whether it is \
             overwritten, so the gap is the wire's"
        );
        let mut rx = rx();
        let first = rx.arrive(0x11, 100_000, 150_000);
        assert_eq!(first, 150_000);
        assert_eq!(
            rx.arrive(0x22, 300_000, 160_000) - first,
            200_000,
            "gap-kept"
        );
    }

    // ---- The pins, as the guest's instructions see them ----

    /// `P_ASYNC_RX`.
    const ASYNC_RX: u32 = 0x3E;
    /// `X` for 8-bit frames of 80 clocks a bit: 2 Mbaud at 160 MHz.
    const X_2MBAUD: u32 = 7 | (80 << 16);
    const RX_PIN: u8 = 63;

    /// A core's bus with nothing on its pads, its clock at 160 MHz from
    /// clock count zero at instant zero, so clock `c` is `c * 6.25` ns.
    fn core_pins() -> NetPins {
        let mut bus = NetPins::new(
            Board::new(SdCard::blank(0)),
            Vec::new(),
            Arc::new(Shared::default()),
        );
        bus.core_shared = Some(Arc::new(CoreShared::default()));
        let mut core = CorePads::new(BankSupplies::unpowered(), Vec::new());
        core.clock.set_word(PLL_160, 0, Some(20_000_000), 0);
        bus.core = Some(Box::new(core));
        bus
    }

    #[test]
    fn a_receive_pin_answers_as_of_the_executing_cogs_clock() {
        behaviour!(Test {
            id: "p2-package.rx-answers-at-cog-clock",
            covers: Some("SIL/p2iss/src/package.rs#NetPins::core_testp"),
            given: "a byte on its way to an asynchronous receive pin of the simulated chip, due \
                    to become readable 5 microseconds after the chip started on its 160 MHz clock",
        });
        expect!(
            "hidden-before",
            "an instruction one clock before that instant finds no byte waiting"
        );
        expect!(
            "readable-at",
            "an instruction at that instant finds the byte waiting and reads it from the top \
             eight bits of the pin's result"
        );
        expect!(
            "read-clears",
            "after the read, the pin reports no byte waiting"
        );
        expect!(
            "spin-stops-there",
            "a core spinning on the pin is not skipped past that instant",
            "the simulator skips an idle spin ahead in time, and skipping past the instant the \
             byte becomes readable would carry the core past a byte it would have read"
        );
        let mut bus = core_pins();
        bus.wrpin(RX_PIN, ASYNC_RX);
        bus.wxpin(RX_PIN, X_2MBAUD);
        bus.retune_rx(RX_PIN);
        bus.core_shared
            .as_ref()
            .expect("a core's bus")
            .rx
            .lock()
            .expect("rx map never poisoned")
            .get_mut(&RX_PIN)
            .expect("the pin deframes at its programmed rate")
            .arrive(0x55, 5_000, 0);
        // 5 µs at 160 MHz is clock 800.
        assert_eq!(bus.next_pin_change(0), Some(800), "spin-stops-there");

        bus.set_clock(799);
        assert!(!bus.testp(RX_PIN), "hidden-before");

        bus.set_clock(800);
        assert!(bus.testp(RX_PIN), "readable-at: waiting");
        assert_eq!(
            bus.rdpin(RX_PIN),
            (0x55 << 24, false),
            "readable-at: the byte"
        );

        assert!(!bus.testp(RX_PIN), "read-clears");
    }
}
