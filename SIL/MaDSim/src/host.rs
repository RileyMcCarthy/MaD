//! The host on the board's serial link: the host's Chrome the board's clock
//! meters, or a PTY.
//!
//! Both sit on the same two wires, the host's `TX` into the P2's receive pin
//! and the P2's transmit pin into the host's `RX`, so a run swaps one for the
//! other without touching the board:
//!
//! - **Chrome** (`--chrome`): embsim's `chrome-cdp` bench component kind
//!   (embsim `PROJECTS.md` §5), built through its catalog from a project
//!   entry, as a project file names it. Every page and dedicated worker in
//!   that Chrome lives the board's time, a quantum (1 ms) at a time over
//!   DevTools, and every page's `navigator.serial` is the node's shim, whose
//!   one port is this line. Its pins are a host's rail line, `TX`, `RX`,
//!   `VIO` and `GND`: without the rail wired the line is unpowered and
//!   carries nothing, so [`Host::wire`] puts `VIO` on the P2's 3.3 V I/O
//!   rail and `GND` on the bench ground. The run prints where Chrome's
//!   DevTools are once Chrome is reached (the "reached" line); the e2e suite
//!   attaches there (`CDP_URL`). This is the one configuration a browser
//!   belongs in.
//! - **A PTY** (`--pty-path`, the default): a serial console, or a program
//!   that keeps wall time, opens it. No browser belongs behind it: a browser
//!   on the host's clock measures the host, not the machine.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use embsim_board::{EndpointRef, Harness, Project, Report, Reports, System};
use p2iss::SerialLink;
use tracing::{error, info};

/// The P2's I/O rail, the voltage the host's line signals at.
const HOST_RAIL_VOLTS: f64 = 3.3;

/// The host's component name: its pins are `HOST.TX`, `HOST.RX`, and with
/// Chrome `HOST.VIO` and `HOST.GND`.
const HOST: &str = "HOST";

/// How the host's Chrome is put on the link (`mad-emulator --chrome`). Each
/// option is the `chrome-cdp` kind's option of the same meaning (embsim
/// `PROJECTS.md` §5).
#[derive(clap::Args, Debug, Clone)]
pub struct ChromeArgs {
    /// Put the host's Chrome on the link instead of a PTY: embsim's
    /// `chrome-cdp`, every page's and worker's clock metered by the board's,
    /// each page's Web Serial port this line. `--pty-path` is then unused.
    #[arg(long)]
    pub chrome: bool,

    /// With `--chrome`: the DevTools port Chrome listens on (default: a free
    /// one Chrome picks). The run prints the DevTools URL either way.
    #[arg(long, value_name = "PORT", requires = "chrome")]
    pub devtools_port: Option<u16>,

    /// With `--chrome`: run Chrome headless (default: a window a person can
    /// watch).
    #[arg(long, requires = "chrome")]
    pub headless: bool,

    /// With `--chrome`: the Chrome binary (default: `CHROME`, the host's
    /// Google Chrome, or google-chrome / chromium on PATH).
    #[arg(long, value_name = "PATH", requires = "chrome")]
    pub chrome_binary: Option<PathBuf>,

    /// With `--chrome`: a page to open once Chrome holds it (the playground
    /// opens the app).
    #[arg(long, value_name = "URL", requires = "chrome")]
    pub url: Option<String>,

    /// With `--chrome`: every origin may use the port without a prompt, as
    /// Chrome's `SerialAllowUsbDevicesForUrls` policy grants it, so
    /// `getPorts()` lists it before any `requestPort()` (the app's Connect
    /// screen lists it as granted). Without it a page gets the port from a
    /// Connect click.
    #[arg(long, requires = "chrome")]
    pub granted: bool,

    /// With `--chrome`: the serial adapter's USB vendor id, as `getInfo()`
    /// reports it and `requestPort()` filters match it. MaD's adapter is an
    /// FTDI FT232R, 0x0403; the app finds a replugged port by these ids.
    #[arg(long, value_name = "ID", value_parser = parse_usb_id, default_value = "0x0403", requires = "chrome")]
    pub usb_vendor_id: u16,

    /// With `--chrome`: the serial adapter's USB product id (FT232R: 0x6001).
    #[arg(long, value_name = "ID", value_parser = parse_usb_id, default_value = "0x6001", requires = "chrome")]
    pub usb_product_id: u16,
}

/// A USB id, written `0x0403` or `1027`.
fn parse_usb_id(text: &str) -> Result<u16, String> {
    let parsed = match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        Some(hex) => u16::from_str_radix(hex, 16),
        None => text.parse::<u16>(),
    };
    parsed.map_err(|e| format!("{text:?} is not a 16-bit USB id: {e}"))
}

/// The host, built: the system holding its component, and what it says.
pub struct Host {
    system: System,
    reports: Vec<Box<dyn Report>>,
    /// The host's rail pins (`VIO`, `GND`) need wiring.
    rail: bool,
}

