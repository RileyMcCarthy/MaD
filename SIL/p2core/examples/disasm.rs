//! Disassemble a range of the image using the verified decoder.
//!
//! `disasm <image> <hub_addr|cog:NNN> [count]` — `cog:` addresses the kernel by
//! cog register, which is loaded from hub $404.
use p2core::decode;

fn main() {
    let mut a = std::env::args().skip(1);
    let path = a.next().expect("usage: disasm <image> <addr|cog:NNN> [count]");
    let spec = a.next().expect("addr");
    let count: usize = a.next().and_then(|s| s.parse().ok()).unwrap_or(16);
    let img = std::fs::read(&path).expect("read image");

    let (mut addr, cog) = match spec.strip_prefix("cog:") {
        Some(c) => {
            let n = u32::from_str_radix(c.trim_start_matches('$'), 16).expect("cog addr");
            (0x404 + n * 4, Some(n))
        }
        None => (u32::from_str_radix(spec.trim_start_matches('$'), 16).expect("hub addr"), None),
    };
    for i in 0..count {
        let o = addr as usize;
        let w = u32::from_le_bytes([img[o], img[o + 1], img[o + 2], img[o + 3]]);
        let label = match cog {
            Some(n) => format!("cog${:03X}", n + i as u32),
            None => format!("hub${addr:05X}"),
        };
        match decode(w) {
            Some(d) => println!(
                "{label} {w:08X}  {:9} cond={:2} D=${:03X}{} S=${:03X}{} {}{}{:?}",
                d.op.mnemonic(), d.cond, d.d, if d.l { "(L)" } else { "   " },
                d.s, if d.i { "#" } else { " " },
                if d.c { "wc " } else { "" }, if d.z { "wz " } else { "" }, d.form
            ),
            None => println!("{label} {w:08X}  <undecoded>"),
        }
        addr += 4;
    }
}
