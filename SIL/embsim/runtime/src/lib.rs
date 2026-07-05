//! embsim-runtime — the owning entry abstraction for an emulator.
//!
//! Standing up an emulator means initializing the virtual clock and every
//! peripheral *in the right order*, bridging a host serial PTY, wiring the
//! project's physical models, and finally calling the firmware entry point.
//! Historically every consumer hand-wrote that ~120-line sequence and had to
//! remember the ordering (clock before any timer/serial call; `serial::init`
//! before `serial::init_channel_fd`; …). [`Emulator`] encodes it instead.
//!
//! A new project provides exactly two things:
//! 1. a [`Platform`] — MCU constants (clock frequency, core/lock counts),
//!    typically already supplied by a platform crate such as `embsim-p2`;
//! 2. a [`Machine`] — the project-specific wiring (peripheral channel counts,
//!    which serial channel reaches the host, and the model callback graph).
//!
//! ```rust,ignore
//! let fw = FirmwareInfo::from_archive("libfirmware.a")?;
//! Emulator::builder(embsim_p2::P2)
//!     .firmware(fw)
//!     .machine(Box::new(MyMachine::new()))
//!     .clock_speed(1.0)
//!     .host_pty("/tmp/tty.sim_client")
//!     .sd_path("./sd")
//!     .entry(|| unsafe { firmware_begin() })
//!     .build()?
//!     .run()?;
//! ```

use embsim_core::serial_pty::Pty;
use embsim_core::virtual_clock;
use embsim_memory_inspect::FirmwareInfo;
use embsim_peripherals::{encoder, filesystem, gpio, lock, pulse_out, serial, system};
use std::fmt;
use std::os::fd::AsRawFd;
use std::path::Path;
use tracing::info;

/// MCU/platform constants. Implemented by a platform crate (e.g. `embsim-p2`).
pub trait Platform {
    /// System clock frequency in Hz (drives `virtual_clock` cycle math).
    fn clock_freq_hz(&self) -> u32;
    /// Maximum concurrent execution cores (mapped to OS threads).
    fn max_cores(&self) -> usize;
    /// Maximum hardware locks.
    fn max_locks(&self) -> usize;
}

/// Peripheral channel counts for a firmware, typically resolved from its DWARF
/// enums (e.g. `fw.channel_count("HAL_serial_channel_E")`).
#[derive(Debug, Clone, Default)]
pub struct PeripheralCounts {
    /// Number of GPIO channels.
    pub gpio: usize,
    /// Optional GPIO channel names, indexed by channel (for readable logs).
    pub gpio_names: Option<&'static [&'static str]>,
    /// Number of serial channels.
    pub serial: usize,
    /// Number of encoder channels.
    pub encoder: usize,
    /// Number of pulse-output channels.
    pub pulse_out: usize,
}

/// Project-specific machine wiring. Implemented by the consumer.
///
/// The runtime initializes all peripherals from [`Machine::peripheral_counts`]
/// before calling [`Machine::wire`], so `wire` may freely register callbacks
/// and set initial peripheral states.
pub trait Machine {
    /// Firmware enum variant/type names this machine will look up at wire time.
    ///
    /// The runtime probes them up front and reports *all* missing names in one
    /// [`EmulatorError::MissingSymbols`], instead of panicking on the first one
    /// mid-startup — the difference between "these 3 enums were renamed" and a
    /// crash-fix-rerun loop when porting to a new firmware. Default: none.
    fn required_symbols(&self) -> &'static [&'static str] {
        &[]
    }

    /// Declare peripheral channel counts for this firmware.
    fn peripheral_counts(&self, fw: &FirmwareInfo) -> PeripheralCounts;

    /// The serial channel index bridged to the host PTY.
    fn host_serial_channel(&self, fw: &FirmwareInfo) -> usize;

    /// Wire models, callbacks, initial peripheral states, and trace signals.
    /// Called once, after peripherals are initialized and before the firmware
    /// entry point runs.
    fn wire(&self, fw: &FirmwareInfo);
}

/// Errors raised while building or running an emulator.
#[derive(Debug)]
pub enum EmulatorError {
    /// Firmware archive could not be parsed.
    Firmware(String),
    /// No firmware (parsed `FirmwareInfo` or archive path) was provided.
    MissingFirmware,
    /// No [`Machine`] was provided.
    MissingMachine,
    /// No firmware entry function was provided.
    MissingEntry,
    /// One or more firmware symbols the machine requires are absent from the
    /// firmware's debug info (renamed enums, wrong archive, missing `-g`, …).
    MissingSymbols(Vec<String>),
    /// A peripheral channel count exceeds the backing array's hard ceiling.
    TooManyChannels {
        /// Which peripheral (e.g. "gpio").
        peripheral: &'static str,
        /// Count requested by the machine.
        requested: usize,
        /// Hard maximum supported.
        max: usize,
    },
    /// Host serial PTY could not be created.
    Pty(std::io::Error),
}

