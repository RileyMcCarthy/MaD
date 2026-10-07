//! MaD SIL emulator entry point.
//!
//! The firmware under test is the Propeller 2 image, executed by the
//! instruction-set simulator. Its pins are nets. The host is a PTY a browser
//! outside the emulator opens. There is no host-compiled firmware and no HAL
//! stand-in: `mad_begin` is not linked.

mod iss_description;
mod system_description;

use clap::Parser;
use models::sample::{Config as SampleConfig, MaterialProperties, Sample};
use models::{gantry, strain_gauge};
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{info, Level};
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

    /// The P2 image to execute: `propeller2_debug`'s `program`, or a mask ROM
    /// when `--boot-rom` is set.
    #[arg(value_name = "IMAGE")]
    image: PathBuf,

    /// Boot the mask ROM and put the host on the programming UART (P62/P63)
    /// instead of the protocol link. The ROM's serial strap (P59 pull-up) is
    /// fitted, so `Prop_Chk` works without a DTR→RESn line.
    #[arg(long)]
    boot_rom: bool,
}

/// Set by SIGTERM/SIGINT; the parked main thread notices and returns, so the
/// system drops in order — engine joined, components dropped.
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

    let image = args.image.clone();
    if args.boot_rom {
        run_iss_rom(&args, &image)
    } else {
        run_iss(&args, &image)
    }
}

/// Boot the mask ROM with the host on the programming UART (P62/P63).
///
/// The host is the PTY. A browser outside the emulator opens it. The ROM's
/// serial strap is a pull-up on P59, so `Prop_Chk` works without a DTR line.
fn run_iss_rom(args: &Args, rom_path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use embsim_board::{
        AttachError, Component, ComponentNetIo, Harness, PinDecl, System, TheveninDrive,
    };
    use p2iss::{HostPty, P2Iss, SerialLink};

    const PROG: SerialLink = SerialLink {
        tx_pin: 62,
        rx_pin: 63,
        nominal_baud: 2_000_000,
    };

    struct Pull {
        pins: [PinDecl; 1],
        volts: f64,
    }
    impl Pull {
        fn new(volts: f64) -> Self {
            Self {
                pins: [PinDecl::analog_source("A")],
                volts,
            }
        }
    }
    impl Component for Pull {
        fn pins(&self) -> &[PinDecl] {
            &self.pins
        }
        fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
            io.pin("A")?.set_drive(Some(TheveninDrive {
                volts: self.volts,
                impedance: 15_000.0,
            }));
            Ok(())
        }
    }

    install_shutdown_signals();
    let rom = std::fs::read(rom_path)?;
    info!(
        "ISS ROM: {} ({} bytes) — programming UART on P{}/P{}",
        rom_path.display(),
        rom.len(),
        PROG.tx_pin,
        PROG.rx_pin
    );

    embsim_core::virtual_clock::init(args.speed, 20_000_000);
    let _time_authority = embsim_core::virtual_clock::take_time_authority();

    let iss = P2Iss::with_boot_rom(&rom, p2core::SdCard::blank(0), &[PROG]).with_level_pins(&[59]);
    let handle = iss.handle();

    let host_pty = HostPty::open(&args.pty_path, PROG.nominal_baud)?;
    info!("Host can connect to: {}", host_pty.symlink_path());
    let host: Box<dyn embsim_board::Component> = Box::new(host_pty);

    let harness = Harness::new()
        .connect_str("P2.P62", "HOST.RX")?
        .connect_str("HOST.TX", "P2.P63")?
        .connect_str("P2.P59", "STRAP.A")?;

    let system = System::new()
        .component("P2", Box::new(iss))
        .component("HOST", host)
        .component("STRAP", Box::new(Pull::new(3.3)));
    let _system = system.harness(harness).start()?;

    info!("ISS ROM serial running; main thread parked.");
    std::thread::spawn(move || {
        let mut echoed = 0usize;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let (tx, rx) = handle.byte_counts();
            let console = handle.console();
            if console.len() > echoed {
                let fresh = &console[echoed..];
                eprint!("{fresh}");
                echoed = console.len();
            }
            info!(
                "ISS ROM: tx={tx} rx={rx} guest_us={}",
                handle.guest_now_us()
            );
        }
    });
    park_until_shutdown();
    Ok(())
}

/// Run the P2 image on the instruction-set simulator.
///
/// The image runs on `p2core`. Every signal crosses a net as a voltage: the
/// protocol link as framed levels, GPIO and the encoder as plain ones, and the
/// step train as a periodic drive. The host PTY is a component like any other.
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
    // The host end of the protocol link: a PTY for a browser outside the emulator.
    let host_pty = HostPty::open(&args.pty_path, PROTO.nominal_baud)?;
    info!("Host can connect to: {}", host_pty.symlink_path());
    let host: Box<dyn embsim_board::Component> = Box::new(host_pty);

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
    // while the machine otherwise looks healthy.
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
        // They land in the board's console buffer, so forward them or the
        // firmware's own explanation of what it is doing is invisible.
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
