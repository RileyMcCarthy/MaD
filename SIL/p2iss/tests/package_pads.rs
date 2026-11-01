//! What the ISS core's pads put on the P2-EC32MB's nets, and when.
//!
//! Each test boots a small program the way `ec32mb_flash_boot.rs` boots the
//! firmware: the module from its vendor netlist, powered from its `J203`
//! fingers, `S301` set to boot from flash, [`P2IssCore`] in its package,
//! and the ROM loading stage-1 and the program off the module's flash. A
//! scope on one pad's net records every level it reads and the instant it
//! read it, which is what the board saw, not what the guest believes.
//!
//! The programs are a few instructions of PASM2, assembled with flexspin
//! (`flexspin -2 -l`) and written out here as words, the source beside each.
//! Each is padded so that cog long `$019` holds a `jmp #0`: stage-1 ends by
//! reloading cog `$000`–`$0FF` from hub and jumping to 0 from `$019`, and
//! the ISS executes the reloaded long there, where silicon executes the
//! `jmp #0` it had already fetched. With a `jmp #0` at `$019` both run the
//! program from its first long.
//!
//! Stepped: every assertion is on virtual time and the board's state. The
//! ROM and stage-1 are checked in (`p2iss/rom`); none of this needs the
//! firmware image.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::{
    jesd8c01_lvcmos_thresholds, AttachError, Component, ComponentNetIo, DeadBand, DigitalReceiver,
    EndpointRef, Harness, JumperState, Level, PinDecl, Scenario, System,
};
use embsim_boards::ec32mb::{Ec32mb, FLASH_SELECT_POLE, FLASH_SELECT_SWITCH, P59_PULL_DOWN_POLE};
use embsim_boards::p2::{P2Package, P2_RESTART_DELAY_NS};
use embsim_core::virtual_clock;
use p2iss::{P2IssCore, P2IssHandle};
use vibes_behaviour::{behaviour, expect, Test};

/// The instant the module's reset releases from its fingers: the AP62301
/// bucks' 2.5 ms soft-start (`embsim_models::rail::AP62301_SOFT_START_NS`).
const RESET_RELEASE_NS: u64 = 2_500_000;

/// The START instant, the datasheet's 3 ms restart delay after the reset
/// releases: clock count zero of the guest.
const START_NS: u64 = RESET_RELEASE_NS + P2_RESTART_DELAY_NS;

/// One clock of the RC oscillator these programs run on (they set no
/// clock word): 20 MHz nominal, the rate the core takes for RCFAST.
const RC_CLOCK_NS: u64 = 50;

/// One instruction at two clocks: the closest two of the ROM's flash clock
/// edges (`drvh` and `drvl` back to back) can be.
const INSTRUCTION_NS: u64 = 2 * RC_CLOCK_NS;

/// Cog long `$019`, where stage-1's relaunch `jmp #0` sits.
const RELAUNCH_LONG: usize = 0x19;

/// `jmp #0` assembled at `$019` (a relative jump back to `$000`).
const JMP_0_AT_019: u32 = 0xFD9F_FF98;

/// Board time a test is given before it gives up on the program's marker.
const BUDGET_NS: u64 = 200_000_000;

/// Host time with no board time passing that ends a test: the engine or
/// the host stopped, which is no verdict on the board.
const STALL_WALL: Duration = Duration::from_secs(300);

/// The virtual clock is the process's: one system runs at a time.
static CLOCK_LOCK: Mutex<()> = Mutex::new(());

fn lock_clock() -> MutexGuard<'static, ()> {
    CLOCK_LOCK.lock().unwrap_or_else(|p| {
        CLOCK_LOCK.clear_poison();
        p.into_inner()
    })
}

fn ep(endpoint: &str) -> EndpointRef {
    EndpointRef::parse(endpoint).expect("endpoint parses")
}

fn rom(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("rom")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A program's words, padded with zeros to `$019` and the `jmp #0` there,
/// as the bytes stage-1 loads.
fn relaunchable(words: &[u32]) -> Vec<u8> {
    assert!(
        words.len() < RELAUNCH_LONG,
        "the program must end before $019"
    );
    let mut longs = words.to_vec();
    longs.resize(RELAUNCH_LONG, 0);
    longs.push(JMP_0_AT_019);
    longs.iter().flat_map(|w| w.to_le_bytes()).collect()
}

/// One reading of the scope: the instant, the level the pad's net read
/// (`None`: no level, as a floating net has), and whether the net carried
/// a periodic drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Reading {
    at_ns: u64,
    level: Option<Level>,
    periodic: bool,
}

type Readings = Arc<Mutex<Vec<Reading>>>;

