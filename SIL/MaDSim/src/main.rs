//! MaD SIL emulator entry point.
//!
//! Boot order matters, and it is not the historical one. The firmware runs
//! **inside the simulated system**: the `P2EVAL`
//! [`McuComponent`](embsim_board::mcu::McuComponent) in `system_description`
//! owns `mad_begin()` and spawns it on a thread bound to its own
//! [`PeripheralInstance`](embsim_peripherals::instance::PeripheralInstance)
//! (`BOARD_ENGINE.md`, "The MCU as a component"). So:
//!
//! 1. parse args, read the firmware archive (DWARF + HAL config tables);
//! 2. **describe the system** — this creates the MCU's peripheral instance;
//! 3. **bind this thread to that instance**, so everything the runtime then
//!    initializes through peripheral free functions (channel banks, locks,
//!    threads, the host PTY, the SD mount) lands on the instance the firmware
//!    will actually run against, not on the process default;
//! 4. let `Emulator::run` do that init and call `Machine::wire` (models and
//!    callbacks, all instance-routed);
//! 5. from the emulator's entry hook — the "hand control to the firmware"
//!    step — call `System::start`, which attaches every component onto the
//!    live net engine and *then* spawns the firmware. The main thread has
//!    nothing left to run and parks.

#[cfg(feature = "web")]
mod iss_description;
mod machine_ui;
#[cfg(feature = "web")]
mod machine_view;
mod system_description;
mod wiring;

use clap::Parser;
use embsim_memory_inspect::FirmwareInfo;
use embsim_peripherals::instance::{self, PeripheralInstance};
use embsim_runtime::Emulator;
use models::sample::{Config as SampleConfig, MaterialProperties, Sample};
use models::{gantry, strain_gauge};
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{info, warn, Level};
use tracing_subscriber::FmtSubscriber;

/// MaD Tensile Testing Machine — SIL Emulator
#[derive(Parser, Debug)]
#[command(name = "mad-emulator", version, about)]
struct Args {
    /// Time scale factor (1.0 = real-time, 5.0 = 5x fast, 0.5 = half speed)
    #[arg(long, default_value_t = 1.0)]
    speed: f64,

    /// Symlink path for slave PTY
    #[arg(long, default_value = "/tmp/tty.rpi_client")]
    pty_path: String,

    /// SD card mount directory
    #[arg(long, default_value = "./sd")]
    sd_path: String,

    /// Log verbosity: error, warn, info, debug, trace
    #[arg(long, default_value = "info")]
    log_level: String,

    /// Disable force gauge simulation (zero force always)
    #[arg(long)]
    no_force_sim: bool,

    /// Path to libfirmware.a (for DWARF debug info introspection)
    #[arg(
        long,
        default_value = "../Firmware/MaDCore/.pio/build/native_emulator/libfirmware.a"
    )]
    firmware_lib: String,

    /// Trace viewer HTTP port (0 to disable)
    #[arg(long, default_value_t = 0)]
    trace_port: u16,

    /// Run the **instruction-set simulator** against a real P2 image instead
    /// of the host-compiled firmware.
    ///
    /// The native backend substitutes the HAL and runs clang-compiled code, so
    /// it cannot see flexcc codegen bugs, 32-bit pointer assumptions or
    /// smart-pin misconfiguration. This runs the artifact you actually flash,
    /// with its serial pins on real nets at the rate the firmware programs
    /// them. Slower, and this slice bridges the protocol link only.
    #[arg(long, value_name = "IMAGE")]
    iss: Option<PathBuf>,

    /// ISS only: put the host on the board as a computer — a QEMU guest
    /// booted from this image (embsim-qemu's Chrome guest) whose clock is
    /// metered by the board's, in place of the host PTY. The guest's Chrome
    /// is reachable at the printed DevTools URL for `connectOverCDP`.
    #[arg(long, requires = "iss")]
    computer: Option<PathBuf>,

    /// Host port forwarded to the guest's DevTools (0 = any free port).
    #[arg(long, default_value_t = 0, requires = "computer")]
    devtools_port: u16,
}

// The firmware's mad_begin() is linked from libfirmware.a
extern "C" {
    fn mad_begin();
}

/// Set by SIGTERM/SIGINT; the parked main thread notices and returns, so the
/// system drops in order — engine joined, components dropped, and a computer
/// node's QEMU quit with them rather than orphaned holding its ports.
static SHUTDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

