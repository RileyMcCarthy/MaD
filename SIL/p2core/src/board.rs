//! A MaD board: the debug UART plus an SD card on the P2's SPI smart pins.
//!
//! Pin roles were read off the firmware's own traffic rather than assumed
//! (see `examples/pinlog.rs`), and match `sdmm.cc`'s smart-pin SPI routines:
//!
//! | pin | role | how the firmware drives it                     |
//! |-----|------|------------------------------------------------|
//! | 58  | DO   | `wxpin #7\|32` (8 bits, sample on rising), `rdpin` |
//! | 59  | DI   | `wxpin #31` (32 bits), `wypin` data            |
//! | 60  | CS   | plain GPIO (`wrpin cfg=0`), driven via DIRB/OUTB |
//! | 61  | CLK  | `wypin n` generates n clocks — the transfer trigger |
//! | 62  | TX   | async serial out (the debug console)            |
//! | 63  | RX   | async serial in                                 |
//!
//! A transfer is: set the receive width, queue transmit data, then clock it.
//! Clocking is what actually moves bytes, so [`Board::wypin`] on the clock pin
//! is where the SPI exchange happens.

use std::collections::VecDeque;

use crate::sdcard::SdCard;
use crate::PinBus;

pub const PIN_DO: u8 = 58;
pub const PIN_DI: u8 = 59;
pub const PIN_CS: u8 = 60;
pub const PIN_CLK: u8 = 61;
pub const PIN_TX: u8 = 62;
pub const PIN_RX: u8 = 63;
/// The MaD protocol link to the host (`HW_PIN_RPI_*`), 2,000,000 baud.
pub const PIN_PROTO_TX: u8 = 55;
pub const PIN_PROTO_RX: u8 = 53;

pub struct Board {
    pub card: SdCard,
    /// Bytes the firmware transmitted on the debug UART.
    pub console: Vec<u8>,
    /// Bytes queued for the firmware to receive on the debug UART.
    pub uart_rx: VecDeque<u8>,
    /// Bytes the firmware transmitted on the protocol link.
    pub proto_tx: Vec<u8>,
    /// Bytes queued for the firmware to receive on the protocol link.
    pub proto_rx: VecDeque<u8>,
    mode: [u32; 64],
    /// Receive width in bits, from `WXPIN` on the DO pin.
    rx_bits: u32,
    /// Bytes the host queued to send, oldest first.
    tx: VecDeque<u8>,
    /// Byte-times the clock generator still owes. `xmit_mmc` starts the clocks
    /// for a whole frame and *then* feeds the remaining longwords, so the
    /// transfer must drain as data arrives rather than complete at the WYPIN.
    pending: u32,
    /// Words clocked in and not yet read. `rcvr_mmc` issues ONE `wypin` on the
    /// clock pin for a whole multi-longword burst and then `rdpin`s each word
    /// in turn, so a single value would lose all but the last.
    rx_queue: VecDeque<u32>,
    in_flag: [bool; 64],
    /// Raw WYPIN values seen on the DI pin, for bring-up.
    pub di_log: Vec<u32>,
}

impl Default for Board {
    fn default() -> Self {
        Self::new(SdCard::blank(0))
    }
}

impl Board {
    pub fn new(card: SdCard) -> Self {
        Self {
            card,
            console: Vec::new(),
            uart_rx: VecDeque::new(),
            proto_tx: Vec::new(),
            proto_rx: VecDeque::new(),
            mode: [0; 64],
            rx_bits: 8,
            tx: VecDeque::new(),
            pending: 0,
            rx_queue: VecDeque::new(),
            in_flag: [false; 64],
            di_log: Vec::new(),
        }
    }

    /// Queue bytes for the firmware to read on the protocol link.
    pub fn send_protocol(&mut self, bytes: &[u8]) {
        self.proto_rx.extend(bytes.iter().copied());
    }

    /// Whether the firmware has configured this smart pin.
    pub fn is_configured(&self, pin: u8) -> bool {
        self.mode[pin as usize & 63] != 0
    }

    /// Everything the firmware printed to the debug UART.
    pub fn console(&self) -> String {
        String::from_utf8_lossy(&self.console).into_owned()
    }

    /// Exchange as many owed byte-times as there is data queued for.
    ///
    /// `fill` supplies bytes once the host's queue runs dry, which is how a
    /// pure receive works: the host clocks with the line idling high.
    fn drain(&mut self, fill: bool) {
        let per_word = (self.rx_bits / 8).max(1) as usize;
        while self.pending > 0 && (fill || !self.tx.is_empty()) {
            let mut chunk: u32 = 0;
            let mut n = 0;
            while n < per_word && self.pending > 0 {
                let out = self.tx.pop_front().unwrap_or(0xFF);
                let got = self.card.xfer(out);
                chunk = (chunk << 8) | got as u32;
                self.pending -= 1;
                n += 1;
            }
            // `sdmm.cc` reads every word back with `rdpin` then `rev`, so the
            // shifter hands over bit-reversed data.
            self.rx_queue.push_back(chunk.reverse_bits());
            self.in_flag[PIN_DO as usize] = true;
        }
    }

