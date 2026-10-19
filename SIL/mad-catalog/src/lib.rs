//! The mad catalog: the kinds this project adds to embsim
//! (`PROJECTS.md` §10, "Extending embsim from a project").
//!
//! `embsim new --catalog` started this crate with one example of each sort
//! of kind a catalog can add, so a project file can name all four at once:
//!
//! | Kind | Sort | In the project file |
//! |---|---|---|
//! | `mad-board` | a board: a netlist this crate bundles | `[[board]] kind = "mad-board"` |
//! | `mad-sensor` | a part model | `[[board.model]] value = "MAD-SENSOR"`, `kind = "mad-sensor"` |
//! | `mad-core` | what runs inside the P2's package | `[board.model.options] core = "mad-core"`, `pin = 0` |
//! | `mad-source` | a bench component that acts over time | `[[component]] kind = "mad-source"`, `volts`, `ohms`, `at` |
//!
//! Keep the ones the project needs, rename them, and write the rest. Three
//! rules bind them as they bind embsim's own (`DESIGN.md`):
//!
//! - **Every number has its source.** A model's figures come from its
//!   part's datasheet, each with its citation beside it; a figure the
//!   bench sets (a supply's volts) is an option the project file gives.
//!   None of these examples holds a figure of its own for that reason.
//! - **One interface.** A model talks to the board through its declared
//!   pins: drives it publishes, senses it is handed, wakes it schedules.
//!   A mechanism (a shaft, a carriage) stays inside one component, which
//!   presents electrical pins.
//! - **Nothing starts at registration.** `embsim survey` and `new`
//!   register every kind and build nothing; a thread starts, or a core
//!   runs, when the board or the bench is built.
//!
//! [`register`] is what the runner the `embsim` tool builds calls: keep its
//! name and signature. A finished catalog of this shape, with a test that
//! runs its project, is `examples/custom-project` in the embsim repository.

use std::sync::{Arc, Mutex};

use embsim_board::report::instant;
use embsim_board::{
    netlist, Assignment, AttachError, BoardSpec, Catalog, CatalogBoard, Component, ComponentNetIo,
    ComponentRequest, Drive, KindGuide, KindInfo, ModelFacade, Named, PartOptions, PartRegistry,
    PinDecl, PinHandle, ProjectError, Report, TheveninDrive,
};
use embsim_boards::catalog::CatalogSet;
use embsim_boards::p2::{
    CoreCatalog, CoreCtor, P2Core, P2Pads, PadDrive, NATIVE_PAD_MODE, NUM_PADS,
};
use embsim_core::virtual_clock;

/// Add this crate's kinds to `set`: called once by the runner, after the
/// catalogs embsim ships are in it and before the project is read. Starts
/// nothing.
pub fn register(set: &mut CatalogSet) -> Result<(), ProjectError> {
    // Board, part and bench component kinds: one `Catalog`.
    set.add(Kinds)?;
    // P2 cores: one `CoreCatalog`, under the same name.
    set.add_cores(Cores)?;
    Ok(())
}

/// The catalog's name, as `embsim check` lists it and an error naming two
/// catalogs prints it: the crate's name.
const CATALOG: &str = "mad-catalog";

/// The kinds. A kind is lowercase letters, digits and hyphens, and starts
/// with the project's name so no kind embsim ships ever meets it.
const BOARD: &str = "mad-board";
const SENSOR: &str = "mad-sensor";
const CORE: &str = "mad-core";
const SOURCE: &str = "mad-source";

// ============================================================
// A board kind: a netlist the crate bundles
// ============================================================

/// The board's netlist, as `kicad-cli sch export netlist` writes one (a
/// real board bundles its export with `include_str!`): a two-pin header
/// `J1` and the sensor `U1` across it.
const BOARD_NETLIST: &str = r#"(export (version "E")
  (components
    (comp (ref "J1") (value "Conn_01x02")
      (libsource (lib "Connector") (part "Conn_01x02")))
    (comp (ref "U1") (value "MAD-SENSOR")
      (libsource (lib "mad") (part "Sensor"))))
  (nets
    (net (code "1") (name "IN")
      (node (ref "J1") (pin "1") (pinfunction "Pin_1"))
      (node (ref "U1") (pin "1")))
    (net (code "2") (name "GND")
      (node (ref "J1") (pin "2") (pinfunction "Pin_2"))
      (node (ref "U1") (pin "2")))))"#;

