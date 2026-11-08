//! MaD's eight project files hold one machine: `SIL/mad.toml` (the
//! firmware booted off the module's flash, a `host-serial` on the carrier's
//! control port `J4`, where the machine's FTDI adapter sits, through the
//! isolator `IC2`), `mad-cosim.toml` (the same with the host's Chrome),
//! `mad-serial-boot.toml` (the ROM's serial boot, the flash erased, a
//! `host-serial` on the carrier's debug header `J1`, the programming port,
//! where the Prop Plug sits) and `mad-serial-boot-cosim.toml` (that with the
//! host's Chrome); then
//! `mad-hard-stop-cosim.toml`, `mad-cosim.toml` with a hard stop on the
//! machine's carriage (MaD #298); the two playgrounds,
//! `mad-playground.toml` and `mad-serial-boot-playground.toml`, the two
//! Chrome files with their Chrome headed on the app; and
//! `mad-reflash-cosim.toml`, `mad-cosim.toml` with its host's Chrome on the
//! programming port `J1`, the Prop Plug's reset on `J1.3` and the ROM's
//! serial window open after a reset, the board the app's flasher runs on.
//! Each file is complete on its own, so nothing but this test keeps their
//! shared lines the same: a supply, a wire or a jumper changed in one file
//! and not the others fails here, naming the section.
//!
//! The files are compared twice: as text, section by section (each file is
//! cut at its `# ---- Title ----` lines, so the comments are held too), and
//! as TOML, entry by entry, with each file's own differences applied. No
//! image, no clock and no build: the files' builds are `make check`'s and
//! `tests/mad.rs`'s.

use std::path::PathBuf;

use toml::{Table, Value};
use vibes_behaviour::{behaviour, expect, Test};

/// A project file in `SIL/`.
fn read(name: &str) -> String {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", name].iter().collect();
    std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
}

/// The file cut at its section lines: the text before the first, then each
/// section's title and its text, in order.
fn sections(text: &str) -> Vec<(String, String)> {
    let mut cut = vec![(String::new(), String::new())];
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# ---- ") {
            let title = rest.trim_end_matches(['-', ' ']).to_string();
            cut.push((title, String::new()));
        } else {
            let body = &mut cut.last_mut().expect("there is always a section").1;
            body.push_str(line);
            body.push('\n');
        }
    }
    cut
}

/// The section titles every file has, in order. The first, empty, is the
/// text before the first section: the header and `[catalog]`.
const TITLES: [&str; 9] = [
    "",
    "The boards",
    "The machine",
    "The host",
    "The module in its socket, and the force cable",
    "Supplies",
    "The host's wires",
    "The machine on the carrier's connectors",
    "Scenario",
];

/// Hold `twin`'s sections to `base`'s: the same titles in the same order,
/// word for word the same text but in the sections named `differ`, and
/// different text there.
fn same_but(base: (&str, &str), twin: (&str, &str), differ: &[&str]) {
    let (base_name, base_text) = base;
    let (twin_name, twin_text) = twin;
    let (ours, theirs) = (sections(base_text), sections(twin_text));
    for (name, cut) in [(base_name, &ours), (twin_name, &theirs)] {
        let titles: Vec<&str> = cut.iter().map(|(title, _)| title.as_str()).collect();
        assert_eq!(titles, TITLES, "{name}'s sections");
    }
    for ((title, a), (_, b)) in ours.iter().zip(&theirs) {
        if differ.contains(&title.as_str()) {
            assert_ne!(
                a, b,
                "{base_name} and {twin_name} differ in their {title:?} section"
            );
        } else if a != b {
            let first = a
                .lines()
                .zip(b.lines())
                .find(|(ours, theirs)| ours != theirs)
                .map_or_else(
                    || "one ends before the other".to_string(),
                    |(ours, theirs)| format!("{base_name} has {ours:?}, {twin_name} {theirs:?}"),
                );
            panic!("{twin_name}'s {title:?} section is {base_name}'s, word for word: {first}");
        }
    }
}

