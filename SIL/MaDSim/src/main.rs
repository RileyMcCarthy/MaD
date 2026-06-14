#[cfg(feature = "web")]
mod machine_ui;
#[cfg(feature = "web")]
mod machine_view;
mod wiring;

use clap::Parser;
use embsim_memory_inspect::FirmwareInfo;
use embsim_runtime::Emulator;
use std::path::Path;
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

    // Parse firmware DWARF debug info once; reused for UI setup and the emulator.
    let fw = FirmwareInfo::from_archive(Path::new(&args.firmware_lib))?;

    // Register UI views + machine view BEFORE the emulator starts (they only
    // need firmware enum info, not initialized peripherals). No-op without the
    // `web` feature (headless build).
    let trace_enabled = setup_trace_ui(args.trace_port, &fw)?;

    let baud = host_serial_baud_from_env();

    Emulator::builder(embsim_p2::P2)
        .firmware(fw)
        .machine(Box::new(wiring::MadMachine))
        .clock_speed(args.speed)
        .host_pty(args.pty_path)
        .sd_path(args.sd_path)
        .host_serial_baud(baud)
        .entry(|| unsafe { mad_begin() })
        .on_wired(move |fw| {
            if trace_enabled {
                // Drive the trace: the poller (now owned by embsim-trace) turns
                // record() calls + activated C variables into the time-series.
                embsim_trace::spawn_poller(fw);
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
fn setup_trace_ui(port: u16, fw: &FirmwareInfo) -> Result<bool, Box<dyn std::error::Error>> {
    if port == 0 {
        return Ok(false);
    }
    embsim_trace::register_view();
    machine_view::register_view();
    embsim_ui::start_server(port)?;
    machine_view::init(fw);
    embsim_trace::set_firmware_info(fw);
    Ok(true)
}

#[cfg(not(feature = "web"))]
fn setup_trace_ui(_port: u16, _fw: &FirmwareInfo) -> Result<bool, Box<dyn std::error::Error>> {
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

