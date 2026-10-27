//! How much host time does a second of board time cost the ISS?
//!
//! Every mode runs **stepped**: virtual time advances as fast as the host
//! can process the guest and its nets, so what the run takes is its cost.
//! Each prints, for the phases it times, host seconds per board second —
//! wall time, and the process's CPU time (user and system, every thread),
//! which a loaded host inflates less — and the wall figure's inverse, the
//! rate against real time.
//!
//! ```text
//! # P2Iss on no board, the image put straight into hub RAM, the protocol
//! # link's two pins on nets (what mad-emulator ran before the package).
//! cargo run --release -p p2iss --example iss_speed
//!
//! # The same with fourteen of the firmware's GPIO pins on nets as levels.
//! cargo run --release -p p2iss --example iss_speed -- levels
//!
//! # P2IssCore in the P2-EC32MB's package, powered from its fingers: the
//! # ROM boots stage-1 and the firmware off the module's flash (the boot,
//! # timed to the firmware's first console line), then the firmware runs
//! # with every pad on the module's nets for SECONDS of board time (2).
//! cargo run --release -p p2iss --example iss_speed -- ec32mb [SECONDS]
//! ```
//!
//! Needs the `propeller2_debug` image (`make p2image`); the `ec32mb` mode
//! also the boot ROM and stage-1 in `p2iss/rom/`.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use embsim_board::{Component, EndpointRef, Harness, JumperState, Scenario, System};
use embsim_boards::ec32mb::{Ec32mb, FLASH_SELECT_POLE, FLASH_SELECT_SWITCH, P59_PULL_DOWN_POLE};
use embsim_boards::p2::P2Package;
use embsim_core::virtual_clock;
use p2iss::{P2Iss, P2IssCore, P2IssHandle, SerialLink};

const PROTO: SerialLink = SerialLink {
    tx_pin: p2core::board::PIN_PROTO_TX,
    rx_pin: p2core::board::PIN_PROTO_RX,
    nominal_baud: 2_000_000,
};

/// The firmware's system clock once its PLL is set: flexspin's `_clkfreq`.
const FIRMWARE_CLOCK_HZ: u64 = 160_000_000;

