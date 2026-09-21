//! Spike 0a — can QEMU's TCG be driven synchronously from Rust?
//!
//! Unicorn *is* QEMU's TCG (a fork of QEMU 5.0) driven from the caller's
//! thread with MMIO callbacks, so it answers the two things the P2 plan needs
//! measured before any P2 semantics are written:
//!
//! 1. What does a pin-op-shaped callback (an MMIO store that lands in Rust)
//!    cost, round trip?  Accept: < 50 ns.
//! 2. What does slicing execution from outside cost — `emu_start` for N
//!    instructions, read state, resume — at the granularity embsim needs
//!    (~80 instructions ≈ 1 µs of one P2 cog)?  Accept: ≤ 1 µs virtual
//!    resolution without a thread hop.
//!
//! It also measures what Unicorn's *own* instruction counting costs, because
//! it is implemented as a per-instruction `UC_HOOK_CODE` helper
//! (`hook_count_cb` in uc.c) — the mechanism a real icount budget avoids.
//!
//! Guest: riscv32, a hand-assembled loop.  No toolchain needed.

use std::hint::black_box;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use unicorn_engine::unicorn_const::{Arch, Mode, Prot};
use unicorn_engine::{RegisterRISCV, Unicorn};

const CODE: u64 = 0x1000;
const MMIO: u64 = 0x2000_0000;

// riscv32, hand-encoded.  Layout: lui t0 / lui t1 / BODY / addi / bne / ebreak
const LUI_T1_MMIO: u32 = 0x2000_0337; // lui t1, 0x20000  -> t1 = MMIO base
const SW_T0_0_T1: u32 = 0x0053_2023; //  sw  t0, 0(t1)   <- the pin-op-shaped store
const NOP: u32 = 0x0000_0013; //          addi x0, x0, 0
const ADDI_T0_M1: u32 = 0xFFF2_8293; //   addi t0, t0, -1
const BNE_T0_ZERO_M8: u32 = 0xFE02_9CE3; // bne t0, zero, -8  (back to BODY)
const EBREAK: u32 = 0x0010_0073;
const UNTIL: u64 = CODE + 5 * 4; // address of EBREAK

/// `lui rd, imm20`
fn lui(rd: u32, imm20: u32) -> u32 {
    (imm20 << 12) | (rd << 7) | 0x37
}

/// Instructions retired by the loop program for `iters` iterations.
fn total_insns(iters: u64) -> u64 {
    2 + 3 * iters
}

/// What the MMIO callback records — enough to be "pin-op shaped": which pin
/// (offset), what value, how many times.
static PIN_WRITES: AtomicU64 = AtomicU64::new(0);
static PIN_LAST: AtomicU64 = AtomicU64::new(0);

fn machine(iters_lui: u32, body: u32) -> Unicorn<'static, ()> {
    let mut uc = Unicorn::new(Arch::RISCV, Mode::RISCV32).expect("unicorn riscv32");
    uc.mem_map(CODE, 0x1000, Prot::ALL).expect("map code");
    let words = [lui(5, iters_lui), LUI_T1_MMIO, body, ADDI_T0_M1, BNE_T0_ZERO_M8, EBREAK];
    let mut bytes = Vec::with_capacity(words.len() * 4);
    for w in words {
        bytes.extend_from_slice(&w.to_le_bytes());
    }
    uc.mem_write(CODE, &bytes).expect("write code");
    uc.mmio_map_wo(MMIO, 0x1000, |_uc, offset, _size, value| {
        // A pin op: note which pin and what was driven.  Relaxed load/store
        // rather than fetch_add so the counter is a plain str on arm64.
        PIN_WRITES.store(PIN_WRITES.load(Relaxed) + 1, Relaxed);
        PIN_LAST.store((offset << 32) | (value & 0xFFFF_FFFF), Relaxed);
    })
    .expect("mmio map");
    uc
}

fn mips(insns: u64, d: Duration) -> f64 {
    insns as f64 / d.as_secs_f64() / 1e6
}

fn ns_per(n: u64, d: Duration) -> f64 {
    d.as_nanos() as f64 / n as f64
}

fn run_whole(uc: &mut Unicorn<()>, count: usize) -> Duration {
    let t = Instant::now();
    uc.emu_start(CODE, UNTIL, 0, count).expect("emu_start");
    t.elapsed()
}

