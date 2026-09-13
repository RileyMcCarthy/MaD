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
pub mod host_pty;
pub mod pulse;
use crate::pulse::PulseDriver;
pub mod sdimage;
pub mod sdnode;
pub use host_pty::HostPty;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use embsim_board::uart::{UartDecoder, UartFraming};
use embsim_board::{
    digital_drive, level_of, AttachError, Component, ComponentNetIo, Level, PinDecl, PinHandle,
    PinKind, SerialLevelBridge, StreamRole,
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

/// Assumed clock frequency before the guest has recorded its own at hub `$14`.
const NOMINAL_CLKFREQ: u32 = 160_000_000;

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

/// Bytes a receive pin has deframed and the guest has not yet read.
type RxQueue = Arc<Mutex<VecDeque<u8>>>;

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
    /// Deframed receive bytes, keyed by pin.
    rx: HashMap<u8, RxQueue>,
    /// Receive deframers, keyed by pin.
    ///
    /// Shared with the wake handler rather than owned by the sense callback:
    /// a frame whose tail carries no transition closes only on its deadline,
    /// so *something* has to poll. Leaving that to the sense callback alone
    /// silently drops the last byte of every burst.
    rx_decoders: HashMap<u8, Arc<Mutex<UartDecoder>>>,
    /// Live transmit bridges, keyed by pin. Built on first transmit, once the
    /// smart pin has been configured and its baud can be derived.
    tx: Mutex<HashMap<u8, TxLink>>,
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
    pulse: Mutex<HashMap<u8, Arc<PulseDriver>>>,
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
    /// Pins carried on nets as plain levels — see [`P2Iss::with_level_pins`].
    level_pins: Vec<u8>,
    /// Pins that emit pulse trains — see [`P2Iss::with_pulse_pins`].
    pulse_pins: Vec<u8>,
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
}

impl NetPins {
    fn link_for_tx(&self, pin: u8) -> Option<&SerialLink> {
        self.links.iter().find(|l| l.tx_pin == pin)
    }

    /// The framing this pin is programmed for, or the declared nominal until
    /// the guest has configured it.
    ///
    /// Disagreement is logged rather than corrected: the derived rate is the
    /// truth (it is what the hardware would do), and a mismatch means the
    /// firmware's `clkfreq` or divisor is wrong — which is the class of bug an
    /// ISS exists to find.
    fn framing_for(&self, pin: u8, nominal: u32) -> (UartFraming, u32) {
        let clk = match self.clkfreq {
            0 => NOMINAL_CLKFREQ,
            f => f,
        };
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

    /// Begin (or retune) the train `WYPIN` just asked for.
    ///
    /// The mode and half-period are read back out of the smart pin rather than
    /// declared here, for the same reason the serial rate is: `_pinstart`
    /// wrote them, so they are a decoded fact. A firmware that programs the
    /// wrong divisor moves the carriage at the wrong speed *here*, which is
    /// the class of bug the ISS exists to surface.
    fn start_pulse(&mut self, pin: u8, y: u32) {
        let clk = match self.clkfreq {
            0 => NOMINAL_CLKFREQ,
            f => f,
        };
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
                return;
            }
        }
        if let (Some(next), Some(io)) = (driver.service(now), self.io.as_ref()) {
            io.schedule_at_ns(next);
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
        let clk = match self.clkfreq {
            0 => NOMINAL_CLKFREQ,
            f => f,
        };
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
        self.publish_levels();
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
            handle.set_drive(
                want.map(|high| digital_drive(if high { Level::High } else { Level::Low })),
            );
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
        self.inner.dir_out_changed(cog, reg, value);
        // Direction and output are the same event as far as a net is
        // concerned: either can turn a pin from high-Z into a driver or back.
        self.publish_levels();
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
            self.inner.wrpin(pin, cfg);
            return;
        }
        self.inner.wrpin(pin, cfg);
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
    }

    fn wypin(&mut self, pin: u8, y: u32) {
        // A sync-serial pin (clock, TX): the board handles the shift/pending;
        // a clock burst additionally arms the first edge so the pump paces it.
        // Only THIS pin being a bus pin routes here. Testing "does any clock
        // exist" instead swallowed every other WYPIN — the protocol and
        // force-gauge transmit pins, the pulse train — into the byte-path
        // board the moment the stepper's step pin was configured, and the
        // guest went silent on the wire.
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
        if let std::collections::hash_map::Entry::Vacant(slot) = tx.entry(pin) {
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
        if let Some(queue) = self.shared.rx.get(&pin) {
            // `HAL_serial_recieveByte` takes the byte from bits 31:24, where an
            // async-RX smart pin leaves it.
            let byte = queue.lock().expect("rx queue never poisoned").pop_front();
            return (byte.map(|b| u32::from(b) << 24).unwrap_or(0), false);
        }
        self.inner.rdpin(pin)
    }

    fn testp(&self, pin: u8) -> bool {
        if let Some(queue) = self.shared.rx.get(&pin) {
            return !queue.lock().expect("rx queue never poisoned").is_empty();
        }
        self.inner.testp(pin)
    }

    fn akpin(&mut self, pin: u8) {
        self.inner.akpin(pin);
    }

    fn take_net_yield(&mut self) -> bool {
        std::mem::take(&mut self.net_yield)
    }
}