fn manifest(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn read(path: PathBuf) -> Vec<u8> {
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn image() -> Vec<u8> {
    read(manifest(
        "../../Firmware/MaDCore/.pio/build/propeller2_debug/program",
    ))
}

/// The process's CPU time so far, user and system, every thread.
fn cpu_s() -> f64 {
    // SAFETY: `getrusage` writes the struct it is handed and nothing else.
    let usage = unsafe {
        let mut usage = std::mem::zeroed::<libc::rusage>();
        libc::getrusage(libc::RUSAGE_SELF, &mut usage);
        usage
    };
    let secs = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
    secs(usage.ru_utime) + secs(usage.ru_stime)
}

/// A point in a run: the wall clock, the CPU clock and the board's.
#[derive(Clone, Copy)]
struct Mark {
    wall: Instant,
    cpu_s: f64,
    board_ns: u64,
}

/// One timed stretch between two marks.
struct Span {
    name: &'static str,
    wall_s: f64,
    cpu_s: f64,
    board_s: f64,
}

impl Span {
    fn between(name: &'static str, from: Mark, to: Mark) -> Self {
        Self {
            name,
            wall_s: to.wall.duration_since(from.wall).as_secs_f64(),
            cpu_s: to.cpu_s - from.cpu_s,
            board_s: to.board_ns.saturating_sub(from.board_ns) as f64 / 1e9,
        }
    }

    fn print(&self) {
        let board = self.board_s.max(f64::MIN_POSITIVE);
        let wall = self.wall_s / board;
        println!(
            "{:<36} board {:>7.4} s | wall {:>7.2} s, {:>7.2} s per board s ({:.4}x real time) \
             | cpu {:>7.2} s, {:>7.2} s per board s",
            self.name,
            self.board_s,
            self.wall_s,
            wall,
            1.0 / wall.max(f64::MIN_POSITIVE),
            self.cpu_s,
            self.cpu_s / board,
        );
    }
}

/// Poll until `done` or until board time stops moving for `stall`.
fn wait_until(
    h: &P2IssHandle,
    mut done: impl FnMut(&P2IssHandle) -> bool,
    stall: Duration,
) -> bool {
    let mut last = (h.guest_now_ns(), Instant::now());
    loop {
        if done(h) {
            return true;
        }
        if h.trap().is_some() || h.stalled() {
            return false;
        }
        let now = h.guest_now_ns();
        if now != last.0 {
            last = (now, Instant::now());
        } else if last.1.elapsed() > stall {
            return false;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn mark(h: &P2IssHandle) -> Mark {
    Mark {
        wall: Instant::now(),
        cpu_s: cpu_s(),
        board_ns: h.guest_now_ns(),
    }
}

/// P2Iss on no board: today's route, the image straight into hub RAM.
fn bare(level_pins: &[u8], label: &str) {
    let image = image();
    virtual_clock::init(0.0, 160_000_000);
    let iss = P2Iss::new(&image, p2core::SdCard::blank(32 * 1024 * 1024), &[PROTO])
        .with_level_pins(level_pins);
    let h = iss.handle();
    let _sys = System::new()
        .component("P2", Box::new(iss))
        .harness(Harness::new())
        .start()
        .expect("starts");
    println!("P2Iss, the image in hub RAM, {label}");
    let start = mark(&h);
    let lined = wait_until(&h, |h| h.console_lines() > 0, Duration::from_secs(60));
    let line = mark(&h);
    if lined {
        Span::between("boot to the first console line", start, line).print();
    }
    let until = line.board_ns + 2_000_000_000;
    wait_until(&h, |h| h.guest_now_ns() >= until, Duration::from_secs(60));
    Span::between("running, 2 s of board time", line, mark(&h)).print();
}

/// P2IssCore in the P2-EC32MB's package, booting off the module's flash.
fn ec32mb(run_s: u64) {
    let program = image();
    let stage1 = read(manifest("rom/stage1.bin"));
    let rom = read(manifest("rom/rom_booter_v33k.bin"));
    let flash_image = p2iss::flashimage::boot_flash(&stage1, &program).expect("flash image");
    virtual_clock::init(0.0, 160_000_000);

    let core = P2IssCore::with_boot_rom(&rom);
    let h = core.handle();
    let slot = Mutex::new(Some(P2Package::new(core)));
    let board = Ec32mb::new()
        .with_flash_image(flash_image)
        .with_p2(move |_decl| -> Box<dyn Component> {
            Box::new(slot.lock().unwrap().take().expect("one P2 per module"))
        })
        .build()
        .expect("the module builds");
    let ep = |s: &str| EndpointRef::parse(s).expect("endpoint parses");
    let built = Instant::now();
    let _sys = System::new()
        .board("EC32", board)
        .harness(
            Harness::new()
                .power(ep("CARRIER.5V"), ep("EC32.J203.41"), 5.0)
                .power(ep("CARRIER.5Vb"), ep("EC32.J203.42"), 5.0)
                .power(ep("CARRIER.GND"), ep("EC32.J203.43"), 0.0)
                .power(ep("CARRIER.GNDb"), ep("EC32.J203.44"), 0.0)
                .power(ep("CARRIER.GNDc"), ep("EC32.J203.45"), 0.0),
        )
        .scenario(
            Scenario::default()
                .switch(
                    &format!("EC32.{FLASH_SELECT_SWITCH}"),
                    FLASH_SELECT_POLE,
                    JumperState::Closed,
                )
                .switch(
                    &format!("EC32.{FLASH_SELECT_SWITCH}"),
                    P59_PULL_DOWN_POLE,
                    JumperState::Closed,
                ),
        )
        .start()
        .expect("starts");
    println!(
        "P2IssCore in the P2-EC32MB's package: {} byte program off the module's flash, every pad \
         on a net",
        program.len()
    );
    let stall = Duration::from_secs(120);
    wait_until(&h, |h| h.started_at_ns().is_some(), stall);
    let start = mark(&h);
    let lined = wait_until(&h, |h| h.console_lines() > 0, stall);
    let line = mark(&h);
    println!(
        "power-up to START: board {:.4} s, wall {:.2} s",
        start.board_ns as f64 / 1e9,
        start.wall.duration_since(built).as_secs_f64()
    );
    if !lined {
        println!(
            "no console line: trap {:?}, clock {:?} Hz",
            h.trap(),
            h.clock_hz()
        );
        return;
    }
    Span::between("boot: START to the first line", start, line).print();
    // The ROM and stage-1 run on the RC oscillator; the firmware's first act
    // is setting its PLL, so the instant that rate took effect ends the load.
    if let (Some(FIRMWARE_CLOCK_HZ), Some(pll_ns)) = (h.clock_hz(), h.clock_set_at_ns()) {
        println!(
            "  of which the ROM and stage-1 load (START to the PLL): board {:.4} s; the \
             firmware, the PLL to the line: board {:.4} s",
            pll_ns.saturating_sub(start.board_ns) as f64 / 1e9,
            line.board_ns.saturating_sub(pll_ns) as f64 / 1e9,
        );
    }
    let until = line.board_ns + run_s * 1_000_000_000;
    wait_until(&h, |h| h.guest_now_ns() >= until, stall);
    let end = mark(&h);
    Span::between("running, every pad on a net", line, end).print();
    println!(
        "net yields {}, cogs running {}, console {} bytes",
        h.net_yields(),
        h.running_cogs(),
        h.console().len()
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut load = [0f64; 3];
    // SAFETY: `getloadavg` writes at most the three doubles it is handed.
    let n = unsafe { libc::getloadavg(load.as_mut_ptr(), 3) };
    if n == 3 {
        println!(
            "host load average {:.2} {:.2} {:.2}, {} CPUs",
            load[0],
            load[1],
            load[2],
            std::thread::available_parallelism().map_or(0, |n| n.get())
        );
    }
    match args.first().map(String::as_str) {
        Some("ec32mb") => ec32mb(args.get(1).and_then(|s| s.parse().ok()).unwrap_or(2)),
        Some(_) => bare(
            &[5, 6, 7, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 28],
            "the protocol link and 14 level pins on nets",
        ),
        None => bare(&[], "the protocol link on nets"),
    }
}
