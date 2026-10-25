//! The P2 instruction-set simulator as a live board component.
//!
//! [`p2core`] is the CPU: real flexcc-compiled P2 machine code, executed
//! instruction by instruction, with a [`PinBus`] as its only outside edge and
//! no knowledge of nets, harnesses or virtual clocks. This crate is the seam
//! that mounts it on an [`embsim_board`] system, so a *system description*
//! drives the firmware image the machine actually flashes.
//!
//! ```text
//!   embsim engine                 P2Iss                        p2core
//!   ─────────────                 ─────                        ──────
//!   wake(now_ns) ─────────► step_until(now_us) ──────────────► Machine
//!   TX pin  ◄── SerialLevelBridge ◄── wypin(pin, byte) ◄────── smart pin
//!   RX pin ──► on_sense ──► deframe ──► rdpin(pin) ──────────► smart pin
//! ```
//!
//! # Why this is not the native bridge again
//!
//! The native backend has no bit timing. Firmware calls
//! `HAL_serial_transmitData` and a *byte* appears; the board has to synthesise
//! edges from a baud rate it was told by a config table, and a wrong `clkfreq`
//! is invisible because nothing ever computed a bit period from it.
//!
//! The ISS is the opposite. The firmware executes `WRPIN`/`WXPIN`/`WYPIN`
//! against a smart pin, so the bit period is a *decoded* fact
//! ([`p2core::SmartPin::baud_hz`]) rather than a declared one. This adapter
//! frames at the rate the firmware actually programmed, which is why
//! [`P2IssHandle::derived_baud`] is worth asserting on: a wrong `clkfreq` shows
//! up as a wrong rate on the wire instead of as bytes that look fine.
//!
//! The receive side is deliberately *not* symmetric. Its deframer has to exist
//! before the first edge arrives, and at that moment the guest may not have
//! configured the pin, so it runs at the rate the link was declared with. The
//! asymmetry is not a gap: a disagreement between declared and programmed
//! shows up on the transmit side, where the rate *is* derived, and is reported
//! there.
//!
//! # Time
//!
//! The engine is the time authority. Each wake advances the machine to the
//! engine's current instant with [`p2core::Machine::step_until`], so guest
//! time is slaved to virtual time and never runs ahead of it.
//!
//! The cadence is adaptive, and not by design so much as by consequence:
//! [`SLICE_NS`] is only the *idle* rate. Once a link is clocking, its bit
//! wakes land on the same handler, so the guest is stepped at the bit rate —
//! the slice tightens exactly when something is on the wire. In the protocol
//! round trip the guest's clock and the engine's agree to the microsecond.

pub mod flashimage;
pub mod flashnode;
pub mod package;
pub mod pulse;
use crate::pulse::PulseDriver;
pub mod sdimage;
pub mod sdnode;
pub use embsim_board::HostPty;
pub use package::P2IssCore;

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use embsim_board::uart::{UartDecoder, UartFraming};
use embsim_board::{
    digital_drive, AttachError, Component, ComponentNetIo, DeadBand, DigitalReceiver, Drive, Level,
    PinDecl, PinHandle, SerialLevelBridge, Thresholds,
};
use embsim_core::virtual_clock;
use p2core::{Board, Machine, PinBus, PinMode, SdCard};

/// How often the engine advances the guest **while nothing is on the wire**.
///
/// This is the latency between the instruction that writes a byte and the
/// start bit appearing: up to 100 µs, or twenty byte times at 2 Mbaud. It is
/// latency, not distortion — the frame itself is clocked on its own grid once
/// it starts, and a burst written inside one slice queues and clocks out
/// back to back.
///
/// It does not need to be finer, because it is not the cadence that matters.
/// A live bridge arms its own wake per bit on this same component, so while a
/// link is transmitting the guest is stepped every bit period; the slice only
/// governs how long an *idle* machine waits to notice it has something to say.
/// Making it 1 µs costs a hundredfold more wakes through boot — where the
/// guest has 400 ms of virtual time to get through — and buys nothing.
pub const SLICE_NS: u64 = 100_000;

/// How many unread net transitions to hold before dropping them.
///
/// Large enough that a normal slice never reaches it; bounded so a guest that
/// has stopped being stepped cannot exhaust memory.
const EDGE_QUEUE_MAX: usize = 1 << 16;

/// How every pad the ISS carries on a net reads its net: the P2's own input
/// pair, not JESD8C.01's, because the P2's datasheet names one.
///
/// `Vih`, Input Logic Threshold, min `Vxxyy` × 0.3, max `Vxxyy` × 0.7
/// (P2X8C4M64P Datasheet, "System Characteristics" → "DC Characteristics",
/// p. 47): the threshold lies somewhere in that band, so an input at or below
/// 0.3 × `Vxxyy` reads low on every part and one at or above 0.7 × `Vxxyy`
/// high. Made absolute at the 3.3 V the ISS drives its own highs at
/// ([`embsim_board::net::LOGIC_HIGH_VOLTS`], what [`digital_drive`]
/// publishes) — **0.99 V / 2.31 V** — because a [`P2Iss`] sits on no board and
/// declares no bank supply to scale them against. The logic input mode names
/// no hysteresis (the Schmitt modes are a `WRPIN` choice the declaration does
/// not see), so between the two the pad reads no level
/// ([`DeadBand::Unknown`]) and the guest keeps the input bit it has.
///
/// The same figures as `embsim_boards::p2::P2_PAD_THRESHOLDS`, which declares
/// them relative to each pad's `VIO_a_b`; inside the P2 package
/// (`MIGRATING-MAD.md` step 2) the package's relative declaration replaces
/// this one.
pub const P2ISS_PAD: Thresholds = Thresholds::new(
    0.3 * embsim_board::net::LOGIC_HIGH_VOLTS,
    0.7 * embsim_board::net::LOGIC_HIGH_VOLTS,
    0.0,
    DeadBand::Unknown,
);

/// Assumed clock frequency before the guest has recorded its own at hub `$14`.
const NOMINAL_CLKFREQ: u32 = 160_000_000;
/// RC oscillator the boot ROM runs on until a `HUBSET` writes `clkfreq`.
const RC_CLKFREQ: u32 = 20_000_000;

/// One asynchronous serial link the firmware drives, by physical pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SerialLink {
    /// Pin the firmware transmits on (`P_ASYNC_TX`).
    pub tx_pin: u8,
    /// Pin the firmware receives on (`P_ASYNC_RX`).
    pub rx_pin: u8,
    /// The rate the link is *expected* to run at.
    ///
    /// Used only until the guest has configured the pin — after that the
    /// framing comes from the smart pin's own `WXPIN` and the recorded
    /// `clkfreq`, which is the whole point of running an ISS. A disagreement
    /// is reported, not silently accepted.
    pub nominal_baud: u32,
}

/// `"P0"`..`"P63"`. `PinDecl` needs `&'static str`, so they are spelled out.
#[rustfmt::skip]
const PIN_NAMES: [&str; 64] = [
    "P0",  "P1",  "P2",  "P3",  "P4",  "P5",  "P6",  "P7",
    "P8",  "P9",  "P10", "P11", "P12", "P13", "P14", "P15",
    "P16", "P17", "P18", "P19", "P20", "P21", "P22", "P23",
    "P24", "P25", "P26", "P27", "P28", "P29", "P30", "P31",
    "P32", "P33", "P34", "P35", "P36", "P37", "P38", "P39",
    "P40", "P41", "P42", "P43", "P44", "P45", "P46", "P47",
    "P48", "P49", "P50", "P51", "P52", "P53", "P54", "P55",
    "P56", "P57", "P58", "P59", "P60", "P61", "P62", "P63",
];

pub fn pin_name(pin: u8) -> &'static str {
    PIN_NAMES[usize::from(pin) & 63]
}

