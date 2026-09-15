use p2core::decode;
fn main() {
    for w in [
        0xfc22b557u32,
        0xfc187f58,
        0xfd72b040,
        0x3d9ffff8,
        0xfa8ab558,
        0xfd62b469,
    ] {
        match decode(w) {
            Some(i) => println!(
                "{w:08x}  {:?} d={:#05x} s={:#05x} c={} z={}",
                i.op, i.d, i.s, i.c, i.z
            ),
            None => println!("{w:08x}  <undecoded>"),
        }
    }
}
