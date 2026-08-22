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
mod machine_ui;
#[cfg(feature = "web")]
mod machine_view;
mod system_description;
mod wiring;

use clap::Parser;
use embsim_memory_inspect::FirmwareInfo;
use embsim_peripherals::instance::{self, PeripheralInstance};
use embsim_runtime::Emulator;
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
    #[arg(long, default_value = "../Firmware/MaDCore/.pio/build/native_emulator/libfirmware.a")]
    firmware_lib: String,

    /// Trace viewer HTTP port (0 to disable)
    #[arg(long, default_value_t = 0)]
    trace_port: u16,
}

// The firmware's mad_begin() is linked from libfirmware.a
extern "C" {
    fn mad_begin();
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    init_logging(&args.log_level);

    info!("MaD Emulator v{}", env!("CARGO_PKG_VERSION"));
    info!("Speed: {}x  PTY: {}  SD: {}", args.speed, args.pty_path, args.sd_path);

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
    tracing::subscriber::set_global_default(subscriber)
        .expect("Failed to set tracing subscriber");
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
