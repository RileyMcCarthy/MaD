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

pub mod host_pty;
pub use host_pty::HostPty;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use embsim_board::uart::{UartDecoder, UartFraming};
use embsim_board::{AttachError, Component, ComponentNetIo, PinDecl, PinKind, SerialLevelBridge};
use embsim_core::virtual_clock;
use p2core::{Board, Machine, PinBus, SdCard};

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

fn pin_name(pin: u8) -> &'static str {
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
}

impl PinBus for NetPins {
    fn ina(&self) -> u32 {
        self.inner.ina()
    }

    fn inb(&self) -> u32 {
        self.inner.inb()
    }

    fn dir_out_changed(&mut self, reg: u16, value: u32) {
        self.inner.dir_out_changed(reg, value);
    }

    fn wrpin(&mut self, pin: u8, cfg: u32) {
        self.inner.wrpin(pin, cfg);
    }

    fn wxpin(&mut self, pin: u8, x: u32) {
        self.inner.wxpin(pin, x);
    }

    fn wypin(&mut self, pin: u8, y: u32) {
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
        }
    }
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

    /// `(bytes the guest transmitted, bytes deframed off the wire)`.
    pub fn byte_counts(&self) -> (u64, u64) {
        (
            self.shared.tx_bytes.load(Ordering::Relaxed),
            self.shared.rx_bytes.load(Ordering::Relaxed),
        )
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
            shared,
            machine: Arc::new(Mutex::new(Machine::new(image, bus))),
            shutdown,
        }
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
                        Err(error) => tracing::debug!(
                            ?error,
                            "p2iss: receive frame dropped (bad framing on the wire)"
                        ),
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
                    if let Err(trap) = machine.step_until(now_ns / 1_000) {
                        tracing::error!(%trap, "p2iss: the guest trapped; it will not run again");
                        shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
                        return;
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
                            Err(error) => tracing::debug!(
                                pin,
                                ?error,
                                "p2iss: receive frame dropped (bad framing on the wire)"
                            ),
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
