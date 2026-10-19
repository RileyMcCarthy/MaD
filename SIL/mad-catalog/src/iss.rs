//! `mad-p2iss`: MaD's instruction-set simulator as a core the P2 package
//! holds ([`IssCores`]), so a project's P2 runs the firmware on it:
//!
//! ```toml
//! [[board.model]]
//! value = "P2X8C4M64P"
//! kind = "p2"
//! [board.model.options]
//! core = "mad-p2iss"
//! rom = "rom.bin"             # optional; p2iss's boot ROM otherwise
//! ```
//!
//! The `p2` part kind is the package (embsim `boards/src/p2.rs`): its pins,
//! its START gate, its bank supplies. It takes `core` from the entry and
//! hands every other option to the core's seat; the core it seats is
//! [`p2iss::P2IssCore`], the ISS with every pad on its net and each pad's
//! role the guest's (`SIL/p2iss/src/package.rs`). The shape is QEMU's core
//! catalog's (embsim `p2-qemu/src/catalog.rs`) and the worked example's
//! (`examples/custom-project/catalog/src/blinker.rs`).
//!
//! | Option | What it says |
//! |---|---|
//! | `rom` | the boot ROM, a file relative to the project; by default [`BOOT_ROM`], `SIL/p2iss/rom/rom_booter_v33k.bin` |
//!
//! The core boots its ROM off whatever the board gives it, as the chip
//! does: on the P2-EC32MB, the module's flash and its `S301` straps. No
//! option puts a program straight into hub RAM; a fast load skips the boot
//! chain a board simulation exists to check (embsim `NODES.md` §13, decision
//! (m); `MIGRATING-MAD.md` §3, "`src/iss.rs`").
//!
//! Seating reads the ROM and builds nothing; the board build makes the core,
//! once per part the key reaches, and adds its report ([`Report`]):
//!
//! - at each look, every console line the guest has ended on its debug pin
//!   (`P62`) since the last, as it handed the line's bytes to the pin. The
//!   ISS's asynchronous transmit pin never reads busy, so the guest hands a
//!   line over at the speed it runs and a look can say it milliseconds
//!   before its last byte leaves the wire;
//! - at the end, the cogs running, the rate the guest programmed on each
//!   asynchronous transmit pin it sent on, the frames that did not deframe
//!   on its receive pins, the pad edges it dropped, and a console line not
//!   yet ended;
//! - a trap that stopped the guest, at the look that finds it, as the core's
//!   failure: the run stops there.
//!
//! Every line is the board's time and state, none the host's: two runs of a
//! stepped project print the same report. How fast the guest ran against the
//! wall clock is no report line; `run` prints the wall time.

use embsim_board::{Assignment, KindInfo, PartOptions, ProjectError, Report};
use embsim_boards::p2::{CoreCatalog, CoreCtor, P2Core};
use p2iss::{P2IssCore, P2IssHandle};

/// The core kind.
pub const ISS: &str = "mad-p2iss";

/// The boot ROM the core runs unless `rom` names another: Parallax's
/// `ROM_Booter_v33k`, trimmed for flexspin and assembled by `make bootrom`
/// (`SIL/p2iss/rom/README.md`).
pub const BOOT_ROM: &[u8] = include_bytes!("../../p2iss/rom/rom_booter_v33k.bin");

/// The most a boot ROM can be: the 16 KB at the top of hub RAM the chip
/// boots from, which the simulator fills from the ROM
/// (`p2core::Machine::with_boot_rom`).
pub const BOOT_ROM_MAX_BYTES: usize = 16 * 1024;

/// The debug console's pin, `P62`, the one whose bytes the simulator keeps
/// as the guest's console (`p2core::board::PIN_TX`).
const CONSOLE_PIN: u8 = 62;

/// The P2's pads, `P0`–`P63`.
const PADS: u8 = 64;

/// MaD's one core kind (module docs).
#[derive(Debug, Default, Clone, Copy)]
pub struct IssCores;

impl CoreCatalog for IssCores {
    fn name(&self) -> &str {
        crate::NAME
    }

    fn core_kinds(&self) -> Vec<KindInfo> {
        vec![KindInfo::new(
            ISS,
            "the chip booting its ROM on MaD's instruction-set simulator (SIL/p2iss), every pad \
             on its net",
        )]
    }

