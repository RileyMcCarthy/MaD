//! The boot flash as a component on the net.
//!
//! The flash logic is [`p2core::SpiFlash`] unchanged — the same command set,
//! the same rising-edge bit presentation the ROM's `drvh`/`drvl`/`testp` loop
//! reads. This wraps it in the net: it senses CLK/CS/MOSI and drives MISO, so
//! two devices (this and the microSD) can share the four Edge-module pins and
//! be told apart by chip select.
//!
//! # This works because the ISS yields at pin events
//!
//! The ROM bit-bangs the bus and samples MISO microseconds after driving the
//! clock. That only resolves correctly because the ISS yields to the engine at
//! every net-pin drive ([`p2core::PinBus::take_net_yield`]): the guest drives
//! CLK, the engine resolves and delivers this component's `on_sense`, the
//! flash drives MISO, the engine resolves again, and only then does the guest
//! read the pin back. Each clock edge is a discrete event the engine
//! serialises — which is exactly what a bit-banged external device is.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use embsim_board::{
    digital_drive, jesd8c01_lvcmos_thresholds, AttachError, Component, ComponentNetIo, DeadBand,
    DigitalReceiver, Level, PinDecl, PinHandle, Thresholds,
};
use p2core::SpiFlash;

const TH: Thresholds = jesd8c01_lvcmos_thresholds(DeadBand::Unknown);

const PINS: [PinDecl; 4] = [
    PinDecl::digital_in("CLK", TH),
    PinDecl::digital_in("CS", TH),
    PinDecl::digital_in("MOSI", TH),
    PinDecl::digital_out("MISO").with_idle(None),
];

/// Observable counters, so a test can assert the bus really moved.
#[derive(Debug, Default)]
pub struct FlashCounters {
    /// Clock edges the flash acted on (while selected).
    pub edges: AtomicU64,
}

struct Wire {
    flash: SpiFlash,
    mosi: bool,
    miso: Option<PinHandle>,
}

/// A serial flash answering on the wire.
pub struct FlashNode {
    wire: Arc<Mutex<Wire>>,
    counters: Arc<FlashCounters>,
}

impl FlashNode {
    pub fn new(image: Vec<u8>) -> Self {
        Self {
            wire: Arc::new(Mutex::new(Wire {
                flash: SpiFlash::with_image(image),
                mosi: false,
                miso: None,
            })),
            counters: Arc::new(FlashCounters::default()),
        }
    }

    pub fn counters(&self) -> Arc<FlashCounters> {
        Arc::clone(&self.counters)
    }

    /// Block addresses the flash has served `$03` reads from.
    pub fn reads(&self) -> Vec<u32> {
        self.wire
            .lock()
            .expect("wire never poisoned")
            .flash
            .reads
            .clone()
    }
}

impl std::fmt::Debug for FlashNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FlashNode").finish_non_exhaustive()
    }
}

fn drive_miso(wire: &Wire) {
    if let Some(handle) = wire.miso.as_ref() {
        handle.set_drive(Some(digital_drive(if wire.flash.miso() {
            Level::High
        } else {
            Level::Low
        })));
    }
}

impl Component for FlashNode {
    fn pins(&self) -> &[PinDecl] {
        &PINS
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        {
            let mut wire = self.wire.lock().expect("wire never poisoned");
            wire.miso = Some(io.pin("MISO")?);
            drive_miso(&wire);
        }

        {
            let wire = Arc::clone(&self.wire);
            let cs = DigitalReceiver::new(io.pin("CS")?);
            io.on_sense("CS", move |sense| {
                if let Some(level) = cs.read(&sense) {
                    let mut wire = wire.lock().expect("wire never poisoned");
                    wire.flash.set_selected(level == Level::Low);
                    drive_miso(&wire);
                }
            })?;
        }

        {
            let wire = Arc::clone(&self.wire);
            let mosi = DigitalReceiver::new(io.pin("MOSI")?);
            io.on_sense("MOSI", move |sense| {
                if let Some(level) = mosi.read(&sense) {
                    wire.lock().expect("wire never poisoned").mosi = level == Level::High;
                }
            })?;
        }

        {
            let (wire, counters) = (Arc::clone(&self.wire), Arc::clone(&self.counters));
            let clk = DigitalReceiver::new(io.pin("CLK")?);
            io.on_sense("CLK", move |sense| {
                let Some(level) = clk.read(&sense) else {
                    return;
                };
                let mut wire = wire.lock().expect("wire never poisoned");
                let mosi = wire.mosi;
                wire.flash.clock(level == Level::High, mosi);
                counters.edges.fetch_add(1, Ordering::Relaxed);
                drive_miso(&wire);
            })?;
        }
        Ok(())
    }
}