impl Host {
    /// The host `chrome` asks for: the host's Chrome when `--chrome` is set,
    /// otherwise a PTY at `pty_path`; either at `link`'s rate.
    pub fn open(
        chrome: &ChromeArgs,
        pty_path: &str,
        link: SerialLink,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if chrome.chrome {
            info!(
                "Host: the host's Chrome ({}), metered by the board's clock; USB {:04x}:{:04x}{}",
                if chrome.headless {
                    "headless"
                } else {
                    "a window"
                },
                chrome.usb_vendor_id,
                chrome.usb_product_id,
                if chrome.granted {
                    ", granted to every origin"
                } else {
                    ""
                }
            );
            Ok(Self::chrome(chrome, link)?)
        } else {
            Ok(Self::pty(pty_path, link)?)
        }
    }

    /// A PTY at `path`, at `link`'s rate.
    fn pty(path: &str, link: SerialLink) -> std::io::Result<Self> {
        let pty = p2iss::HostPty::open(path, link.nominal_baud)?;
        info!("Host can connect to: {}", pty.symlink_path());
        Ok(Self {
            system: System::new().component(HOST, Box::new(pty)),
            reports: Vec::new(),
            rail: false,
        })
    }

    /// The host's Chrome: a `chrome-cdp` at `link`'s rate, built from its
    /// catalog as a project entry names it.
    fn chrome(args: &ChromeArgs, link: SerialLink) -> Result<Self, String> {
        let project =
            chrome_project(args, link).map_err(|e| format!("the chrome-cdp entry: {e}"))?;
        let reports = Reports::new();
        let system = project
            .instantiate_with(&embsim_cdp::catalog::CdpCatalog, &reports)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            system,
            reports: reports.take(),
            rail: true,
        })
    }

    /// The host's two wires to the P2, `HOST.TX` into `rx` and `tx` into
    /// `HOST.RX`, and its rail when it has one (embsim `MIGRATING-MAD.md`
    /// step 1b).
    pub fn wire(&self, harness: Harness, tx: &str, rx: &str) -> Result<Harness, String> {
        let ep = |s: &str| EndpointRef::parse(s).map_err(|e| format!("{s}: {e}"));
        let mut harness = harness
            .connect(ep(tx)?, ep(&format!("{HOST}.RX"))?)
            .connect(ep(&format!("{HOST}.TX"))?, ep(rx)?);
        if self.rail {
            harness = harness
                .power(
                    ep("BENCH.HOST3V3")?,
                    ep(&format!("{HOST}.VIO"))?,
                    HOST_RAIL_VOLTS,
                )
                .power(ep("BENCH.HOSTGND")?, ep(&format!("{HOST}.GND"))?, 0.0);
        }
        Ok(harness)
    }

    /// The system holding the host, and what it says while the run goes.
    pub fn into_parts(self) -> (System, Reporter) {
        (
            self.system,
            Reporter {
                reports: self.reports,
            },
        )
    }
}

/// The project holding one `chrome-cdp` entry for `args`, its options set as
/// a project file writes them; paths in it are relative to the current
/// directory, as the command line's are.
fn chrome_project(
    args: &ChromeArgs,
    link: SerialLink,
) -> Result<Project, embsim_board::ProjectError> {
    let mut project = Project::parse(&format!(
        "[[component]]\nname = \"{HOST}\"\nkind = \"{}\"\n",
        embsim_cdp::catalog::KIND
    ))?;
    let host = HOST;
    project.set_component_option(host, "baud", i64::from(link.nominal_baud))?;
    project.set_component_option(host, "usb_vendor_id", i64::from(args.usb_vendor_id))?;
    project.set_component_option(host, "usb_product_id", i64::from(args.usb_product_id))?;
    project.set_component_option(host, "headless", args.headless)?;
    project.set_component_option(host, "granted", args.granted)?;
    if let Some(port) = args.devtools_port {
        project.set_component_option(host, "devtools_port", i64::from(port))?;
    }
    if let Some(binary) = &args.chrome_binary {
        project.set_component_option(host, "chrome", binary.to_string_lossy().into_owned())?;
    }
    if let Some(url) = &args.url {
        project.set_component_option(host, "url", url.clone())?;
    }
    let dir = std::env::current_dir()
        .map_err(|e| embsim_board::ProjectError::message(format!("the current directory: {e}")))?;
    Ok(project.relative_to(dir))
}

/// What the host's component says while the run goes, as `embsim run`
/// prints it: the first look at once, then every quarter second of host
/// time, each line stamped with the board's time.
pub struct Reporter {
    reports: Vec<Box<dyn Report>>,
}

