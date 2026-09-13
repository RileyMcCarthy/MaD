//! p2core vs one-instruction records captured from a real P2.
//!
//! `hwtest/golden/probe.binary` is the stub RAM-loaded onto a P2-EVAL.
//! `hwtest/golden/probe.txt` is, per case, the mailbox we patched in and the
//! DUMP the chip printed. This test patches the same mailbox, interprets the
//! image, and demands the same DUMP — so a p2core change is checked against
//! silicon without the board.
//!
//! Recapture:
//!
//! ```text
//! python3 tools/hw_probe.py --capture
//! ```

use std::path::PathBuf;

use p2core::{decode, Machine, SmartPins};

fn crate_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

const MAGIC: [u8; 8] = [0x0D, 0xF0, 0x55, 0xAA, 0x01, 0x0B, 0xDE, 0xC0];

#[derive(Debug)]
struct Case {
    name: String,
    enc: u32,
    pre: u32,
    din: u32,
    sin: u32,
    flags: u32,
    hub_in: [u32; 4],
    d: u32,
    s: u32,
    c: u32,
    z: u32,
    hub_out: [u32; 4],
}

fn mailbox_off(image: &[u8]) -> usize {
    image
        .windows(8)
        .position(|w| w == MAGIC)
        .expect("probe mailbox magic not found")
}

fn patch(image: &[u8], c: &Case) -> Vec<u8> {
    let mut buf = image.to_vec();
    let off = mailbox_off(image);
    let put = |buf: &mut [u8], rel: usize, v: u32| {
        buf[off + rel..off + rel + 4].copy_from_slice(&v.to_le_bytes());
    };
    put(&mut buf, 8, c.enc);
    put(&mut buf, 12, c.pre);
    put(&mut buf, 16, c.din);
    put(&mut buf, 20, c.sin);
    put(&mut buf, 24, c.flags);
    put(&mut buf, 28, 0);
    for (i, v) in c.hub_in.iter().enumerate() {
        put(&mut buf, 32 + i * 4, *v);
    }
    put(&mut buf, 60, 0);
    buf
}

fn parse_kv(line: &str) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    for tok in line.split_whitespace() {
        if let Some((k, v)) = tok.split_once('=') {
            m.insert(k.to_string(), v.to_string());
        }
    }
    m
}

fn parse_hub(s: &str) -> [u32; 4] {
    let mut out = [0u32; 4];
    for (i, p) in s.split(',').take(4).enumerate() {
        out[i] = u32::from_str_radix(p, 16).expect("hub hex");
    }
    out
}

fn parse_golden(text: &str) -> Vec<Case> {
    let mut cases = Vec::new();
    let mut cur: Option<Case> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix("CASE ") {
            if let Some(c) = cur.take() {
                cases.push(c);
            }
            cur = Some(Case {
                name: name.to_string(),
                enc: 0,
                pre: 0,
                din: 0,
                sin: 0,
                flags: 0,
                hub_in: [0; 4],
                d: 0,
                s: 0,
                c: 0,
                z: 0,
                hub_out: [0; 4],
            });
        } else if let Some(rest) = line.strip_prefix("IN ") {
            let kv = parse_kv(rest);
            let c = cur.as_mut().expect("IN without CASE");
            c.enc = u32::from_str_radix(&kv["enc"], 16).unwrap();
            c.pre = u32::from_str_radix(&kv["pre"], 16).unwrap();
            c.din = u32::from_str_radix(&kv["din"], 16).unwrap();
            c.sin = u32::from_str_radix(&kv["sin"], 16).unwrap();
            c.flags = kv["flags"].parse().unwrap();
            c.hub_in = parse_hub(&kv["hub"]);
        } else if let Some(rest) = line.strip_prefix("OUT ") {
            let kv = parse_kv(rest);
            let c = cur.as_mut().expect("OUT without CASE");
            c.d = u32::from_str_radix(&kv["d"], 16).unwrap();
            c.s = u32::from_str_radix(&kv["s"], 16).unwrap();
            c.c = kv["c"].parse().unwrap();
            c.z = kv["z"].parse().unwrap();
            c.hub_out = parse_hub(&kv["hub"]);
        }
    }
    if let Some(c) = cur {
        cases.push(c);
    }
    cases
}