/// Board, part and bench component kinds.
struct Kinds;

impl Catalog for Kinds {
    fn name(&self) -> &str {
        CATALOG
    }

    // Every sort of kind describes itself the same way: its name, what it
    // is, and the options it cannot be built without.
    fn board_kinds(&self) -> Vec<KindInfo> {
        vec![KindInfo::new(
            BOARD,
            "a two-pin header and the sensor U1 across it, from the netlist this crate bundles",
        )]
    }

    fn board(&self, spec: &BoardSpec) -> Result<CatalogBoard, ProjectError> {
        let netlist = netlist::parse(BOARD_NETLIST)
            .map_err(|err| ProjectError::message(format!("board {}: {err}", spec.name)))?;
        // The connector and anything embsim places by part number come
        // from the base registrations; `U1` is left for the project's
        // `[[board.model]]`. A board may also bring entries for its own
        // parts: `.with_model(ModelSpec::by_value("MAD-SENSOR",
        // SENSOR))`.
        Ok(CatalogBoard::from_base(netlist))
    }

    fn part_kinds(&self) -> Vec<KindGuide> {
        // What the kind is, and what a part must be for it to seat there:
        // the project checks every part an entry reaches against `is`
        // before `register_part` runs.
        vec![KindGuide::new(
            SENSOR,
            "a sensor that reads the voltage across its two pins",
            Named::family(["MAD-SENSOR"]),
        )]
    }

    fn register_part(
        &self,
        registry: &mut PartRegistry,
        assignment: &Assignment<'_>,
        options: PartOptions,
    ) -> Result<(), ProjectError> {
        // `register_part` is called only for this catalog's part kinds.
        // This one takes no options; `finish` refuses any it is given,
        // naming the ones it takes.
        options.finish()?;
        let board = assignment.board.to_string();
        let reports = assignment.reports.clone();
        // The facade is the model's pin table: the survey checks it against
        // the netlist without building anything. The constructor runs once
        // per part, when the board is built.
        registry.register_model(
            assignment.key,
            ModelFacade::of(SENSOR, &SENSOR_PINS),
            move |decl| {
                let reading = Arc::new(Mutex::new(None));
                reports.add(SensorReport {
                    subject: format!("{board}.{}", decl.reference),
                    reading: Arc::clone(&reading),
                });
                Box::new(Sensor { reading })
            },
        );
        Ok(())
    }

    fn component_kinds(&self) -> Vec<KindInfo> {
        vec![KindInfo::new(
            SOURCE,
            "one pin, OUT, released until a while after the start, then driven",
        )
        .requires("volts", "3.3", "what the pin drives")
        .requires("ohms", "100.0", "the source's impedance, more than 0")
        .requires(
            "at",
            "\"1ms\"",
            "when, after the system starts, the pin is driven",
        )]
    }

    fn component(&self, request: ComponentRequest<'_>) -> Result<Box<dyn Component>, ProjectError> {
        source(request)
    }
}

// ============================================================
// A part kind: the sensor's model
// ============================================================

/// The sensor's pins: what it reads (`1`, against `2`), and its return.
const SENSOR_PINS: [PinDecl; 2] = [
    PinDecl::analog("1").with_reference("2"),
    PinDecl::power_in("2"),
];

/// What pin 1 was last handed: its voltage (`None` while no source
/// reaches it) and the instant it was handed it.
type Reading = Arc<Mutex<Option<(Option<f64>, u64)>>>;

/// The sensor: an analog reader across its pins. A real part's model
/// declares its datasheet's thresholds, supply and outputs here.
struct Sensor {
    reading: Reading,
}

impl Component for Sensor {
    fn pins(&self) -> &[PinDecl] {
        &SENSOR_PINS
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let reading = Arc::clone(&self.reading);
        // Delivered once at registration and on every change of the net,
        // on the engine thread, stamped with the virtual instant.
        io.on_sense("1", move |sense| {
            *reading.lock().expect("the reading is never poisoned") =
                Some((sense.volts, sense.at_ns));
        })
    }
}