impl NetPins {
    fn new(inner: Board, links: Vec<SerialLink>, shared: Arc<Shared>) -> Self {
        Self {
            inner,
            links,
            shared,
            io: None,
            shutdown: Arc::new(AtomicBool::new(false)),
            clkfreq: 0,
            level_pins: Vec::new(),
            pulse_pins: Vec::new(),
            level_handles: [const { None }; 64],
            published: [None; 64],
            net_yield: false,
            next_edge_ns: None,
            armed_edge_ns: None,
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

    /// Virtual microseconds of guest time executed so far.
    pub fn guest_now_us(&self) -> u64 {
        self.machine
            .lock()
            .expect("machine never poisoned")
            .now_us()
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

    /// Transitions a pulse pin has put on its net.
    ///
    /// This is the price of carrying a rate as voltages, in the only units
    /// that matter: engine events. Assert on it when the question is cost.
    pub fn pulse_edges(&self, pin: u8) -> u64 {
        self.shared
            .pulse
            .lock()
            .expect("pulse map never poisoned")
            .get(&pin)
            .map_or(0, |d| d.emitted())
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
                .insert(link.rx_pin, Arc::new(Mutex::new(VecDeque::new())));
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
            pins.push(PinDecl {
                number: pin_name(link.tx_pin),
                name: None,
                kind: PinKind::DigitalOut,
                stream: None,
                drive_impedance: None,
            });
            pins.push(PinDecl {
                number: pin_name(link.rx_pin),
                name: None,
                kind: PinKind::DigitalIn,
                stream: None,
                drive_impedance: None,
            });
        }
        let shared = Arc::new(shared);
        let mut bus = NetPins::new(Board::new(card), links.to_vec(), Arc::clone(&shared));
        bus.shutdown = Arc::clone(&shutdown);
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
    /// These are declared [`PinKind::DigitalBidir`], because the guest decides
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
            self.pins.push(PinDecl {
                number: pin_name(pin),
                name: None,
                kind: PinKind::DigitalBidir,
                stream: None,
                drive_impedance: None,
            });
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
            self.pins.push(PinDecl {
                number: pin_name(pin),
                name: None,
                kind: PinKind::DigitalIn,
                stream: None,
                drive_impedance: None,
            });
            self.sense_pins.push(pin);
        }
        self
    }

    /// Carry `pins` on nets as **pulse trains**: timed level transitions.
    ///
    /// The step train is the firmware's one continuous, rate-carried output,
    /// and this is where it becomes a voltage like everything else. Each edge
    /// is a Thevenin drive the net resolves, so a stepper model on the far end
    /// counts real transitions rather than being handed a number.
    ///
    /// The cost is honest and measurable: see [`P2IssHandle::pulse_edges`]. A
    /// finite `P_TRANSITION` train costs one event per edge for the length of
    /// a move; a continuous `P_NCO_FREQ` wave costs one per edge for as long as
    /// it runs, which is the case a rate-carried drive would collapse.
    pub fn with_pulse_pins(mut self, pins: &[u8]) -> Self {
        for &pin in pins {
            if self.pins.iter().any(|d| d.number == pin_name(pin)) {
                continue;
            }
            self.pins.push(PinDecl {
                number: pin_name(pin),
                name: None,
                kind: PinKind::DigitalOut,
                // A step train is a rate. Declaring the source role lets the
                // engine route it to the drive's `PulseSink` as one event per
                // rate change, instead of one wheel deadline per edge that a
                // late service silently collapses.
                stream: Some(StreamRole::PulseSource),
                drive_impedance: None,
            });
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
                .set_drive(Some(digital_drive(Level::High)));
        }

        // Pulse pins: one driver each, holding its facade handle. Built here
        // rather than on first `WYPIN` because a train's first edge is due one
        // half-period after the command, and building lazily would spend that
        // half-period looking the handle up.
        {
            let mut map = self.shared.pulse.lock().expect("pulse map never poisoned");
            for &pin in &self.pulse_pins {
                let handle = io.pin(pin_name(pin))?;
                // `None` when nothing on the net declared a sink: the engine
                // routes no train, and the driver falls back to edges.
                let tx = io.pulse_tx(pin_name(pin)).ok();
                let driver = Arc::new(PulseDriver::new(pin, handle).with_tx(tx));
                driver.idle();
                map.insert(pin, driver);
            }
        }

        // Level pins: whatever the net resolves becomes the pin's input on
        // the next slice. `Floating` and `Contention` deliberately hold the
        // last level rather than inventing one — the same rule
        // `SerialLevelBridge` follows, for the same reason: an unresolvable
        // net is not a logic value, and guessing one hides the fault.
        for &pin in &self.sense_pins {
            let shared = Arc::clone(&self.shared);
            let shutdown = Arc::clone(&self.shutdown);
            io.on_sense(pin_name(pin), move |state| {
                if shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                // `Floating` and `Contention` hold the last level rather
                // than inventing one, the same rule `SerialLevelBridge`
                // follows: an unresolvable net is not a logic value.
                let Some(level) = level_of(state) else {
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

        // Receive: the pin's resolved state feeds a deframer, and whatever it
        // decodes waits for the guest's next `RDPIN`.
        for link in &self.links {
            let queue = Arc::clone(&self.shared.rx[&link.rx_pin]);
            let counted = Arc::clone(&self.shared);
            let decoder = Arc::clone(&self.shared.rx_decoders[&link.rx_pin]);
            let shutdown = Arc::clone(&self.shutdown);
            let arm = io.clone();
            io.on_sense(pin_name(link.rx_pin), move |state| {
                if shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                let now = virtual_clock::virtual_ns();
                let mut rx = decoder.lock().expect("decoder never poisoned");
                if let Some(level) = embsim_board::level_of(state) {
                    rx.on_level(level, now);
                }
                while let Some(frame) = rx.poll(now) {
                    match frame {
                        Ok(byte) => {
                            counted.rx_bytes.fetch_add(1, Ordering::Relaxed);
                            queue
                                .lock()
                                .expect("rx queue never poisoned")
                                .push_back(byte);
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
                // Advance every running pulse train and arm the next edge.
                // Trains are serviced after the guest has stepped, so a
                // `WYPIN` issued this slice has its first edge scheduled from
                // the moment it was issued rather than a slice later.
                {
                    let map = shared.pulse.lock().expect("pulse map never poisoned");
                    let mut next: Option<u64> = None;
                    for driver in map.values() {
                        if let Some(at) = driver.service(now_ns) {
                            next = Some(next.map_or(at, |n: u64| n.min(at)));
                        }
                    }
                    if let Some(at) = next {
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
                                    .expect("rx queue never poisoned")
                                    .push_back(byte);
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
