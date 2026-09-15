//! Run the PWA's loadp2 flash stub and report EVERY instruction p2core lacks.
//!
//! Steps one instruction at a time; on a trap it records the word, steps the
//! PC past it and carries on, so one pass yields the whole inventory instead
//! of one instruction per run.
use p2core::{decode, Board, Machine, SdCard, Trap};
use std::collections::BTreeMap;

fn b64(s: &str) -> Vec<u8> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, &c) in T.iter().enumerate() {
        rev[c as usize] = i as u8;
    }
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0u32);
    for b in s.bytes() {
        if b == b'=' {
            break;
        }
        let v = rev[b as usize];
        if v == 255 {
            continue;
        }
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

fn stub() -> Vec<u8> {
    let src = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../Software/Control/src/firmware/image.ts"),
    )
    .expect("image.ts");
    let start = src.find("const FLASH_LOADER_BASE64").unwrap();
    let decl = &src[start..start + src[start..].find(';').unwrap()];
    let (mut acc, mut rest) = (String::new(), decl);
    while let Some(o) = rest.find('\'') {
        let after = &rest[o + 1..];
        let c = after.find('\'').unwrap();
        acc.push_str(&after[..c]);
        rest = &after[c + 1..];
    }
    b64(&acc)
}

fn main() {
    let s = stub();
    let fw: Vec<u8> = (0..1024u32)
        .map(|i| (i.wrapping_mul(31).wrapping_add(7) & 0xFF) as u8)
        .collect();
    let mut img = Vec::new();
    img.extend_from_slice(&s);
    img.extend_from_slice(&fw);
    while img.len() % 4 != 0 {
        img.push(0)
    }
    let put = |img: &mut Vec<u8>, l: usize, v: u32| {
        img[l * 4..l * 4 + 4].copy_from_slice(&v.to_le_bytes())
    };
    put(&mut img, 2, 0);
    put(&mut img, 1, 0);
    let mut sum = 0u32;
    for i in (0..img.len()).step_by(4) {
        sum = sum.wrapping_add(u32::from_le_bytes(img[i..i + 4].try_into().unwrap()))
    }
    put(&mut img, 1, 0u32.wrapping_sub(sum));

    let board = Board::new(SdCard::blank(0)).with_flash(vec![0xFF; 1 << 20]);
    let mut m = Machine::new(&img, board);
    // The state the boot ROM leaves behind: its hub FIFO pointer sits just past
    // the image it downloaded, and that is how the stub learns the size
    // (GETPTR / SHR #2 at $003..$006).
    m.cogs[0].fifo_addr = img.len() as u32;

    let mut gaps: BTreeMap<String, (usize, u32)> = BTreeMap::new();
    let mut steps = 0u64;
    let budget = 2_000_000u64;
    let mut hist: BTreeMap<u32, u64> = BTreeMap::new();
    while steps < budget {
        match m.step(1) {
            Ok(_) => {
                *hist.entry(m.cogs[0].pc).or_default() += 1;
                steps += 1;
            }
            Err(t) => {
                let (pc, word, name) = match &t {
                    Trap::UndecodedWord { pc, word, .. } => {
                        (*pc, *word, format!("<undecoded {word:08X}>"))
                    }
                    Trap::Unimplemented {
                        pc, word, mnemonic, ..
                    } => (*pc, *word, (*mnemonic).to_string()),
                    other => {
                        println!("STOP: {other:?} after {steps} steps");
                        break;
                    }
                };
                let e = gaps.entry(name).or_insert((0, word));
                e.0 += 1;
                // step over it and keep going
                m.cogs[0].running = true;
                m.cogs[0].pc = if pc < 0x400 { pc + 1 } else { pc + 4 };
                steps += 1;
                if gaps.values().map(|v| v.0).sum::<usize>() > 4000 {
                    println!("(too many traps; stopping)");
                    break;
                }
            }
        }
        if !m.cogs[0].running && m.cogs.iter().all(|c| !c.running) {
            println!("all cogs halted after {steps} steps");
            break;
        }
    }
    println!("steps executed: {steps}");
    println!(
        "flash: commands={:02X?} writes={:?} erases={:?}",
        m.pins.flash.commands, m.pins.flash.writes, m.pins.flash.erases
    );
    let mut top: Vec<_> = hist.iter().map(|(a, n)| (*n, *a)).collect();
    top.sort_unstable_by_key(|(n, _)| std::cmp::Reverse(*n));
    println!("\nhottest PCs (cog longs):");
    for (n, a) in top.iter().take(14) {
        let w = if *a < 0x200 {
            m.cogs[0].regs[*a as usize]
        } else {
            0
        };
        let dec = decode(w)
            .map(|d| format!("{:?} d={:#05x} s={:#05x} i={}", d.op, d.d, d.s, d.i))
            .unwrap_or_else(|| "-".into());
        println!("  ${a:03X}  n={n:<9} word={w:08X}  {dec}");
    }
    println!("\nmissing instructions encountered on the executed path:");
    for (name, (n, word)) in &gaps {
        let dec = decode(*word)
            .map(|d| format!("{:?}", d.op))
            .unwrap_or_else(|| "-".into());
        println!("  {name:24} hits={n:6}  word={word:08X}  decodes_as={dec}");
    }
}