fn parse(name: &str, text: &str) -> Table {
    text.parse::<Table>()
        .unwrap_or_else(|err| panic!("{name} is TOML: {err}"))
}

/// The entries of the array of tables `key`.
fn entries<'a>(file: &'a Table, key: &str) -> &'a Vec<Value> {
    file.get(key)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("the file has [[{key}]] entries"))
}

fn entries_mut<'a>(file: &'a mut Table, key: &str) -> &'a mut Vec<Value> {
    file.get_mut(key)
        .and_then(Value::as_array_mut)
        .unwrap_or_else(|| panic!("the file has [[{key}]] entries"))
}

/// A string field of an entry.
fn field<'a>(entry: &'a Value, key: &str) -> Option<&'a str> {
    entry.get(key).and_then(Value::as_str)
}

/// Take the bench component `name` out of `file` and return it.
fn take_component(file: &mut Table, name: &str) -> Value {
    let components = entries_mut(file, "component");
    let at = components
        .iter()
        .position(|entry| field(entry, "name") == Some(name))
        .unwrap_or_else(|| panic!("the file has a component {name}"));
    components.remove(at)
}

/// An option of a component's entry.
fn option<'a>(entry: &'a Value, key: &str) -> Option<&'a Value> {
    entry.get("options").and_then(|options| options.get(key))
}

/// Each base file, its Chrome twin, and the USB product id of the adapter
/// on the connector its host is wired to: an FTDI FT232R's on the control
/// port `J4`, an FTDI FT231X's (the Prop Plug's) on the debug header `J1`.
const COSIM_TWINS: [(&str, &str, i64); 2] = [
    ("mad.toml", "mad-cosim.toml", 0x6001),
    ("mad-serial-boot.toml", "mad-serial-boot-cosim.toml", 0x6015),
];

#[test]
fn each_cosim_file_is_its_base_with_the_hosts_chrome() {
    behaviour!(Test {
        id: "mad-project.cosim-twins",
        covers: Some("SIL/mad-cosim.toml"),
        given: "each of the machine's two project files whose host is a serial port, beside its \
                twin whose host is the host's Chrome",
    });
    expect!(
        "text-but-host",
        "the two files are word for word the same outside the host's section"
    );
    expect!(
        "host-chrome",
        "the twin's host runs at the base's line rate, on a fixed DevTools port, its serial \
         port granted to every page",
        "the e2e suite attaches to that port and finds the board's serial port granted, as it \
         does on the board route today"
    );
    expect!(
        "adapter-ids",
        "the twin's serial port reports USB ids 0403:6001, an FTDI FT232R's, when its host is on \
         the control port, and 0403:6015, an FTDI FT231X's, on the debug header",
        "the app connects to the machine on the control port's adapter and flashes it through \
         the Prop Plug on the debug header, and tells the two ports apart by their USB ids"
    );
    expect!(
        "entries-but-host",
        "every board, model, component, wire, mate, switch and jumper but the host's entry is \
         the same in both"
    );
    for (base_name, twin_name, product_id) in COSIM_TWINS {
        let (base_text, twin_text) = (read(base_name), read(twin_name));
        same_but(
            (base_name, &base_text),
            (twin_name, &twin_text),
            &["The host"],
        );
        let (mut base, mut twin) = (parse(base_name, &base_text), parse(twin_name, &twin_text));
        let (serial, chrome) = (
            take_component(&mut base, "HOST"),
            take_component(&mut twin, "HOST"),
        );
        assert_eq!(field(&serial, "kind"), Some("host-serial"), "{base_name}");
        assert_eq!(field(&chrome, "kind"), Some("chrome-cdp"), "{twin_name}");
        let baud = option(&serial, "baud").expect("the serial host names its rate");
        assert_eq!(option(&chrome, "baud"), Some(baud), "{twin_name}");
        assert_eq!(
            option(&chrome, "devtools_port").and_then(Value::as_integer),
            Some(9222),
            "{twin_name}"
        );
        assert_eq!(
            option(&chrome, "granted").and_then(Value::as_bool),
            Some(true),
            "{twin_name}"
        );
        assert_eq!(
            ["usb_vendor_id", "usb_product_id"]
                .map(|id| option(&chrome, id).and_then(Value::as_integer)),
            [Some(0x0403), Some(product_id)],
            "{twin_name}"
        );
        assert_eq!(base, twin, "{twin_name} is {base_name} but its host");
    }
}