extern "C" fn on_shutdown_signal(_signal: libc::c_int) {
    SHUTDOWN.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn install_shutdown_signals() {
    let handler: extern "C" fn(libc::c_int) = on_shutdown_signal;
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGTERM, handler as usize as libc::sighandler_t);
        libc::signal(libc::SIGINT, handler as usize as libc::sighandler_t);
    }
}

/// Park until a shutdown signal arrives.
fn park_until_shutdown() {
    while !SHUTDOWN.load(std::sync::atomic::Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    info!("shutdown signal received; stopping the system");
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    init_logging(&args.log_level);

    info!("MaD Emulator v{}", env!("CARGO_PKG_VERSION"));
    info!(
        "Speed: {}x  PTY: {}  SD: {}",
        args.speed, args.pty_path, args.sd_path
    );

    if let Some(image) = args.iss.clone() {
        return run_iss(&args, &image);
    }

    // Parse firmware DWARF debug info once; reused for the system description,
    // the UI setup and the emulator.
    let firmware_lib = PathBuf::from(&args.firmware_lib);
    let fw = FirmwareInfo::from_archive(&firmware_lib)?;

    // Describe the simulated system. This builds the P2 as a board component
    // that OWNS the firmware entry, which means it also creates the peripheral
    // instance the firmware will run against (HAL config tables come from the
    // same archive). Nothing is live yet — `start()` below does that.
    let force_path = system_description::describe(&fw, &firmware_lib, || unsafe { mad_begin() });
    let mcu = Arc::clone(force_path.mcu_instance());

    // Bind THIS thread to the MCU's instance before the runtime initializes
    // peripherals. `Emulator::run` sizes the channel banks, the lock pool and
    // the thread registry, mounts the SD path and bridges the host PTY through
    // peripheral FREE functions, which route to the *calling thread's*
    // instance. Unbound, all of that would land on the process-default
    // instance and the firmware — running on the component's own instance —
    // would boot with no channels, no host serial and no SD card. The guard is
    // `!Send` and must outlive the init; `run()` never returns, so it lives
    // for the process.
    let _mcu_bind = instance::bind_current_thread(Arc::clone(&mcu));

    // Register UI views + machine view BEFORE the emulator starts (they only
    // need firmware enum info and the MCU instance, not initialized
    // peripherals). No-op without the `web` feature (headless build).
    let trace_enabled = setup_trace_ui(args.trace_port, &fw, &mcu)?;

    let baud = host_serial_baud_from_env();

    Emulator::builder(embsim_p2::P2)
        .firmware(fw)
        .machine(Box::new(wiring::MadMachine::new(
            Arc::clone(&mcu),
            force_path.bridge(),
        )))
        .clock_speed(args.speed)
        .host_pty(args.pty_path)
        .sd_path(args.sd_path)
        .host_serial_baud(baud)
        .on_wired(move |fw| {
            if trace_enabled {
                // Drive the trace: the poller (now owned by embsim-trace) turns
                // record() calls + activated C variables into the time-series.
                embsim_trace::spawn_poller(fw);
            }
        })
        // "Hand control to the firmware" is now `System::start`: it spawns the
        // net engine, attaches every component (the ADS122U04 model, the load
        // cell, and the P2's serial bridges) and only then lets the P2
        // component spawn `mad_begin()` on its own instance-bound thread.
        // The main thread has nothing left to do — but it must not return,
        // because `Emulator::run` drops the host PTY when the entry does.
        .entry(move || {
            let _force_path = force_path.start();
            info!("Firmware running on the P2 component's own thread; main thread parked.");
            loop {
                std::thread::park();
            }
        })
        .build()?
        .run()?;

    info!("Exiting.");
    Ok(())
}

/// Run the P2 instruction-set simulator instead of the native firmware.
///
/// A different world from the native path, and deliberately so: there is no
/// `FirmwareInfo`, no peripheral instance and no `Emulator`, because there is
/// no host-compiled firmware to substitute a HAL for. The image runs on
/// `p2core`, its protocol pins are on nets, and the host PTY is a component
/// like any other.
///
/// Every signal here crosses a net as a voltage: the protocol link as framed
/// levels, GPIO and the encoder as plain ones. The step train is the exception
/// still outstanding — a rate belongs on a periodic drive, not on 8192 level
/// edges per millimetre — so a host can read and write the protocol and see
/// the machine's inputs, but cannot yet move a carriage.
fn run_iss(args: &Args, image_path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use embsim_board::{Harness, System};
    use p2iss::{HostPty, P2Iss, SerialLink};

    /// A 32 MiB card: at 2 KiB clusters that lands mid-window for FAT16,
    /// clear of the cluster counts where the type would be read as FAT12 or
    /// FAT32 instead.
    const SD_CARD_BYTES: usize = 32 * 1024 * 1024;

    /// The MaD protocol link, as the firmware programs it.
    const PROTO: SerialLink = SerialLink {
        tx_pin: crate::iss_description::pins::RPI_TX,
        rx_pin: crate::iss_description::pins::RPI_RX,
        nominal_baud: 2_000_000,
    };

    use crate::iss_description::{
        BenchForcePath, BenchMachine, BenchPulls, BenchSd, FORCE_GAUGE, IDLE_PULLS, INPUT_PINS,
        LEVEL_PINS, PULSE_PINS, SD_INPUT_PINS, SD_LEVEL_PINS,
    };

    install_shutdown_signals();
    let image = std::fs::read(image_path)?;
    info!(
        "ISS: {} ({} bytes) — protocol on P{}/P{}",
        image_path.display(),
        image.len(),
        PROTO.tx_pin,
        PROTO.rx_pin
    );

    embsim_core::virtual_clock::init(args.speed, 160_000_000);
    // Hold time authority from here: the component models spawn actor
    // threads (the ADS122U04 protocol loop) before the engine exists, and a
    // parked actor with nobody in authority idle-jumps the clock forward.
    // That made the run's time origin depend on how long assembly took on
    // the wall clock -- a different virtual T0 every boot, and with it a
    // different guest history (the first slice runs the guest up to T0).
    let _time_authority = embsim_core::virtual_clock::take_time_authority();

    // A formatted card, mirroring `--sd-path` if it exists. A blank one is a
    // block device with no filesystem: the firmware's own FatFs rejects it and
    // boots on failsafe records.
    let card = p2iss::sdimage::mad_card(SD_CARD_BYTES, Some(std::path::Path::new(&args.sd_path)))
        .map_err(|e| format!("building the SD image: {e}"))?;
    info!(
        "ISS: SD card {} MiB, mirroring {}",
        SD_CARD_BYTES / (1024 * 1024),
        args.sd_path
    );

    // Both serial links the firmware drives: the host protocol and the force
    // gauge. Each is the same levels-on-a-net as any other pin, with a framer
    // on top at the rate the guest's own smart pin is programmed for.
    let links = [PROTO, FORCE_GAUGE];
    // The card is a COMPONENT now, not part of the CPU model: the machine
    // gets an empty in-process card (nothing routes to it once the SPI pins
    // are lifted onto nets) and the real image sits across four wires.
    let sd = BenchSd::build(card);
    // The SD wires join the other net pins: three driven levels and one input.
    // The ISS discovers the clock/TX/RX roles from the mode words the firmware
    // programs — it holds no notion of an "SPI bus".
    let sd_levels: Vec<u8> = LEVEL_PINS.iter().chain(SD_LEVEL_PINS).copied().collect();
    let sd_inputs: Vec<u8> = INPUT_PINS.iter().chain(SD_INPUT_PINS).copied().collect();
    let iss = P2Iss::new(&image, p2core::SdCard::blank(0), &links)
        .with_level_pins(&sd_levels)
        .with_input_pins(&sd_inputs)
        .with_pulse_pins(PULSE_PINS)
        .with_sync_serial();
    let handle = iss.handle();
    // The host end of the protocol link: a PTY for a human or a bridge, or a
    // whole computer whose clock the board meters. Same two pins either way.
    let host: Box<dyn embsim_board::Component> = match &args.computer {
        Some(image) => {
            let chrome = embsim_qemu::ChromeGuest::new(image)
                .devtools_port(args.devtools_port)
                .spawn()
                .map_err(|e| format!("computer node: {e}"))?;
            info!(
                "Computer node: Chrome guest ready, DevTools at {} (frozen until the board runs)",
                chrome.devtools().url()
            );
            Box::new(embsim_qemu::QemuNode::new(
                Box::new(chrome),
                PROTO.nominal_baud,
            ))
        }
        None => {
            let host = HostPty::open(&args.pty_path, PROTO.nominal_baud)?;
            info!("Host can connect to: {}", host.symlink_path());
            Box::new(host)
        }
    };

    let pulls = BenchPulls::new(IDLE_PULLS);
    let force = BenchForcePath::build();
    let machine = BenchMachine::build()?;
    let travel = machine.travel();

    let mut harness = Harness::new()
        .connect_str("P2.P55", "HOST.RX")?
        .connect_str("HOST.TX", "P2.P53")?;
    for (from, to) in pulls.wires() {
        harness = harness.connect_str(&from, &to)?;
    }
    // Dotted endpoints: the component is named "P2" and its pins "P0".."P63",
    // so the force-gauge TX is "P2.P2".
    harness = force.wire(
        harness,
        &format!("P2.{}", p2iss::pin_name(FORCE_GAUGE.tx_pin)),
        &format!("P2.{}", p2iss::pin_name(FORCE_GAUGE.rx_pin)),
    );
    harness = machine.wire(harness);
    harness = sd.wire(harness);

    // The sample, and the chain that lets the load cell weigh it.
    //
    // Without this the bridge sits balanced forever, the ADC reads exactly
    // zero however far the carriage travels, and every force assertion fails
    // while the machine otherwise looks healthy. The native bench builds this
    // chain in `wiring.rs`; the ISS description took the drive handle and
    // dropped it on the floor, which is why the ISS could home, move and log
    // perfectly and still never develop a newton of tension.
    //
    //   carriage position -> gantry extension past the grip slack
    //                     -> sample force (k = E*A/L0)
    //                     -> strain-gauge millivolts
    //                     -> the load cell's live bench terminals
    //
    // Same models and the same constants as the native bench, so the two
    // describe one machine rather than two. The gantry's limit comparators are
    // unused here -- the ISS has real `EndSwitch` models at the travel ends --
    // so its thresholds are parked outside the working range on purpose.
    let load = force.drive();
    let gantry_model = gantry::Gantry::new(gantry::Config {
        engagement_slack_mm: 15.0,
        tension_on_decreasing_position: false,
        upper_threshold_mm: -10.0,
        lower_threshold_mm: 300.0,
    });
    let strain = strain_gauge::StrainGauge::new(strain_gauge::Config {
        full_scale_force_n: 100.0,
        sensitivity_mv_per_v: -4.868009,
        excitation_v: 3.3,
    });
    let sample = Sample::new(SampleConfig {
        stiffness_n_per_mm: 5.0 / (100.0 - 15.0),
        tension_on_decreasing_position: false,
        material: Some(MaterialProperties {
            name: "SIL-Linear-Reference",
            youngs_modulus_mpa: 5.0 / (100.0 - 15.0),
            area_mm2: 20.0,
            gauge_length_mm: 20.0,
        }),
    });
    {
        let smp = Arc::clone(&sample);
        gantry_model.on_extension_change(move |extension_mm| smp.on_extension(extension_mm));
    }
    {
        let sg = Arc::clone(&strain);
        sample.on_change(move |force_n| sg.set_force(force_n));
    }
    {
        let bridge = load.clone();
        strain.on_change(move |voltage_mv| bridge.set_differential_mv(voltage_mv));
    }
    {
        let g = Arc::clone(&gantry_model);
        machine
            .motor
            .shaft()
            .on_position_change(move |mm| g.on_position(mm));
    }

    let system = System::new()
        .component("P2", Box::new(iss))
        .component("HOST", host)
        .component("PULLS", Box::new(pulls));
    let system = sd.mount(machine.mount(force.mount(system)));
    // A computer node holds virtual time still for a slice plus its QMP round
    // trips; one slow host moment must delay the board, not break the
    // engine's actor barrier for the rest of the run.
    let system = if args.computer.is_some() {
        system.quiescence_timeout(std::time::Duration::from_secs(30))
    } else {
        system
    };
    let _system = system.harness(harness).start()?;

    info!("ISS running; main thread parked.");
    // Report periodically, not once. The two numbers that matter while
    // something is attached are the byte counts and how fast guest time is
    // advancing: the ISS interprets every instruction, so if it falls far
    // behind the wall clock a host's response timeouts expire no matter how
    // correct the firmware is.
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let mut last = (0u64, 0u128);
        // The guest narrates its own boot and faults on its debug UART (P62).
        // Under the native backend those lines reach the operator's terminal
        // through the substituted HAL; on the ISS they land in the board's
        // console buffer, so forward them or the firmware's own explanation of
        // what it is doing is invisible.
        let mut echoed = 0usize;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let guest_us = handle.guest_now_us();
            let wall_ms = start.elapsed().as_millis();
            let rate = (guest_us.saturating_sub(last.0)) as f64
                / ((wall_ms - last.1).max(1) as f64 * 1000.0);
            last = (guest_us, wall_ms);
            let (tx, rx) = handle.byte_counts();
            let carriage = travel.take_window();
            let console = handle.console();
            if console.len() > echoed {
                for line in console[echoed..].lines().filter(|l| !l.trim().is_empty()) {
                    info!(target: "guest", "{}", line.trim_end());
                }
                echoed = console.len();
            }
            // Both links, because "the protocol works" and "the force gauge
            // works" are different questions and a single number hides one of
            // them. A `?` means the guest has never transmitted on that pin —
            // which is itself the answer when a peripheral is silent.
            info!(
                "ISS: {} cogs, {:.4}x real time, proto {} baud, fg {} baud, tx {} rx {} bytes, {} frames dropped, {} edges dropped, carriage {:.3} mm ({:.3}..{:.3})",
                handle.running_cogs(),
                rate,
                handle
                    .derived_baud(PROTO.tx_pin)
                    .map_or_else(|| "?".to_string(), |b| b.to_string()),
                handle
                    .derived_baud(FORCE_GAUGE.tx_pin)
                    .map_or_else(|| "?".to_string(), |b| b.to_string()),
                tx,
                rx,
                // A dropped frame is invisible to the guest: the byte never
                // arrives and its driver reports a timeout, not corruption.
                // Non-zero here is the difference between "the peripheral is
                // slow" and "the wire is eating replies".
                handle.rx_framing_errors(),
                // The level-pin edge queue is bounded; an overflow silently
                // loses a transition, and an edge-counted input never gets it
                // back. Counted since it was added, reported since never.
                handle.edges_dropped(),
                // Where the carriage actually went. A commanded move that runs
                // into an endstop is invisible from every other vantage point:
                // the firmware logs targets, not travel, and the app samples
                // far too slowly to show the envelope of a waveform.
                carriage.0,
                carriage.1,
                carriage.2,
            );
        }
    });
    park_until_shutdown();
    Ok(())
}

