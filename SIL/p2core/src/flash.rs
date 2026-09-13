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
//! Two groups, for the two things that actually drive this bus.
//!
//! **Boot (read):** `$03` read-data with a 24-bit address, and `$05`
//! read-status — which is how the ROM confirms a device is present at all.
//! `ROM_Booter_v33k`'s `try_spi` also issues `$66`/`$99` reset and `$04`
//! write-disable; those need no state to be correct, and are accepted as
//! no-ops rather than ignored as unknown. (This doc used to claim they were
//! handled while `consume` silently dropped them into the unknown bucket. The
//! boot still worked, which is exactly why nobody noticed.)
//!
//! **Programming (write):** `$06`/`$04` write-enable latch, `$02` page program
//! with 256-byte page wrap, `$20`/`$52`/`$D8` sector and block erase,
//! `$60`/`$C7` chip erase, and `$9F` JEDEC ID. This is the set loadp2's
//! `flash_loader` stub needs to write a firmware image, so the stub can be run
//! as real machine code and made to program this model — see
//! `tests/flash_program.rs`.
//!
//! NOR semantics are modelled where they bite: a program may only clear bits
//! (the byte is AND-ed into place), so writing without erasing first gives the
//! wrong answer here exactly as it would on the part. Erase sets `$FF`.
//! Programming is instantaneous, so WIP in the status byte always reads 0; a
//! loader that polls WIP sees the write already finished, which is benign. The
//! write-enable latch clears after each program or erase, as on silicon.

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
    /// Read the JEDEC ID triple.
    Jedec,
    /// Collecting the 24-bit address of a page program.
    ProgramAddress {
        have: u32,
    },
    /// Address taken; every further byte is programmed.
    Programming,
    /// Collecting the 24-bit address of an erase of `span` bytes.
    EraseAddress {
        span: u32,
        have: u32,
    },
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
    /// Write-enable latch. Set by `$06`, cleared by `$04` and by completing a
    /// program or erase — so a loader that forgets `$06` writes nothing, here
    /// as on the part.
    wel: bool,
    /// Where the next programmed byte lands, and the base of its 256-byte page.
    prog_addr: u32,
    prog_page: u32,
    /// How far through the JEDEC triple a `$9F` read has got.
    jedec_idx: u32,
    /// Every command opcode decoded, in order. The cheapest honest answer to
    /// "what does this loader actually issue?" — read it, do not guess from
    /// byte frequencies in the binary.
    pub commands: Vec<u8>,
    /// `(address, len)` of each program and erase applied, oldest first.
    pub writes: Vec<(u32, u32)>,
    pub erases: Vec<(u32, u32)>,
}