impl Reporter {
    /// Look until `stop` is set, printing what is new; when a report says
    /// its subject failed (a grant that stuck, a page that crashed, a Chrome
    /// that went away), set `failed` and `stop`. Prints every summary on the
    /// way out. `None` when the host says nothing (a PTY).
    pub fn spawn(
        mut self,
        stop: &'static AtomicBool,
        failed: &'static AtomicBool,
    ) -> Option<std::thread::JoinHandle<()>> {
        if self.reports.is_empty() {
            return None;
        }
        Some(std::thread::spawn(move || {
            loop {
                let now = embsim_core::virtual_clock::virtual_ns();
                for report in &mut self.reports {
                    let subject = report.subject();
                    for line in report.look(now) {
                        info!(target: "host", "[{}] {subject}: {line}", embsim_board::report::instant(now));
                    }
                    if let Some(why) = report.failure() {
                        error!(target: "host", "{subject} failed: {why}");
                        failed.store(true, Ordering::SeqCst);
                        stop.store(true, Ordering::SeqCst);
                    }
                }
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            for report in &self.reports {
                let subject = report.subject();
                for line in report.summary() {
                    info!(target: "host", "{subject}: {line}");
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use vibes_behaviour::{behaviour, expect, Test};

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        chrome: ChromeArgs,
    }

    #[test]
    fn usb_ids_read_as_hex_or_decimal() {
        behaviour!(Test {
            id: "emulator.usb-id-spelling",
            covers: Some("SIL/MaDSim/src/host.rs#parse_usb_id"),
            given: "a USB vendor or product id for the browser's serial port, written on the \
                    emulator's command line",
        });
        expect!(
            "hex-or-decimal",
            "it is read as hexadecimal after a 0x prefix and as decimal without one"
        );
        expect!(
            "sixteen-bits",
            "a value that does not fit in 16 bits is refused"
        );
        assert_eq!(parse_usb_id("0x0403"), Ok(0x0403));
        assert_eq!(parse_usb_id("24577"), Ok(0x6001));
        assert!(parse_usb_id("0x10000").is_err());
    }

    #[test]
    fn the_chrome_entry_carries_every_option_the_command_line_set() {
        behaviour!(Test {
            id: "emulator.chrome-host-options",
            covers: Some("SIL/MaDSim/src/host.rs#chrome_project"),
            given: "the emulator started with the host's Chrome on the protocol link, headless, \
                    granted to every page, on a fixed DevTools port, with a page to open",
        });
        expect!(
            "line-rate",
            "the browser's serial port runs at the protocol link's 2,000,000 baud"
        );
        expect!(
            "adapter-ids",
            "the browser's serial port reports MaD's FTDI adapter, USB 0403:6001, when the \
             command line names no other ids",
            "the app finds a replugged port again by these ids"
        );
        expect!(
            "launch-as-asked",
            "Chrome is launched headless on that DevTools port, opens that page, and every page \
             may use the port without a prompt"
        );
        expect!(
            "own-chrome",
            "with no Chrome binary named, the host's own Chrome is the one launched"
        );
        let cli = Cli::parse_from([
            "mad-emulator",
            "--chrome",
            "--headless",
            "--granted",
            "--devtools-port",
            "9222",
            "--url",
            "http://127.0.0.1:5174/",
        ]);
        let link = SerialLink {
            tx_pin: 55,
            rx_pin: 53,
            nominal_baud: 2_000_000,
        };
        let project = chrome_project(&cli.chrome, link).expect("the entry parses");
        let spec = project.component_spec(HOST).expect("one HOST");
        assert_eq!(spec.kind, embsim_cdp::catalog::KIND);
        let int = |key: &str| spec.options.get(key).and_then(|v| v.as_integer());
        let flag = |key: &str| spec.options.get(key).and_then(|v| v.as_bool());
        let text = |key: &str| spec.options.get(key).and_then(|v| v.as_str());
        assert_eq!(int("baud"), Some(2_000_000));
        assert_eq!(int("usb_vendor_id"), Some(0x0403));
        assert_eq!(int("usb_product_id"), Some(0x6001));
        assert_eq!(flag("headless"), Some(true));
        assert_eq!(flag("granted"), Some(true));
        assert_eq!(int("devtools_port"), Some(9222));
        assert_eq!(text("url"), Some("http://127.0.0.1:5174/"));
        assert!(!spec.options.contains_key("chrome"));
    }

    #[test]
    fn chrome_options_need_chrome() {
        behaviour!(Test {
            id: "emulator.browser-options-need-the-browser",
            covers: Some("SIL/MaDSim/src/host.rs#ChromeArgs"),
            given: "a browser option on the emulator's command line without the host's Chrome \
                    asked for",
        });
        expect!(
            "refused",
            "the emulator refuses to start and names the missing option"
        );
        for option in ["--granted", "--headless"] {
            let refused = Cli::try_parse_from(["mad-emulator", option])
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default();
            assert!(refused.contains("--chrome"), "{option}: {refused:?}");
        }
    }
}