impl fmt::Display for EmulatorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EmulatorError::Firmware(e) => write!(f, "failed to parse firmware debug info: {e}"),
            EmulatorError::MissingFirmware => {
                write!(f, "no firmware provided (call .firmware(..) or .firmware_lib(..))")
            }
            EmulatorError::MissingMachine => write!(f, "no machine provided (call .machine(..))"),
            EmulatorError::MissingEntry => write!(f, "no firmware entry provided (call .entry(..))"),
            EmulatorError::MissingSymbols(names) => write!(
                f,
                "firmware is missing {} required symbol(s): {}",
                names.len(),
                names.join(", ")
            ),
            EmulatorError::TooManyChannels { peripheral, requested, max } => write!(
                f,
                "{peripheral} channel count {requested} exceeds the maximum {max}"
            ),
            EmulatorError::Pty(e) => write!(f, "failed to create host serial PTY: {e}"),
        }
    }
}

impl std::error::Error for EmulatorError {}

type EntryFn = Box<dyn FnOnce()>;
type WiredHook = Box<dyn FnOnce(&FirmwareInfo)>;

/// Validate a requested channel count against a peripheral's hard maximum.
fn check_count(peripheral: &'static str, requested: usize, max: usize) -> Result<(), EmulatorError> {
    if requested > max {
        Err(EmulatorError::TooManyChannels { peripheral, requested, max })
    } else {
        Ok(())
    }
}

/// Builder for an [`Emulator`]. Create via [`Emulator::builder`].
pub struct EmulatorBuilder {
    platform: Box<dyn Platform>,
    firmware: Option<FirmwareInfo>,
    firmware_lib: Option<String>,
    machine: Option<Box<dyn Machine>>,
    entry: Option<EntryFn>,
    on_wired: Option<WiredHook>,
    clock_speed: f64,
    host_pty: String,
    sd_path: String,
    host_serial_baud: u32,
}

impl EmulatorBuilder {
    /// Provide an already-parsed [`FirmwareInfo`]. Takes precedence over
    /// [`firmware_lib`](EmulatorBuilder::firmware_lib).
    pub fn firmware(mut self, fw: FirmwareInfo) -> Self {
        self.firmware = Some(fw);
        self
    }

    /// Provide a path to a firmware archive; `build` parses it.
    pub fn firmware_lib(mut self, path: impl Into<String>) -> Self {
        self.firmware_lib = Some(path.into());
        self
    }

    /// The project machine wiring.
    pub fn machine(mut self, machine: Box<dyn Machine>) -> Self {
        self.machine = Some(machine);
        self
    }

    /// The firmware entry point (e.g. `|| unsafe { mad_begin() }`).
    pub fn entry(mut self, entry: impl FnOnce() + 'static) -> Self {
        self.entry = Some(Box::new(entry));
        self
    }

    /// Optional hook run after [`Machine::wire`] and before the entry point —
    /// the place to start a trace poller or other observers that need `&fw`.
    pub fn on_wired(mut self, hook: impl FnOnce(&FirmwareInfo) + 'static) -> Self {
        self.on_wired = Some(Box::new(hook));
        self
    }

    /// Time scale (1.0 = real-time, 5.0 = 5× faster). Default 1.0.
    pub fn clock_speed(mut self, speed: f64) -> Self {
        self.clock_speed = speed;
        self
    }

    /// Host-facing PTY symlink path. Default `/tmp/tty.sim_client`.
    pub fn host_pty(mut self, path: impl Into<String>) -> Self {
        self.host_pty = path.into();
        self
    }

    /// SD-card mount directory. Default `./sd`.
    pub fn sd_path(mut self, path: impl Into<String>) -> Self {
        self.sd_path = path.into();
        self
    }

    /// Optional deterministic baud pacing on the host serial channel.
    /// `0` (default) means unpaced (instant TX/RX).
    pub fn host_serial_baud(mut self, baud: u32) -> Self {
        self.host_serial_baud = baud;
        self
    }

    /// Resolve firmware + create the host PTY. Fallible setup happens here so
    /// [`Emulator::run`] can focus on the start sequence.
    pub fn build(self) -> Result<Emulator, EmulatorError> {
        let machine = self.machine.ok_or(EmulatorError::MissingMachine)?;
        let entry = self.entry.ok_or(EmulatorError::MissingEntry)?;

        let firmware = match self.firmware {
            Some(fw) => fw,
            None => {
                let path = self.firmware_lib.ok_or(EmulatorError::MissingFirmware)?;
                FirmwareInfo::from_archive(Path::new(&path)).map_err(EmulatorError::Firmware)?
            }
        };

        let pty = Pty::new(&self.host_pty).map_err(EmulatorError::Pty)?;
        info!("Host can connect to: {}", pty.symlink_path);

        Ok(Emulator {
            platform: self.platform,
            firmware,
            machine,
            entry,
            on_wired: self.on_wired,
            clock_speed: self.clock_speed,
            sd_path: self.sd_path,
            host_serial_baud: self.host_serial_baud,
            pty,
        })
    }
}