fn parse_dump(console: &str) -> Option<(u32, u32, u32, u32, [u32; 4])> {
    let mut d = None;
    let mut hub = [0u32; 4];
    for raw in console.replace('\r', "\n").lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("DUMP ") {
            let p: Vec<&str> = rest.split_whitespace().collect();
            if p.len() >= 5 {
                d = Some((
                    u32::from_str_radix(p[1], 16).ok()?,
                    u32::from_str_radix(p[2], 16).ok()?,
                    p[3].parse().ok()?,
                    p[4].parse().ok()?,
                ));
            }
        }
        if let Some(rest) = line.strip_prefix("HUB ") {
            let p: Vec<&str> = rest.split_whitespace().collect();
            if p.len() >= 4 {
                for i in 0..4 {
                    hub[i] = u32::from_str_radix(p[i], 16).ok()?;
                }
            }
        }
    }
    d.map(|(dv, sv, c, z)| (dv, sv, c, z, hub))
}

fn run_iss(image: &[u8]) -> Result<String, String> {
    let mut m = Machine::new(image, SmartPins::default());
    const CHUNK: u64 = 10_000;
    const BUDGET: u64 = 50_000_000;
    let mut ran = 0u64;
    while ran < BUDGET {
        let n = CHUNK.min(BUDGET - ran);
        match m.step(n) {
            Ok(k) => {
                ran += k;
                if k < n {
                    break;
                }
            }
            Err(t) => return Err(format!("TRAP: {t}")),
        }
        if m.pins.console().contains("END") {
            break;
        }
    }
    if !m.pins.console().contains("END") {
        return Err(format!(
            "no END after {ran} instructions\n{}",
            m.pins.console()
        ));
    }
    Ok(m.pins.console().to_string())
}

#[test]
fn silicon_probe_matches_golden() {
    let bin_path = crate_path("hwtest/golden/probe.binary");
    let txt_path = crate_path("hwtest/golden/probe.txt");
    if !bin_path.is_file() || !txt_path.is_file() {
        eprintln!(
            "skipping: no probe golden; capture with:\n  python3 tools/hw_probe.py --capture"
        );
        return;
    }

    let stub = std::fs::read(&bin_path).expect("read probe.binary");
    let cases = parse_golden(&std::fs::read_to_string(&txt_path).unwrap());
    assert!(!cases.is_empty(), "probe.txt has no CASE records");

    let mut failed = String::new();
    for c in &cases {
        assert!(
            decode(c.enc).is_some(),
            "{}: p2core cannot decode {:08x}",
            c.name,
            c.enc
        );
        let image = patch(&stub, c);
        let console = match run_iss(&image) {
            Ok(s) => s,
            Err(e) => {
                failed.push_str(&format!("{}: {e}\n", c.name));
                continue;
            }
        };
        let Some((d, s, zc, zz, hub)) = parse_dump(&console) else {
            failed.push_str(&format!("{}: no DUMP in\n{console}\n", c.name));
            continue;
        };
        if d != c.d || s != c.s || zc != c.c || zz != c.z || hub != c.hub_out {
            failed.push_str(&format!(
                "{}:\n  iss     d={d:08x} s={s:08x} c={zc} z={zz} hub={hub:08x?}\n  silicon d={:08x} s={:08x} c={} z={} hub={:08x?}\n",
                c.name, c.d, c.s, c.c, c.z, c.hub_out
            ));
        }
    }
    if !failed.is_empty() {
        panic!(
            "p2core ISS does not match silicon probe records\n{failed}recapture: python3 tools/hw_probe.py --capture\n"
        );
    }
}