/// What a sensor says at the end of a run.
struct SensorReport {
    subject: String,
    reading: Reading,
}

impl Report for SensorReport {
    fn subject(&self) -> String {
        self.subject.clone()
    }

    fn look(&mut self, _now_ns: u64) -> Vec<String> {
        Vec::new()
    }

    fn summary(&self) -> Vec<String> {
        let line = match *self.reading.lock().expect("the reading is never poisoned") {
            Some((Some(volts), at_ns)) => format!("pin 1 read {volts} V from {}", instant(at_ns)),
            Some((None, _)) => "pin 1 read no voltage: no source reaches it".to_string(),
            None => "pin 1 was never read".to_string(),
        };
        vec![line]
    }
}

// ============================================================
// A P2 core kind: what runs inside the processor
// ============================================================

/// The core kinds. The `p2` part kind is the package — its pins, its reset
/// and restart delay, its bank supplies — and asks the set for the core
/// its `core` option names, handing it the entry's other options.
struct Cores;

impl CoreCatalog for Cores {
    fn name(&self) -> &str {
        CATALOG
    }

    fn core_kinds(&self) -> Vec<KindInfo> {
        vec![KindInfo::new(
            CORE,
            "a core that drives one pad high from the moment it starts",
        )
        .requires("pin", "0", "the pad the core drives, 0 to 63")]
    }

    fn seat(
        &self,
        _core: &str,
        assignment: &Assignment<'_>,
        mut options: PartOptions,
    ) -> Result<CoreCtor, ProjectError> {
        let pin = options
            .integer("pin")?
            .ok_or_else(|| options.error("options.pin is the pad the core drives, 0 to 63"))?;
        let pin = u8::try_from(pin)
            .ok()
            .filter(|pin| usize::from(*pin) < NUM_PADS)
            .ok_or_else(|| options.error(format!("options.pin = {pin} is not a pad, 0 to 63")))?;
        options.finish()?;
        let reports = assignment.reports.clone();
        let board = assignment.board.to_string();
        // Called once per part when the board is built; a survey never
        // calls it.
        Ok(Box::new(move |decl| {
            let driven = Arc::new(Mutex::new(false));
            reports.add(CoreReport {
                subject: format!("{board}.{}", decl.reference),
                pin,
                driven: Arc::clone(&driven),
            });
            Ok(Box::new(PadHigh {
                pin,
                pad: None,
                driven,
            }) as Box<dyn P2Core>)
        }))
    }
}

/// The core: at the START instant it drives its pad high, as a program's
/// `DRVH` would with the pad in its reset mode (fast both ways).
struct PadHigh {
    pin: u8,
    /// The pad's handle and the package's bank supplies, from attach.
    pad: Option<(PinHandle, P2Pads)>,
    driven: Arc<Mutex<bool>>,
}

impl P2Core for PadHigh {
    fn attach(&mut self, pads: P2Pads) -> Result<(), AttachError> {
        // A core keeps what it needs from its pads: here one pad's handle.
        // `pads.on_pad_sense` reads a pad, `pads.on_wake_ns` and
        // `pads.schedule_at_ns` give it time through the package's START
        // gate.
        self.pad = Some((pads.pad(self.pin)?, pads));
        Ok(())
    }

    fn start(&mut self) {
        let Some((pad, pads)) = &self.pad else {
            return;
        };
        // The drive a pad presents is the package's: its bank's supply
        // behind the mode's impedance (P2 datasheet), or nothing when the
        // bank has no supply.
        match pads
            .bank_supplies()
            .pad_drive(self.pin, NATIVE_PAD_MODE, true, true)
        {
            PadDrive::Thevenin(drive) => {
                pad.drive(Drive::Thevenin(drive));
                *self.driven.lock().expect("never poisoned") = true;
            }
            PadDrive::Released | PadDrive::CurrentSource(_) => pad.release(),
        }
    }
}