/// One async-RX smart pin as silicon has it: a single holding register.
///
/// The pin latches each byte into `Z` (bits 31:24) the instant its frame
/// closes and raises `IN`; `RDPIN` or `AKPIN` lowers `IN`. There is no FIFO.
/// The next byte to complete overwrites `Z` whether or not the guest read the
/// last one, so a receiver that leaves the pin unread for longer than a byte
/// time loses bytes, silently — at 2 Mbaud that is 800 clocks at 160 MHz.
///
/// Bytes come off the wire on the engine's clock, which runs ahead of the
/// guest's: a slice deframes them first and executes the guest up to the same
/// instant afterwards. So each byte waits in `arriving`, stamped with the
/// instant its frame closed, and lands in the register only when the clock of
/// the cog looking at the pin reaches that stamp ([`PinBus::set_clock`]). The
/// guest then sees every byte at the instruction it would on silicon, however
/// many bytes one slice delivered.
///
/// Inside the P2 package the guest runs ahead of the engine instead, and a
/// byte's stamp is the instant the package lands it at, not the one its frame
/// closed at (`package.rs`, "Receive: one byte, landed in the guest's
/// present").
#[derive(Debug, Default)]
pub(crate) struct RxPin {
    /// Deframed bytes the guest's clock has not reached yet, oldest first,
    /// each with the virtual nanosecond it lands at.
    pub(crate) arriving: VecDeque<(u64, u8)>,
    /// `Z`'s byte: the last one to land, kept after it is read.
    pub(crate) held: u8,
    /// `IN`: a byte has landed since the last `RDPIN`/`AKPIN`.
    pub(crate) waiting: bool,
    /// Bytes overwritten before the guest read them.
    pub(crate) overruns: u64,
}

impl RxPin {
    /// Land every byte whose stamp is at or before `now_ns`, in order.
    pub(crate) fn land_until(&mut self, now_ns: u64) {
        while let Some(&(at, byte)) = self.arriving.front() {
            if at > now_ns {
                break;
            }
            self.arriving.pop_front();
            if self.waiting {
                self.overruns += 1;
                tracing::debug!(
                    lost = self.held,
                    by = byte,
                    at,
                    "p2iss: receive byte overwritten before the guest read it"
                );
            }
            self.held = byte;
            self.waiting = true;
        }
    }
}

/// A receive pin's register, shared between the engine (which deframes into
/// it) and the guest (which reads it).
type SharedRxPin = Arc<Mutex<RxPin>>;

/// One async-TX smart pin's buffer and shifter, in guest clocks.
///
/// `WYPIN` puts a byte in the buffer; it moves into the shifter as soon as the
/// shifter is free, and `IN` rises then — the signal a driver waits on before
/// its next `WYPIN`. `RDPIN`'s C reads busy until the shifter has sent the
/// last frame. So a driver that writes a burst byte by byte is held for a
/// frame time per byte after the first, as on silicon. The wire itself is
/// clocked by the link's bridge; this only paces the guest.
#[derive(Debug, Default, Clone, Copy)]
struct TxPace {
    /// The clock at which the buffered byte enters the shifter: `IN` rises.
    loaded_at: u64,
    /// The clock at which the shifter has sent everything: busy clears.
    idle_at: u64,
}

/// The transmit half of one link, once the guest has configured its pin.
#[derive(Debug)]
struct TxLink {
    bridge: Arc<SerialLevelBridge>,
    baud_hz: u32,
}

/// Everything the two sides share: the engine writes into it from sense
/// callbacks, the guest reads out of it through [`PinBus`].
#[derive(Debug, Default)]
struct Shared {
    /// Receive pins' holding registers, keyed by pin. Ordered maps, here and
    /// below: the wake walks them, and the order it services pins in must not
    /// depend on a hash (embsim `DESIGN.md` rule 7).
    rx: BTreeMap<u8, SharedRxPin>,
    /// Receive deframers, keyed by pin.
    ///
    /// Shared with the wake handler rather than owned by the sense callback:
    /// a frame whose tail carries no transition closes only on its deadline,
    /// so *something* has to poll. Leaving that to the sense callback alone
    /// silently drops the last byte of every burst.
    rx_decoders: BTreeMap<u8, Arc<Mutex<UartDecoder>>>,
    /// Live transmit bridges, keyed by pin. Built on first transmit, once the
    /// smart pin has been configured and its baud can be derived.
    tx: Mutex<BTreeMap<u8, TxLink>>,
    /// Bytes the guest has handed to a transmit bridge.
    tx_bytes: AtomicU64,
    /// Bytes a receive pin has deframed off the wire.
    rx_bytes: AtomicU64,
    /// Frames a receive pin threw away because they did not deframe.
    ///
    /// A dropped frame is silent to the guest — the byte simply never arrives,
    /// and the driver waiting for it reports a timeout instead of a corruption.
    /// That is a hard failure to diagnose from the firmware side, so count it
    /// here and report it with the byte counts rather than only at `debug`.
    rx_framing_errors: AtomicU64,
    /// Times the guest yielded to let a net pin resolve (diagnostics).
    net_yields: AtomicU64,
    /// The virtual instant the guest's clock had reached at the end of the
    /// last wake: what a handle reads without waiting on the machine.
    guest_now_ns: AtomicU64,
    /// Line feeds the guest has handed its debug pin (`P62`).
    console_lines: AtomicU64,

    /// Net transitions awaiting the guest, oldest first.
    ///
    /// An ordered queue, deliberately, and not a level snapshot. `on_sense`
    /// fires once per resolved change in engine sequence order, but the wake
    /// handler runs at most once a slice — so sampling levels at the wake
    /// would collapse every transition that happened in between. For an
    /// endstop that is invisible. For a quadrature pair it is fatal: the count
    /// *is* the transition history, and two folded edges read as a two-state
    /// jump whose direction cannot be recovered.
    ///
    /// Staged here rather than written straight into [`p2core::Board`] because
    /// sense callbacks and the wake handler both run on the engine thread and
    /// the machine's mutex is not reentrant.
    edges: Mutex<VecDeque<(u8, bool)>>,
    /// Transitions dropped because the queue was full — a guest that has
    /// stopped being stepped. Counted so a test can assert it is zero rather
    /// than silently reading a stale pin.
    edges_dropped: AtomicU64,
    /// Pulse pins driving trains onto nets, keyed by pin. Built at attach,
    /// because a driver needs a facade handle.
    pulse: Mutex<BTreeMap<u8, Arc<PulseDriver>>>,
    /// The trap that stopped the guest, if one has.
    trap: Mutex<Option<String>>,
}

/// A [`PinBus`] that puts the guest's smart-pin traffic on real nets.
///
/// Everything that is not an async serial pin — the SD card's SPI, GPIO, the
/// encoder — is delegated to [`p2core::Board`], which already models it. Only
/// the serial pins are lifted onto the engine.
struct NetPins {
    inner: Board,
    links: Vec<SerialLink>,
    shared: Arc<Shared>,
    /// Filled at attach; `None` on the inert build path, where a transmit is
    /// traced and dropped.
    io: Option<ComponentNetIo>,
    shutdown: Arc<AtomicBool>,
    /// The guest's recorded clock frequency, refreshed each slice.
    ///
    /// [`PinBus`] is called *by* the machine, so it cannot ask the machine for
    /// `clkfreq`; the component reads it out after each slice and stores it
    /// here, where [`NetPins::framing_for`] can derive a rate from it.
    clkfreq: u32,
    /// True when the guest started in the boot ROM (RC oscillator, ~20 MHz)
    /// rather than a flexcc image that already selected the 160 MHz PLL.
    rom_boot: bool,
    /// Pins carried on nets as plain levels — see [`P2Iss::with_level_pins`].
    level_pins: Vec<u8>,
    /// Pins that emit pulse trains — see [`P2Iss::with_pulse_pins`].
    pulse_pins: Vec<u8>,
    /// The clock of the instruction executing now ([`PinBus::set_clock`]).
    clock: u64,
    /// Each link's transmit pacing, by its index in `links`.
    tx_pace: Vec<TxPace>,
    /// Cached facade handles for those pins, filled on first publish.
    /// Pin handles by pin number. An array rather than a map: this is walked
    /// for every pin on every published edge, and an SD sector is 8192 edges —
    /// hashing there showed up as SipHash and malloc traffic in the profile.
    level_handles: [Option<PinHandle>; 64],
    /// The last drive published per level pin, so an unchanged `OUTA` write
    /// does not become an engine event. The firmware writes the output
    /// registers constantly; only transitions are worth resolving.
    /// The level last published per pin, so an unchanged pin costs nothing.
    published: [Option<Option<bool>>; 64],
    /// Set when the guest drove a net pin whose response it may read back, so
    /// [`p2core::Machine::step_until`] yields and the engine can resolve. See
    /// [`PinBus::take_net_yield`].
    net_yield: bool,
    /// Virtual time the next sync-clock edge is due. The pump only advances
    /// when time reaches it, so a burst of same-instant wakes (the yield
    /// re-wakes, the periodic slice) cannot fire several edges at once — which
    /// would collapse on the net and make the device miss transitions.
    next_edge_ns: Option<u64>,
    /// The edge deadline already handed to the wheel, so a second call at
    /// the same instant (a net-yield re-arm) does not arm it again: each
    /// duplicate would fire the whole wake callback once more per edge for
    /// the rest of the burst, and they compound -- a sector read ended with
    /// ~300 callbacks per clock transition.
    armed_edge_ns: Option<u64>,
    /// The pads inside the P2 package, for a [`P2IssCore`]'s bus: every pad
    /// on its net, each playing the role its mode word gives it. `None` for
    /// a [`P2Iss`], whose pin lists say which pins are on nets.
    core: Option<Box<package::CorePads>>,
    /// What a [`P2IssCore`]'s wake, senses and handle share; `None` for a
    /// [`P2Iss`].
    core_shared: Option<Arc<package::CoreShared>>,
}

