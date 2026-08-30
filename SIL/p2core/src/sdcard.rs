//! An SD card, device side, in SPI mode.
//!
//! Written against permissive references only — never QEMU's GPL model:
//!
//! * `sdmm.cc` (ChaN, "no restriction on use"), which ships with the flexcc
//!   toolchain and is *literally the driver this firmware runs*, so it defines
//!   exactly which commands arrive and what each expects back;
//! * the SD Simplified Specification, for response formats;
//! * the ISS itself — run the firmware and see what it sends.
//!
//! # Scope
//!
//! Enough of the SPI-mode protocol for FatFs to initialise a card and read and
//! write 512-byte blocks. The card is an SDHC/SDv2 (block-addressed), which is
//! the simplest case: `CMD17`/`CMD24` take a block index rather than a byte
//! offset, so no capacity maths is needed.
//!
//! Storage is a flat image — [`SdCard::blocks`] is just the bytes of a disk.
//! No filesystem logic lives here: FatFs on the guest does that, which is the
//! point (it is the code under test) and keeps this crate dependency-free.

use std::collections::VecDeque;

/// Bytes per block. Fixed at 512 for SDHC.
pub const BLOCK_LEN: usize = 512;

/// R1 response bits. Bit 7 is always 0, which is how the host finds the
/// response byte in a stream of $FF idles.
const R1_READY: u8 = 0x00;
const R1_IDLE: u8 = 0x01;
const R1_ILLEGAL: u8 = 0x04;

/// Data-block start token for single-block read/write.
const TOKEN_START: u8 = 0xFE;
/// Data-response token: bits 3:0 = %0101 means "data accepted".
const TOKEN_ACCEPTED: u8 = 0x05;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Waiting for the 6-byte command frame to arrive.
    Command,
    /// Streaming a queued response out to the host.
    Responding,
    /// Receiving a data block the host is writing (token + payload + CRC).
    ReceivingBlock { addr: u32, got: usize },
}

/// A card that speaks SPI-mode SD over one-byte exchanges.
pub struct SdCard {
    /// The disk image. Length should be a multiple of [`BLOCK_LEN`].
    pub blocks: Vec<u8>,
    /// True once `ACMD41` has completed initialisation.
    pub initialised: bool,
    /// Chip select, driven by the host's CS pin. Commands only run when low.
    pub selected: bool,
    /// Set when the host sends `CMD55`, so the next command is an ACMD.
    app_cmd: bool,
    phase: Phase,
    /// Bytes queued to return to the host, oldest first.
    out: VecDeque<u8>,
    /// Command frame being assembled.
    frame: Vec<u8>,
    /// Payload being received during a block write.
    incoming: Vec<u8>,
    /// Count of commands seen, for diagnostics.
    pub commands: Vec<u8>,
}

impl SdCard {
    /// A card holding `blocks_len` bytes of zeroed image.
    pub fn blank(bytes: usize) -> Self {
        Self::with_image(vec![0u8; bytes])
    }

    /// A card backed by an existing disk image.
    pub fn with_image(blocks: Vec<u8>) -> Self {
        Self {
            blocks,
            initialised: false,
            // CS idles low until the firmware drives it, and the very first
            // thing sdmm.cc does is clock dummy bytes with the card selected.
            selected: true,
            app_cmd: false,
            phase: Phase::Command,
            out: VecDeque::new(),
            frame: Vec::new(),
            incoming: Vec::new(),
            commands: Vec::new(),
        }
    }

    /// Exchange one byte: the host shifts `mosi` in, the card shifts one out.
    ///
    /// SPI is symmetric, so every host byte produces exactly one card byte —
    /// `$FF` whenever the card has nothing to say, which is also how it signals
    /// "busy" and how the host clocks responses out.
    pub fn xfer(&mut self, mosi: u8) -> u8 {
        if !self.selected {
            return 0xFF;
        }
        match self.phase {
            Phase::Responding => {
                if let Some(b) = self.out.pop_front() {
                    if self.out.is_empty() {
                        self.phase = Phase::Command;
                    }
                    return b;
                }
                self.phase = Phase::Command;
                0xFF
            }
            Phase::ReceivingBlock { addr, got } => {
                self.receive_block_byte(mosi, addr, got)
            }
            Phase::Command => {
                self.collect_command(mosi);
                // Anything queued by the command becomes readable next byte.
                if !self.out.is_empty() {
                    self.phase = Phase::Responding;
                }
                0xFF
            }
        }
    }

