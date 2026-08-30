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

pub struct Board {
    pub card: SdCard,
    /// Bytes the firmware transmitted on the debug UART.
    pub console: Vec<u8>,
    /// Bytes queued for the firmware to receive on the debug UART.
    pub uart_rx: VecDeque<u8>,
    mode: [u32; 64],
    /// Receive width in bits, from `WXPIN` on the DO pin.
    rx_bits: u32,
    /// Bytes the host queued to send, oldest first.
    tx: VecDeque<u8>,
    /// Words clocked in and not yet read. `rcvr_mmc` issues ONE `wypin` on the
    /// clock pin for a whole multi-longword burst and then `rdpin`s each word
    /// in turn, so a single value would lose all but the last.
    rx_queue: VecDeque<u32>,
    in_flag: [bool; 64],
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
            mode: [0; 64],
            rx_bits: 8,
            tx: VecDeque::new(),
            rx_queue: VecDeque::new(),
            in_flag: [false; 64],
        }
    }

    /// Everything the firmware printed to the debug UART.
    pub fn console(&self) -> String {
        String::from_utf8_lossy(&self.console).into_owned()
    }

    /// Clock `bits` bits through the card, queueing one word per receive unit.
    ///
    /// `sdmm.cc` reads every word back with `rdpin` then `rev`, so the shifter
    /// hands over bit-reversed data: the value the driver wants, right-aligned,
    /// passed through `reverse_bits`. (32-bit reads then `movbyts #$1b` to
    /// endian-swap, which needs no help from us.)
    fn clock(&mut self, bits: u32) {
        let total = ((bits / 8).max(1) as usize).min(4096);
        let per_word = (self.rx_bits / 8).max(1) as usize;
        let mut chunk: u32 = 0;
        let mut n = 0usize;
        for _ in 0..total {
            // With nothing queued the line idles high, which is what the host
            // sends while clocking a response out of the card.
            let out = self.tx.pop_front().unwrap_or(0xFF);
            let got = self.card.xfer(out);
            chunk = (chunk << 8) | got as u32;
            n += 1;
            if n == per_word {
                self.rx_queue.push_back(chunk.reverse_bits());
                chunk = 0;
                n = 0;
            }
        }
        if n != 0 {
            self.rx_queue.push_back(chunk.reverse_bits());
        }
        self.in_flag[PIN_DO as usize] = true;
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
            PIN_DI => {
                // Queue transmit data MSB-first, matching SPI bit order.
                for i in (0..4).rev() {
                    self.tx.push_back((y >> (i * 8)) as u8);
                }
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
            PIN_DO => self.rx_queue.pop_front().unwrap_or(0xFFFF_FFFF),
            PIN_RX => self.uart_rx.pop_front().map(|b| b as u32).unwrap_or(0),
            _ => 0xFF,
        };
        // C reports BUSY; nothing here ever is.
        (v, false)
    }

    fn testp(&self, pin: u8) -> bool {
        let p = pin as usize & 63;
        self.in_flag[p] || self.mode[p] != 0
    }

    fn akpin(&mut self, pin: u8) {
        self.in_flag[pin as usize & 63] = false;
    }
}