/// A fully-configured emulator, ready to [`run`](Emulator::run).
pub struct Emulator {
    platform: Box<dyn Platform>,
    firmware: FirmwareInfo,
    machine: Box<dyn Machine>,
    entry: EntryFn,
    on_wired: Option<WiredHook>,
    clock_speed: f64,
    sd_path: String,
    host_serial_baud: u32,
    pty: Pty,
}

impl Emulator {
    /// Start a builder for the given platform.
    pub fn builder(platform: impl Platform + 'static) -> EmulatorBuilder {
        EmulatorBuilder {
            platform: Box::new(platform),
            firmware: None,
            firmware_lib: None,
            machine: None,
            entry: None,
            on_wired: None,
            clock_speed: 1.0,
            host_pty: "/tmp/tty.sim_client".to_string(),
            sd_path: "./sd".to_string(),
            host_serial_baud: 0,
        }
    }

    /// Borrow the parsed firmware info (for pre-run setup such as registering
    /// trace variables or UI views).
    pub fn firmware(&self) -> &FirmwareInfo {
        &self.firmware
    }

    /// Initialize the clock and peripherals, wire the machine, then call the
    /// firmware entry point and join its threads.
    ///
    /// The entry point typically does not return (firmware spins forever); if
    /// it does, this joins all firmware-spawned threads before returning.
    pub fn run(self) -> Result<(), EmulatorError> {
        let Emulator {
            platform,
            firmware,
            machine,
            entry,
            on_wired,
            clock_speed,
            sd_path,
            host_serial_baud,
            pty,
        } = self;

        // 0. Preflight: probe every symbol the machine needs and report ALL
        //    missing ones at once, before any lookup can panic mid-startup.
        let missing: Vec<String> = machine
            .required_symbols()
            .iter()
            .filter(|name| !firmware.has_enum_variant(name) && !firmware.has_enum_type(name))
            .map(|name| name.to_string())
            .collect();
        if !missing.is_empty() {
            return Err(EmulatorError::MissingSymbols(missing));
        }

        // 1. Virtual clock first — every timer/serial call depends on it.
        virtual_clock::init(clock_speed, platform.clock_freq_hz());

        // 2. Size peripherals from the machine's firmware-derived counts,
        //    validating each against its backing array's hard ceiling.
        let counts = machine.peripheral_counts(&firmware);
        check_count("gpio", counts.gpio, gpio::MAX_CHANNELS)?;
        check_count("serial", counts.serial, serial::MAX_CHANNELS)?;
        check_count("encoder", counts.encoder, encoder::MAX_CHANNELS)?;
        check_count("pulse_out", counts.pulse_out, pulse_out::MAX_CHANNELS)?;
        check_count("lock", platform.max_locks(), lock::MAX_LOCKS)?;
        check_count("system", platform.max_cores(), system::MAX_THREADS)?;

        gpio::init(counts.gpio, counts.gpio_names);
        serial::init(counts.serial);
        encoder::init(counts.encoder);
        pulse_out::init(counts.pulse_out);
        lock::init(platform.max_locks());
        system::init(platform.max_cores());
        filesystem::init(&sd_path);

        // 3. Bridge the host PTY to the machine's host serial channel.
        let host_ch = machine.host_serial_channel(&firmware);
        serial::init_channel_fd(host_ch, pty.master.as_raw_fd());
        if host_serial_baud > 0 {
            serial::set_baud(host_ch, host_serial_baud);
            info!("Host serial baud pacing enabled at {host_serial_baud} bps");
        }

        // 4. Project wiring (models, callbacks, initial states, trace signals).
        machine.wire(&firmware);

        // 5. Post-wire hook (e.g. start a trace poller that needs &fw).
        if let Some(hook) = on_wired {
            hook(&firmware);
        }

        // 6. Hand control to the firmware. Keep `pty` alive across this call.
        info!("Starting firmware...");
        (entry)();

        info!("Firmware entry returned, waiting for threads...");
        system::join_all_threads();
        info!("All threads finished.");
        drop(pty);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `check_count` is `Ok` when the request is at or below the maximum and
    /// `Err(TooManyChannels{..})` when it exceeds it. Boundary: `max == max`.
    #[test]
    fn check_count_boundary_and_overflow() {
        // Below and exactly at the ceiling are accepted.
        assert!(check_count("gpio", 0, 64).is_ok());
        assert!(check_count("gpio", 63, 64).is_ok());
        assert!(check_count("gpio", 64, 64).is_ok(), "max == max is allowed");

        // One over the ceiling is rejected, with the originating fields intact.
        let err = check_count("serial", 65, 64).expect_err("65 > 64 must error");
        match err {
            EmulatorError::TooManyChannels { peripheral, requested, max } => {
                assert_eq!(peripheral, "serial");
                assert_eq!(requested, 65);
                assert_eq!(max, 64);
            }
            other => panic!("expected TooManyChannels, got {other:?}"),
        }
    }

    /// A zero maximum still rejects any positive request (degenerate ceiling).
    #[test]
    fn check_count_zero_max_rejects_positive() {
        assert!(check_count("encoder", 0, 0).is_ok());
        assert!(check_count("encoder", 1, 0).is_err());
    }
}
