//! A serial boot flash, device side, bit-banged.
//!
//! The P2 boot ROM reads flash with plain pin instructions — `drvh`/`drvl` on
//! the clock, `testp` on the data line — in a tight loop, sampling a floated
//! pin microseconds after driving the clock. That is instant-feedback timing:
//! there is no smart pin handing off the transfer, so the device must answer
//! within the same breath the guest asks.
//!
//! This lives in [`crate::Board`], next to the SD card, for exactly that
//! reason. A net-resolved model (see `p2iss::flashnode`) is faithful to a
//! *smart-pin-clocked* flash, but a net resolves between engine wakes, and the
//! ROM's bit-bang samples faster than that. Here the pins are the board's own,
//! resolved the instant they change.
//!
//! # Pin map — the swap that matters
//!
//! On a P2 Edge the flash and the microSD share four pins with **CLK and CS
//! exchanged**: flash `CLK = P60`, `CS = P61`, versus the card's `CLK = P61`,
//! `CS = P60`. So the flash clock is the pin [`crate::Board`] calls `PIN_CS`,
//! and the flash select is the pin it calls `PIN_CLK`. The constants below
//! name them by flash function to keep the model honest.
//!
//! # Command set
//!
//! Exactly what `ROM_Booter_v33k`'s `try_spi` and the stage-1 loader issue:
//! `$66`/`$99` reset, `$04` write-disable, `$05` read-status (always `$00` —
//! idle, writable, which is how the ROM confirms a device is present), and
//! `$03` read-data with a 24-bit address.

/// Flash clock — physically P60, which the SD model calls `PIN_CS`.
pub const FLASH_CLK: u8 = 60;
/// Flash chip select — physically P61, the SD model's `PIN_CLK`.
pub const FLASH_CS: u8 = 61;
/// Flash data in (MOSI) — P59, shared with the card.
pub const FLASH_DI: u8 = 59;
/// Flash data out (MISO) — P58, shared with the card.
pub const FLASH_DO: u8 = 58;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Phase {
    #[default]
    Command,
    Address {
        have: u32,
    },
    Reading,
    Status,
}

/// A bit-banged SPI flash.
#[derive(Debug, Default)]
pub struct SpiFlash {
    image: Vec<u8>,
    selected: bool,
    clk_high: bool,
    /// Bits shifted in this byte, MSB first.
    in_bits: u8,
    in_count: u32,
    /// The byte being shifted out and how far through it we are.
    out_byte: u8,
    out_count: u32,
    /// The bit currently held on MISO, updated as the clock moves.
    miso_bit: bool,
    phase: Phase,
    addr_acc: u32,
    read_addr: u32,
    /// Starting addresses of `$03` reads served, for diagnostics/tests.
    pub reads: Vec<u32>,
    /// Output bytes fully shifted out, for diagnostics/tests.
    pub served: Vec<u8>,
}

impl SpiFlash {
    pub fn image_bytes(&self) -> Vec<u8> {
        self.image.clone()
    }

    /// A flash preloaded with `image`.
    pub fn with_image(image: Vec<u8>) -> Self {
        Self {
            image,
            ..Self::default()
        }
    }

    /// Whether any image is present. An empty flash reads all-`$FF` and the
    /// ROM's status check then finds no device.
    pub fn present(&self) -> bool {
        !self.image.is_empty()
    }

    fn next_out(&mut self) -> u8 {
        match self.phase {
            Phase::Status => 0x00,
            Phase::Reading => {
                let b = self
                    .image
                    .get(self.read_addr as usize)
                    .copied()
                    .unwrap_or(0xFF);
                self.read_addr = self.read_addr.wrapping_add(1);
                b
            }
            _ => 0xFF,
        }
    }

    /// The bit currently on MISO (P58).
    pub fn miso(&self) -> bool {
        if !self.selected {
            return true; // released line idles high (pull-up)
        }
        self.miso_bit
    }

    /// The bit at the current output position of `out_byte`.
    fn out_bit(&self) -> bool {
        self.out_byte >> (7 - self.out_count.min(7)) & 1 != 0
    }

