//! Build a bootable SPI-flash image.
//!
//! The layout is the contract between three programs, each of which really
//! executes: the **ROM** loads flash `$000..$3FF` into hub 0, requires the
//! 256 longs to sum to `"Prop"`, and launches them as cog code; **stage-1**
//! (`rom/stage1.spin2`) reads a length long at `$400` and streams the
//! application after it into hub 0; the **application** is any flexcc image,
//! whose own first `$400` bytes are its cog bootstrap.
//!
//! ```text
//! $000 ┌──────────────────────────────┐
//!      │ stage-1 loader (cog code)    │  sum of the 256 longs == "Prop",
//!      │ … zero padding …             │  balanced by a fix-up long at $3FC
//! $400 ├──────────────────────────────┤
//!      │ application length (LE)      │
//! $404 ├──────────────────────────────┤
//!      │ application image            │
//!      └──────────────────────────────┘
//! ```

/// `"Prop"`, the checksum the ROM demands of a bootable first kilobyte.
const PROP: u32 = u32::from_le_bytes(*b"Prop");

/// Where the balancing long lives. The stage-1 loader is a couple of hundred
/// bytes, so the last long of its kilobyte is always free.
const FIXUP_AT: usize = 0x3FC;

/// Errors a flash image cannot be built around.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlashImageError {
    /// Stage-1 must fit its kilobyte with the fix-up long spare.
    Stage1TooBig { len: usize },
}

impl std::fmt::Display for FlashImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FlashImageError::Stage1TooBig { len } => {
                write!(f, "stage-1 is {len} bytes; it must fit $000..$3FB")
            }
        }
    }
}

impl std::error::Error for FlashImageError {}

/// Assemble `stage1` and `program` into a bootable flash image.
pub fn boot_flash(stage1: &[u8], program: &[u8]) -> Result<Vec<u8>, FlashImageError> {
    if stage1.len() > FIXUP_AT {
        return Err(FlashImageError::Stage1TooBig { len: stage1.len() });
    }
    let mut img = vec![0u8; 0x404 + program.len()];
    img[..stage1.len()].copy_from_slice(stage1);
    img[0x400..0x404].copy_from_slice(&(program.len() as u32).to_le_bytes());
    img[0x404..].copy_from_slice(program);

    // Balance the first kilobyte to "Prop". The ROM sums 256 longs and
    // compares; one free long absorbs the difference.
    let mut sum = 0u32;
    for i in (0..0x400).step_by(4) {
        sum = sum.wrapping_add(u32::from_le_bytes(img[i..i + 4].try_into().unwrap()));
    }
    let fix = PROP.wrapping_sub(sum);
    img[FIXUP_AT..FIXUP_AT + 4].copy_from_slice(&fix.to_le_bytes());
    Ok(img)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_kilobyte_sums_to_prop() {
        let img = boot_flash(&[0xAA; 100], &[1, 2, 3, 4]).expect("builds");
        let mut sum = 0u32;
        for i in (0..0x400).step_by(4) {
            sum = sum.wrapping_add(u32::from_le_bytes(img[i..i + 4].try_into().unwrap()));
        }
        assert_eq!(sum, PROP, "the ROM rejects anything else");
        assert_eq!(&img[0x400..0x404], &4u32.to_le_bytes());
        assert_eq!(&img[0x404..], &[1, 2, 3, 4]);
    }

    #[test]
    fn an_oversized_stage1_is_refused() {
        assert!(boot_flash(&[0u8; 0x400], &[]).is_err());
    }
}