/// The host's wires: each wire with an end on the host or on its adapter's
/// supply, taken out of `file`.
fn host_wires(file: &mut Table) -> Vec<Value> {
    let wires = entries_mut(file, "wire");
    let on_host = |wire: &Value| {
        ["from", "to"].iter().any(|end| {
            field(wire, end)
                .is_some_and(|end| end.starts_with("HOST.") || end.starts_with("ADAPTER."))
        })
    };
    let host: Vec<Value> = wires.iter().filter(|wire| on_host(wire)).cloned().collect();
    wires.retain(|wire| !on_host(wire));
    host
}

/// The wire in `wires` from `from`: its other end and its voltage.
fn wire_from<'a>(wires: &'a [Value], from: &str) -> Option<(&'a str, Option<f64>)> {
    wires
        .iter()
        .find(|wire| field(wire, "from") == Some(from))
        .map(|wire| {
            (
                field(wire, "to").expect("a wire has a to"),
                wire.get("volts").and_then(Value::as_float),
            )
        })
}

/// The wires as `(from, to, volts)`, sorted.
fn ends(wires: &[Value]) -> Vec<(String, String, Option<f64>)> {
    let mut ends: Vec<_> = wires
        .iter()
        .map(|wire| {
            (
                field(wire, "from").expect("a wire has a from").to_string(),
                field(wire, "to").expect("a wire has a to").to_string(),
                wire.get("volts").and_then(Value::as_float),
            )
        })
        .collect();
    ends.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    ends
}

/// `(from, to, volts)`, as [`ends`] gives a wire.
fn wire(from: &str, to: &str, volts: Option<f64>) -> (String, String, Option<f64>) {
    (from.to_string(), to.to_string(), volts)
}

/// The wires of `file` with an end on the carrier's connector `connector`
/// (`"J4"`).
fn on_connector<'a>(file: &'a Table, connector: &str) -> Vec<&'a Value> {
    let prefix = format!("EDGE.{connector}.");
    entries(file, "wire")
        .iter()
        .filter(|wire| {
            ["from", "to"]
                .iter()
                .any(|end| field(wire, end).is_some_and(|end| end.starts_with(&prefix)))
        })
        .collect()
}

/// The `w25q128jv` entry's options, the module's flash.
fn flash_options(file: &mut Table) -> &mut Table {
    let boards = entries_mut(file, "board");
    let module = boards
        .iter_mut()
        .find(|board| field(board, "name") == Some("EC32"))
        .expect("the file seats the module");
    module
        .get_mut("model")
        .and_then(Value::as_array_mut)
        .expect("the module has model entries")
        .iter_mut()
        .find(|model| field(model, "kind") == Some("w25q128jv"))
        .and_then(|model| model.get_mut("options"))
        .and_then(Value::as_table_mut)
        .expect("the module's flash has options")
}

/// The poles of `S301` the file closes, in order.
fn s301_closed(file: &mut Table) -> Vec<i64> {
    let switches = entries_mut(file, "switch");
    let s301 = |switch: &Value| field(switch, "part") == Some("EC32.S301");
    let closed = switches
        .iter()
        .filter(|switch| s301(switch))
        .map(|switch| {
            assert_eq!(field(switch, "state"), Some("closed"), "{switch}");
            switch
                .get("pole")
                .and_then(Value::as_integer)
                .expect("a pole")
        })
        .collect();
    switches.retain(|switch| !s301(switch));
    closed
}