impl NetPins {
    fn link_for_tx(&self, pin: u8) -> Option<&SerialLink> {
        self.links.iter().find(|l| l.tx_pin == pin)
    }

    fn tx_index(&self, pin: u8) -> Option<usize> {
        self.links.iter().position(|l| l.tx_pin == pin)
    }

    /// The rate [`Machine::now_us`] converts clocks to time at.
    ///
    /// Not [`Self::guest_clk`]: during a ROM boot that reports the RC
    /// oscillator, while the machine keeps converting at whatever hub `$14`
    /// holds. Wire stamps have to be compared on the machine's own scale.
    fn clock_hz(&self) -> u64 {
        match self.clkfreq {
            0 => u64::from(NOMINAL_CLKFREQ),
            f => u64::from(f),
        }
    }

    fn clocks_to_ns(&self, clocks: u64) -> u64 {
        (u128::from(clocks) * 1_000_000_000 / u128::from(self.clock_hz())) as u64
    }

    /// The first clock at or after virtual `ns`.
    fn ns_to_clocks(&self, ns: u64) -> u64 {
        (u128::from(ns) * u128::from(self.clock_hz())).div_ceil(1_000_000_000) as u64
    }

    /// A receive pin's register as of the executing instruction: every byte
    /// whose frame has closed by this clock has landed.
    fn rx_now(&self, pin: u8) -> Option<std::sync::MutexGuard<'_, RxPin>> {
        let rx = self.shared.rx.get(&pin)?;
        let mut rx = rx.lock().expect("rx pin never poisoned");
        if !rx.arriving.is_empty() {
            rx.land_until(self.clocks_to_ns(self.clock));
        }
        Some(rx)
    }

    /// `RDPIN`/`AKPIN` on a receive pin: `IN` drops. True if it was one.
    fn acknowledge_rx(&self, pin: u8) -> bool {
        if self.core_acknowledge_rx(pin) {
            return true;
        }
        match self.rx_now(pin) {
            Some(mut rx) => {
                rx.waiting = false;
                true
            }
            None => false,
        }
    }

    /// Clocks one frame occupies on a transmit pin, as the guest programmed
    /// it: start bit, data bits, stop bit, each `X[31:16]` clocks. Zero until
    /// the pin is an async transmitter, so an unconfigured pin never blocks.
    fn tx_frame_clocks(&self, pin: u8) -> u64 {
        let smart = self.inner.pins[usize::from(pin) & 63];
        if smart.mode() != PinMode::AsyncTx {
            return 0;
        }
        u64::from(smart.frame_bits() + 2) * u64::from(smart.bit_period())
    }

    /// Land every receive byte the whole machine has passed, so the overrun
    /// count is current and a pin nothing reads does not accumulate.
    fn land_rx_until_clock(&self, clocks: u64) {
        let now = self.clocks_to_ns(clocks);
        for rx in self.shared.rx.values() {
            rx.lock().expect("rx pin never poisoned").land_until(now);
        }
    }

    /// The framing this pin is programmed for, or the declared nominal until
    /// the guest has configured it.
    ///
    /// Disagreement is logged rather than corrected: the derived rate is the
    /// truth (it is what the hardware would do), and a mismatch means the
    /// firmware's `clkfreq` or divisor is wrong — which is the class of bug an
    /// ISS exists to find.
    fn framing_for(&self, pin: u8, nominal: u32) -> (UartFraming, u32) {
        let clk = self.guest_clk();
        match self.inner.baud_of(pin, clk) {
            Some(derived) if derived > 0 => {
                if !p2core::baud_matches(derived, nominal, 2.0) {
                    tracing::warn!(
                        pin,
                        derived,
                        nominal,
                        clkfreq = clk,
                        "p2iss: the smart pin is programmed for a rate the link did not expect"
                    );
                }
                (UartFraming::new_8n1(derived), derived)
            }
            _ => (UartFraming::new_8n1(nominal), nominal),
        }
    }

    fn set_clkfreq(&mut self, hz: u32) {
        self.clkfreq = hz;
    }

    fn guest_clk(&self) -> u32 {
        // Inside the package the clock is the one the guest's clock word and
        // the crystal on XI give.
        if let Some(core) = self.core.as_ref() {
            return u32::try_from(core.clock.hz()).unwrap_or(u32::MAX);
        }
        // The ROM fills a base64 table at hub $0, so `$14` is not clkfreq
        // until an application writes it. Stay on the RC oscillator.
        if self.rom_boot {
            return RC_CLKFREQ;
        }
        match self.clkfreq {
            0 => NOMINAL_CLKFREQ,
            f => f,
        }
    }

    /// Begin (or retune) the train `WYPIN` just asked for.
    ///
    /// The mode and half-period are read back out of the smart pin rather than
    /// declared here, for the same reason the serial rate is: `_pinstart`
    /// wrote them, so they are a decoded fact. A firmware that programs the
    /// wrong divisor moves the carriage at the wrong speed *here*, which is
    /// the class of bug the ISS exists to surface.
    fn start_pulse(&mut self, pin: u8, y: u32) {
        let clk = self.guest_clk();
        let smart = self.inner.pins[usize::from(pin) & 63];
        let now = virtual_clock::virtual_ns();
        let map = self.shared.pulse.lock().expect("pulse map never poisoned");
        let Some(driver) = map.get(&pin) else {
            return;
        };
        match smart.mode() {
            PinMode::Transition => {
                driver.start_transitions(now, u64::from(y), smart.x, clk);
            }
            PinMode::NcoFreq => driver.set_nco(now, y, clk),
            other => {
                tracing::debug!(
                    pin,
                    ?other,
                    "p2iss: WYPIN on a pulse pin in an unexpected mode"
                );
            }
        }
    }

    /// Put every level pin's current output on its net, as a voltage.
    ///
    /// Emit one synchronous-serial clock transition, if the firmware has a
    /// burst running, and publish the pins it moved.
    ///
    /// This is the whole of the adapter's bus knowledge: it asks the board
    /// which pin is the clock and whether it is busy, drives one edge, and
    /// lets `publish_levels` put the clock and TX levels on their nets. The
    /// board did the shifting and sampling; the adapter did the timing and the
    /// wire. It never learns "SPI". Returns the virtual time the next edge is
    /// due, or `None` when the burst is finished.
    fn service_smart_clock(&mut self, now_ns: u64) -> Option<u64> {
        // The wake this call is servicing has been delivered, so the slot it
        // occupied is free: without this, a deadline that has already fired
        // could match `armed_edge_ns` and be skipped as "already armed",
        // leaving the burst waiting for a wake nobody holds.
        if self.armed_edge_ns == Some(now_ns) {
            self.armed_edge_ns = None;
        }
        let clk_pin = self.inner.smart_clock_pin()?;
        if !self.inner.smart_clock_busy() {
            self.next_edge_ns = None;
            self.armed_edge_ns = None;
            return None;
        }
        let clk = self.guest_clk();
        let x = self.inner.pins[usize::from(clk_pin) & 63].x;
        let period_ticks = u64::from(x & 0xFFFF).max(2);
        let half_ns = (period_ticks / 2 * 1_000_000_000 / u64::from(clk)).max(1);

        // First edge of a burst: schedule it, do not fire yet.
        //
        // Not at `now + half`: the guest must execute at least one more
        // instruction before the first edge. `rcvr_mmc` starts the clock
        // and sets the receive width in consecutive instructions (`WYPIN
        // CLK` then `WXPIN DO`), and on silicon the pulse pin's first
        // transition comes a half period later, long after that `WXPIN`.
        // Here the guest only runs when its slice target moves, so a
        // `WYPIN` that lands exactly on a microsecond boundary is the last
        // instruction of its slice; edges armed from `now` then clock the
        // burst against the previous width, `WXPIN` restarts the bit
        // counter under them, and the word never completes -- the driver
        // spins forever with the burst spent. Wake at the next microsecond
        // plus a half period: that wake steps the guest first (the `WXPIN`
        // executes), then fires the edge.
        let due = match self.next_edge_ns {
            Some(t) => t,
            None => {
                let next_us = (now_ns / 1_000 + 1) * 1_000;
                let t = next_us.saturating_add(half_ns);
                self.next_edge_ns = Some(t);
                return self.arm_edge_once(t);
            }
        };
        // Only fire when time has actually reached the edge — one edge per
        // distinct virtual instant, so the device senses every transition.
        if now_ns < due {
            return self.arm_edge_once(due);
        }
        self.inner.advance_smart_clock();
        self.publish();
        if self.inner.smart_clock_busy() {
            let next = due.saturating_add(half_ns);
            self.next_edge_ns = Some(next);
            self.arm_edge_once(next)
        } else {
            self.next_edge_ns = None;
            // The burst is over and the guest is spinning on `TESTP` for the
            // word it just clocked in. Arming nothing here left it asleep
            // until the next periodic slice: a byte's wire time is 0.4 us but
            // the gap after it measured a median 93.6 us, so 99.9% of every SD
            // transfer was dead time and a sector cost ~50 ms of guest clock
            // instead of ~0.2 ms. `sdmm.cc` times its own transfers out in
            // guest clocks (500 ms in `wait_ready`, 125 ms for a data token),
            // so transfers failed with the card never at fault.
            //
            // Wake at the next microsecond *from now*, which is the finest
            // step `step_until` can act on and is always strictly in the
            // future — arming from `due` instead can land in the past, and the
            // wheel then refires at an instant virtual time cannot leave.
            self.arm_edge_once((now_ns / 1_000 + 1) * 1_000)
        }
    }

    /// Hand a deadline to the caller to arm unless it is the one already on
    /// the wheel. `None` here means "nothing new to arm", not "burst over".
    fn arm_edge_once(&mut self, at: u64) -> Option<u64> {
        if self.armed_edge_ns == Some(at) {
            return None;
        }
        self.armed_edge_ns = Some(at);
        Some(at)
    }

    /// Put what the guest changed on the nets: every pad, inside the
    /// package; the level pins, for a [`P2Iss`].
    fn publish(&mut self) {
        if self.core.is_some() {
            self.publish_pads();
        } else {
            self.publish_levels();
        }
    }

    /// A pin the guest has released drives `None` — high-Z — so a pull-up or
    /// another driver on the same net decides the level, which is the whole
    /// point of putting it on the net rather than handing a value across.
    fn publish_levels(&mut self) {
        if self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        if self.io.is_none() {
            return;
        }
        for i in 0..self.level_pins.len() {
            let pin = self.level_pins[i];
            let idx = usize::from(pin & 63);
            let want = self.inner.output_level(pin);
            if self.published[idx] == Some(want) {
                continue;
            }
            if self.level_handles[idx].is_none() {
                // Only reached until every pin has been seen once: cloning the
                // facade per call was pure allocation churn on the hot path.
                let Some(io) = self.io.clone() else {
                    return;
                };
                match io.pin(pin_name(pin)) {
                    Ok(h) => self.level_handles[idx] = Some(h),
                    Err(_) => {
                        tracing::warn!(pin, "p2iss: level pin is not on this component's facade");
                        continue;
                    }
                }
            }
            let Some(handle) = self.level_handles[idx].as_ref() else {
                continue;
            };
            match want {
                Some(high) => handle.drive(Drive::Thevenin(digital_drive(if high {
                    Level::High
                } else {
                    Level::Low
                }))),
                None => handle.release(),
            }
            self.published[idx] = Some(want);
            // A net pin's drive changed: the guest must yield before reading
            // any net back, so a component on it can respond first.
            self.net_yield = true;
        }
    }
}

