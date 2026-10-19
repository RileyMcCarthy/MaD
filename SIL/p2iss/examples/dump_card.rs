//! Write MaD's SD card image to a file: the 32 MiB FAT16 card
//! `p2iss::sdimage::mad_card` builds, the card `mad-emulator` gives the
//! firmware. `make sd-image` writes it for a project's `sd-card` entry, and
//! a host FAT driver can judge it.
//!
//! ```text
//! cargo run -p p2iss --example dump_card -- IMAGE [DIR]
//! ```
//!
//! `DIR`, when it is a directory, is mirrored onto the card, as
//! `mad-emulator --sd-path` mirrors it (`make sd-image` passes `SIL/sd`). The
//! firmware's `/test` and `/gcode` are on the card either way: it opens files
//! inside them and does not create them.

use std::path::PathBuf;
use std::process::ExitCode;

/// 32 MiB: FAT16 at 2 KiB clusters, mid-window (`p2iss::sdimage`), the size
/// `mad-emulator` builds its card at.
const CARD_BYTES: usize = 32 * 1024 * 1024;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let (Some(image), dir, None) = (args.next().map(PathBuf::from), args.next(), args.next())
    else {
        eprintln!("usage: dump_card IMAGE [DIR]");
        return ExitCode::from(2);
    };
    let dir = dir.map(PathBuf::from);
    let card = match p2iss::sdimage::mad_card(CARD_BYTES, dir.as_deref()) {
        Ok(card) => card,
        Err(err) => {
            eprintln!("error: the card image does not build: {err}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(err) = std::fs::write(&image, &card) {
        eprintln!("error: cannot write {}: {err}", image.display());
        return ExitCode::FAILURE;
    }
    let holds = match &dir {
        Some(dir) if dir.is_dir() => format!("{} mirrored", dir.display()),
        Some(dir) => format!(
            "only /test and /gcode, with no directory {} to mirror",
            dir.display()
        ),
        None => "only /test and /gcode".to_string(),
    };
    println!(
        "wrote {}: {} bytes, a FAT16 card holding {holds}",
        image.display(),
        card.len()
    );
    ExitCode::SUCCESS
}
