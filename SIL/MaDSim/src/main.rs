mod machine_ui;
mod machine_view;
mod wiring;

use clap::Parser;
use embsim_memory_inspect::FirmwareInfo;
use embsim_p2;
use embsim_peripherals::{encoder, filesystem, lock, pulse_out, serial, system};
use std::os::fd::AsRawFd;
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

fn main() {
    let args = Args::parse();

    // Setup logging
    let level = match args.log_level.as_str() {
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

    info!("MaD Emulator v{}", env!("CARGO_PKG_VERSION"));
    info!("Speed: {}x", args.speed);
    info!("PTY path: {}", args.pty_path);
    info!("SD path: {}", args.sd_path);

    // Register UI views and start the web server
    if args.trace_port > 0 {
        embsim_trace::register_view();
        machine_view::register_view();
        embsim_ui::start_server(args.trace_port);
    }

    // Parse firmware DWARF debug info for enum/struct introspection
    let fw = FirmwareInfo::from_archive(Path::new(&args.firmware_lib))
        .expect("Failed to parse firmware debug info");

    // Initialize machine view GPIO channel mappings (needs fw info)
    if args.trace_port > 0 {
        machine_view::init(&fw);
    }

    // Resolve channel counts from firmware enums
    let serial_count = fw.channel_count("HAL_serial_channel_E");
    let encoder_count = fw.channel_count("HAL_encoder_channel_E");
    let pulse_out_count = fw.channel_count("HAL_pulseOut_channel_E");

    let serial_main = fw.enum_channel("HAL_SERIAL_CHANNEL_MAIN");

    // Initialize embsim infrastructure with P2 constants
    embsim_core::virtual_clock::init(args.speed, embsim_p2::P2_CLOCK_FREQ);

    // Initialize peripherals with firmware-derived channel counts
    serial::init(serial_count);
    encoder::init(encoder_count);
    pulse_out::init(pulse_out_count);
    lock::init(embsim_p2::P2_MAX_LOCKS);
    system::init(embsim_p2::P2_MAX_COGS);
    filesystem::init(&args.sd_path);

    // Create PTY pair for UI serial communication
    let pty = embsim_core::serial_pty::Pty::new(&args.pty_path)
        .expect("Failed to create PTY pair");
    info!("UI can connect to: {}", pty.symlink_path);

    // Wire PTY to serial channel MAIN
    serial::init_channel_fd(serial_main, pty.master.as_raw_fd());

    // Optional deterministic baud-rate pacing on the MAIN serial channel.
    // Enabled by setting MAD_SIM_BAUD to a positive integer (e.g. 230400).
    // When unset or 0, TX is instant (default behaviour).
    match std::env::var("MAD_SIM_BAUD") {
        Ok(raw) => match raw.trim().parse::<u32>() {
            Ok(0) => info!("MAD_SIM_BAUD=0; serial baud pacing disabled"),
            Ok(baud) => {
                serial::set_baud(serial_main, baud);
                info!(
                    "Serial MAIN baud pacing enabled at {} bps (deterministic, full-duplex)",
                    baud
                );
            }
            Err(_) => warn!("MAD_SIM_BAUD={:?} is not a valid u32; pacing disabled", raw),
        },
        Err(_) => {}
    }

    // Wire machine: register callbacks, set initial GPIO states
    wiring::init(&fw);

    // Register C firmware variables for trace polling
    if args.trace_port > 0 {
        // Build the firmware variable catalog from DWARF debug info.
        // Variables are NOT activated at startup — they are activated on-demand
        // from the trace viewer UI when the user selects them.
        embsim_trace::set_firmware_info(&fw);

        // Start C variable polling thread
        let fw_clone = fw.clone();
        std::thread::Builder::new()
            .name("trace-poll".into())
            .spawn(move || poll_c_variables(&fw_clone))
            .expect("Failed to start trace poll thread");
    }

    info!("Starting firmware...");

    // Call the firmware's mad_begin() entry point
    unsafe {
        mad_begin();
    }

    // Firmware main() should not return in normal operation,
    // but if it does, we wait for threads to finish
    info!("Firmware main() returned, waiting for threads...");
    system::join_all_threads();
    info!("All threads finished. Exiting.");
}

/// Periodically poll registered C firmware variables and record to trace.
fn poll_c_variables(fw: &FirmwareInfo) {
    use embsim_memory_inspect::SymbolResolver;

    // Wait a moment for firmware to initialize
    std::thread::sleep(std::time::Duration::from_millis(500));

    let resolver = match SymbolResolver::new() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("Trace C-variable polling disabled: {}", e);
            return;
        }
    };

    loop {
        let watches = embsim_trace::c_watches();
        for watch in &watches {
            let value: Option<f64> = unsafe {
                resolver.read_field_as_f64(fw, &watch.var_name, &watch.field_path)
            };
            if let Some(v) = value {
                embsim_trace::record(&watch.signal_name, v);
            }
        }

        // Re-record all model/peripheral signals at the current time so
        // that the trace has uniform sample density at the configured rate.
        embsim_trace::resample_all();

        // Poll at configurable rate (default 10ms / 100Hz)
        let interval_us = embsim_trace::poll_interval_us();
        let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(interval_us);
        if wall_us > 0 {
            std::thread::sleep(std::time::Duration::from_micros(wall_us));
        }
    }
}