    /// Chip select changed (CS is active-low).
    pub fn set_selected(&mut self, selected: bool) {
        if self.selected == selected {
            return;
        }
        self.selected = selected;
        self.in_count = 0;
        self.in_bits = 0;
        self.out_count = 0;
        self.phase = Phase::Command;
        self.out_byte = self.next_out();
        self.miso_bit = self.out_bit();
    }

    /// Clock a bit, sampling `mosi`. Returns after updating the outgoing bit,
    /// so the guest's next `testp` on MISO reads the fresh value.
    pub fn clock(&mut self, high: bool, mosi: bool) {
        if self.clk_high == high || !self.selected {
            self.clk_high = high;
            return;
        }
        self.clk_high = high;
        // The ROM's loop is drvh / drvl / testp, and the P2 registers the
        // input a beat late, so the bit it reads after a pulse is the one the
        // device presented *for* that pulse. Model it as: the output bit is
        // stable on MISO throughout the pulse (presented at select and after
        // each advance); MOSI is sampled on the rising edge; the position
        // advances on the falling edge, ready for the next pulse.
        if high {
            // Input: sample MOSI and assemble the command byte.
            self.in_bits = (self.in_bits << 1) | u8::from(mosi);
            self.in_count += 1;
            if self.in_count == 8 {
                self.in_count = 0;
                let byte = self.in_bits;
                self.in_bits = 0;
                self.consume(byte);
            }
            // Output: present the current bit *now*, on the rising edge, then
            // step. The ROM's `testp` runs after `drvh`/`drvl` and reads the
            // pin as it was set up for this pulse — so the bit must be on MISO
            // before the pulse ends, not after. Presenting on the falling edge
            // instead reads back one bit late and the checksum never matches.
            self.miso_bit = self.out_bit();
            self.out_count += 1;
            if self.out_count == 8 {
                if self.served.len() < 4096 {
                    self.served.push(self.out_byte);
                }
                self.out_count = 0;
                self.out_byte = self.next_out();
            }
        }
    }

    fn consume(&mut self, byte: u8) {
        self.phase = match self.phase {
            Phase::Command => match byte {
                0x03 => Phase::Address { have: 0 },
                0x05 => Phase::Status,
                _ => Phase::Command,
            },
            Phase::Address { have } => {
                self.addr_acc = (self.addr_acc << 8) | u32::from(byte);
                if have == 2 {
                    let addr = self.addr_acc & 0x00FF_FFFF;
                    self.addr_acc = 0;
                    self.read_addr = addr;
                    self.reads.push(addr);
                    Phase::Reading
                } else {
                    Phase::Address { have: have + 1 }
                }
            }
            other => other,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shift a command byte in, MSB first.
    fn send(flash: &mut SpiFlash, byte: u8) {
        for i in (0..8).rev() {
            let bit = (byte >> i) & 1 != 0;
            flash.clock(true, bit);
            flash.clock(false, bit);
        }
    }

    /// Read a byte out, MSB first — pulse then sample, as the ROM does.
    fn recv(flash: &mut SpiFlash) -> u8 {
        let mut b = 0u8;
        for _ in 0..8 {
            flash.clock(true, true);
            flash.clock(false, true);
            b = (b << 1) | u8::from(flash.miso());
        }
        b
    }

    #[test]
    fn a_read_command_streams_from_the_addressed_offset() {
        let mut image = vec![0u8; 0x500];
        image[0x400] = 0xDE;
        image[0x401] = 0xAD;
        let mut flash = SpiFlash::with_image(image);
        flash.set_selected(true);
        send(&mut flash, 0x03);
        send(&mut flash, 0x00);
        send(&mut flash, 0x04);
        send(&mut flash, 0x00);
        assert_eq!(recv(&mut flash), 0xDE, "first byte at $400");
        assert_eq!(recv(&mut flash), 0xAD, "then $401");
        assert_eq!(flash.reads, vec![0x400]);
    }

    #[test]
    fn status_reads_zero_so_the_rom_finds_a_device() {
        let mut flash = SpiFlash::with_image(vec![1, 2, 3, 4]);
        flash.set_selected(true);
        send(&mut flash, 0x05);
        assert_eq!(recv(&mut flash), 0x00, "idle and writable");
    }
}