impl PinBus for NetPins {
    fn external_transfer_busy(&self) -> bool {
        self.inner.external_transfer_busy()
    }

    fn ina(&self) -> u32 {
        self.inner.ina()
    }

    fn inb(&self) -> u32 {
        self.inner.inb()
    }

    fn dir_out_changed(&mut self, cog: usize, reg: u16, value: u32) {
        // Direction and output are the same event as far as a net is
        // concerned: either can turn a pin from high-Z into a driver or back.
        if self.core.is_some() {
            // Inside the package the change waits for its own instant. Only
            // the pins the write moved can present something new.
            let before = self.inner.dir_out_bits();
            self.inner.dir_out_changed(cog, reg, value);
            let after = self.inner.dir_out_bits();
            let moved = (before.0 ^ after.0) | (before.1 ^ after.1);
            if moved != 0 {
                self.core_note_pads(moved);
            }
        } else {
            self.inner.dir_out_changed(cog, reg, value);
            self.publish_levels();
        }
    }

    fn wrpin(&mut self, pin: u8, cfg: u32) {
        // AKPIN assembles as `WRPIN #1,S` — confirmed against flexspin's own
        // listing (`akpin #58` → $FC0C023A, opcode WRPIN, D=1). It never
        // arrives as a distinct op, so the acknowledge must be caught HERE.
        // `rcvr_mmc` opens with it to discard whatever the receiver latched
        // while the previous burst was clocking out — miss it and the guest
        // reads that stale word instead of waiting, runs a whole byte ahead of
        // the bus, and deselects mid-burst: the four-bit frame slip.
        if cfg == 1 {
            // AKPIN (`WRPIN #1`): the board routes the acknowledge to the sync
            // receiver if the pin is one.
            if self.acknowledge_rx(pin) {
                return;
            }
            self.inner.wrpin(pin, cfg);
            return;
        }
        self.inner.wrpin(pin, cfg);
        if self.core.is_some() {
            // Inside the package: the pad's role follows its new mode word,
            // at the instant the guest wrote it.
            self.core_op(package::CoreOp::Wrpin { pin: pin & 63, cfg });
            return;
        }
        // Configuring a smart pin can change whether the pin drives at all: a
        // quadrature or async-receive mode has `DIR` set and no `P_OE`, so a
        // pin that drove as plain GPIO a moment ago is now an input. Without
        // republishing here the P2 keeps driving a net the encoder also
        // drives, and the board reports contention on both channels.
        self.publish_levels();
        // `_pinclear` hands the pin back; a train that kept running after that
        // would move a carriage the firmware believes it has stopped.
        if cfg == 0 {
            if let Some(driver) = self
                .shared
                .pulse
                .lock()
                .expect("pulse map never poisoned")
                .get(&pin)
            {
                driver.stop(virtual_clock::virtual_ns());
            }
        }
    }

    fn wxpin(&mut self, pin: u8, x: u32) {
        self.inner.wxpin(pin, x);
        if self.core.is_some() {
            // A receive pin's bit period is its rate.
            self.core_wxpin(pin);
        }
    }