    /// Clock `bits` bits through the card, queueing one word per receive unit.
    ///
    /// `sdmm.cc` reads every word back with `rdpin` then `rev`, so the shifter
    /// hands over bit-reversed data: the value the driver wants, right-aligned,
    /// passed through `reverse_bits`. (32-bit reads then `movbyts #$1b` to
    /// endian-swap, which needs no help from us.)
    fn clock(&mut self, bits: u32) {
        self.pending += (bits / 8).max(1).min(4096);
        // Only exchange what the host has already queued; the rest drains as
        // `xmit_mmc` feeds it, or fills with idles when a read is attempted.
        self.drain(false);
    }
}

impl PinBus for Board {
    fn inb(&self) -> u32 {
        0
    }

    fn dir_out_changed(&mut self, reg: u16, value: u32) {
        // OUTB bit 28 is pin 60 (CS). SPI selects on CS low.
        if reg == 0x1FD {
            let cs_high = value & (1 << (PIN_CS - 32)) != 0;
            self.card.selected = !cs_high;
        }
    }

    fn wrpin(&mut self, pin: u8, cfg: u32) {
        let p = pin as usize & 63;
        // AKPIN is literally `WRPIN #1,S`, so a cfg of 1 is an acknowledge --
        // `rcvr_mmc` opens with `akpin PIN_DO` to clear the rx buffer. Treating
        // it as a mode write would wipe the pin's sync-serial configuration.
        if cfg == 1 {
            self.in_flag[p] = false;
            self.rx_queue.clear();
            return;
        }
        self.mode[p] = cfg;
        self.in_flag[p] = cfg != 0;
    }

    fn wxpin(&mut self, pin: u8, x: u32) {
        if pin == PIN_DO {
            // %1IIIII where the low five bits are (bits - 1); bit 5 selects
            // sampling after the rising clock edge.
            self.rx_bits = (x & 0x1F) + 1;
        }
        self.in_flag[pin as usize & 63] = true;
    }

    fn wypin(&mut self, pin: u8, y: u32) {
        match pin {
            PIN_TX => self.console.push(y as u8),
            PIN_PROTO_TX => self.proto_tx.push(y as u8),
            PIN_DI => {
                if self.di_log.len() < 64 {
                    self.di_log.push(y);
                }
                // The TX shifter sends LSB-first, which is why `xmit_mmc`
                // pre-applies `rev` + `movbyts` before WYPIN. Reversing the
                // whole word here recovers the wire order: a CMD0 frame whose
                // first long reaches us as $00000002 goes out as 40 00 00 00.
                let wire = y.reverse_bits();
                for i in (0..4).rev() {
                    self.tx.push_back((wire >> (i * 8)) as u8);
                }
                self.drain(false);
            }
            PIN_CLK => {
                // Clocking is the transfer: y counts clock edges, so it moves
                // y/8 bytes. The 80 dummy clocks at init are 10 bytes; an
                // 8-clock burst is the single-byte exchange `rcvr_mmc` uses.
                self.clock(y);
            }
            _ => {}
        }
        self.in_flag[pin as usize & 63] = true;
    }

    fn rdpin(&mut self, pin: u8) -> (u32, bool) {
        let p = pin as usize & 63;
        self.in_flag[p] = false;
        let v = match pin {
            PIN_DO => {
                if self.rx_queue.is_empty() {
                    // A read with clocks still owed means a pure receive: the
                    // host is clocking with its line idle.
                    self.drain(true);
                }
                self.rx_queue.pop_front().unwrap_or(0xFFFF_FFFF)
            }
            // `HAL_serial_recieveByte` takes the byte from bits 31:24, which is
            // where an async-RX smart pin leaves it.
            PIN_RX => self.uart_rx.pop_front().map(|b| (b as u32) << 24).unwrap_or(0),
            PIN_PROTO_RX => self.proto_rx.pop_front().map(|b| (b as u32) << 24).unwrap_or(0),
            _ => 0xFF,
        };
        // C reports BUSY; nothing here ever is.
        (v, false)
    }

    fn testp(&self, pin: u8) -> bool {
        // An async RX pin reports "a byte is waiting", not "an operation
        // finished". Reporting every configured pin as ready would make
        // `HAL_serial_recieveByte` read an endless stream of zero bytes.
        match pin {
            PIN_RX => return !self.uart_rx.is_empty(),
            PIN_PROTO_RX => return !self.proto_rx.is_empty(),
            _ => {}
        }
        let p = pin as usize & 63;
        self.in_flag[p] || self.mode[p] != 0
    }

    fn akpin(&mut self, pin: u8) {
        self.in_flag[pin as usize & 63] = false;
    }
}
