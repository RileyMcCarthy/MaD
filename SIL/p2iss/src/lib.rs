//! The P2 instruction-set simulator as the core inside embsim's P2 package.
//!
//! [`p2core`] is the CPU: real flexcc-compiled P2 machine code, executed
//! instruction by instruction, with a [`PinBus`] as its only outside edge and
//! no knowledge of nets, harnesses or virtual clocks. This crate mounts it on
//! an [`embsim_board`] system as [`P2IssCore`], an
//! [`embsim_boards::p2::P2Core`]: the processor of a P2 package (`U100` on
//! the P2-EC32MB; `core = "mad-p2iss"` in a project file), all 64 pads on
//! the module's nets, booting the firmware the machine flashes through the
//! real boot ROM ([`package`]).
//!
//! ```text
//!   embsim engine              P2IssCore (NetPins)                p2core
//!   ─────────────              ───────────────────                ──────
//!   wake(now_ns) ────────────► step_until_clocks(horizon) ──────► Machine
//!   pad nets ◄── each change at its instant ◄── DIR/OUT, WRPIN, WYPIN
//!   pad senses ──► edge queue, deframers ──► INA/INB, TESTP, RDPIN
//! ```
//!
//! # Why an ISS
//!
//! The firmware executes `WRPIN`/`WXPIN`/`WYPIN` against a smart pin, so a
//! serial pin's bit period is a *decoded* fact
//! ([`p2core::SmartPin::baud_hz`]): the divisor the firmware wrote, at the
//! clock its clock word selected. [`P2IssHandle::derived_baud`] is worth
//! asserting on: a wrong clock shows up as a wrong rate on the wire instead
//! of as bytes that look fine.
//!
//! Beside the core: [`flashimage`] and [`sdimage`] build what the module's
//! flash and card hold, and [`pulse`] carries a step train onto its net as
//! one periodic drive per rate change.

pub mod flashimage;
pub mod package;
pub mod pulse;
use crate::pulse::PulseDriver;
pub mod sdimage;
pub use package::P2IssCore;

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use embsim_board::{ComponentNetIo, SerialLevelBridge};
use embsim_core::virtual_clock;
use p2core::{Board, Machine, PinBus, PinMode};

/// How far past the engine's instant a wake runs the guest, at most.
///
/// The guest leads the board (`package.rs`, "Time: the guest leads"): a
/// wake runs it from its own clock to this far past the engine's instant, or
/// to the first instruction that does something outside the chip, which
/// ends the pass. So this bounds how far an idle guest, or one only
/// computing, runs ahead, and with it how late such a guest reads what the
/// nets present: up to a slice.
pub const SLICE_NS: u64 = 100_000;

/// How many unread net transitions to hold before dropping them.
///
/// Large enough that a normal slice never reaches it; bounded so a guest that
/// has stopped being stepped cannot exhaust memory.
const EDGE_QUEUE_MAX: usize = 1 << 16;

/// `"P0"`..`"P63"`: the names of the pads' handles.
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
/// The pin latches each byte into `Z` (bits 31:24) and raises `IN`; `RDPIN`
/// or `AKPIN` lowers `IN`. There is no FIFO. The next byte to land
/// overwrites `Z` whether or not the guest read the last one, so a receiver
/// that leaves the pin unread for longer than a byte time loses bytes,
/// silently — at 2 Mbaud that is 800 clocks at 160 MHz.
///
/// Each byte waits in `arriving`, stamped with the virtual instant it lands
/// at, and lands in the register only when the clock of the cog looking at
/// the pin reaches that stamp ([`PinBus::set_clock`]). The package decides
/// the stamp: the guest runs ahead of the engine, so a byte lands in the
/// guest's present, the wire's spacing kept (`package.rs`, "Receive: one
/// byte, landed in the guest's present").
#[derive(Debug, Default)]
pub(crate) struct RxPin {
    /// Bytes the guest's clock has not reached yet, oldest first, each with
    /// the virtual nanosecond it lands at.
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

/// One async-TX smart pin's buffer and shifter, in guest clocks.
///
/// `WYPIN` puts a byte in the buffer; it moves into the shifter as soon as the
/// shifter is free, and `IN` rises then — the signal a driver waits on before
/// its next `WYPIN`. `RDPIN`'s C reads busy until the shifter has sent the
/// last frame. So a driver that writes a burst byte by byte is held for a
/// frame time per byte after the first, as on silicon. The wire itself is
/// clocked by the pin's bridge; this only paces the guest.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct TxPace {
    /// The clock at which the buffered byte enters the shifter: `IN` rises.
    pub(crate) loaded_at: u64,
    /// The clock at which the shifter has sent everything: busy clears.
    pub(crate) idle_at: u64,
}