    fn wypin(&mut self, pin: u8, y: u32) {
        if pin & 63 == p2core::board::PIN_TX && y as u8 == b'\n' {
            self.shared.console_lines.fetch_add(1, Ordering::Relaxed);
        }
        // A sync-serial pin (clock, TX): the board handles the shift/pending;
        // a clock burst additionally arms the first edge so the pump paces it.
        // Only THIS pin being a bus pin routes here. Testing "does any clock
        // exist" instead swallowed every other WYPIN — the protocol and
        // force-gauge transmit pins, the pulse train — into the byte-path
        // board the moment the stepper's step pin was configured, and the
        // guest went silent on the wire.
        if self.core.is_some() {
            // Inside the package the bus is clocked on the guest's own
            // clock, and every other WYPIN with an effect outside waits for
            // the instant the guest wrote it.
            return self.core_wypin(pin, y);
        }
        let is_clock = self.inner.smart_clock_pin() == Some(pin & 63);
        if is_clock || self.inner.smart_bus.tx_pin() == Some(pin & 63) {
            let was_clock = is_clock;
            self.inner.wypin(pin, y);
            // A clock burst arms the pump, but does NOT yield: `xmit_mmc`/
            // `rcvr_mmc` set the RX width in the very next instruction, and
            // yielding here would clock the burst against the stale width.
            // The pump publishes the clock and TX levels on its own wakes.
            if was_clock && self.inner.smart_clock_busy() {
                if let Some(io) = self.io.as_ref() {
                    io.schedule_at_ns(virtual_clock::virtual_ns());
                }
            }
            return;
        }
        if self.pulse_pins.contains(&pin) {
            self.start_pulse(pin, y);
            return self.inner.wypin(pin, y);
        }
        let Some(link) = self.link_for_tx(pin).copied() else {
            return self.inner.wypin(pin, y);
        };
        // The byte waits in the buffer until the shifter is free, then takes
        // a frame time to send.
        if let Some(i) = self.tx_index(pin) {
            let frame = self.tx_frame_clocks(pin);
            let pace = &mut self.tx_pace[i];
            pace.loaded_at = self.clock.max(pace.idle_at);
            pace.idle_at = pace.loaded_at + frame;
        }
        if self.shutdown.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let Some(io) = self.io.clone() else {
            tracing::debug!(pin, "p2iss: transmit on an inert io handle dropped");
            return;
        };
        // Build the bridge on first transmit, not at attach: only by now has
        // the guest programmed the pin, so only by now is the rate a decoded
        // fact rather than a declared one.
        let mut tx = self.shared.tx.lock().expect("tx map never poisoned");
        if let std::collections::btree_map::Entry::Vacant(slot) = tx.entry(pin) {
            let (framing, baud_hz) = self.framing_for(pin, link.nominal_baud);
            let Ok(handle) = io.pin(pin_name(pin)) else {
                tracing::warn!(pin, "p2iss: transmit pin is not on this component's facade");
                return;
            };
            let bridge = Arc::new(SerialLevelBridge::new(
                framing,
                handle,
                io.clone(),
                Arc::clone(&self.shutdown),
            ));
            bridge.idle();
            slot.insert(TxLink { bridge, baud_hz });
        }
        self.shared.tx_bytes.fetch_add(1, Ordering::Relaxed);
        tx[&pin].bridge.transmit(&[y as u8]);
    }

    fn rdpin(&mut self, pin: u8) -> (u32, bool) {
        if let Some(read) = self.core_rdpin(pin) {
            return read;
        }
        if let Some(mut rx) = self.rx_now(pin) {
            // `RDPIN` reads `Z` and acknowledges. `HAL_serial_recieveByte`
            // takes the byte from bits 31:24, where an async-RX smart pin
            // leaves it; read again with nothing new, it is the same byte.
            rx.waiting = false;
            return (u32::from(rx.held) << 24, false);
        }
        if let Some(i) = self.tx_index(pin) {
            // C is the transmitter's busy flag: set until the last frame is out.
            let (value, _) = self.inner.rdpin(pin);
            return (value, self.clock < self.tx_pace[i].idle_at);
        }
        self.inner.rdpin(pin)
    }

    fn testp(&self, pin: u8) -> bool {
        if let Some(waiting) = self.core_testp(pin) {
            return waiting;
        }
        // Autobaud timing pins (P0/P1) go IN-high when a programming-UART
        // byte is waiting: that is the fall-to-fall measurement the ROM's
        // SETSE1 is looking for. The byte itself lives on P63.
        if (pin == 0 || pin == 1)
            && self.links.iter().any(|l| l.rx_pin == 63)
            && self.rx_now(63).is_some_and(|rx| rx.waiting)
        {
            return true;
        }
        if let Some(rx) = self.rx_now(pin) {
            return rx.waiting;
        }
        if let Some(i) = self.tx_index(pin) {
            // `IN` rises when the buffered byte moves into the shifter.
            return self.clock >= self.tx_pace[i].loaded_at;
        }
        self.inner.testp(pin)
    }

    fn akpin(&mut self, pin: u8) {
        if self.acknowledge_rx(pin) {
            return;
        }
        self.inner.akpin(pin);
    }

    fn take_net_yield(&mut self) -> bool {
        std::mem::take(&mut self.net_yield)
    }

    fn set_clock(&mut self, clocks: u64) {
        self.clock = clocks;
    }

    fn next_pin_change(&self, now: u64) -> Option<u64> {
        let rx = self.shared.rx.values().filter_map(|rx| {
            let rx = rx.lock().expect("rx pin never poisoned");
            rx.arriving.front().map(|&(at, _)| self.ns_to_clocks(at))
        });
        let tx = self
            .tx_pace
            .iter()
            .flat_map(|pace| [pace.loaded_at, pace.idle_at]);
        rx.chain(tx)
            .chain(self.core_next_pin_change(now))
            .filter(|&at| at > now)
            .min()
    }
}

impl NetPins {
    fn new(inner: Board, links: Vec<SerialLink>, shared: Arc<Shared>) -> Self {
        let tx_pace = vec![TxPace::default(); links.len()];
        Self {
            inner,
            links,
            shared,
            io: None,
            shutdown: Arc::new(AtomicBool::new(false)),
            clkfreq: 0,
            rom_boot: false,
            level_pins: Vec::new(),
            pulse_pins: Vec::new(),
            clock: 0,
            tx_pace,
            level_handles: [const { None }; 64],
            published: [None; 64],
            net_yield: false,
            next_edge_ns: None,
            armed_edge_ns: None,
            core: None,
            core_shared: None,
        }
    }
}

/// How the machine gets its first instructions.
enum BootSource<'a> {
    /// A flexcc image injected straight into hub — the shortcut every test
    /// took before the ROM existed here.
    Image(&'a [u8]),
    /// The 16 KB boot ROM at the top of hub; everything else arrives over
    /// the pins.
    Rom(&'a [u8]),
}

/// A cloneable view onto a mounted [`P2Iss`].
///
/// `System::start` takes ownership of the component, so anything that wants to
/// interrogate the machine afterwards holds one of these — the same pattern
/// `embsim_models`' ADS122U04 uses for its own state.
#[derive(Clone)]
pub struct P2IssHandle {
    shared: Arc<Shared>,
    machine: Arc<Mutex<Machine<NetPins>>>,
    /// A [`P2IssCore`]'s own state; `None` for a [`P2Iss`].
    core: Option<Arc<package::CoreShared>>,
}

impl std::fmt::Debug for P2IssHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("P2IssHandle").finish_non_exhaustive()
    }
}

impl P2IssHandle {
    /// The rate a transmit pin is actually framing at, once it has transmitted.
    ///
    /// `None` before the first byte. This is the ISS's own answer — derived
    /// from the pin's `WXPIN` divisor and the `clkfreq` the guest recorded —
    /// not the rate the link was declared with.
    pub fn derived_baud(&self, tx_pin: u8) -> Option<u32> {
        self.shared
            .tx
            .lock()
            .expect("tx map never poisoned")
            .get(&tx_pin)
            .map(|link| link.baud_hz)
    }

    /// Virtual microseconds of guest time executed so far. Inside the
    /// package, the virtual instant the guest's clock has reached, from its
    /// START instant on.
    pub fn guest_now_us(&self) -> u64 {
        self.guest_now_ns() / 1_000
    }

    /// [`Self::guest_now_us`] in nanoseconds, as of the end of the last
    /// wake: read without waiting on the machine, which the engine thread
    /// holds while the guest runs.
    pub fn guest_now_ns(&self) -> u64 {
        self.shared.guest_now_ns.load(Ordering::Relaxed)
    }

    /// Line feeds the guest has handed its debug pin (`P62`), read without
    /// waiting on the machine.
    pub fn console_lines(&self) -> u64 {
        self.shared.console_lines.load(Ordering::Relaxed)
    }

    /// The clock frequency the guest recorded, or 0 before boot.
    pub fn clkfreq(&self) -> u32 {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .clkfreq()
    }

    /// Frames dropped on a receive pin because they did not deframe.
    ///
    /// Non-zero means the wire is corrupting the link: the guest's driver sees
    /// a timeout, not an error, so this counter is the only place it shows.
    pub fn rx_framing_errors(&self) -> u64 {
        self.shared.rx_framing_errors.load(Ordering::Relaxed)
    }

    /// Bytes a receive pin latched and then overwrote before the guest read
    /// them.
    ///
    /// An async-RX smart pin holds one byte, so this is how a receiver that
    /// polls too slowly fails on silicon: the bytes reach the pin, and the
    /// guest never sees them. Counted up to the instant the whole machine has
    /// executed to.
    pub fn rx_overruns(&self, rx_pin: u8) -> u64 {
        if let Some(core) = self.core.as_ref() {
            return core.rx_overruns(rx_pin);
        }
        self.shared
            .rx
            .get(&rx_pin)
            .map_or(0, |rx| rx.lock().expect("rx pin never poisoned").overruns)
    }