/// Manufacturer/type/capacity reported for `$9F`. Winbond W25Q128, which is
/// what a P2 Edge carries; the stub only needs a non-`$FF` first byte to
/// believe a device answered.
pub const JEDEC_ID: [u8; 3] = [0xEF, 0x40, 0x18];

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
            // bit0 WIP, bit1 WEL. Programming is instantaneous here, so WIP is
            // always clear and a loader's "wait while busy" spin exits at once.
            Phase::Status => u8::from(self.wel) << 1,
            Phase::Jedec => {
                let b = JEDEC_ID.get(self.jedec_idx as usize).copied().unwrap_or(0);
                self.jedec_idx = self.jedec_idx.saturating_add(1);
                b
            }
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
        if !selected {
            // A program or erase commits when the device is deselected; the
            // latch drops with it, so the next write needs its own `$06`.
            if matches!(
                self.phase,
                Phase::Programming | Phase::ProgramAddress { .. } | Phase::EraseAddress { .. }
            ) {
                self.wel = false;
            }
        }
        self.in_count = 0;
        self.in_bits = 0;
        self.out_count = 0;
        self.jedec_idx = 0;
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

    /// Program one byte at `addr`. NOR flash can only pull bits to 0, so this
    /// AND-s rather than assigns: programming over un-erased data gives the
    /// same wrong answer here that it gives on the part.
    fn program_byte(&mut self, addr: u32, byte: u8) {
        let i = addr as usize;
        if i < self.image.len() {
            self.image[i] &= byte;
        }
    }

    fn erase(&mut self, addr: u32, span: u32) {
        let (start, end) = if span == 0 {
            (0usize, self.image.len())
        } else {
            let base = (addr & !(span - 1)) as usize;
            (base, (base + span as usize).min(self.image.len()))
        };
        let end = end.min(self.image.len());
        if start < end {
            self.image[start..end].fill(0xFF);
            self.erases.push((start as u32, (end - start) as u32));
        }
        self.wel = false;
    }

    fn consume(&mut self, byte: u8) {
        self.phase = match self.phase {
            Phase::Command => {
                self.commands.push(byte);
                match byte {
                    0x03 => Phase::Address { have: 0 },
                    0x05 => Phase::Status,
                    0x9F => {
                        self.jedec_idx = 0;
                        Phase::Jedec
                    }
                    0x06 => {
                        self.wel = true;
                        Phase::Command
                    }
                    0x04 => {
                        self.wel = false;
                        Phase::Command
                    }
                    0x02 => Phase::ProgramAddress { have: 0 },
                    0x20 => Phase::EraseAddress {
                        span: 4 * 1024,
                        have: 0,
                    },
                    0x52 => Phase::EraseAddress {
                        span: 32 * 1024,
                        have: 0,
                    },
                    0xD8 => Phase::EraseAddress {
                        span: 64 * 1024,
                        have: 0,
                    },
                    // Chip erase takes no address: act at once.
                    0x60 | 0xC7 => {
                        if self.wel {
                            self.erase(0, 0);
                        }
                        Phase::Command
                    }
                    // `$66`/`$99` reset and anything else: no state to change.
                    _ => Phase::Command,
                }
            }
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
            Phase::ProgramAddress { have } => {
                self.addr_acc = (self.addr_acc << 8) | u32::from(byte);
                if have == 2 {
                    let addr = self.addr_acc & 0x00FF_FFFF;
                    self.addr_acc = 0;
                    self.prog_addr = addr;
                    self.prog_page = addr & !0xFF;
                    self.writes.push((addr, 0));
                    Phase::Programming
                } else {
                    Phase::ProgramAddress { have: have + 1 }
                }
            }
            Phase::Programming => {
                if self.wel {
                    let addr = self.prog_addr;
                    self.program_byte(addr, byte);
                    if let Some(last) = self.writes.last_mut() {
                        last.1 += 1;
                    }
                    // A page program wraps within its 256-byte page rather
                    // than running on into the next one.
                    let next = addr.wrapping_add(1);
                    self.prog_addr = if next & !0xFF != self.prog_page {
                        self.prog_page
                    } else {
                        next
                    };
                }
                Phase::Programming
            }
            Phase::EraseAddress { span, have } => {
                self.addr_acc = (self.addr_acc << 8) | u32::from(byte);
                if have == 2 {
                    let addr = self.addr_acc & 0x00FF_FFFF;
                    self.addr_acc = 0;
                    if self.wel {
                        self.erase(addr, span);
                    }
                    Phase::Command
                } else {
                    Phase::EraseAddress {
                        span,
                        have: have + 1,
                    }
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

    /// Drive one complete transaction: select, send bytes, deselect.
    fn tx(flash: &mut SpiFlash, bytes: &[u8]) {
        flash.set_selected(true);
        for &b in bytes {
            send(flash, b);
        }
        flash.set_selected(false);
    }

    #[test]
    fn a_page_program_needs_the_write_enable_latch() {
        let mut flash = SpiFlash::with_image(vec![0xFF; 512]);
        // No `$06` first: the part ignores the data, and so does this.
        tx(&mut flash, &[0x02, 0x00, 0x00, 0x00, 0xAA]);
        assert_eq!(flash.image_bytes()[0], 0xFF, "unlatched write is discarded");

        tx(&mut flash, &[0x06]);
        tx(&mut flash, &[0x02, 0x00, 0x00, 0x00, 0xAA]);
        assert_eq!(flash.image_bytes()[0], 0xAA, "latched write lands");
    }

    #[test]
    fn the_latch_clears_after_a_program_so_the_next_write_needs_its_own_enable() {
        let mut flash = SpiFlash::with_image(vec![0xFF; 512]);
        tx(&mut flash, &[0x06]);
        tx(&mut flash, &[0x02, 0x00, 0x00, 0x00, 0x0F]);
        // Second write, no new `$06`.
        tx(&mut flash, &[0x02, 0x00, 0x00, 0x01, 0x0F]);
        let img = flash.image_bytes();
        assert_eq!(img[0], 0x0F, "first write was enabled");
        assert_eq!(img[1], 0xFF, "second was not");
    }

    #[test]
    fn programming_only_clears_bits_so_an_unerased_write_is_wrong_here_too() {
        let mut flash = SpiFlash::with_image(vec![0x0F; 4]);
        tx(&mut flash, &[0x06]);
        tx(&mut flash, &[0x02, 0x00, 0x00, 0x00, 0xF0]);
        assert_eq!(
            flash.image_bytes()[0],
            0x00,
            "NOR programming ANDs: $0F & $F0 = $00, not $F0"
        );
    }

    #[test]
    fn a_page_program_wraps_inside_its_own_256_byte_page() {
        let mut flash = SpiFlash::with_image(vec![0xFF; 1024]);
        tx(&mut flash, &[0x06]);
        // Start two bytes below the page end and write four.
        let mut frame = vec![0x02, 0x00, 0x00, 0xFE];
        frame.extend_from_slice(&[0x11, 0x22, 0x33, 0x44]);
        tx(&mut flash, &frame);
        let img = flash.image_bytes();
        assert_eq!((img[0xFE], img[0xFF]), (0x11, 0x22), "the tail of the page");
        assert_eq!(
            img[0x100], 0xFF,
            "the next page is untouched — the write wrapped"
        );
        assert_eq!(
            (img[0x00], img[0x01]),
            (0x33, 0x44),
            "it wrapped to the base"
        );
    }

    #[test]
    fn a_sector_erase_clears_its_own_4k_and_nothing_else() {
        let mut flash = SpiFlash::with_image(vec![0x00; 16 * 1024]);
        tx(&mut flash, &[0x06]);
        // An address inside the second sector, not its base.
        tx(&mut flash, &[0x20, 0x00, 0x11, 0x22]);
        let img = flash.image_bytes();
        assert_eq!(img[0x0FFF], 0x00, "sector 0 untouched");
        assert_eq!(img[0x1000], 0xFF, "sector 1 erased from its base");
        assert_eq!(img[0x1FFF], 0xFF, "to its end");
        assert_eq!(img[0x2000], 0x00, "sector 2 untouched");
        assert_eq!(flash.erases, vec![(0x1000, 4096)]);
    }

    #[test]
    fn the_jedec_id_answers_so_a_loader_can_see_a_device() {
        let mut flash = SpiFlash::with_image(vec![0xFF; 16]);
        flash.set_selected(true);
        send(&mut flash, 0x9F);
        assert_eq!(
            [recv(&mut flash), recv(&mut flash), recv(&mut flash)],
            JEDEC_ID
        );
    }

    #[test]
    fn every_opcode_is_logged_so_a_loader_can_be_observed_rather_than_guessed() {
        let mut flash = SpiFlash::with_image(vec![0xFF; 512]);
        tx(&mut flash, &[0x06]);
        tx(&mut flash, &[0x02, 0x00, 0x00, 0x00, 0xAA]);
        tx(&mut flash, &[0x05]);
        assert_eq!(flash.commands, vec![0x06, 0x02, 0x05]);
    }
}