impl TxPace {
    /// A `WYPIN` at `clock` of a byte whose frame takes `frame` clocks: it
    /// waits in the buffer until the shifter is free, then takes a frame
    /// time to send.
    pub(crate) fn load(&mut self, clock: u64, frame: u64) {
        self.loaded_at = clock.max(self.idle_at);
        self.idle_at = self.loaded_at + frame;
    }
}

/// The slowest transition pin the package's bus clocks edge by edge
/// ([`p2core::PinBus::clocks_synchronously`]): one transition every 16
/// clocks, 5 MHz at the firmware's 160 MHz. loadp2's flash clock makes one
/// a clock; a step/direction drive's step train toggles far slower, and is
/// carried as a rate ([`crate::pulse`]).
const SYNC_CLOCK_MAX_TRANSITION_CLOCKS: u32 = 16;

/// An asynchronous transmit pin's bridge onto its net, once the guest has
/// handed the pin a byte.
#[derive(Debug)]
struct TxLink {
    bridge: Arc<SerialLevelBridge>,
    baud_hz: u32,
}

/// Everything the core's wake, its pad senses, its bus and its handles
/// share; [`package::CoreShared`] holds the rest.
#[derive(Debug, Default)]
struct Shared {
    /// Live transmit bridges, keyed by pin. Ordered maps, here and below:
    /// the wake walks them, and the order it services pins in must not
    /// depend on a hash (embsim `DESIGN.md` rule 7).
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
    /// Times the guest stopped for a change outside the chip (diagnostics).
    net_yields: AtomicU64,
    /// The virtual instant the guest's clock had reached at the end of the
    /// last wake: what a handle reads without waiting on the machine.
    guest_now_ns: AtomicU64,
    /// Line feeds the guest has handed its debug pin (`P62`).
    console_lines: AtomicU64,

    /// Net transitions awaiting the guest, oldest first.
    ///
    /// An ordered queue, deliberately, and not a level snapshot. A pad sense
    /// fires once per resolved change in engine sequence order, but the
    /// guest reads its pins only when a wake runs it — so sampling levels
    /// there would collapse every transition that happened in between. For
    /// an endstop that is invisible. For a quadrature pair it is fatal: the
    /// count *is* the transition history, and two folded edges read as a
    /// two-state jump whose direction cannot be recovered.
    ///
    /// Staged here rather than written straight into [`p2core::Board`] because
    /// sense callbacks and the wake handler both run on the engine thread and
    /// the machine's mutex is not reentrant.
    edges: Mutex<VecDeque<(u8, bool)>>,
    /// Transitions dropped because the queue was full — a guest that has
    /// stopped being stepped. Counted so a test can assert it is zero rather
    /// than silently reading a stale pin.
    edges_dropped: AtomicU64,
    /// Pads running step trains onto their nets, keyed by pin.
    pulse: Mutex<BTreeMap<u8, Arc<PulseDriver>>>,
    /// The trap that stopped the guest, if one has.
    trap: Mutex<Option<String>>,
}