    /// `(bytes the guest transmitted, bytes deframed off the wire)`.
    pub fn byte_counts(&self) -> (u64, u64) {
        (
            self.shared.tx_bytes.load(Ordering::Relaxed),
            self.shared.rx_bytes.load(Ordering::Relaxed),
        )
    }

    /// Everything the guest has written to its debug console (pin 62).
    ///
    /// The firmware narrates its own boot here — cog starts, NVRAM, the SD
    /// mount — so this is the ISS's most direct oracle: an assertion on it is
    /// an assertion about what the real firmware decided, not about what the
    /// harness modelled.
    pub fn console(&self) -> String {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .inner
            .console()
    }

    /// The quadrature count the guest would read from the channel on `a_pin`.
    pub fn encoder_count(&self, a_pin: u8) -> Option<i32> {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .inner
            .quadrature_count(a_pin)
    }

    /// Undecodable two-state jumps on that channel. Assert this is zero: a
    /// non-zero value means transitions are reaching the decoder folded
    /// together, and the position it reports is wrong, not merely noisy.
    pub fn encoder_slips(&self, a_pin: u8) -> u32 {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .inner
            .quadrature_slips(a_pin)
    }

    /// Times the guest yielded for a net pin to resolve.
    pub fn net_yields(&self) -> u64 {
        self.shared.net_yields.load(Ordering::Relaxed)
    }

    /// Net transitions dropped because the guest stopped consuming them.
    /// Worth asserting is zero: a non-zero value means pin reads are stale.
    pub fn edges_dropped(&self) -> u64 {
        self.shared.edges_dropped.load(Ordering::Relaxed)
    }

    /// The level a net is currently presenting to one of the guest's pins.
    pub fn input_level(&self, pin: u8) -> bool {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .inner
            .input_level(pin)
    }

    /// What the guest is driving on `pin`, or `None` if it has released it.
    pub fn output_level(&self, pin: u8) -> Option<bool> {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .inner
            .output_level(pin)
    }

    /// SD commands the guest has issued, in order — a bring-up probe for
    /// whether the firmware got as far as reading a sector at all.
    pub fn sd_commands(&self) -> Vec<u8> {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .inner
            .card
            .commands
            .clone()
    }

    /// Block addresses the guest's FatFs has read from the in-process card.
    ///
    /// The mount has a wire-visible shape: block 0 (the boot sector) and then
    /// block 129 (this image's root directory). A card that is probed and
    /// rejected shows block 0 alone.
    pub fn sd_reads(&self) -> Vec<u32> {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .inner
            .card
            .reads
            .clone()
    }

    /// Enable the card's `(mosi, miso)` trace before boot.
    pub fn trace_sd(&self) {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .inner
            .card
            .trace = Some(Vec::new());
    }

    /// The card's `(mosi, miso)` trace, if enabled.
    pub fn sd_trace(&self) -> Vec<(u8, u8)> {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .inner
            .card
            .trace
            .clone()
            .unwrap_or_default()
    }

    /// Cogs currently running.
    pub fn running_cogs(&self) -> usize {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .cogs
            .iter()
            .filter(|c| c.running)
            .count()
    }
}

/// The P2 ISS mounted on a board.
pub struct P2Iss {
    pins: Vec<PinDecl>,
    links: Vec<SerialLink>,
    level_pins: Vec<u8>,
    /// Every pin whose net feeds the guest, driven or not.
    sense_pins: Vec<u8>,
    pulse_pins: Vec<u8>,
    shared: Arc<Shared>,
    machine: Arc<Mutex<Machine<NetPins>>>,
    shutdown: Arc<AtomicBool>,
}

impl std::fmt::Debug for P2Iss {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("P2Iss")
            .field("pins", &self.pins.len())
            .field("links", &self.links)
            .finish()
    }
}

impl P2Iss {
    /// Mount `image` — a real flexcc-compiled P2 program — with `card` as its
    /// SD card and `links` as the serial pins to lift onto nets.
    ///
    /// Only the pins named by `links` are declared: a bench system connects
    /// them by bare endpoint, and every other P2 pin stays inside
    /// [`p2core::Board`]'s own model.
    pub fn new(image: &[u8], card: SdCard, links: &[SerialLink]) -> Self {
        Self::construct(BootSource::Image(image), card, links)
    }

    /// Mount the machine the way silicon powers on: nothing in hub but the
    /// 16 KB boot ROM, COG 0 in hub-exec at `$FC000`. The application must
    /// arrive over a wire — which is the point.
    pub fn with_boot_rom(rom: &[u8], card: SdCard, links: &[SerialLink]) -> Self {
        Self::construct(BootSource::Rom(rom), card, links)
    }

    fn construct(source: BootSource<'_>, card: SdCard, links: &[SerialLink]) -> Self {
        let shutdown = Arc::new(AtomicBool::new(false));
        let mut shared = Shared::default();
        let mut pins = Vec::with_capacity(links.len() * 2);
        for link in links {
            shared
                .rx
                .insert(link.rx_pin, Arc::new(Mutex::new(RxPin::default())));
            // The deframer runs at the *declared* rate, not a derived one: it
            // has to exist before the first edge arrives, and at that moment
            // the guest may not have configured the pin yet. A disagreement
            // between the two shows up on the transmit side, where the rate is
            // derived — see `NetPins::framing_for`.
            shared.rx_decoders.insert(
                link.rx_pin,
                Arc::new(Mutex::new(UartDecoder::new(UartFraming::new_8n1(
                    link.nominal_baud,
                )))),
            );
            pins.push(PinDecl::digital_out(pin_name(link.tx_pin)));
            pins.push(PinDecl::digital_in(pin_name(link.rx_pin), P2ISS_PAD));
        }
        let shared = Arc::new(shared);
        let mut bus = NetPins::new(Board::new(card), links.to_vec(), Arc::clone(&shared));
        bus.shutdown = Arc::clone(&shutdown);
        // No strap is assumed here: the ROM reads P59 (the serial strap) and
        // P61 (the flash strap) off whatever the bench puts on their nets, as
        // the chip does. A ROM boot that wants the programming UART carries
        // P59 as a level pin and pulls it up.
        bus.rom_boot = matches!(source, BootSource::Rom(_));
        Self {
            pins,
            links: links.to_vec(),
            level_pins: Vec::new(),
            sense_pins: Vec::new(),
            pulse_pins: Vec::new(),
            shared,
            machine: Arc::new(Mutex::new(match source {
                BootSource::Image(image) => Machine::new(image, bus),
                BootSource::Rom(rom) => Machine::with_boot_rom(rom, bus),
            })),
            shutdown,
        }
    }

    /// Carry `pins` on nets as plain levels.
    ///
    /// These are bidirectional pads, because the guest decides
    /// direction at runtime with `DIR` and the adapter follows: a pin the
    /// firmware has released drives high-Z and whatever else is on the net —
    /// a pull-up, another component — sets the level it reads back.
    ///
    /// This is the general path. [`SerialLink`] exists only because an async
    /// UART needs a framer on top of the same levels; everything else the
    /// firmware does with a pin is a level, and belongs here.
    pub fn with_level_pins(mut self, pins: &[u8]) -> Self {
        for &pin in pins {
            if self.pins.iter().any(|d| d.number == pin_name(pin)) {
                continue;
            }
            // Released until the guest drives it, as a pad is out of reset,
            // and reading its net through the P2's own pair meanwhile.
            self.pins
                .push(PinDecl::digital_io(pin_name(pin), P2ISS_PAD));
            self.level_pins.push(pin);
            self.sense_pins.push(pin);
        }
        {
            let mut machine = self.machine.lock().expect("machine never poisoned");
            machine.pins.level_pins = self.level_pins.clone();
        }
        self
    }

    /// Carry `pins` on nets as **inputs only**: sensed, never driven.
    ///
    /// The distinction from [`P2Iss::with_level_pins`] is not cosmetic. A pin
    /// the firmware only ever reads — an endstop, an ESD line, the encoder's
    /// quadrature channels — has no business owning a drive slot on its net.
    /// Declaring it bidirectional lets the P2 contend with whatever is
    /// actually driving, and the board says so: `Contention { net: "P2.P9",
    /// drivers: [P2.P9, ENCODER.A] }` is what this exists to prevent.
    pub fn with_input_pins(mut self, pins: &[u8]) -> Self {
        for &pin in pins {
            if self.pins.iter().any(|d| d.number == pin_name(pin)) {
                continue;
            }
            self.pins
                .push(PinDecl::digital_in(pin_name(pin), P2ISS_PAD));
            self.sense_pins.push(pin);
        }
        self
    }