/// Register the trace viewer + machine visualizer web UI and start the server.
/// Returns whether tracing is enabled. With the `web` feature off this is a
/// no-op that always returns `false` (headless build).
#[cfg(feature = "web")]
fn setup_trace_ui(
    port: u16,
    fw: &FirmwareInfo,
    mcu: &Arc<PeripheralInstance>,
) -> Result<bool, Box<dyn std::error::Error>> {
    if port == 0 {
        return Ok(false);
    }
    embsim_trace::register_view();
    machine_view::register_view();
    embsim_ui::start_server(port)?;
    machine_view::init(fw, Arc::clone(mcu));
    embsim_trace::set_firmware_info(fw);
    Ok(true)
}

#[cfg(not(feature = "web"))]
fn setup_trace_ui(
    _port: u16,
    _fw: &FirmwareInfo,
    _mcu: &Arc<PeripheralInstance>,
) -> Result<bool, Box<dyn std::error::Error>> {
    Ok(false)
}

/// Configure the global tracing subscriber from a log-level string.
fn init_logging(log_level: &str) {
    let level = match log_level {
        "error" => Level::ERROR,
        "warn" => Level::WARN,
        "info" => Level::INFO,
        "debug" => Level::DEBUG,
        "trace" => Level::TRACE,
        _ => Level::INFO,
    };
    let subscriber = FmtSubscriber::builder()
        .with_max_level(level)
        .with_target(true)
        .with_thread_ids(true)
        .with_thread_names(true)
        .finish();
    tracing::subscriber::set_global_default(subscriber).expect("Failed to set tracing subscriber");
}

/// Optional deterministic baud-rate pacing on the host serial channel.
/// Enabled by setting `MAD_SIM_BAUD` to a positive integer (e.g. 230400).
/// Unset or 0 means instant TX (the default).
fn host_serial_baud_from_env() -> u32 {
    match std::env::var("MAD_SIM_BAUD") {
        Ok(raw) => match raw.trim().parse::<u32>() {
            Ok(0) => {
                info!("MAD_SIM_BAUD=0; serial baud pacing disabled");
                0
            }
            Ok(baud) => baud,
            Err(_) => {
                warn!("MAD_SIM_BAUD={raw:?} is not a valid u32; pacing disabled");
                0
            }
        },
        Err(_) => 0,
    }
}