/// The [`PinBus`] of a [`P2IssCore`]: every pad on its net, each playing the
/// role its mode word gives it (`package.rs`, "A pad's role is the guest's").
///
/// [`p2core::Board`] models the pins themselves — the smart pins' modes, the
/// synchronous-serial hardware, the quadrature decoders — and this carries
/// what the guest does with them out to the nets, each change at the instant
/// the guest made it.
struct NetPins {
    inner: Board,
    shared: Arc<Shared>,
    /// What the core's wake, pad senses and handle share.
    core_shared: Arc<package::CoreShared>,
    /// The pads' handle table, filled at attach; `None` before it, when a
    /// byte handed to a transmit pin is dropped.
    io: Option<ComponentNetIo>,
    shutdown: Arc<AtomicBool>,
    /// The clock of the instruction executing now ([`PinBus::set_clock`]).
    clock: u64,
    /// Set when the guest did something outside the chip, so
    /// [`p2core::Machine::step_until_clocks`] ends the pass after it. See
    /// [`PinBus::take_net_yield`].
    net_yield: bool,
    /// The pads, filled at attach: their handles, what each was last told,
    /// the guest's clock, and the changes waiting for their instants.
    core: Option<Box<package::CorePads>>,
}

impl NetPins {
    fn new(
        inner: Board,
        shared: Arc<Shared>,
        core_shared: Arc<package::CoreShared>,
        shutdown: Arc<AtomicBool>,
    ) -> Self {
        Self {
            inner,
            shared,
            core_shared,
            io: None,
            shutdown,
            clock: 0,
            net_yield: false,
            core: None,
        }
    }

    /// Clocks one frame occupies on a transmit pin, as the guest programmed
    /// it: start bit, data bits, stop bit, each `X[31:16]` clocks. Zero until
    /// the pin is an async transmitter, so an unconfigured pin never blocks.
    pub(crate) fn tx_frame_clocks(&self, pin: u8) -> u64 {
        let smart = self.inner.pins[usize::from(pin) & 63];
        if smart.mode() != PinMode::AsyncTx {
            return 0;
        }
        u64::from(smart.frame_bits() + 2) * u64::from(smart.bit_period())
    }

    /// The rate the guest's clock runs at: the one its clock word and the
    /// crystal on `XI` give, and RCFAST's until the pads are attached.
    fn guest_clk(&self) -> u32 {
        let hz = self
            .core
            .as_ref()
            .map_or(package::RCFAST_HZ, |core| core.clock.hz());
        u32::try_from(hz).unwrap_or(u32::MAX)
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
        // The change waits for its own instant, and only the pins the write
        // moved can present something new.
        let before = self.inner.dir_out_bits();
        self.inner.dir_out_changed(cog, reg, value);
        let after = self.inner.dir_out_bits();
        let moved = (before.0 ^ after.0) | (before.1 ^ after.1);
        if moved != 0 {
            self.core_note_pads(moved);
        }
    }

    fn defers_streamer(&self) -> bool {
        // Every edge is a change at its own instant, and a flash's answer to
        // one edge is on its net by the next.
        true
    }

    fn stream_burst_started(&mut self, clock_pin: u8) {
        self.core_op(package::CoreOp::StreamStart { clock_pin });
    }

    fn clocks_synchronously(&self, pin: u8) -> bool {
        // By speed: a transition pin toggling every
        // `SYNC_CLOCK_MAX_TRANSITION_CLOCKS` clocks or faster is a bus clock,
        // whose every edge something samples (loadp2 runs the flash's clock
        // at one clock a transition); slower, it is a step train, a rate on
        // its net (the firmware's step output, whose transitions are 80
        // clocks apart and more).
        self.inner.pins[usize::from(pin & 63)].x & 0xFFFF <= SYNC_CLOCK_MAX_TRANSITION_CLOCKS
    }

    fn pin_cfg(&self, pin: u8) -> u32 {
        // The streamer asks which mode a pin is in to find its clock.
        self.inner.pins[usize::from(pin & 63)].cfg
    }

    fn set_pad(&mut self, pin: u8, high: bool) {
        self.inner.set_pad(pin, high);
        self.core_note_pads(1u64 << (pin & 63));
    }