    /// Carry `pins` on nets as **pulse trains**: a square wave the pin drives.
    ///
    /// The step train is the firmware's one continuous, rate-carried output.
    /// Each pin publishes a [`Drive::Periodic`] through its own handle — the
    /// Thevenin port of its high phase, the one of its low phase, and the
    /// [`embsim_board::PeriodicSchedule`] that alternates them, in
    /// nanoseconds — once per rate change (a `WYPIN`, a retune, `_pinclear`),
    /// never per edge. The engine resolves the square wave like any other
    /// drive, and a stepper model on the far end reads the train off its own
    /// STEP pin's sense, the schedule folding every pulse already counted.
    /// See [`pulse`].
    pub fn with_pulse_pins(mut self, pins: &[u8]) -> Self {
        for &pin in pins {
            if self.pins.iter().any(|d| d.number == pin_name(pin)) {
                continue;
            }
            self.pins.push(PinDecl::digital_out(pin_name(pin)));
            self.pulse_pins.push(pin);
        }
        {
            let mut machine = self.machine.lock().expect("machine never poisoned");
            machine.pins.pulse_pins = self.pulse_pins.clone();
        }
        self
    }

    /// Model the synchronous-serial smart pins on nets, so a device like the
    /// SD card shares the bus as an ordinary component.
    ///
    /// The board reads clock/TX/RX roles from the mode words the firmware
    /// programs (bits 26:24, exactly as the quadrature decoder reads its
    /// channel offset), so the ISS holds no notion of an "SPI bus": it pumps
    /// the clock pin's edges over virtual time and moves the pins' levels on
    /// and off the nets, nothing more. The device (`SdCardNode`) is a plain
    /// net-sensing component, as decoupled as the flash.
    ///
    /// One edge fires per distinct virtual instant ([`NetPins::next_edge_ns`]),
    /// so the yield re-wakes and the periodic slice cannot burst several
    /// transitions into one net resolution — which would collapse on the wire
    /// and make the device miss edges.
    ///
    /// Off by default: without it the byte-routed `p2core::Board` SD path runs,
    /// which standalone `p2core` tests rely on.
    pub fn with_sync_serial(self) -> Self {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .pins
            .inner
            .enable_smart_bus();
        self
    }

    /// A view that outlives handing this component to a `System`.
    pub fn handle(&self) -> P2IssHandle {
        P2IssHandle {
            shared: Arc::clone(&self.shared),
            machine: Arc::clone(&self.machine),
            core: None,
        }
    }
}

impl Component for P2Iss {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        // Hand the bus its scheduling handle before anything can transmit.
        {
            let mut machine = self.machine.lock().expect("machine never poisoned");
            machine.pins.io = Some(io.clone());
        }

        // Every transmit pin idles **high, from attach**, before the guest has
        // configured anything.
        //
        // An asynchronous receiver finds a byte by watching for a falling edge
        // out of the mark level. The bridge that eventually drives this pin is
        // built lazily — only the first `WYPIN` makes the rate a decoded fact
        // rather than a declared one — but if the line is high-Z until that
        // moment, the far end has no mark to fall from: its first start bit is
        // whatever transition happens to arrive, and every byte after it is
        // framed off by some number of bits. The ADS122U04 model showed this
        // exactly, reading the protocol's `0x55` sync byte as register data.
        //
        // So claim the idle level now and let the bridge take over later. This
        // commits to no rate; it only says what an idle asynchronous line is.
        for link in &self.links {
            io.pin(pin_name(link.tx_pin))?
                .drive(Drive::Thevenin(digital_drive(Level::High)));
        }

        // Pulse pins: one driver each, holding its facade handle, so a `WYPIN`
        // publishes its train through the pin the moment the guest issues it.
        {
            let mut map = self.shared.pulse.lock().expect("pulse map never poisoned");
            for &pin in &self.pulse_pins {
                let handle = io.pin(pin_name(pin))?;
                let driver = Arc::new(PulseDriver::new(pin, handle));
                driver.idle();
                map.insert(pin, driver);
            }
        }

        // Level pins: each sense is projected through the pad's own
        // thresholds (`P2ISS_PAD`), and the level becomes the pin's input on
        // the next slice. A sense with no level — a floating or fought net, or
        // a voltage inside the pad's dead band — deliberately holds the last
        // level rather than inventing one: the same rule `SerialLevelBridge`
        // follows, for the same reason: an unresolvable net is not a logic
        // value, and guessing one hides the fault.
        for &pin in &self.sense_pins {
            let shared = Arc::clone(&self.shared);
            let shutdown = Arc::clone(&self.shutdown);
            let reader = DigitalReceiver::new(io.pin(pin_name(pin))?);
            io.on_sense(pin_name(pin), move |sense| {
                if shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                // A sense with no level holds the last one rather than
                // inventing one, the same rule `SerialLevelBridge` follows:
                // an unresolvable net is not a logic value.
                let Some(level) = reader.read(&sense) else {
                    return;
                };
                let mut queue = shared.edges.lock().expect("edge queue never poisoned");
                if queue.len() >= EDGE_QUEUE_MAX {
                    shared.edges_dropped.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                queue.push_back((pin, level == Level::High));
            })?;
        }

        // Receive: the pin's resolved state feeds a deframer, and each byte it
        // decodes lands in the pin's register at the instant its frame closed.
        for link in &self.links {
            let pin = Arc::clone(&self.shared.rx[&link.rx_pin]);
            let counted = Arc::clone(&self.shared);
            let decoder = Arc::clone(&self.shared.rx_decoders[&link.rx_pin]);
            let shutdown = Arc::clone(&self.shutdown);
            let arm = io.clone();
            let reader = DigitalReceiver::new(io.pin(pin_name(link.rx_pin))?);
            io.on_sense(pin_name(link.rx_pin), move |sense| {
                if shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                let now = sense.at_ns;
                let mut rx = decoder.lock().expect("decoder never poisoned");
                if let Some(level) = reader.read(&sense) {
                    rx.on_level(level, now);
                }
                while let Some(frame) = rx.poll(now) {
                    match frame {
                        Ok(byte) => {
                            counted.rx_bytes.fetch_add(1, Ordering::Relaxed);
                            pin.lock()
                                .expect("rx pin never poisoned")
                                .arriving
                                .push_back((now, byte));
                        }
                        Err(error) => {
                            counted.rx_framing_errors.fetch_add(1, Ordering::Relaxed);
                            tracing::debug!(
                                ?error,
                                "p2iss: receive frame dropped (bad framing on the wire)"
                            );
                        }
                    }
                }
                if let Some(at) = rx.frame_deadline_ns() {
                    arm.schedule_at_ns(at);
                }
            })?;
        }

        // Run the guest, then clock out whatever it transmitted. Both on the
        // engine thread: `step_until` is pure computation and never blocks.
        {
            let machine = Arc::clone(&self.machine);
            let shared = Arc::clone(&self.shared);
            let shutdown = Arc::clone(&self.shutdown);
            let arm = io.clone();
            io.on_wake_ns(move |now_ns| {
                if shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                {
                    let mut machine = machine.lock().expect("machine never poisoned");
                    // The guest's own clkfreq, so a rate derived on the next
                    // transmit uses the value the firmware actually recorded.
                    let clk = machine.clkfreq();
                    machine.pins.set_clkfreq(clk);
                    // Replay every transition the nets resolved since the last
                    // slice, in order, before the guest executes anything that
                    // could read a pin. One at a time: an edge-counted input
                    // needs each transition, not the net result of them.
                    {
                        let mut queue = shared.edges.lock().expect("edge queue never poisoned");
                        for (pin, level) in queue.drain(..) {
                            machine.pins.inner.set_input_level(pin, level);
                        }
                    }
                    let target_us = now_ns / 1_000;
                    if let Err(trap) = machine.step_until(target_us) {
                        tracing::error!(%trap, "p2iss: the guest trapped; it will not run again");
                        *shared.trap.lock().expect("trap slot never poisoned") =
                            Some(trap.to_string());
                        shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
                        return;
                    }
                    shared
                        .guest_now_ns
                        .store(machine.now_us().saturating_mul(1_000), Ordering::Relaxed);
                    // If the guest yielded short of the deadline, it drove a
                    // net pin and must not run on until the engine has
                    // resolved it. Re-arm at the current instant: the engine
                    // drains the drive, resolves, delivers the sense (a
                    // component drives its response), resolves again, then
                    // fires this wake — all before the guest reads back. This
                    // is what makes a bit-banged bus a first-class net
                    // participant; the cost is one engine pass per net-pin
                    // edge, which is the real cost of the bus.
                    let running = machine.cogs.iter().any(|c| c.running);
                    if running && machine.now_us() < target_us {
                        shared.net_yields.fetch_add(1, Ordering::Relaxed);
                        arm.schedule_at_ns(virtual_clock::virtual_ns());
                    }
                }
                // Emit a synchronous-serial clock edge if a burst is running,
                // and arm the next at the clock's period. The board did the
                // shift and sample; this just paces the wire.
                {
                    let mut machine = machine.lock().expect("machine never poisoned");
                    // Drain any net transitions (the card's MISO response to the
                    // last clock edge) into the pins *now*, so the pump samples
                    // the freshest input rather than one edge-queue hop stale.
                    {
                        let mut queue = shared.edges.lock().expect("edge queue never poisoned");
                        for (pin, level) in queue.drain(..) {
                            machine.pins.inner.set_input_level(pin, level);
                        }
                    }
                    if let Some(at) = machine.pins.service_smart_clock(now_ns) {
                        arm.schedule_at_ns(at);
                    }
                }
                // Service every live transmit bridge: each clocks its own next
                // bit and arms its own next wake.
                {
                    let tx = shared.tx.lock().expect("tx map never poisoned");
                    for link in tx.values() {
                        let _ = link.bridge.service(now_ns);
                    }
                }
                // And close any receive frame whose tail carried no transition.
                // The last byte of every burst ends this way, so without this
                // the guest never sees it.
                for (pin, decoder) in &shared.rx_decoders {
                    let mut rx = decoder.lock().expect("decoder never poisoned");
                    while let Some(frame) = rx.poll(now_ns) {
                        match frame {
                            Ok(byte) => {
                                shared.rx_bytes.fetch_add(1, Ordering::Relaxed);
                                shared.rx[pin]
                                    .lock()
                                    .expect("rx pin never poisoned")
                                    .arriving
                                    .push_back((now_ns, byte));
                            }
                            Err(error) => {
                                shared.rx_framing_errors.fetch_add(1, Ordering::Relaxed);
                                tracing::debug!(
                                    pin,
                                    ?error,
                                    "p2iss: receive frame dropped (bad framing on the wire)"
                                );
                            }
                        }
                    }
                }
                // Land every byte the whole machine has passed, so the overrun
                // count is current and a pin nothing reads cannot accumulate.
                {
                    let machine = machine.lock().expect("machine never poisoned");
                    machine.pins.land_rx_until_clock(machine.system_clocks());
                }
            });
        }
        io.schedule_every_ns(SLICE_NS);
        Ok(())
    }
}

