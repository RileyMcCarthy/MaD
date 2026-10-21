//! MaD's four project files hold one machine: `SIL/mad.toml` (the production
//! firmware booted off the module's flash, a `host-serial` on the carrier's
//! debug header `J1`, where the machine's Prop Plug sits), `mad-cosim.toml`
//! (the same with the host's Chrome), `mad-serial-boot.toml` (the ROM's
//! serial boot, the flash erased, the same host) and
//! `mad-serial-boot-cosim.toml` (that with the host's Chrome). Each file is
//! complete on its own, so nothing but this test keeps their shared lines
//! the same: a supply, a wire or a jumper changed in one file and not the
//! others fails here, naming the section.
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

const COSIM_TWINS: [(&str, &str); 2] = [
    ("mad.toml", "mad-cosim.toml"),
    ("mad-serial-boot.toml", "mad-serial-boot-cosim.toml"),
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
        "the twin's serial port reports USB vendor 0403 and product 6015, an FTDI FT231X's",
        "the machine's host is the Prop Plug on the debug header, and the app finds a port \
         again after a replug by its USB ids"
    );
    expect!(
        "entries-but-host",
        "every board, model, component, wire, mate, switch and jumper but the host's entry is \
         the same in both"
    );
    for (base_name, twin_name) in COSIM_TWINS {
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
            [Some(0x0403), Some(0x6015)],
            "{twin_name}"
        );
        assert_eq!(base, twin, "{twin_name} is {base_name} but its host");
    }
}

/// The host's wires: each wire with an end on the host.
fn host_wires(file: &mut Table) -> Vec<Value> {
    let wires = entries_mut(file, "wire");
    let on_host = |wire: &Value| {
        ["from", "to"]
            .iter()
            .any(|end| field(wire, end).is_some_and(|end| end.starts_with("HOST.")))
    };
    let host: Vec<Value> = wires.iter().filter(|wire| on_host(wire)).cloned().collect();
    wires.retain(|wire| !on_host(wire));
    host
}

/// The wire whose `from` is `from`, as `(to, volts)`.
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
        "both files' host sends to the chip's receive pin P63 and reads its transmit pin P62, \
         on the carrier's debug header",
        "the production build's protocol channel and the ROM's serial loader are both on P62 \
         and P63, so one host on the debug header flashes the firmware and then drives it"
    );
    expect!(
        "host-rail",
        "both files' host has a 3.3 volt rail of its own and the carrier's ground"
    );
    expect!(
        "pi-connector-empty",
        "both files leave the Raspberry Pi's connector J4 empty, no supply and no wire on it",
        "the Pi's line reaches the carrier's P52 to P55 only, pins the P2-EC32MB module has no \
         finger for"
    );
    expect!(
        "entries-identical",
        "every other board, model, component, wire, mate, switch and jumper is the same in both"
    );
    expect!(
        "text-identical",
        "the files are word for word the same outside their boards', host's and scenario \
         sections"
    );
    let (flash_text, serial_text) = (read("mad.toml"), read("mad-serial-boot.toml"));
    same_but(
        ("mad.toml", &flash_text),
        ("mad-serial-boot.toml", &serial_text),
        &["The boards", "The host", "Scenario"],
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

    for (name, file) in [("mad.toml", &flash), ("mad-serial-boot.toml", &serial)] {
        let on_j4: Vec<&Value> = entries(file, "wire")
            .iter()
            .filter(|wire| {
                ["from", "to"]
                    .iter()
                    .any(|end| field(wire, end).is_some_and(|end| end.starts_with("EDGE.J4.")))
            })
            .collect();
        assert!(on_j4.is_empty(), "{name} wires J4: {on_j4:?}");
    }
    for (name, file) in [
        ("mad.toml", &mut flash),
        ("mad-serial-boot.toml", &mut serial),
    ] {
        let debug = host_wires(file);
        assert_eq!(
            wire_from(&debug, "HOST.TX"),
            Some(("EDGE.J1.2", None)),
            "{name}"
        );
        assert_eq!(
            wire_from(&debug, "EDGE.J1.1"),
            Some(("HOST.RX", None)),
            "{name}"
        );
        assert_eq!(
            wire_from(&debug, "ADAPTER.3V3"),
            Some(("HOST.VIO", Some(3.3))),
            "{name}"
        );
        assert_eq!(
            wire_from(&debug, "HOST.GND"),
            Some(("EDGE.J1.4", None)),
            "{name}"
        );
        assert_eq!(debug.len(), 4, "{name}: {debug:?}");
    }

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
