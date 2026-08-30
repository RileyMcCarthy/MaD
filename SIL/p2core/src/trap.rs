//! Traps.
//!
//! Unknown opcode, unknown pin mode and out-of-range access all **trap** rather
//! than silently no-op. A no-op turns a firmware change into drifting numbers
//! that look like a plant-model tuning problem; a trap names the address and
//! stops.

use core::fmt;

/// Why a cog stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trap {
    /// The word at `pc` is not in the decode table.
    UndecodedWord { cog: u8, pc: u32, word: u32 },
    /// Decoded, but this build has no execute arm for it.
    Unimplemented {
        cog: u8,
        pc: u32,
        word: u32,
        mnemonic: &'static str,
    },
    /// A hub address outside the 512 KB map. Silicon wraps; during bring-up a
    /// wild pointer that aliases onto valid memory is the most expensive bug
    /// to chase, so `Machine::strict_hub` turns it into this.
    HubOutOfRange { cog: u8, pc: u32, addr: u32 },
    /// `COGINIT` asked for a cog that does not exist or is already running.
    NoFreeCog { cog: u8, pc: u32 },
    /// The PC left the address map -- a bad branch or a corrupted stack.
    PcOutOfRange { cog: u8, pc: u32 },
}

impl Trap {
    /// The cog that trapped.
    pub fn cog(&self) -> u8 {
        match self {
            Trap::UndecodedWord { cog, .. }
            | Trap::Unimplemented { cog, .. }
            | Trap::HubOutOfRange { cog, .. }
            | Trap::NoFreeCog { cog, .. }
            | Trap::PcOutOfRange { cog, .. } => *cog,
        }
    }
}

impl fmt::Display for Trap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Trap::UndecodedWord { cog, pc, word } => {
                write!(f, "cog {cog}: no decoding for word {word:08X} at ${pc:05X}")
            }
            Trap::Unimplemented { cog, pc, word, mnemonic } => write!(
                f,
                "cog {cog}: {mnemonic} not implemented (word {word:08X} at ${pc:05X})"
            ),
            Trap::HubOutOfRange { cog, pc, addr } => write!(
                f,
                "cog {cog}: hub address ${addr:X} out of range at ${pc:05X}"
            ),
            Trap::NoFreeCog { cog, pc } => {
                write!(f, "cog {cog}: COGINIT found no free cog at ${pc:05X}")
            }
            Trap::PcOutOfRange { cog, pc } => {
                write!(f, "cog {cog}: PC left the address map at ${pc:08X}")
            }
        }
    }
}

impl std::error::Error for Trap {}