    fn seat(
        &self,
        _core: &str,
        assignment: &Assignment<'_>,
        mut options: PartOptions,
    ) -> Result<CoreCtor, ProjectError> {
        let rom = options.string("rom")?;
        options.finish()?;
        let rom = match rom {
            None => BOOT_ROM.to_vec(),
            Some(file) => {
                let path = assignment.dir.join(&file);
                let rom = std::fs::read(&path).map_err(|err| {
                    assignment.error(format!("cannot read boot ROM {}: {err}", path.display()))
                })?;
                if rom.len() > BOOT_ROM_MAX_BYTES {
                    return Err(assignment.error(format!(
                        "boot ROM {} is {} bytes; the chip boots from the {BOOT_ROM_MAX_BYTES} \
                         bytes at the top of hub RAM, so a ROM is at most that",
                        path.display(),
                        rom.len()
                    )));
                }
                rom
            }
        };
        let reports = assignment.reports.clone();
        let board = assignment.board.to_string();
        // Called once per part when the board is built; a survey never
        // calls it.
        Ok(Box::new(move |decl| {
            let core = P2IssCore::with_boot_rom(&rom);
            reports.add(IssReport::new(
                format!("{board}.{}", decl.reference),
                core.handle(),
            ));
            Ok(Box::new(core) as Box<dyn P2Core>)
        }))
    }
}

/// What a `mad-p2iss` core says in a run (module docs).
struct IssReport {
    subject: String,
    core: P2IssHandle,
    /// How much of the console the looks have said: up to and including its
    /// last line end so far.
    said: usize,
    /// The console's line ends at the last look that read it, so a look
    /// with none new reads nothing more.
    lines_seen: u64,
    /// Whether a look has said the trap.
    trapped: bool,
}

impl IssReport {
    fn new(subject: String, core: P2IssHandle) -> Self {
        Self {
            subject,
            core,
            said: 0,
            lines_seen: 0,
            trapped: false,
        }
    }

    /// The asynchronous transmit pins the guest sent on, each at the rate
    /// it programmed: `P62 at 230547 baud`.
    fn transmit_rates(&self) -> Vec<String> {
        (0..PADS)
            .filter_map(|pin| {
                self.core
                    .derived_baud(pin)
                    .map(|baud| format!("P{pin} at {baud} baud"))
            })
            .collect()
    }
}

/// A console line as a report says it: the pin, then the line quoted, its
/// carriage return dropped.
fn console_line(line: &str) -> String {
    format!("P{CONSOLE_PIN} {:?}", line.trim_end_matches('\r'))
}

impl Report for IssReport {
    fn subject(&self) -> String {
        self.subject.clone()
    }

    fn look(&mut self, _now_ns: u64) -> Vec<String> {
        let mut lines = Vec::new();
        let ended = self.core.console_lines();
        if ended != self.lines_seen {
            self.lines_seen = ended;
            let console = self.core.console();
            // Up to a line end, the console's text never changes as it grows:
            // a line end is a byte of its own in any decoding.
            if let Some(fresh) = console.get(self.said..) {
                if let Some(last) = fresh.rfind('\n') {
                    lines.extend(fresh[..last].split('\n').map(console_line));
                    self.said += last + 1;
                }
            }
        }
        if !self.trapped {
            if let Some(trap) = self.core.trap() {
                self.trapped = true;
                lines.push(format!("the guest trapped: {trap}"));
            }
        }
        lines
    }

    fn summary(&self) -> Vec<String> {
        let rates = self.transmit_rates();
        let mut lines = vec![format!(
            "{} cogs running; transmitting on {}; {} frames on receive pins did not deframe; {} \
             pad edges dropped",
            self.core.running_cogs(),
            if rates.is_empty() {
                "no pin".to_string()
            } else {
                rates.join(", ")
            },
            self.core.rx_framing_errors(),
            self.core.edges_dropped(),
        )];
        let console = self.core.console();
        if let Some(rest) = console.get(self.said..).filter(|rest| !rest.is_empty()) {
            // Whatever follows the last line end a look said: lines a look
            // has not reached, and one the guest has not ended.
            let mut rest = rest.split('\n').peekable();
            while let Some(line) = rest.next() {
                match rest.peek() {
                    Some(_) => lines.push(console_line(line)),
                    None if !line.is_empty() => {
                        lines.push(format!("{}, its line not ended", console_line(line)));
                    }
                    None => {}
                }
            }
        }
        if let Some(trap) = self.core.trap() {
            lines.push(format!("stopped by a trap: {trap}"));
        }
        lines
    }

    /// The guest trapped: the simulator runs it no further, and the run
    /// stops.
    fn failure(&self) -> Option<String> {
        self.core
            .trap()
            .map(|trap| format!("the guest trapped and runs no more: {trap}"))
    }
}