/// A scope probe on one net: a high-impedance input reading through the
/// JESD8C.01 LVCMOS pair, recording each change of what it reads.
struct Scope {
    pins: [PinDecl; 1],
    readings: Readings,
}

impl Component for Scope {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let readings = Arc::clone(&self.readings);
        let receiver = DigitalReceiver::new(io.pin("A")?);
        io.on_sense("A", move |sense| {
            let reading = Reading {
                at_ns: sense.at_ns,
                level: receiver.read(&sense),
                periodic: sense.periodic.is_some(),
            };
            let mut readings = readings.lock().unwrap();
            let last = readings.last().copied();
            if last
                .is_none_or(|last| (last.level, last.periodic) != (reading.level, reading.periodic))
            {
                readings.push(reading);
            }
        })
    }
}

/// What a run left behind.
struct Run {
    readings: Vec<Reading>,
    handle: P2IssHandle,
    reads: Vec<u32>,
    report: String,
}

/// Boot `payload` off the module's flash with a scope on `probe` (an
/// endpoint such as `EC32.U100.P60`), until the program writes `B` to its
/// debug pin.
fn boot(payload: &[u8], probe: &str) -> Run {
    let _clock = lock_clock();
    let image =
        p2iss::flashimage::boot_flash(&rom("stage1.bin"), payload).expect("the flash image");
    virtual_clock::init(0.0, 160_000_000);
    let core = P2IssCore::with_boot_rom(&rom("rom_booter_v33k.bin"));
    let handle = core.handle();
    let package = P2Package::new(core);
    let board = Ec32mb::new().with_flash_image(image);
    let flash = board.flash_view().expect("a programmed flash has a view");
    let slot = Mutex::new(Some(package));
    let board = board
        .with_p2(move |_decl| -> Box<dyn Component> {
            Box::new(slot.lock().unwrap().take().expect("one P2 per module"))
        })
        .build()
        .expect("the module builds");
    let readings = Readings::default();
    let scope = Scope {
        pins: [PinDecl::digital_in(
            "A",
            jesd8c01_lvcmos_thresholds(DeadBand::Unknown),
        )],
        readings: Arc::clone(&readings),
    };
    let system = System::new()
        .board("EC32", board)
        .component("SCOPE", Box::new(scope))
        .harness(
            Harness::new()
                .connect_str(probe, "SCOPE.A")
                .expect("the probed pad exists")
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
        .expect("the system starts");

    // Wait on board time: until the marker, the budget, or a trap. A
    // watchdog on host time ends a run whose board time stopped moving.
    let wall = Instant::now();
    let mut last = (virtual_clock::virtual_ns(), Instant::now());
    loop {
        if handle.console().contains('B') || handle.trap().is_some() {
            break;
        }
        let board_ns = virtual_clock::virtual_ns();
        if board_ns >= START_NS + BUDGET_NS {
            break;
        }
        if board_ns != last.0 {
            last = (board_ns, Instant::now());
        } else if last.1.elapsed() > STALL_WALL {
            panic!(
                "no board time passed in {STALL_WALL:?} of host time, at board {board_ns} ns: \
                 the engine or the host stopped, which says nothing about the board"
            );
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let report = format!(
        "board {} ns, guest {} ns, console {:?}, trap {:?}, start {:?}, net yields {}, \
         host {:.1} s",
        virtual_clock::virtual_ns(),
        handle.guest_now_ns(),
        handle.console(),
        handle.trap(),
        handle.started_at_ns(),
        handle.net_yields(),
        wall.elapsed().as_secs_f64(),
    );
    let reads = flash.reads();
    drop(system);
    let readings = readings.lock().unwrap().clone();
    Run {
        readings,
        handle,
        reads,
        report,
    }
}

/// The instants at which the scope read a level change between high and
/// low, in order.
fn transitions(readings: &[Reading]) -> Vec<(u64, Level)> {
    let mut out: Vec<(u64, Level)> = Vec::new();
    for r in readings {
        if let Some(level) = r.level {
            if out.last().is_none_or(|&(_, last)| last != level) {
                out.push((r.at_ns, level));
            }
        }
    }
    out
}

#[test]
fn every_flash_clock_edge_of_the_boot_lands_on_its_own_instant() {
    behaviour!(Test {
        id: "p2iss.core-edges-at-own-instant",
        covers: Some("SIL/p2iss/src/package.rs#P2IssCore"),
        given: "the ROM and stage-1 bit-banging the P2-EC32MB's flash to load a small program, \
                with a scope on the flash's clock net",
    });
    expect!(
        "none-shared",
        "every clock edge lands on a nanosecond of its own"
    );
    expect!(
        "on-the-guest-clock",
        "every edge falls on a tick of the 20 MHz RC oscillator counted from the start instant"
    );
    expect!(
        "closest-one-instruction",
        "the closest two edges are one instruction, two clocks, apart"
    );
    expect!(
        "typical-loop",
        "the typical gap between edges is the loader's own loop, one to four instructions"
    );

    // mov pa, #"B" / wypin pa, #62 / jmp #$: a byte on the debug pin.
    let run = boot(
        &relaunchable(&[0xF607_EC42, 0xFC27_EC3E, 0xFD9F_FFFC]),
        "EC32.U100.P60",
    );
    let report = &run.report;
    assert!(
        run.handle.console().contains('B'),
        "the program ran; {report}"
    );
    assert!(
        run.reads.starts_with(&[0, 0x400]),
        "the ROM reads stage-1 at 0, stage-1 the program at $400; reads {:?}; {report}",
        run.reads
    );

    let edges: Vec<u64> = transitions(&run.readings)
        .into_iter()
        .map(|(at, _)| at)
        .collect();
    let mut gaps: Vec<u64> = edges.windows(2).map(|w| w[1] - w[0]).collect();
    gaps.sort_unstable();
    let median = gaps.get(gaps.len() / 2).copied().unwrap_or(0);
    let summary = format!(
        "{} edges, first {:?}, min gap {:?}, median gap {median}; {report}",
        edges.len(),
        &edges[..edges.len().min(12)],
        gaps.first()
    );
    eprintln!("flash clock: {summary}");
    // A kilobyte for stage-1 and the program after it: eight clocks a byte,
    // two edges a clock.
    assert!(
        edges.len() >= 2 * 8 * (1024 + 4 + 104),
        "the scope saw every edge of the loads; {summary}"
    );
    assert!(
        edges.first().is_some_and(|&at| at >= START_NS),
        "nothing clocks the flash before START; {summary}"
    );
    assert!(
        gaps.first().is_some_and(|&g| g > 0),
        "no two edges share an instant; {summary}"
    );
    assert!(
        edges
            .iter()
            .all(|&at| (at - START_NS).is_multiple_of(RC_CLOCK_NS)),
        "every edge is at a clock count of the guest; {summary}"
    );
    assert!(
        gaps.first().is_some_and(|&g| g >= INSTRUCTION_NS),
        "the closest edges are one instruction apart; {summary}"
    );
    assert!(
        (INSTRUCTION_NS..=4 * INSTRUCTION_NS).contains(&median),
        "the typical gap is the loader's own loop; {summary}"
    );
}

#[test]
fn a_step_pin_cleared_after_its_train_is_a_plain_pin_again() {
    behaviour!(Test {
        id: "p2iss.core-train-cleared",
        covers: Some("SIL/p2iss/src/package.rs#NetPins::core_wrpin"),
        given: "a program that runs a step train on a pad, clears the pin as the firmware's \
                _pinclear does, then drives the pad high and, 1 ms later, low",
    });
    expect!(
        "released",
        "once the pin is cleared its pad is released and its net reads no level"
    );
    expect!(
        "plain-pulse",
        "the high and the low then reach the net, the gap between them the clocks the program \
         spent between the two writes"
    );

    // wrpin ##$4A, #0       ' P_TRANSITION | P_OE
    // wxpin ##2000, #0      ' 2000 clocks a transition: 100 us at RCFAST
    // dirh #0
    // wypin #6, #0          ' six transitions: three pulses
    // waitx ##60000         ' 3 ms
    // dirl #0               ' _pinclear
    // wrpin #0, #0
    // waitx ##4000          ' 200 us
    // drvh #0
    // waitx ##20000         ' 1 ms
    // drvl #0
    // waitx ##20000
    // wypin #"B", #62       ' done
    // jmp #$
    let program = [
        0xFF80_0000,
        0xFC0C_9400,
        0xFF80_0003,
        0xFC1F_A000,
        0xFD64_0041,
        0xFC2C_0C00,
        0xFF80_0075,
        0xFD64_C01F,
        0xFD64_0040,
        0xFC0C_0000,
        0xFF80_0007,
        0xFD67_401F,
        0xFD64_0059,
        0xFF80_0027,
        0xFD64_401F,
        0xFD64_0058,
        0xFF80_0027,
        0xFD64_401F,
        0xFC2C_843E,
        0xFD9F_FFFC,
    ];
    let run = boot(&relaunchable(&program), "EC32.U100.P0");
    let report = &run.report;
    let readings = &run.readings;
    eprintln!("P0: {readings:?}; {report}");
    assert!(
        run.handle.console().contains('B'),
        "the program ran; {report}"
    );

    let train = readings
        .iter()
        .position(|r| r.periodic)
        .unwrap_or_else(|| panic!("the train reached the net; {readings:?}"));
    let released = readings[train..]
        .iter()
        .position(|r| !r.periodic && r.level.is_none())
        .map(|i| train + i)
        .unwrap_or_else(|| panic!("the cleared pin released its pad; {readings:?}"));
    // The train ran its six transitions long before the clear, 3 ms on.
    assert!(
        readings[released].at_ns >= readings[train].at_ns + 3_000_000,
        "the pad is released by the clear, not before; {readings:?}"
    );
    let after = transitions(&readings[released..]);
    assert_eq!(
        after.iter().map(|&(_, level)| level).collect::<Vec<_>>(),
        vec![Level::High, Level::Low],
        "a plain high then low after the clear; {readings:?}"
    );
    // `waitx ##20000` is its `augd` prefix and the wait, 20 000 clocks past
    // its own two, and the `drvl` takes its two: the low lands that long
    // after the high.
    let width = after[1].0 - after[0].0;
    assert_eq!(
        width,
        (2 + 2 + 20_000 + 2) * RC_CLOCK_NS,
        "the pulse is as wide as the program's wait; {readings:?}"
    );
}

#[test]
fn the_sync_serial_clock_runs_on_the_guests_clock_and_a_cleared_clock_pin_is_released() {
    behaviour!(Test {
        id: "p2iss.core-sync-clock",
        covers: Some("SIL/p2iss/src/package.rs#NetPins::core_pump_edge"),
        given: "a program that sets a pad as a synchronous-serial clock with a 32-clock period, \
                asks it for two pulses, waits past them, then clears the pin as the firmware's \
                _pinclear does",
    });
    expect!(
        "half-period-edges",
        "the pad makes four transitions, high, low, high, low, half the period apart: 800 ns \
         at the 20 MHz RC oscillator"
    );
    expect!(
        "first-edge",
        "the first transition comes half a period after the instruction that asked for the \
         pulses"
    );
    expect!(
        "released",
        "once the pin is cleared its pad is released and its net reads no level"
    );

    // wrpin ##$48, #0          ' P_PULSE | P_OE
    // wxpin ##$0010_0020, #0   ' a 32-clock period
    // dirh #0                  ' the clock idles low
    // wypin #2, #0             ' two pulses
    // waitx ##4000             ' 200 us
    // dirl #0                  ' _pinclear
    // wrpin #0, #0
    // waitx ##4000
    // wypin #"B", #62          ' done
    // jmp #$
    let program = [
        0xFF80_0000,
        0xFC0C_9000,
        0xFF80_0800,
        0xFC1C_4000,
        0xFD64_0041,
        0xFC2C_0400,
        0xFF80_0007,
        0xFD67_401F,
        0xFD64_0040,
        0xFC0C_0000,
        0xFF80_0007,
        0xFD67_401F,
        0xFC2C_843E,
        0xFD9F_FFFC,
    ];
    let run = boot(&relaunchable(&program), "EC32.U100.P0");
    let report = &run.report;
    let readings = &run.readings;
    eprintln!("P0: {readings:?}; {report}");
    assert!(
        run.handle.console().contains('B'),
        "the program ran; {report}"
    );

    let levels = transitions(readings);
    // `dirh` drives the idle low, then the burst.
    let idle = levels
        .iter()
        .position(|&(_, level)| level == Level::Low)
        .unwrap_or_else(|| panic!("the enabled clock pin idles low; {readings:?}"));
    let burst = &levels[idle..];
    assert!(burst.len() >= 5, "a burst follows the idle; {readings:?}");
    assert_eq!(
        burst[1..5].iter().map(|&(_, l)| l).collect::<Vec<_>>(),
        vec![Level::High, Level::Low, Level::High, Level::Low],
        "two pulses; {readings:?}"
    );
    let half_ns = 16 * RC_CLOCK_NS;
    assert!(
        burst[1..5].windows(2).all(|w| w[1].0 - w[0].0 == half_ns),
        "the transitions are half a period apart; {readings:?}"
    );
    // The idle low is `dirh`'s; the `wypin` after it is one instruction.
    assert_eq!(
        burst[1].0 - burst[0].0,
        INSTRUCTION_NS + half_ns,
        "the first transition is half a period after the wypin; {readings:?}"
    );
    let last_edge = burst[4].0;
    assert!(
        readings
            .iter()
            .any(|r| r.at_ns > last_edge && r.level.is_none() && !r.periodic),
        "the cleared clock pin is released; {readings:?}"
    );
}