#[test]
fn the_serial_boot_file_is_the_flash_boot_with_the_roms_boot() {
    behaviour!(Test {
        id: "mad-project.serial-boot-twin",
        covers: Some("SIL/mad-serial-boot.toml"),
        given: "the machine's project file that boots the firmware off the module's flash, \
                beside the one that boots the chip's ROM over its serial loader, each with a \
                serial-port host",
    });
    expect!(
        "flash-erased",
        "the serial boot's module flash holds no image, and the flash boot's holds the \
         firmware's"
    );
    expect!(
        "boot-strap",
        "the serial boot closes the boot switch's P59 pull-up, position 3, and the flash boot \
         its pull-down, position 4",
        "the ROM reads P59 at reset: pulled up it waits for a serial boot, pulled down it boots \
         the program in flash"
    );
    expect!(
        "flash-selected",
        "both close the boot switch's position 2, the flash's chip select"
    );
    expect!(
        "host-on-debug-header",
        "the serial boot's host sends to the chip's receive pin P63, reads its transmit pin \
         P62 and shares the carrier's ground, on the carrier's debug header",
        "the ROM's serial loader listens on P63 and answers on P62, the programming port, \
         where the app flashes the firmware"
    );
    expect!(
        "host-on-control-port",
        "the flash boot's host sends into the control port's receive line and reads its \
         transmit line, which the isolator IC2 carries to the chip's P30 and from its P32",
        "the firmware's protocol channel is on P30 and P32, and the programming port's \
         adapter resets the chip whenever a port is opened on it"
    );
    expect!(
        "host-rail",
        "both files' host has a 3.3 volt rail of its own"
    );
    expect!(
        "control-port-powered",
        "the flash boot's host powers the control port's side of the isolator from its 3.3 \
         volt rail and ties that side's ground to 0 volts",
        "nothing on the carrier powers that side of the isolator or ties its ground down: \
         whatever is plugged into the control port does"
    );
    expect!(
        "pi-connector-empty",
        "the serial boot leaves the control port J4 empty, no supply and no wire on it",
        "the ROM's serial loader is on the debug header, and the isolator's side on J4 stays \
         unpowered, as it is with nothing plugged in"
    );
    expect!(
        "debug-header-empty",
        "the flash boot leaves the debug header J1 empty, no wire on it",
        "nothing in the flash boot flashes the firmware or reads its log, and the reset pin on \
         that header stays untouched, so the firmware runs from power-up"
    );
    expect!(
        "entries-identical",
        "every other board, model, component, wire, mate, switch and jumper is the same in both"
    );
    expect!(
        "text-identical",
        "the files are word for word the same outside their boards', host's, host's wires' \
         and scenario sections"
    );
    let (flash_text, serial_text) = (read("mad.toml"), read("mad-serial-boot.toml"));
    same_but(
        ("mad.toml", &flash_text),
        ("mad-serial-boot.toml", &serial_text),
        &["The boards", "The host", "The host's wires", "Scenario"],
    );
    let (mut flash, mut serial) = (
        parse("mad.toml", &flash_text),
        parse("mad-serial-boot.toml", &serial_text),
    );

    let image = flash_options(&mut flash).remove("image");
    assert_eq!(
        image.as_ref().and_then(Value::as_str),
        Some("build/flash.bin"),
        "the flash boot's module flash holds `make flash-image`'s image"
    );
    assert_eq!(
        flash_options(&mut serial).get("image"),
        None,
        "the serial boot's flash is erased"
    );

    assert_eq!(s301_closed(&mut flash), [1, 3], "the flash boot's S301");
    assert_eq!(s301_closed(&mut serial), [1, 2], "the serial boot's S301");

    let on_j1 = on_connector(&flash, "J1");
    assert!(on_j1.is_empty(), "mad.toml wires J1: {on_j1:?}");
    let on_j4 = on_connector(&serial, "J4");
    assert!(on_j4.is_empty(), "mad-serial-boot.toml wires J4: {on_j4:?}");

    let control = ends(&host_wires(&mut flash));
    let rail = wire("ADAPTER.3V3", "HOST.VIO", Some(3.3));
    assert!(control.contains(&rail), "mad.toml: {control:?}");
    let mut expected = vec![
        rail.clone(),
        // RPI_3V3, IC2's side-2 supply, on the host's rail.
        wire("ADAPTER.3V3", "EDGE.J4.1", None),
        // RPI_GND, IC2's side-2 ground, tied to 0 V and shared with the host.
        wire("ADAPTER.GND", "EDGE.J4.6", Some(0.0)),
        wire("HOST.GND", "EDGE.J4.6", None),
        // RPI_RX, IC2's INC to OUTC on P30; RPI_TX, IC2's OUTA from P32.
        wire("HOST.TX", "EDGE.J4.3", None),
        wire("EDGE.J4.2", "HOST.RX", None),
    ];
    expected.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    assert_eq!(control, expected, "mad.toml's host on J4");

    let debug = ends(&host_wires(&mut serial));
    assert!(debug.contains(&rail), "mad-serial-boot.toml: {debug:?}");
    let mut expected = vec![
        rail,
        // P63, the chip's receive pin, and P62, its transmit pin.
        wire("HOST.TX", "EDGE.J1.2", None),
        wire("EDGE.J1.1", "HOST.RX", None),
        wire("HOST.GND", "EDGE.J1.4", None),
    ];
    expected.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    assert_eq!(debug, expected, "mad-serial-boot.toml's host on J1");

    let (flash_host, serial_host) = (
        take_component(&mut flash, "HOST"),
        take_component(&mut serial, "HOST"),
    );
    assert_eq!(
        flash_host, serial_host,
        "both hosts are the same serial port"
    );
    assert_eq!(
        flash, serial,
        "mad-serial-boot.toml is mad.toml but its boot"
    );
    for key in ["mate", "jumper", "component"] {
        assert!(!entries(&flash, key).is_empty(), "the files have [[{key}]]");
    }
}