    fn receive_block_byte(&mut self, mosi: u8, addr: u32, got: usize) -> u8 {
        if got == 0 {
            // Skip idles until the start token arrives.
            if mosi != TOKEN_START {
                return 0xFF;
            }
            self.incoming.clear();
            self.phase = Phase::ReceivingBlock { addr, got: 1 };
            return 0xFF;
        }
        if self.incoming.len() < BLOCK_LEN {
            self.incoming.push(mosi);
            return 0xFF;
        }
        // Two CRC bytes follow the payload; consume them, then acknowledge.
        self.incoming.push(mosi);
        if self.incoming.len() >= BLOCK_LEN + 2 {
            let off = addr as usize * BLOCK_LEN;
            if off + BLOCK_LEN <= self.blocks.len() {
                self.blocks[off..off + BLOCK_LEN]
                    .copy_from_slice(&self.incoming[..BLOCK_LEN]);
            }
            self.incoming.clear();
            self.phase = Phase::Command;
            // Data-accepted token, then one busy byte before ready.
            self.out.push_back(TOKEN_ACCEPTED);
            self.out.push_back(0xFF);
            self.phase = Phase::Responding;
        }
        0xFF
    }

    fn collect_command(&mut self, mosi: u8) {
        // A command frame starts with %01xxxxxx; everything else is an idle.
        if self.frame.is_empty() {
            if mosi & 0xC0 != 0x40 {
                return;
            }
            self.frame.push(mosi);
            return;
        }
        self.frame.push(mosi);
        if self.frame.len() < 6 {
            return;
        }
        let cmd = self.frame[0] & 0x3F;
        let arg = u32::from_be_bytes([self.frame[1], self.frame[2], self.frame[3], self.frame[4]]);
        self.frame.clear();
        self.run(cmd, arg);
    }

    fn run(&mut self, cmd: u8, arg: u32) {
        let app = std::mem::take(&mut self.app_cmd);
        self.commands.push(if app { cmd | 0x80 } else { cmd });

        match (app, cmd) {
            // ACMD41 -- initialise. Report ready immediately; the host polls
            // until it sees 0, and there is nothing to wait for here.
            (true, 41) => {
                self.initialised = true;
                self.out.push_back(R1_READY);
            }
            // ACMD other -- accept and report ready.
            (true, _) => self.out.push_back(R1_READY),

            // CMD0 GO_IDLE_STATE
            (false, 0) => self.out.push_back(R1_IDLE),

            // CMD8 SEND_IF_COND -- an SDv2 card echoes the check pattern in an
            // R7 (R1 + 4 bytes). Answering this is what makes the host treat
            // the card as SDv2/SDHC and use block addressing.
            (false, 8) => {
                self.out.push_back(R1_IDLE);
                self.out.push_back(0x00);
                self.out.push_back(0x00);
                self.out.push_back(0x01); // voltage accepted
                self.out.push_back((arg & 0xFF) as u8); // echo-back pattern
            }

            // CMD58 READ_OCR -- R3. CCS set marks a block-addressed (SDHC) card.
            (false, 58) => {
                self.out.push_back(R1_READY);
                self.out.push_back(0xC0); // ready + CCS
                self.out.push_back(0xFF);
                self.out.push_back(0x80);
                self.out.push_back(0x00);
            }

            // CMD55 APP_CMD -- the next command is an ACMD.
            (false, 55) => {
                self.app_cmd = true;
                self.out.push_back(R1_READY);
            }

            // CMD16 SET_BLOCKLEN -- fixed at 512, so just acknowledge.
            (false, 16) => self.out.push_back(R1_READY),

            // CMD17 READ_SINGLE_BLOCK -- R1, then a start token and 512 bytes.
            (false, 17) => {
                self.out.push_back(R1_READY);
                let off = arg as usize * BLOCK_LEN;
                if off + BLOCK_LEN <= self.blocks.len() {
                    self.out.push_back(TOKEN_START);
                    for i in 0..BLOCK_LEN {
                        self.out.push_back(self.blocks[off + i]);
                    }
                    self.out.push_back(0xFF); // CRC hi
                    self.out.push_back(0xFF); // CRC lo
                } else {
                    self.out.push_back(0x08); // out-of-range error token
                }
            }

            // CMD24 WRITE_BLOCK -- R1, then the host sends the data block.
            (false, 24) => {
                self.out.push_back(R1_READY);
                self.phase = Phase::ReceivingBlock { addr: arg, got: 0 };
            }

            // CMD9/CMD10 SEND_CSD/CID -- R1 then a 16-byte register block.
            (false, 9) | (false, 10) => {
                self.out.push_back(R1_READY);
                self.out.push_back(TOKEN_START);
                for _ in 0..16 {
                    self.out.push_back(0x00);
                }
                self.out.push_back(0xFF);
                self.out.push_back(0xFF);
            }

            // CMD12 STOP_TRANSMISSION, CMD13 SEND_STATUS
            (false, 12) => self.out.push_back(R1_READY),
            (false, 13) => {
                self.out.push_back(R1_READY);
                self.out.push_back(0x00);
            }

            // Anything else: report it as unsupported rather than pretending.
            _ => self.out.push_back(R1_ILLEGAL),
        }
    }
}