    fn toggle_pad(&mut self, pin: u8) {
        self.inner.toggle_pad(pin);
        self.core_note_pads(1u64 << (pin & 63));
    }

    fn pad_level(&self, pin: u8) -> bool {
        self.inner.pad_level(pin)
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
            // AKPIN (`WRPIN #1`): a receive pin drops `IN`; otherwise the
            // board routes the acknowledge to the sync receiver if the pin is
            // one.
            if !self.core_acknowledge_rx(pin) {
                self.inner.wrpin(pin, cfg);
            }
            return;
        }
        self.inner.wrpin(pin, cfg);
        // The pad's role follows its new mode word, at the instant the guest
        // wrote it.
        self.core_op(package::CoreOp::Wrpin { pin: pin & 63, cfg });
    }

    fn wxpin(&mut self, pin: u8, x: u32) {
        self.inner.wxpin(pin, x);
        // A receive pin's bit period is its rate.
        self.core_wxpin(pin);
    }

    fn wypin(&mut self, pin: u8, y: u32) {
        if pin & 63 == p2core::board::PIN_TX && y as u8 == b'\n' {
            self.shared.console_lines.fetch_add(1, Ordering::Relaxed);
        }
        // The bus is clocked on the guest's own clock, and every other WYPIN
        // with an effect outside waits for the instant the guest wrote it.
        self.core_wypin(pin, y);
    }

    fn rdpin(&mut self, pin: u8) -> (u32, bool) {
        if let Some(read) = self.core_rdpin(pin) {
            return read;
        }
        self.inner.rdpin(pin)
    }

    fn testp(&self, pin: u8) -> bool {
        self.core_testp(pin)
            .unwrap_or_else(|| self.inner.testp(pin))
    }

    fn akpin(&mut self, pin: u8) {
        if !self.core_acknowledge_rx(pin) {
            self.inner.akpin(pin);
        }
    }

    fn take_net_yield(&mut self) -> bool {
        std::mem::take(&mut self.net_yield)
    }

    fn set_clock(&mut self, clocks: u64) {
        self.clock = clocks;
    }

    fn next_pin_change(&self, now: u64) -> Option<u64> {
        self.core_next_pin_change(now)
    }
}

/// A cloneable view onto a [`P2IssCore`].
///
/// `System::start` takes ownership of the package the core sits in, so
/// anything that wants to interrogate the machine afterwards holds one of
/// these — the same pattern `embsim_models`' ADS122U04 uses for its own
/// state.
#[derive(Clone)]
pub struct P2IssHandle {
    shared: Arc<Shared>,
    machine: Arc<Mutex<Machine<NetPins>>>,
    core: Arc<package::CoreShared>,
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
    /// from the pin's `WXPIN` divisor and the rate the clock runs at
    /// ([`Self::clock_hz`]).
    pub fn derived_baud(&self, tx_pin: u8) -> Option<u32> {
        self.shared
            .tx
            .lock()
            .expect("tx map never poisoned")
            .get(&tx_pin)
            .map(|link| link.baud_hz)
    }

    /// The virtual instant the guest's clock has reached, in microseconds,
    /// from its START instant on.
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
    /// guest never sees them.
    pub fn rx_overruns(&self, rx_pin: u8) -> u64 {
        self.core.rx_overruns(rx_pin)
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

    /// Times the guest stopped for a change outside the chip.
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

    /// Each cog's state, for diagnosis: `(cog, running, pc, hub FIFO
    /// pointer)`.
    pub fn cogs(&self) -> Vec<(usize, bool, u32, u32)> {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .cogs
            .iter()
            .enumerate()
            .map(|(i, c)| (i, c.running, c.pc, c.fifo_addr))
            .collect()
    }

    /// `len` bytes of hub RAM from `addr`, for diagnosis.
    pub fn hub_bytes(&self, addr: usize, len: usize) -> Vec<u8> {
        let machine = self.machine.lock().expect("machine never poisoned");
        (addr..addr + len)
            .map(|a| machine.hub[a % machine.hub.len()])
            .collect()
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
