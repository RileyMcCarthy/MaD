//! A bring-up smart-pin model.
//!
//! This is deliberately *not* part of the CPU. `p2core` stays a pure
//! interpreter whose only outward surface is [`crate::PinBus`]; this module is
//! a reference implementation of the other side of that trait, good enough to
//! get the firmware through startup and out to its serial port.
//!
//! It models completion, not timing: every smart-pin operation finishes
//! instantly. That is the right first step — it unblocks the firmware without
//! pretending to a fidelity we cannot verify — but it is exactly the shortcut
//! that hides a wrong `clkfreq` or bit period. The bit-level version, where
//! each pin drives a net at its configured baud, belongs in embsim next to the
//! electrical net model, and this type is shaped to be replaced by it.
//!
//! # Polarity, learned the hard way
//!
//! - `RDPIN ... WC` sets C for **busy**, not ready. `__system___txraw` spins on
//!   `rdpin #62 wc` / `if_b jmp`, so reporting "busy" here hangs the guest.
//! - `TESTP ... WC` sets C from the pin's IN flag and drivers spin with
//!   `if_nc jmp` waiting for it. Drivers commonly `AKPIN` (clearing IN) and
//!   *then* wait for hardware to raise it again, so a configured pin must read
//!   as complete or the SD SPI driver spins forever.

use crate::PinBus;

/// Number of P2 smart pins.
const PINS: usize = 64;

/// Pins carrying the FlexC debug UART; `_txraw`/`_rxraw` hard-code these.
pub const PIN_TX: u8 = 62;
pub const PIN_RX: u8 = 63;

/// A smart-pin bank that completes every operation immediately.
pub struct SmartPins {
    /// Last `WRPIN` mode word per pin; non-zero means "configured".
    pub mode: [u32; PINS],
    /// Last `WXPIN` parameter per pin (bit period / transfer width).
    pub x: [u32; PINS],
    /// Pending IN flag per pin.
    pub in_flag: [bool; PINS],
    /// Bytes the guest transmitted, as `(pin, byte)`.
    pub tx: Vec<(u8, u8)>,
    /// Bytes queued for the guest to receive, as `(pin, byte)`.
    pub rx: Vec<(u8, u8)>,
    /// Value `RDPIN` returns for pins with no queued data.
    ///
    /// `$FF` reads as an idle (pulled-high) line, which is what an absent SD
    /// card looks like on MISO — so `disk_initialize` fails its retries and the
    /// firmware takes its documented mount-failure path instead of hanging.
    pub idle_value: u32,
    /// Pin level bits 0..31 / 32..63, driven by DIRx/OUTx writes.
    pub out: [u32; 2],
    pub dir: [u32; 2],
}

impl Default for SmartPins {
    fn default() -> Self {
        Self {
            mode: [0; PINS],
            x: [0; PINS],
            in_flag: [false; PINS],
            tx: Vec::new(),
            rx: Vec::new(),
            idle_value: 0xFF,
            out: [0; 2],
            dir: [0; 2],
        }
    }
}

impl SmartPins {
    /// Bytes transmitted on one pin, in order.
    pub fn tx_bytes(&self, pin: u8) -> Vec<u8> {
        self.tx
            .iter()
            .filter(|(p, _)| *p == pin)
            .map(|(_, b)| *b)
            .collect()
    }

    /// Everything the guest sent to the debug UART, as text.
    pub fn console(&self) -> String {
        String::from_utf8_lossy(&self.tx_bytes(PIN_TX)).into_owned()
    }

    /// Queue a byte for the guest to read from `pin`.
    pub fn feed(&mut self, pin: u8, byte: u8) {
        self.rx.push((pin, byte));
        self.in_flag[pin as usize & 63] = true;
    }

    fn take_rx(&mut self, pin: u8) -> Option<u8> {
        let idx = self.rx.iter().position(|(p, _)| *p == pin)?;
        Some(self.rx.remove(idx).1)
    }
}

impl PinBus for SmartPins {
    fn ina(&self) -> u32 {
        self.out[0]
    }
    fn inb(&self) -> u32 {
        self.out[1]
    }

    fn dir_out_changed(&mut self, reg: u16, value: u32) {
        // $1FA/$1FB are DIRA/DIRB, $1FC/$1FD are OUTA/OUTB.
        match reg {
            0x1FA => self.dir[0] = value,
            0x1FB => self.dir[1] = value,
            0x1FC => self.out[0] = value,
            0x1FD => self.out[1] = value,
            _ => {}
        }
    }

    fn wrpin(&mut self, pin: u8, cfg: u32) {
        let p = pin as usize & 63;
        self.mode[p] = cfg;
        self.in_flag[p] = cfg != 0;
    }

    fn wxpin(&mut self, pin: u8, x: u32) {
        let p = pin as usize & 63;
        self.x[p] = x;
        self.in_flag[p] = true;
    }

    fn wypin(&mut self, pin: u8, y: u32) {
        let p = pin as usize & 63;
        self.tx.push((pin, y as u8));
        self.in_flag[p] = true;
    }

    fn rdpin(&mut self, pin: u8) -> (u32, bool) {
        let p = pin as usize & 63;
        self.in_flag[p] = false;
        let value = match self.take_rx(pin) {
            Some(b) => b as u32,
            None => self.idle_value,
        };
        // C reports BUSY; nothing here ever is.
        (value, false)
    }

    fn testp(&self, pin: u8) -> bool {
        // A configured pin always reads "operation complete" -- see the module
        // note on AKPIN-then-wait.
        let p = pin as usize & 63;
        self.in_flag[p] || self.mode[p] != 0
    }

    fn akpin(&mut self, pin: u8) {
        self.in_flag[pin as usize & 63] = false;
    }
}