impl Drop for P2Iss {
    fn drop(&mut self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibes_behaviour::{behaviour, expect, Test};

    const LINK: SerialLink = SerialLink {
        tx_pin: 55,
        rx_pin: 53,
        nominal_baud: 2_000_000,
    };
    /// `P_ASYNC_TX | P_OE`, and `X` for 8-bit frames of 80 clocks a bit:
    /// 2 Mbaud at 160 MHz, as `HAL_serial_start` programs it.
    const ASYNC_TX: u32 = 0x3C | p2core::smartpin::P_OE;
    const X_2MBAUD: u32 = 7 | (80 << 16);
    /// One 10-bit frame at that rate.
    const FRAME_CLOCKS: u64 = 800;

    /// The bus a guest sees, with nothing on the nets: arrivals are handed in
    /// directly, stamped as the engine would stamp them.
    fn pins() -> NetPins {
        let mut shared = Shared::default();
        shared
            .rx
            .insert(LINK.rx_pin, Arc::new(Mutex::new(RxPin::default())));
        NetPins::new(Board::new(SdCard::blank(0)), vec![LINK], Arc::new(shared))
    }

    fn arrive(pins: &NetPins, at_ns: u64, byte: u8) {
        pins.shared.rx[&LINK.rx_pin]
            .lock()
            .expect("rx pin never poisoned")
            .arriving
            .push_back((at_ns, byte));
    }

    /// At the default 160 MHz, the clock of virtual nanosecond `ns`.
    fn clock_at(ns: u64) -> u64 {
        ns * 160 / 1_000
    }

    #[test]
    fn a_received_byte_is_readable_from_the_instant_its_frame_closes() {
        behaviour!(Test {
            id: "p2.async-rx-latches-at-frame-close",
            covers: Some("SIL/p2iss/src/lib.rs#RxPin"),
            given: "a byte whose frame closes on an asynchronous receive pin at a known instant while the program runs",
        });
        expect!(
            "hidden-before",
            "an instruction before that instant finds no byte waiting",
            "the program and the wire run on one clock, however the simulator batches them"
        );
        expect!(
            "readable-after",
            "an instruction at that instant finds the byte waiting and reads it"
        );
        expect!("read-clears", "reading the byte leaves no byte waiting");

        let mut pins = pins();
        arrive(&pins, 5_000, 0x55);

        pins.set_clock(clock_at(5_000) - 1);
        assert!(!pins.testp(LINK.rx_pin), "hidden-before");

        pins.set_clock(clock_at(5_000));
        assert!(pins.testp(LINK.rx_pin), "readable-after: waiting");
        assert_eq!(
            pins.rdpin(LINK.rx_pin),
            (0x55 << 24, false),
            "readable-after: the byte, in bits 31:24"
        );

        assert!(!pins.testp(LINK.rx_pin), "read-clears");
    }

    #[test]
    fn an_unread_byte_is_overwritten_by_the_next() {
        behaviour!(Test {
            id: "p2.async-rx-one-byte-register",
            covers: Some("SIL/p2iss/src/lib.rs#RxPin"),
            given: "two bytes arriving back to back on an asynchronous receive pin while the program reads neither until both have arrived",
        });
        expect!(
            "latest-kept",
            "the program reads the second byte",
            "the pin holds a single byte, and each new one replaces it"
        );
        expect!(
            "overwrite-counted",
            "the first byte is counted as overwritten"
        );

        let mut pins = pins();
        arrive(&pins, 5_000, 0x55);
        arrive(&pins, 10_000, 0x00);

        pins.set_clock(clock_at(12_000));
        assert_eq!(pins.rdpin(LINK.rx_pin).0 >> 24, 0x00, "latest-kept");
        assert_eq!(
            pins.shared.rx[&LINK.rx_pin]
                .lock()
                .expect("rx pin never poisoned")
                .overruns,
            1,
            "overwrite-counted"
        );
    }

    #[test]
    fn a_transmit_pin_takes_one_byte_a_frame() {
        behaviour!(Test {
            id: "p2.async-tx-paces-writer",
            covers: Some("SIL/p2iss/src/lib.rs#TxPace"),
            given: "a program writing two bytes back to back to an idle asynchronous transmit pin",
        });
        expect!(
            "first-taken-at-once",
            "the pin is ready for the next byte as soon as the first is written",
            "an idle pin starts sending the first byte at once, which leaves room for one more"
        );
        expect!(
            "second-waits-a-frame",
            "after the second byte the pin is ready again only once the first byte's frame has been sent"
        );
        expect!(
            "busy-until-sent",
            "the pin reports busy until the second byte's frame has been sent too"
        );

        let mut pins = pins();
        pins.wrpin(LINK.tx_pin, ASYNC_TX);
        pins.wxpin(LINK.tx_pin, X_2MBAUD);

        pins.set_clock(1_000);
        pins.wypin(LINK.tx_pin, 0x55);
        assert!(pins.testp(LINK.tx_pin), "first-taken-at-once");

        pins.set_clock(1_010);
        pins.wypin(LINK.tx_pin, 0x02);
        assert!(
            !pins.testp(LINK.tx_pin),
            "second-waits-a-frame: still buffered"
        );
        pins.set_clock(1_000 + FRAME_CLOCKS - 1);
        assert!(
            !pins.testp(LINK.tx_pin),
            "second-waits-a-frame: just before"
        );
        pins.set_clock(1_000 + FRAME_CLOCKS);
        assert!(pins.testp(LINK.tx_pin), "second-waits-a-frame: taken");

        pins.set_clock(1_000 + 2 * FRAME_CLOCKS - 1);
        assert!(pins.rdpin(LINK.tx_pin).1, "busy-until-sent: still sending");
        pins.set_clock(1_000 + 2 * FRAME_CLOCKS);
        assert!(!pins.rdpin(LINK.tx_pin).1, "busy-until-sent: done");
    }
}
