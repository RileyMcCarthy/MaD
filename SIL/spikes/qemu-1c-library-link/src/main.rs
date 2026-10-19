//! Spike 1c: link upstream QEMU into a Rust process and run TCG from it.
//!
//! This is the structural claim the whole plan rests on — Spike 0a could only
//! approximate it with Unicorn. Here the process is Rust, the QEMU objects are
//! linked in, and `qemu_init` builds a riscv32 `virt` machine in-process.
use std::ffi::CString;
use std::os::raw::{c_char, c_int};

extern "C" {
    fn p2lib_boot(argc: c_int, argv: *mut *mut c_char);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut argv: Vec<CString> = vec![CString::new("qemu-lib-spike").unwrap()];
    argv.extend(args.iter().map(|a| CString::new(a.as_str()).unwrap()));
    let mut ptrs: Vec<*mut c_char> = argv.iter().map(|c| c.as_ptr() as *mut c_char).collect();
    ptrs.push(std::ptr::null_mut());

    eprintln!("[rust] linking QEMU in-process; calling qemu_init with {} args", ptrs.len() - 1);
    unsafe { p2lib_boot((ptrs.len() - 1) as c_int, ptrs.as_mut_ptr()) };
    eprintln!("[rust] qemu_init returned, BQL+replay released; vCPU thread is live");

    // The patched rr loop runs the slice benchmark and exits the process.
    loop {
        std::thread::park();
    }
}