/// What the core says at the end of a run.
struct CoreReport {
    subject: String,
    pin: u8,
    driven: Arc<Mutex<bool>>,
}

impl Report for CoreReport {
    fn subject(&self) -> String {
        self.subject.clone()
    }

    fn look(&mut self, _now_ns: u64) -> Vec<String> {
        Vec::new()
    }

    fn summary(&self) -> Vec<String> {
        let driven = *self.driven.lock().expect("never poisoned");
        vec![if driven {
            format!("drove P{} high", self.pin)
        } else {
            format!(
                "did not drive P{}: it did not start, or its bank had no supply",
                self.pin
            )
        }]
    }
}

// ============================================================
// A bench component kind that acts over time
// ============================================================

/// `mad-source`: one pin, `OUT`, released until `at` after the
/// system starts, then driving `volts` behind `ohms`. All three are the
/// bench's to say, so all are required: the kind invents none.
fn source(request: ComponentRequest<'_>) -> Result<Box<dyn Component>, ProjectError> {
    let ComponentRequest {
        spec,
        mut options,
        reports,
        ..
    } = request;
    let volts = options
        .number("volts")?
        .ok_or_else(|| options.error("options.volts is what the source drives"))?;
    let ohms = options
        .number("ohms")?
        .filter(|ohms| *ohms > 0.0)
        .ok_or_else(|| options.error("options.ohms, more than 0, is the source's impedance"))?;
    let at_ns = options.duration("at")?.ok_or_else(|| {
        options.error("options.at is when, after the system starts, the source drives (\"1ms\")")
    })?;
    options.finish()?;
    let driven_at = Arc::new(Mutex::new(None));
    reports.add(SourceReport {
        subject: spec.name.clone(),
        volts,
        ohms,
        driven_at: Arc::clone(&driven_at),
    });
    Ok(Box::new(Source {
        pins: [PinDecl::analog_source("OUT")],
        drive: TheveninDrive {
            volts,
            impedance: ohms,
        },
        at_ns,
        io: None,
        driven_at,
    }))
}

/// The source: its one pin released until its instant, then driven.
struct Source {
    pins: [PinDecl; 1],
    drive: TheveninDrive,
    /// When it drives, after the system starts.
    at_ns: u64,
    /// The handle `start` arms the wake on.
    io: Option<ComponentNetIo>,
    /// The virtual instant it drove, once it has.
    driven_at: Arc<Mutex<Option<u64>>>,
}

impl Component for Source {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let (pin, drive) = (io.pin("OUT")?, self.drive);
        let driven_at = Arc::clone(&self.driven_at);
        // Runs on the engine thread at each instant this component armed
        // (`schedule_at_ns`), with that instant: virtual time, so a stepped
        // run reaches it exactly, and two runs alike.
        io.on_wake_ns(move |now_ns| {
            let mut driven = driven_at.lock().expect("never poisoned");
            if driven.is_none() {
                pin.drive(Drive::Thevenin(drive));
                *driven = Some(now_ns);
            }
        });
        self.io = Some(io);
        Ok(())
    }

    /// The system started: time is held until every component has, so the
    /// instant read here is the same on every run. Arm the one wake.
    fn start(&mut self) {
        let started_ns = virtual_clock::virtual_ns();
        if let Some(io) = &self.io {
            io.schedule_at_ns(started_ns.saturating_add(self.at_ns));
        }
    }
}

/// What the source says at the end of a run.
struct SourceReport {
    subject: String,
    volts: f64,
    ohms: f64,
    driven_at: Arc<Mutex<Option<u64>>>,
}

impl Report for SourceReport {
    fn subject(&self) -> String {
        self.subject.clone()
    }

    fn look(&mut self, _now_ns: u64) -> Vec<String> {
        Vec::new()
    }

    fn summary(&self) -> Vec<String> {
        let (volts, ohms) = (self.volts, self.ohms);
        vec![match *self.driven_at.lock().expect("never poisoned") {
            Some(at_ns) => format!(
                "drove OUT at {volts} V behind {ohms} Ω from {}",
                instant(at_ns)
            ),
            None => "drove nothing: the run ended before its instant".to_string(),
        }]
    }
}
