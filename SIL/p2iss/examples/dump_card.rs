//! Write the generated card image to a file, so a host FAT driver can judge it.
fn main() {
    let out = std::env::args().nth(1).expect("usage: dump_card <path>");
    let img = p2iss::sdimage::mad_card(32 * 1024 * 1024, None).expect("builds");
    std::fs::write(&out, &img).expect("write");
    eprintln!("wrote {} bytes to {out}", img.len());
}