/// The lines `twin` adds to `base`: `twin` must be `base` with one run of
/// lines inserted, or this panics naming the first line that differs.
fn inserted(base: (&str, &str), twin: (&str, &str)) -> Vec<String> {
    let (base_name, base_text) = base;
    let (twin_name, twin_text) = twin;
    let ours: Vec<&str> = base_text.lines().collect();
    let theirs: Vec<&str> = twin_text.lines().collect();
    let head = ours.iter().zip(&theirs).take_while(|(a, b)| a == b).count();
    let tail = ours[head..]
        .iter()
        .rev()
        .zip(theirs[head..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    assert_eq!(
        head + tail,
        ours.len(),
        "{twin_name} is {base_name} with lines added, and no other change: {base_name} line {} \
         reads {:?}, {twin_name}'s {:?}",
        head + 1,
        ours.get(head),
        theirs.get(head)
    );
    theirs[head..theirs.len() - tail]
        .iter()
        .map(|line| (*line).to_string())
        .collect()
}

/// The file with a hard stop on the machine's carriage, and the file it
/// stops.
const HARD_STOP: (&str, &str) = ("mad-cosim.toml", "mad-hard-stop-cosim.toml");

#[test]
fn the_hard_stop_file_is_the_cosim_file_with_one_stop() {
    behaviour!(Test {
        id: "mad-project.hard-stop-twin",
        covers: Some("SIL/mad-hard-stop-cosim.toml"),
        given: "the machine's project file whose host is the host's Chrome, beside its twin \
                whose carriage meets a hard stop",
    });
    expect!(
        "text-one-block",
        "the twin is the file word for word with one run of lines added to its machine's \
         section"
    );
    expect!(
        "one-option",
        "the twin's machine has one option more, a hard stop above the carriage's start and \
         short of the 15 millimetres of grip slack",
        "the stall scenario jogs the carriage up into the stop and back off it, and short of \
         the grip slack the sample takes no load"
    );
    expect!(
        "cites-the-issue",
        "the added lines name MaD issue 298, the stall scenario's need for a carriage that \
         stops, as the stop's reason"
    );
    expect!(
        "entries-but-stop",
        "every board, model, component, wire, mate, switch, jumper and short is the same in \
         both but the machine's stop"
    );
    let (base_name, twin_name) = HARD_STOP;
    let (base_text, twin_text) = (read(base_name), read(twin_name));
    same_but(
        (base_name, &base_text),
        (twin_name, &twin_text),
        &["The machine"],
    );
    let added = inserted((base_name, &base_text), (twin_name, &twin_text));
    let machine = sections(&twin_text)
        .into_iter()
        .find(|(title, _)| title == "The machine")
        .expect("the file has the machine's section")
        .1;
    assert!(
        machine.contains(&added.join("\n")),
        "{twin_name}'s added lines are in its machine's section: {added:#?}"
    );
    assert!(
        added.iter().any(|line| line.contains("MaD #298")),
        "{twin_name}'s added lines cite MaD #298: {added:#?}"
    );

    let (base, mut twin) = (parse(base_name, &base_text), parse(twin_name, &twin_text));
    let stop = entries_mut(&mut twin, "component")
        .iter_mut()
        .find(|entry| field(entry, "name") == Some("MACHINE"))
        .and_then(|machine| machine.get_mut("options"))
        .and_then(Value::as_table_mut)
        .and_then(|options| options.remove("hard_stop_mm"))
        // A number, as the kind reads it: `3.0` or a whole `3`.
        .and_then(|stop| {
            stop.as_float()
                .or_else(|| stop.as_integer().map(|whole| whole as f64))
        })
        .unwrap_or_else(|| panic!("{twin_name}'s machine names a hard stop in millimetres"));
    // Above the carriage's start, 0 mm, and short of the grip slack, 15 mm
    // (mad-catalog/src/machine.rs, GANTRY_SLACK_MM).
    assert!(
        stop > 0.0 && stop < 15.0,
        "{twin_name}'s stop is at {stop} mm"
    );
    assert_eq!(base, twin, "{twin_name} is {base_name} but its stop");
}

/// The playgrounds, each beside the file it is a headed copy of.
const PLAYGROUNDS: [(&str, &str); 2] = [
    ("mad-cosim.toml", "mad-playground.toml"),
    (
        "mad-serial-boot-cosim.toml",
        "mad-serial-boot-playground.toml",
    ),
];

/// The app's dev server, where the makefile serves the app for a person.
const DEV_SERVER: &str = "http://127.0.0.1:5174/";

#[test]
fn each_playground_is_its_cosim_file_with_chrome_headed_on_the_app() {
    behaviour!(Test {
        id: "mad-project.playgrounds",
        covers: Some("SIL/mad-playground.toml"),
        given: "each of the machine's two playground project files, beside the project file it \
                copies: the flash boot with the host's Chrome, and the ROM's serial boot",
    });
    expect!(
        "text-but-host",
        "the two files are word for word the same outside the host's section"
    );
    expect!(
        "headed-on-the-app",
        "the playground's Chrome opens a window, its first page on the app's development \
         server on the host",
        "a person watches and drives the app in that window"
    );
    expect!(
        "host-otherwise-same",
        "the playground's host has every other option of the copied file's host, with the \
         same values"
    );
    expect!(
        "entries-but-host",
        "every entry but the host's is the same in both"
    );
    for (base_name, playground_name) in PLAYGROUNDS {
        let (base_text, playground_text) = (read(base_name), read(playground_name));
        same_but(
            (base_name, &base_text),
            (playground_name, &playground_text),
            &["The host"],
        );
        let (mut base, mut playground) = (
            parse(base_name, &base_text),
            parse(playground_name, &playground_text),
        );
        let (mut cosim, mut headed) = (
            take_component(&mut base, "HOST"),
            take_component(&mut playground, "HOST"),
        );
        assert_eq!(
            option(&cosim, "headless"),
            None,
            "{base_name}'s Chrome is headless, the kind's default"
        );
        let options = |host: &mut Value| -> Table {
            host.get_mut("options")
                .and_then(Value::as_table_mut)
                .map(std::mem::take)
                .expect("the host has options")
        };
        let (cosim_options, mut headed_options) = (options(&mut cosim), options(&mut headed));
        assert_eq!(
            headed_options.remove("headless").and_then(|v| v.as_bool()),
            Some(false),
            "{playground_name}'s Chrome is headed"
        );
        let url = headed_options
            .remove("url")
            .and_then(|url| url.as_str().map(str::to_string))
            .unwrap_or_else(|| panic!("{playground_name}'s Chrome opens a page"));
        assert!(
            url.starts_with(DEV_SERVER),
            "{playground_name} opens {url}, a page of the dev server's at {DEV_SERVER}"
        );
        assert_eq!(cosim_options, headed_options, "{playground_name}'s host");
        assert_eq!(cosim, headed, "{playground_name}'s host entry");
        assert_eq!(
            base, playground,
            "{playground_name} is {base_name} but its host"
        );
    }
}

/// The file the app's flasher runs on, and the file it resets.
const REFLASH: (&str, &str) = ("mad-cosim.toml", "mad-reflash-cosim.toml");

#[test]
fn the_reflash_file_is_the_cosim_file_with_the_prop_plugs_reset() {
    behaviour!(Test {
        id: "mad-project.reflash-twin",
        covers: Some("SIL/mad-reflash-cosim.toml"),
        given: "the machine's project file whose host is the host's Chrome, beside its twin for \
                the app's firmware flasher",
    });
    expect!(
        "text-but-reset",
        "the two files are word for word the same outside the host's section, the host's \
         wires and the scenario"
    );
    expect!(
        "dtr-inverted",
        "the twin's adapter inverts DTR, and the base's keeps the line as the host drives it",
        "the machine's Prop Plug is taken to reset the chip when the host asserts DTR, which \
         the plug's reset stage does on a rising edge of an inverted DTR"
    );
    expect!(
        "prop-plug-ids",
        "the twin's serial port reports USB ids 0403:6015, the Prop Plug's FTDI FT231X, and \
         every other option of its host is the base's",
        "the app's flasher writes the firmware through the Prop Plug on the debug header"
    );
    expect!(
        "host-on-debug-header",
        "the twin's host sends to the chip's receive pin P63, reads its transmit pin P62 and \
         shares the carrier's ground on the debug header, from a 3.3 volt rail of its own, and \
         leaves the control port J4 empty",
        "the ROM's serial loader and the firmware's log are on the debug header; the \
         firmware's protocol on the control port is out of this host's reach, so the flash is \
         judged by the new firmware's boot line in its log"
    );
    expect!(
        "reset-stage-on-j1",
        "the twin adds a Prop Plug reset stage between the host's DTR and the debug header's \
         reset pin, grounded on the header",
        "the debug header's third pin is the chip's reset, where the Prop Plug's reset line \
         lands"
    );
    expect!(
        "serial-window-open",
        "the twin leaves the boot switch's P59 pull-down open, closing only the flash's chip \
         select, where the base closes both",
        "with nothing on P59 the ROM listens on its serial loader for 100 ms after a reset \
         before it boots the flash, and the app's flasher probes in that window"
    );
    expect!(
        "entries-identical",
        "every other board, model, component, wire, mate, switch and jumper is the same in both"
    );
    let (base_name, twin_name) = REFLASH;
    let (base_text, twin_text) = (read(base_name), read(twin_name));
    same_but(
        (base_name, &base_text),
        (twin_name, &twin_text),
        &["The host", "The host's wires", "Scenario"],
    );
    let (mut base, mut twin) = (parse(base_name, &base_text), parse(twin_name, &twin_text));

    let (mut base_host, mut twin_host) = (
        take_component(&mut base, "HOST"),
        take_component(&mut twin, "HOST"),
    );
    let host_option = |host: &mut Value, key: &str| -> Option<Value> {
        host.get_mut("options")
            .and_then(Value::as_table_mut)
            .and_then(|options| options.remove(key))
    };
    assert_eq!(
        host_option(&mut twin_host, "invert_dtr").and_then(|v| v.as_bool()),
        Some(true),
        "{twin_name}'s adapter inverts DTR"
    );
    assert_eq!(option(&base_host, "invert_dtr"), None, "{base_name}'s host");
    assert_eq!(
        host_option(&mut twin_host, "usb_product_id").and_then(|v| v.as_integer()),
        Some(0x6015),
        "{twin_name}'s adapter is the Prop Plug's FT231X"
    );
    assert_eq!(
        host_option(&mut base_host, "usb_product_id").and_then(|v| v.as_integer()),
        Some(0x6001),
        "{base_name}'s adapter is the control port's FT232R"
    );
    assert_eq!(base_host, twin_host, "{twin_name}'s host is {base_name}'s");

    let plug = take_component(&mut twin, "PLUG");
    assert_eq!(field(&plug, "kind"), Some("prop-plug-reset"), "{twin_name}");
    assert!(
        entries(&base, "component")
            .iter()
            .all(|entry| field(entry, "kind") != Some("prop-plug-reset")),
        "{base_name} has no reset stage"
    );
    let wires = entries_mut(&mut twin, "wire");
    let on_plug = |wire: &Value| {
        ["from", "to"]
            .iter()
            .any(|end| field(wire, end).is_some_and(|end| end.starts_with("PLUG.")))
    };
    let plug_wires: Vec<Value> = wires.iter().filter(|wire| on_plug(wire)).cloned().collect();
    wires.retain(|wire| !on_plug(wire));
    assert_eq!(
        wire_from(&plug_wires, "HOST.DTR"),
        Some(("PLUG.DTR", None)),
        "{twin_name}"
    );
    assert_eq!(
        wire_from(&plug_wires, "PLUG.VSS"),
        Some(("EDGE.J1.4", None)),
        "{twin_name}"
    );
    assert_eq!(
        wire_from(&plug_wires, "PLUG.RES"),
        Some(("EDGE.J1.3", None)),
        "{twin_name}"
    );
    assert_eq!(plug_wires.len(), 3, "{twin_name}: {plug_wires:?}");

    let on_j4 = on_connector(&twin, "J4");
    assert!(on_j4.is_empty(), "{twin_name} wires J4: {on_j4:?}");
    let debug = ends(&host_wires(&mut twin));
    let mut expected = vec![
        wire("ADAPTER.3V3", "HOST.VIO", Some(3.3)),
        // P63, the chip's receive pin, and P62, its transmit pin.
        wire("HOST.TX", "EDGE.J1.2", None),
        wire("EDGE.J1.1", "HOST.RX", None),
        wire("HOST.GND", "EDGE.J1.4", None),
    ];
    expected.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    assert_eq!(debug, expected, "{twin_name}'s host on J1");
    // The base's host wires, on J4, are the serial-boot twin test's.
    host_wires(&mut base);

    assert_eq!(s301_closed(&mut base), [1, 3], "{base_name}'s S301");
    assert_eq!(s301_closed(&mut twin), [1], "{twin_name}'s S301");

    assert_eq!(base, twin, "{twin_name} is {base_name} but its port and reset");
}