/// `qemu-0a-unicorn slice <N>`: run only the slicing loop at slice N for a
/// long time, so `sample` can show where a slice's fixed cost goes.
fn profile_slices(slice: usize) {
    let lui = 0x400u32; // 4 M iterations = 12.6 M instructions
    let mut uc = machine(lui, NOP);
    let mut pc = CODE;
    let mut slices = 0u64;
    let t = Instant::now();
    while pc != UNTIL {
        uc.emu_start(pc, UNTIL, 0, slice).expect("slice");
        pc = uc.pc_read().expect("pc");
        slices += 1;
    }
    let d = t.elapsed();
    println!("slice={slice}: {slices} slices, {:.1} ns/slice", d.as_nanos() as f64 / slices as f64);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1] == "slice" {
        profile_slices(args[2].parse().expect("slice size"));
        return;
    }
    // 0x1000 << 12 = 16,777,216 iterations = 50,331,650 instructions.
    let iters_lui = 0x1000u32;
    let iters = (iters_lui as u64) << 12;
    let n = total_insns(iters);
    println!("guest: riscv32 loop, {iters} iterations, {n} instructions\n");

    // A. Pure TCG rate: nop body, no counting, run to `until`.
    let mut uc = machine(iters_lui, NOP);
    let d_a = run_whole(&mut uc, 0);
    assert_eq!(uc.reg_read(RegisterRISCV::X5).unwrap(), 0, "loop ran to completion");
    println!("A  pure TCG, nop body, no count        {:>8.1} M inst/s   {:>6.2} ns/inst",
        mips(n, d_a), ns_per(n, d_a));

    // B. Pin-op-shaped MMIO store every iteration.
    PIN_WRITES.store(0, Relaxed);
    let mut uc = machine(iters_lui, SW_T0_0_T1);
    let d_b = run_whole(&mut uc, 0);
    let writes = PIN_WRITES.load(Relaxed);
    assert_eq!(writes, iters, "one callback per iteration");
    assert_eq!(PIN_LAST.load(Relaxed) & 0xFFFF_FFFF, 1, "last write was t0 == 1");
    let cb_ns = (d_b.as_nanos() as f64 - d_a.as_nanos() as f64) / iters as f64;
    println!("B  + MMIO store -> Rust callback/iter  {:>8.1} M inst/s   {:>6.2} ns/inst   callback ≈ {:.1} ns each ({} calls)",
        mips(n, d_b), ns_per(n, d_b), cb_ns, writes);

    // C. Same as A but with Unicorn's per-instruction count hook armed.
    let mut uc = machine(iters_lui, NOP);
    let d_c = run_whole(&mut uc, (n + 1_000_000) as usize);
    assert_eq!(uc.reg_read(RegisterRISCV::X5).unwrap(), 0);
    println!("C  nop body, count hook armed          {:>8.1} M inst/s   {:>6.2} ns/inst   (per-insn UC_HOOK_CODE: the mechanism icount avoids)",
        mips(n, d_c), ns_per(n, d_c));

    // D. Slice from outside: run SLICE instructions, read state, resume.
    println!();
    println!("D  slicing from Rust (emu_start N / pc_read / reg_read / resume), nop body");
    println!("   {:>6}  {:>10}  {:>12}  {:>12}  {:>10}", "slice", "slices", "ns/slice", "M inst/s", "x of A");
    for &slice in &[1usize, 8, 80, 800, 8000, 80_000] {
        // Keep wall time sane: fewer iterations for tiny slices.
        let lui_d = if slice < 80 { 0x10 } else { 0x1000 };
        let iters_d = (lui_d as u64) << 12;
        let n_d = total_insns(iters_d);
        let mut uc = machine(lui_d, NOP);
        let mut pc = CODE;
        let mut slices = 0u64;
        let t = Instant::now();
        while pc != UNTIL {
            uc.emu_start(pc, UNTIL, 0, slice).expect("slice");
            pc = uc.pc_read().expect("pc");
            black_box(uc.reg_read(RegisterRISCV::X5).expect("t0"));
            slices += 1;
        }
        let d = t.elapsed();
        assert_eq!(uc.reg_read(RegisterRISCV::X5).unwrap(), 0);
        let base_ns = ns_per(n_d, d_a) * n_d as f64; // what A would take for n_d
        println!("   {:>6}  {:>10}  {:>12.1}  {:>12.1}  {:>9.2}x",
            slice, slices, d.as_nanos() as f64 / slices as f64, mips(n_d, d),
            d.as_nanos() as f64 / base_ns);
    }

    // E. Exactness: does `count = N` retire exactly N instructions per slice?
    println!();
    let slice = 80usize;
    let lui_e = 0x1u32; // 4096 iterations
    let mut uc = machine(lui_e, NOP);
    let per_slice = std::rc::Rc::new(std::cell::Cell::new(0u64));
    let ps = per_slice.clone();
    uc.add_code_hook(CODE, UNTIL + 4, move |_uc, _addr, _size| ps.set(ps.get() + 1))
        .expect("code hook");
    let mut pc = CODE;
    let mut exact = 0u64;
    let mut inexact = Vec::new();
    while pc != UNTIL {
        per_slice.set(0);
        uc.emu_start(pc, UNTIL, 0, slice).expect("slice");
        pc = uc.pc_read().expect("pc");
        let got = per_slice.get();
        if pc == UNTIL {
            break; // final partial slice
        }
        if got as usize == slice { exact += 1 } else { inexact.push(got) }
    }
    println!("E  exactness at slice={slice}: {exact} exact slices, {} inexact {:?}",
        inexact.len(), &inexact[..inexact.len().min(5)]);
}
