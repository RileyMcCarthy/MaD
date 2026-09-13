//! An SD card on the net: four wires, no shortcuts.
//!
//! The protocol logic is [`p2core::SdCard`] unchanged — it is written against
//! ChaN's `sdmm.cc`, which is literally the driver the firmware runs, and it
//! already knows the SPI-mode command set. What this adds is the **wire**: chip
//! select, a clock it counts edges on, MOSI it samples and MISO it drives.
//!
//! # Why the card must be able to speak before it has finished listening
//!
//! SPI is simultaneous. The card's outgoing bits are on the wire while the
//! host's incoming byte is still arriving, so a bit-level model needs the
//! outgoing byte at the *start* of an exchange, not the end.
//! [`p2core::SdCard::peek_miso`] provides it, and doing so is exact rather
//! than an approximation: in SPI mode an SD card's response is queued by an
//! earlier command and never depends on the byte arriving now.
//!
//! # Idle
//!
//! A deselected card releases MISO. Nothing then drives that net, so the bench
//! needs the pull-up the firmware itself assumes — `sdmm.cc` configures
//! `P_HIGH_15K | P_LOW_15K` on the receive pin for exactly this. Modelled as a
//! bench resistor rather than pretended away, because "MISO reads high when no
//! card answers" is the behaviour `disk_initialize` depends on.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use embsim_board::{
    digital_drive, level_of, AttachError, Component, ComponentNetIo, Level, PinDecl, PinHandle,
    PinKind,
};
use p2core::SdCard;

/// Pin names on this component's facade.
const PINS: [PinDecl; 4] = [
    decl("CLK", PinKind::DigitalIn),
    decl("CS", PinKind::DigitalIn),
    decl("MOSI", PinKind::DigitalIn),
    decl("MISO", PinKind::DigitalOut),
];

const fn decl(number: &'static str, kind: PinKind) -> PinDecl {
    PinDecl {
        number,
        name: None,
        kind,
        stream: None,
        drive_impedance: None,
    }
}

/// A card that answers on the wire.
pub struct SdCardNode {
    card: Arc<Mutex<SdCard>>,
    wire: Arc<Mutex<Wire>>,
    counters: Arc<Counters>,
}

/// What the card has seen and is saying.
#[derive(Debug, Default)]
struct Wire {
    clk_high: bool,
    selected: bool,
    mosi: bool,
    /// Bits taken from MOSI this byte, MSB first.
    in_bits: u8,
    in_count: u32,
    /// The byte being shifted out, and how far through it we are.
    out_byte: u8,
    out_count: u32,
    miso: Option<PinHandle>,
}

/// Observable counts, so a test can assert the bus actually moved.
#[derive(Debug, Default)]
pub struct Counters {
    /// Clock edges seen.
    pub edges: AtomicU64,
    /// Whole bytes exchanged.
    pub bytes: AtomicU64,
}

impl SdCardNode {
    pub fn new(card: SdCard) -> Self {
        Self {
            card: Arc::new(Mutex::new(card)),
            wire: Arc::new(Mutex::new(Wire::default())),
            counters: Arc::new(Counters::default()),
        }
    }

    /// A view that survives handing the component to a `System`.
    pub fn counters(&self) -> Arc<Counters> {
        Arc::clone(&self.counters)
    }

    /// The card's image, for reading back what the firmware wrote.
    pub fn card(&self) -> Arc<Mutex<SdCard>> {
        Arc::clone(&self.card)
    }
}

impl std::fmt::Debug for SdCardNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SdCardNode").finish_non_exhaustive()
    }
}

/// Put the bit the card is currently presenting on MISO, or release the line
/// when the card is not selected.
fn drive_miso(wire: &Wire) {
    let Some(handle) = wire.miso.as_ref() else {
        return;
    };
    if !wire.selected {
        handle.set_drive(None);
        return;
    }
    let bit = wire.out_byte >> (7 - wire.out_count.min(7)) & 1 != 0;
    handle.set_drive(Some(digital_drive(if bit {
        Level::High
    } else {
        Level::Low
    })));
}

impl Component for SdCardNode {
    fn pins(&self) -> &[PinDecl] {
        &PINS
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        {
            let mut wire = self.wire.lock().expect("wire never poisoned");
            wire.miso = Some(io.pin("MISO")?);
            // Released until selected.
            drive_miso(&wire);
        }

        // Chip select. A deselected card releases MISO and forgets where it
        // was in a byte — the next selection starts a fresh exchange.
        {
            let (card, wire) = (Arc::clone(&self.card), Arc::clone(&self.wire));
            io.on_sense("CS", move |state| {
                let Some(level) = level_of(state) else {
                    return;
                };
                let selected = level == Level::Low;
                let mut wire = wire.lock().expect("wire never poisoned");
                if wire.selected == selected {
                    return;
                }
                wire.selected = selected;
                wire.in_count = 0;
                wire.out_count = 0;
                let mut card = card.lock().expect("card never poisoned");
                card.set_selected(selected);
                wire.out_byte = card.peek_miso();
                drop(card);
                drive_miso(&wire);
            })?;
        }

        {
            let wire = Arc::clone(&self.wire);
            io.on_sense("MOSI", move |state| {
                if let Some(level) = level_of(state) {
                    wire.lock().expect("wire never poisoned").mosi = level == Level::High;
                }
            })?;
        }

        // The clock is the engine of the whole exchange.
        {
            let (card, wire, counters) = (
                Arc::clone(&self.card),
                Arc::clone(&self.wire),
                Arc::clone(&self.counters),
            );
            io.on_sense("CLK", move |state| {
                let Some(level) = level_of(state) else {
                    return;
                };
                let high = level == Level::High;
                let mut wire = wire.lock().expect("wire never poisoned");
                if wire.clk_high == high || !wire.selected {
                    wire.clk_high = high;
                    return;
                }
                wire.clk_high = high;
                counters.edges.fetch_add(1, Ordering::Relaxed);

                // SPI mode 3, as the driver programs it (`P_INVERT_OUTPUT`,
                // "CPOL = 1"): the clock idles high, both ends drive on the
                // falling (leading) edge and sample on the rising (trailing)
                // one.
                if high {
                    // Trailing edge: the host's bit is stable.
                    wire.in_bits = (wire.in_bits << 1) | u8::from(wire.mosi);
                    wire.in_count += 1;
                    if wire.in_count == 8 {
                        wire.in_count = 0;
                        let byte = wire.in_bits;
                        wire.in_bits = 0;
                        // The card consumes the byte; what it returns is what
                        // has already been shifted out, bit by bit.
                        card.lock().expect("card never poisoned").xfer(byte);
                        counters.bytes.fetch_add(1, Ordering::Relaxed);
                    }
                    // Move to the next outgoing bit only after sampling, so a
                    // byte boundary lands in the same place both ways.
                    wire.out_count += 1;
                    if wire.out_count == 8 {
                        wire.out_count = 0;
                        wire.out_byte = card.lock().expect("card never poisoned").peek_miso();
                    }
                } else {
                    // Leading edge: present the bit this pulse carries.
                    drive_miso(&wire);
                }
            })?;
        }
        Ok(())
    }
}
