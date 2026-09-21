//! Dump p2core's decode for every distinct instruction word in the firmware,
//! so a differential test can check the generated QEMU DecodeTree agrees.
use std::collections::BTreeMap;
use p2core::generated::decode::decode;

fn main() {
    let path = std::env::args().nth(1).expect("usage: dumpdec <image>");
    let img = std::fs::read(&path).expect("read");
    let mut seen: BTreeMap<u32, String> = BTreeMap::new();
    // The hub-exec region of a flexspin image: every aligned long is a
    // candidate instruction, which is exactly what decoder_golden.rs checks.
    for ch in img.chunks_exact(4) {
        let w = u32::from_le_bytes([ch[0], ch[1], ch[2], ch[3]]);
        seen.entry(w).or_insert_with(|| match decode(w) {
            Some(d) => d.op.mnemonic().to_string(),
            None => "<undecoded>".to_string(),
        });
    }
    for (w, m) in &seen {
        println!("{w:08X} {m}");
    }
    eprintln!("distinct words: {}", seen.len());
}
