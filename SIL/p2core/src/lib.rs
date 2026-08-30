//! `p2core` — a functional Propeller 2 instruction-set simulator.
//!
//! This is the CPU only. It executes the real flexcc-produced P2 image rather
//! than host-compiled C, which is the whole reason it exists: the native SIL
//! backend compiles the firmware with clang and substitutes the HAL, so it
//! structurally cannot see flexcc codegen bugs, 32-bit pointer assumptions,
//! cog stack overflow, or smart-pin misconfiguration.
//!
//! # Scope
//!
//! Functional (instruction-accurate), not cycle-accurate. The P2 RTL is not
//! public and the encoding tables carry no cycle counts, so there is no oracle
//! for per-instruction timing; claiming cycle accuracy would be claiming
//! something unverifiable. Instruction cost is a nominal constant, which makes
//! virtual time *systematically* approximate and bit-reproducible rather than
//! randomly wrong.
//!
//! # Dependencies
//!
//! None, deliberately — not even `embsim-core`. Hub bytes in, [`PinBus`] calls
//! out, [`Machine::step_until`] for time.

pub mod board;
pub mod generated;
pub mod model;
pub mod pins;
pub mod sdcard;
pub mod trap;

pub use generated::decode::{decode, Decoded, Form, Op};
pub use board::Board;
pub use model::SmartPins;
pub use sdcard::SdCard;
pub use pins::{NullPins, PinBus};
pub use trap::Trap;

/// Hub RAM size. The C stack starts near `$4B410` and grows *upward*, so the
/// full 512 KB is required even though the image is ~300 KB.
pub const HUB_BYTES: usize = 512 * 1024;
/// Cog RAM, in longs.
pub const COG_LONGS: usize = 512;
/// Lookup RAM, in longs.
pub const LUT_LONGS: usize = 512;
/// Cogs on a P2.
pub const NUM_COGS: usize = 8;
/// Hardware locks on a P2.
pub const NUM_LOCKS: usize = 16;

/// Longs a `COGINIT` load copies from hub into cog RAM (`$000..$1F7`).
const COGINIT_LOAD_LONGS: usize = 0x1F8;

// Cog special registers ($1F0..$1FF).
const REG_PA: u16 = 0x1F6;
const REG_PB: u16 = 0x1F7;
const REG_PTRA: u16 = 0x1F8;
const REG_PTRB: u16 = 0x1F9;
const REG_DIRA: u16 = 0x1FA;
const REG_OUTA: u16 = 0x1FC;
const REG_INA: u16 = 0x1FE;
const REG_INB: u16 = 0x1FF;

/// Where a unified 20-bit PC points. Cog and LUT step by 1, hub by 4.
const LUT_BASE: u32 = 0x200;
const HUB_BASE: u32 = 0x400;

/// Nominal clocks charged per executed instruction.
///
/// Most P2 cog instructions are 2 clocks; hub access is 9-16 depending on
/// egg-beater alignment. With no cycle table to consult, a flat nominal keeps
/// virtual time deterministic. Being uniformly wrong is fine — the cog and the
/// pin models share this clock, so they stay consistent with each other, which
/// is the property the simulation actually needs.
pub const CLOCKS_PER_INSTRUCTION: u64 = 2;
/// Extra clocks charged for a hub read or write.
pub const CLOCKS_HUB_ACCESS: u64 = 9;

/// A hub write that landed inside a watched range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchHit {
    pub cog: u8,
    /// PC of the instruction *after* the writing one.
    pub pc: u32,
    /// Address as the instruction computed it, before hub wrapping.
    pub addr: u32,
    /// Address actually written, after masking to the 512 KB hub.
    pub effective: u32,
    pub value: u32,
    pub width: u8,
}

/// One cog's architectural state.
#[derive(Clone)]
pub struct Cog {
    /// Cog RAM. `$1F0..$1FF` are the special registers (PA/PTRA/DIRA/...).
    pub regs: [u32; COG_LONGS],
    pub lut: [u32; LUT_LONGS],
    /// Unified 20-bit PC: `<$200` cog RAM, `<$400` LUT, else a hub byte address.
    pub pc: u32,
    pub c: bool,
    pub z: bool,
    /// The 8-level hardware call stack (a ring on silicon too).
    pub stack: [u32; 8],
    pub sp: usize,
    pub running: bool,
    /// Pending `AUGS`/`AUGD` prefix, consumed by the next instruction.
    aug_s: Option<u32>,
    aug_d: Option<u32>,
    /// Pending `SETQ`/`SETQ2` value, consumed by the next instruction.
    setq: Option<u32>,
    /// `REP` block: (remaining iterations, first pc, last pc).
    rep: Option<(u32, u32, u32)>,
    /// CORDIC results, filled by QMUL/QDIV/... and read by GETQX/GETQY.
    qx: u32,
    qy: u32,
    /// Hub write-FIFO cursor for `WRFAST`/`WFLONG`.
    fifo: u32,
    /// `ADDCT1` target for `WAITCT1`.
    ct1: u32,
    /// Pending `ALTD`/`ALTS` field substitution for the next instruction.
    alt_d: Option<u16>,
    alt_s: Option<u16>,
    /// Guest clocks this cog has retired.
    pub clocks: u64,
}

impl Default for Cog {
    fn default() -> Self {
        Self {
            regs: [0; COG_LONGS],
            lut: [0; LUT_LONGS],
            pc: 0,
            c: false,
            z: false,
            stack: [0; 8],
            sp: 0,
            running: false,
            aug_s: None,
            aug_d: None,
            setq: None,
            rep: None,
            qx: 0,
            qy: 0,
            fifo: 0,
            ct1: 0,
            alt_d: None,
            alt_s: None,
            clocks: 0,
        }
    }
}

impl Cog {
    fn push(&mut self, v: u32) {
        self.stack[self.sp & 7] = v;
        self.sp = (self.sp + 1) & 7;
    }
    fn pop(&mut self) -> u32 {
        self.sp = self.sp.wrapping_sub(1) & 7;
        self.stack[self.sp]
    }
}

/// A whole P2: hub RAM, eight cogs, the lock pool, and a pin bus.
pub struct Machine<P: PinBus> {
    pub hub: Vec<u8>,
    pub cogs: Vec<Cog>,
    pub locks: [Option<u8>; NUM_LOCKS],
    lock_alloc: [bool; NUM_LOCKS],
    pub pins: P,
    /// Retired instructions across all cogs, for throughput measurement.
    pub retired: u64,
    /// Trap on a hub access outside the 512 KB map instead of wrapping.
    ///
    /// Silicon wraps (hub addresses are 20-bit), but during bring-up a wild
    /// pointer that aliases onto valid memory corrupts code far from the
    /// culprit and only surfaces when that code executes.
    pub strict_hub: bool,
    /// Optional hub write watchpoint: `(start, len)`.
    pub watch: Option<(u32, u32)>,
    /// Writes that landed in the watched range, oldest first.
    pub watch_hits: Vec<WatchHit>,
    /// Log of hardware-stack traffic: `(cog, pc, is_push, value)`.
    pub stack_log: Vec<(u8, u32, bool, u32)>,
    /// Record stack traffic into [`Self::stack_log`].
    pub trace_stack: bool,
}

impl<P: PinBus> Machine<P> {
    /// Build a machine with an image loaded at hub `$0`, zero-padded to 512 KB.
    ///
    /// The boot ROM does a cog-exec `COGINIT` from hub `$0`: the first `$1F8`
    /// longs are copied into cog 0 RAM and run at cog `$000`. A flexspin
    /// image's first four longs are therefore a *cog-resident* trampoline
    /// (`cogid pa` / `augs #2` / `coginit pa, ##$404`) that immediately reloads
    /// cog 0 from the real kernel at `$404`, so the ISS needs no special case.
    pub fn new(image: &[u8], pins: P) -> Self {
        let mut hub = vec![0u8; HUB_BYTES];
        let n = image.len().min(HUB_BYTES);
        hub[..n].copy_from_slice(&image[..n]);

        let mut cogs = vec![Cog::default(); NUM_COGS];
        for i in 0..COGINIT_LOAD_LONGS {
            let a = i * 4;
            cogs[0].regs[i] = u32::from_le_bytes([hub[a], hub[a + 1], hub[a + 2], hub[a + 3]]);
        }
        cogs[0].running = true;
        cogs[0].pc = 0;

        Self {
            hub,
            cogs,
            locks: [None; NUM_LOCKS],
            lock_alloc: [false; NUM_LOCKS],
            pins,
            retired: 0,
            strict_hub: true,
            watch: None,
            watch_hits: Vec::new(),
            stack_log: Vec::new(),
            trace_stack: false,
        }
    }

    /// Watch a hub range for writes. Hits accumulate in [`Self::watch_hits`].
    pub fn watch_range(&mut self, addr: u32, len: u32) {
        self.watch = Some((addr, len));
        self.watch_hits.clear();
    }

    // ---------------------------------------------------------------- memory

    fn rd_long(&self, addr: u32) -> u32 {
        let a = (addr as usize) & (HUB_BYTES - 1) & !3;
        u32::from_le_bytes([self.hub[a], self.hub[a + 1], self.hub[a + 2], self.hub[a + 3]])
    }
    fn wr_long(&mut self, addr: u32, v: u32) {
        let a = (addr as usize) & (HUB_BYTES - 1) & !3;
        self.hub[a..a + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn rd_byte(&self, addr: u32) -> u32 {
        self.hub[(addr as usize) & (HUB_BYTES - 1)] as u32
    }
    fn wr_byte(&mut self, addr: u32, v: u32) {
        self.hub[(addr as usize) & (HUB_BYTES - 1)] = v as u8;
    }
    fn rd_word(&self, addr: u32) -> u32 {
        let a = (addr as usize) & (HUB_BYTES - 1) & !1;
        u16::from_le_bytes([self.hub[a], self.hub[a + 1]]) as u32
    }
    fn wr_word(&mut self, addr: u32, v: u32) {
        let a = (addr as usize) & (HUB_BYTES - 1) & !1;
        self.hub[a..a + 2].copy_from_slice(&(v as u16).to_le_bytes());
    }

    /// Reject a hub address outside the map when `strict_hub` is set.
    fn check_hub(&self, cog: usize, addr: u32) -> Result<(), Trap> {
        if self.strict_hub && addr as usize >= HUB_BYTES {
            return Err(Trap::HubOutOfRange {
                cog: cog as u8,
                pc: self.cogs[cog].pc,
                addr,
            });
        }
        Ok(())
    }

    /// Record a write if it overlaps the watched range.
    fn note_write(&mut self, cog: usize, addr: u32, value: u32, width: u8) {
        let Some((start, len)) = self.watch else {
            return;
        };
        // Compare on the *effective* address: hub accesses wrap to 512 KB, so a
        // wild pointer aliases onto valid memory and would otherwise slip past
        // a watch set on the address it lands at.
        let effective = addr & (HUB_BYTES as u32 - 1);
        if effective.wrapping_sub(start) < len {
            let pc = self.cogs[cog].pc;
            self.watch_hits.push(WatchHit {
                cog: cog as u8,
                pc,
                addr,
                effective,
                value,
                width,
            });
        }
    }

    fn reg(&self, cog: usize, a: u16) -> u32 {
        let idx = (a as usize) & 0x1FF;
        match idx as u16 {
            REG_INA => self.pins.ina(),
            REG_INB => self.pins.inb(),
            _ => self.cogs[cog].regs[idx],
        }
    }
    fn set_reg(&mut self, cog: usize, a: u16, v: u32) {
        let idx = (a as usize) & 0x1FF;
        self.cogs[cog].regs[idx] = v;
        if (REG_DIRA..=REG_OUTA + 1).contains(&(idx as u16)) {
            self.pins.dir_out_changed(idx as u16, v);
        }
    }

    /// Fetch the word the unified PC points at.
    fn fetch(&self, cog: usize, pc: u32) -> u32 {
        if pc < LUT_BASE {
            self.cogs[cog].regs[pc as usize]
        } else if pc < HUB_BASE {
            self.cogs[cog].lut[(pc - LUT_BASE) as usize]
        } else {
            self.rd_long(pc)
        }
    }

    fn next_pc(pc: u32) -> u32 {
        if pc < HUB_BASE {
            pc.wrapping_add(1)
        } else {
            pc.wrapping_add(4)
        }
    }

    // ---------------------------------------------------------------- timing

    /// Clock frequency the guest recorded at hub `$14`, or 0 before boot.
    ///
    /// Read on demand: the guest writes it *after* the last `HUBSET`, so
    /// sampling at `HUBSET` time always sees 0.
    pub fn clkfreq(&self) -> u32 {
        self.rd_long(0x14)
    }

    /// Virtual microseconds elapsed, derived from the busiest running cog.
    pub fn now_us(&self) -> u64 {
        let hz = match self.clkfreq() {
            0 => 160_000_000,
            f => f,
        } as u64;
        let clocks = self
            .cogs
            .iter()
            .filter(|c| c.running)
            .map(|c| c.clocks)
            .max()
            .unwrap_or(0);
        clocks * 1_000_000 / hz
    }

    /// Run every running cog until `deadline_us`, or until one traps.
    ///
    /// Round-robin in a single OS thread: no locking on hub RAM, and the
    /// interleaving is a pure function of the image, which is what makes a run
    /// bit-reproducible.
    pub fn step_until(&mut self, deadline_us: u64) -> Result<(), Trap> {
        while self.now_us() < deadline_us {
            if !self.cogs.iter().any(|c| c.running) {
                break;
            }
            for cog in 0..NUM_COGS {
                if self.cogs[cog].running {
                    self.step_one(cog)?;
                }
            }
        }
        Ok(())
    }

    /// Execute at most `n` instructions, round-robin. Returns how many ran.
    pub fn step(&mut self, n: u64) -> Result<u64, Trap> {
        let mut ran = 0;
        while ran < n {
            if !self.cogs.iter().any(|c| c.running) {
                break;
            }
            for cog in 0..NUM_COGS {
                if self.cogs[cog].running && ran < n {
                    self.step_one(cog)?;
                    ran += 1;
                }
            }
        }
        Ok(ran)
    }

    // ------------------------------------------------------------- execution

    /// Evaluate the EEEE condition field against this cog's flags.
    ///
    /// Bit `(C<<1)|Z` of EEEE selects the outcome. `%0000` never matches by
    /// that rule, which is why silicon repurposes it as the `_RET_` prefix:
    /// execute unconditionally, then return.
    fn cond_true(eeee: u8, c: bool, z: bool) -> bool {
        if eeee == 0 {
            return true;
        }
        (eeee >> (((c as u8) << 1) | z as u8)) & 1 != 0
    }

    /// S1 register forms whose word is `EEEE ooooooo 0LI ...`: bit 19 is the
    /// L (D-is-a-literal) bit, so it must never be read as WZ.
    fn l_at_bit19(form: Form) -> bool {
        matches!(
            form,
            Form::OperandLs | Form::OperandLsj | Form::OperandLsp | Form::OperandRep
        )
    }

    /// Misc-block forms whose word is `EEEE 1101011 CZL DDDDDDDDD SSSSSSSSS`:
    /// S is the sub-opcode selector, the operand is D, and **bit 18** is the L
    /// bit. Bit 19 stays a real WZ here.
    ///
    /// Getting this backwards made `setq #2` read register 2 instead of the
    /// literal, so `popregs_` block-copied 512 longs over cog RAM.
    fn l_at_bit18(form: Form) -> bool {
        matches!(
            form,
            Form::OperandL
                | Form::OperandD
                | Form::OperandDe
                | Form::OperandPinop
                | Form::OperandTestp
                | Form::OperandGetbrk
                | Form::OperandAlias
        )
    }

    /// True when this instruction's D operand is an immediate.
    fn d_is_literal(ins: &Decoded) -> bool {
        (Self::l_at_bit19(ins.form) && ins.l) || (Self::l_at_bit18(ins.form) && ins.i)
    }

    fn push_ret(&mut self, cog: usize, v: u32) {
        if self.trace_stack {
            let pc = self.cogs[cog].pc;
            self.stack_log.push((cog as u8, pc, true, v));
        }
        self.cogs[cog].push(v);
    }

    fn pop_ret(&mut self, cog: usize) -> u32 {
        let v = self.cogs[cog].pop();
        if self.trace_stack {
            let pc = self.cogs[cog].pc;
            self.stack_log.push((cog as u8, pc, false, v));
        }
        v
    }

    fn wz(&mut self, cog: usize, ins: &Decoded, result: u32) {
        if ins.z && !Self::l_at_bit19(ins.form) {
            self.cogs[cog].z = result == 0;
        }
    }

    fn step_one(&mut self, cog: usize) -> Result<(), Trap> {
        let pc = self.cogs[cog].pc;
        if pc as usize >= HUB_BYTES {
            self.cogs[cog].running = false;
            return Err(Trap::PcOutOfRange {
                cog: cog as u8,
                pc,
            });
        }
        let word = self.fetch(cog, pc);
        let np = Self::next_pc(pc);

        let Some(ins) = decode(word) else {
            self.cogs[cog].running = false;
            return Err(Trap::UndecodedWord {
                cog: cog as u8,
                pc,
                word,
            });
        };

        self.cogs[cog].clocks += CLOCKS_PER_INSTRUCTION;
        self.retired += 1;

        let (c, z) = (self.cogs[cog].c, self.cogs[cog].z);
        if !Self::cond_true(ins.cond, c, z) {
            self.cogs[cog].pc = np;
            // A skipped instruction still consumes the pending prefixes.
            self.clear_prefixes(cog, &ins);
            return Ok(());
        }

        // A pending ALTD/ALTS rewrites this instruction's field before use.
        let mut ins = ins;
        if let Some(nd) = self.cogs[cog].alt_d.take() {
            ins.d = nd;
        }
        if let Some(ns) = self.cogs[cog].alt_s.take() {
            ins.s = ns;
        }

        // AUGS/AUGD extend the 9-bit fields to 32 bits.
        let s_val = if ins.i {
            let base = ins.s as u32;
            match self.cogs[cog].aug_s.take() {
                Some(a) => a | base,
                None => base,
            }
        } else {
            self.reg(cog, ins.s)
        };
        let d_val = if Self::d_is_literal(&ins) {
            let base = ins.d as u32;
            match self.cogs[cog].aug_d.take() {
                Some(a) => a | base,
                None => base,
            }
        } else {
            self.reg(cog, ins.d)
        };

        self.cogs[cog].pc = np;
        let advanced = self.execute(cog, &ins, word, pc, s_val, d_val)?;

        self.clear_prefixes(cog, &ins);

        // `_RET_` prefix: the instruction ran, now return.
        if ins.cond == 0 && !advanced {
            let ret = self.pop_ret(cog);
            self.cogs[cog].pc = ret;
        }
        self.tick_rep(cog);
        Ok(())
    }

    /// SETQ / AUGS / AUGD modify only the instruction that immediately follows.
    ///
    /// Holding them until something consumes them lets a stale prefix leak into
    /// a later instruction — a left-over SETQ eaten by a QDIV turns a 32-bit
    /// divide into a 64-bit one with a garbage high word.
    fn clear_prefixes(&mut self, cog: usize, ins: &Decoded) {
        if !matches!(ins.op, Op::Setq | Op::Setq2) {
            self.cogs[cog].setq = None;
        }
        if !matches!(ins.op, Op::Augs) {
            self.cogs[cog].aug_s = None;
        }
        if !matches!(ins.op, Op::Augd) {
            self.cogs[cog].aug_d = None;
        }
    }

    /// Close a `REP` block if the PC just fell off its end.
    fn tick_rep(&mut self, cog: usize) {
        let Some((mut left, first, last)) = self.cogs[cog].rep else {
            return;
        };
        if self.cogs[cog].pc > last {
            if left > 1 {
                left -= 1;
                self.cogs[cog].rep = Some((left, first, last));
                self.cogs[cog].pc = first;
            } else {
                self.cogs[cog].rep = None;
            }
        }
    }

    /// Resolve a PTRA/PTRB expression in the S operand of a hub instruction.
    ///
    /// When S is immediate and bit 8 is set, S is a pointer expression
    /// `%1_S_U_P_IIIII`: bit 7 picks PTRA/PTRB, bit 6 writes the pointer back,
    /// bit 5 selects pre- vs post-modify, and the signed 5-bit index is scaled
    /// by the transfer size.
    ///
    /// Bit 5 CLEAR means PRE-modify, SET means POST — verified against the
    /// kernel: `ptra++` (post-inc) encodes S=$161 with bit 5 set, `--ptra`
    /// (pre-dec) encodes S=$15F with it clear. Inverting it stops
    /// `pushregs_`/`popregs_` mirroring.
    ///
    /// `elements` is the number of items a `SETQ` block transfer will move: a
    /// PTR expression advances by the *whole* block, not one item.
    fn ptr_operand(
        &mut self,
        cog: usize,
        ins: &Decoded,
        s: u32,
        scale: i32,
        elements: u32,
    ) -> u32 {
        if !ins.i || s & 0x100 == 0 {
            return s;
        }
        let reg = if s & 0x80 != 0 { REG_PTRB } else { REG_PTRA };
        let update = s & 0x40 != 0;
        let pre = s & 0x20 == 0;
        let idx = (((s & 0x1F) as i32) << 27 >> 27) * scale * elements as i32;

        let base = self.reg(cog, reg);
        let modified = (base as i32).wrapping_add(idx) as u32;
        let addr = if pre { modified } else { base };
        if update {
            self.set_reg(cog, reg, modified);
        }
        addr
    }

    /// Target for the `*sj` forms (`DJNZ`/`TJZ`/`CALLPA`/...).
    ///
    /// With an immediate S the 9-bit field is a SIGNED PC-relative offset in
    /// instructions, not an address — `djnz reg,#$1ED` at hub $193C8 means
    /// -19 instructions, i.e. $19380. With a register S it is absolute, which
    /// is why `callpa #n,fcache_load_ptr_` worked before this was handled.
    fn rel9_target(&self, ins: &Decoded, s: u32, pc: u32) -> u32 {
        if !ins.i {
            return s;
        }
        let off = (((s & 0x1FF) as i32) << 23) >> 23;
        let base = Self::next_pc(pc);
        let step = if base < HUB_BASE { 1 } else { 4 };
        (base as i32).wrapping_add(off * step) as u32
    }

    /// 20-bit branch target, absolute or PC-relative per the R bit.
    fn branch_target(&self, cog: usize, ins: &Decoded, word: u32, pc: u32) -> u32 {
        if ins.form == Form::OperandJmp || ins.form == Form::OperandCall {
            let relative = (word >> 20) & 1 != 0;
            let a = ins.imm & 0xF_FFFF;
            if relative {
                // The displacement is a BYTE count even when the PC is in cog
                // space, where the PC steps one per long — verified against
                // `jmp #skip_clock_set_` at cog $010, whose A=$3BC must reach
                // the `orgf 256` boundary at cog $100.
                let disp = ((a << 12) as i32) >> 12;
                let base = Self::next_pc(pc);
                if base < HUB_BASE {
                    (base as i32 + disp / 4) as u32
                } else {
                    (base as i32 + disp) as u32
                }
            } else {
                a
            }
        } else {
            self.reg(cog, ins.s)
        }
    }

    /// `COGINIT`: load `$1F8` longs from hub into the target cog and run it in
    /// cog-exec at `$000`, with PTRA from the preceding `SETQ` and PTRB = the
    /// source address.
    ///
    /// Every MaD cog runs the same kernel and branches on PTRA, so this one
    /// path serves both the boot trampoline and all seven workers.
    fn coginit(&mut self, cog: usize, ins: &Decoded, pc: u32, s: u32, d: u32) -> Result<(), Trap> {
        let ptra = self.cogs[cog].setq.take().unwrap_or(0);
        let want_free = d & 0x10 != 0;
        let hubexec = d & 0x20 != 0;

        let target = if want_free {
            match (0..NUM_COGS).find(|&i| !self.cogs[i].running) {
                Some(i) => i,
                None => return Err(Trap::NoFreeCog { cog: cog as u8, pc }),
            }
        } else {
            (d & 7) as usize
        };

        let mut fresh = Cog::default();
        if hubexec {
            fresh.pc = s;
        } else {
            for i in 0..COGINIT_LOAD_LONGS {
                fresh.regs[i] = self.rd_long(s.wrapping_add((i * 4) as u32));
            }
            fresh.pc = 0;
        }
        fresh.regs[REG_PTRA as usize] = ptra;
        fresh.regs[REG_PTRB as usize] = s;
        fresh.running = true;
        fresh.clocks = self.cogs[cog].clocks;
        self.cogs[target] = fresh;

        // C reports FAILURE on the P2 (flexspin emits `if_b neg result1,#1`
        // after COGINIT WC) -- note spinsim disagrees.
        if ins.c {
            self.cogs[cog].c = false;
        }
        Ok(())
    }

    /// Returns `true` if the instruction set the PC itself.
    fn execute(
        &mut self,
        cog: usize,
        ins: &Decoded,
        word: u32,
        pc: u32,
        s: u32,
        d: u32,
    ) -> Result<bool, Trap> {
        use Op::*;
        let mut branched = false;

        match ins.op {
            Nop => {}

            // ---- moves and logic
            Mov => {
                self.set_reg(cog, ins.d, s);
                self.wz(cog, ins, s);
                if ins.c {
                    self.cogs[cog].c = s >> 31 != 0;
                }
            }
            Not => {
                let r = !s;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = r >> 31 != 0;
                }
            }
            Abs => {
                let r = (s as i32).unsigned_abs();
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                // C reports the sign of the *input*.
                if ins.c {
                    self.cogs[cog].c = s >> 31 != 0;
                }
            }
            Neg => {
                let r = (s as i32).wrapping_neg() as u32;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = r >> 31 != 0;
                }
            }
            And => {
                let r = d & s;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Andn => {
                let r = d & !s;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Or => {
                let r = d | s;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Xor => {
                let r = d ^ s;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Test => {
                let r = d & s;
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = r.count_ones() & 1 != 0;
                }
            }

            // ---- arithmetic
            Add | Adds => {
                let (r, carry) = d.overflowing_add(s);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = carry;
                }
            }
            Sub | Subs => {
                let (r, borrow) = d.overflowing_sub(s);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = borrow;
                }
            }
            Subr => {
                let r = s.wrapping_sub(d);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Addx | Addsx => {
                let cin = self.cogs[cog].c as u32;
                let (t, c1) = d.overflowing_add(s);
                let (r, c2) = t.overflowing_add(cin);
                self.set_reg(cog, ins.d, r);
                if ins.z {
                    self.cogs[cog].z = self.cogs[cog].z && r == 0;
                }
                if ins.c {
                    self.cogs[cog].c = c1 || c2;
                }
            }
            Subx | Subsx => {
                let cin = self.cogs[cog].c as u32;
                let (t, b1) = d.overflowing_sub(s);
                let (r, b2) = t.overflowing_sub(cin);
                self.set_reg(cog, ins.d, r);
                if ins.z {
                    self.cogs[cog].z = self.cogs[cog].z && r == 0;
                }
                if ins.c {
                    self.cogs[cog].c = b1 || b2;
                }
            }
            Cmp => {
                let (r, borrow) = d.overflowing_sub(s);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = borrow;
                }
            }
            Cmps => {
                let r = (d as i32).wrapping_sub(s as i32);
                self.wz(cog, ins, r as u32);
                if ins.c {
                    self.cogs[cog].c = (d as i32) < (s as i32);
                }
            }
            Cmpx => {
                let cin = self.cogs[cog].c as u32;
                let (tv, b1) = d.overflowing_sub(s);
                let (r, b2) = tv.overflowing_sub(cin);
                if ins.z {
                    self.cogs[cog].z = self.cogs[cog].z && r == 0;
                }
                if ins.c {
                    self.cogs[cog].c = b1 || b2;
                }
            }
            Cmpsx => {
                let cin = self.cogs[cog].c as i64;
                let full = (d as i32 as i64) - (s as i32 as i64) - cin;
                if ins.z {
                    self.cogs[cog].z = self.cogs[cog].z && full as u32 == 0;
                }
                if ins.c {
                    self.cogs[cog].c = full < 0;
                }
            }
            Sumc | Sumnc | Sumz | Sumnz => {
                let take = match ins.op {
                    Sumc => self.cogs[cog].c,
                    Sumnc => !self.cogs[cog].c,
                    Sumz => self.cogs[cog].z,
                    _ => !self.cogs[cog].z,
                };
                let r = if take { d.wrapping_sub(s) } else { d.wrapping_add(s) };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Negc | Negnc | Negz | Negnz => {
                let take = match ins.op {
                    Negc => self.cogs[cog].c,
                    Negnc => !self.cogs[cog].c,
                    Negz => self.cogs[cog].z,
                    _ => !self.cogs[cog].z,
                };
                let r = if take { (s as i32).wrapping_neg() as u32 } else { s };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = r >> 31 != 0;
                }
            }

            // ---- shifts and bit twiddling
            // Shifts set C to the LAST BIT SHIFTED OUT, which is what
            // soft-float rounding reads. Leaving C untouched here makes every
            // float the firmware formats come out wrong while the integer
            // program behaves perfectly -- the timestamp bug.
            Shl | Rol => {
                let n = s & 31;
                let r = if ins.op == Shl {
                    d.wrapping_shl(n)
                } else {
                    d.rotate_left(n)
                };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    let probe = if n == 0 { d } else { d.wrapping_shl(n - 1) };
                    self.cogs[cog].c = probe >> 31 != 0;
                }
            }
            Shr | Ror => {
                let n = s & 31;
                let r = if ins.op == Shr {
                    d.wrapping_shr(n)
                } else {
                    d.rotate_right(n)
                };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    let probe = if n == 0 { d } else { d.wrapping_shr(n - 1) };
                    self.cogs[cog].c = probe & 1 != 0;
                }
            }
            Sar => {
                let n = s & 31;
                let r = ((d as i32) >> n) as u32;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    let probe = if n == 0 { d as i32 } else { (d as i32) >> (n - 1) };
                    self.cogs[cog].c = probe & 1 != 0;
                }
            }
            Zerox => {
                let bit = s & 31;
                let r = if bit == 31 { d } else { d & ((1u32 << (bit + 1)) - 1) };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Signx => {
                let sh = 31 - (s & 31);
                let r = (((d << sh) as i32) >> sh) as u32;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Decod => {
                let r = 1u32 << (s & 31);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Encod => {
                // Bit position of the top-most 1; C reports S != 0.
                let r = 31u32.saturating_sub(s.leading_zeros().min(31));
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = s != 0;
                }
            }
            Bmask => {
                let bit = s & 31;
                let r = if bit == 31 { u32::MAX } else { (1u32 << (bit + 1)) - 1 };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Ones => {
                let r = s.count_ones();
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Getbyte => {
                let r = (d >> ((s & 3) * 8)) & 0xFF;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Getword => {
                let r = (d >> ((s & 1) * 16)) & 0xFFFF;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Getnib => {
                let r = (d >> ((s & 7) * 4)) & 0xF;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Setbyte => {
                let n = (s & 3) * 8;
                let r = (d & !(0xFFu32 << n)) | ((s & 0xFF) << n);
                self.set_reg(cog, ins.d, r);
            }
            Setword => {
                let n = (s & 1) * 16;
                let r = (d & !(0xFFFFu32 << n)) | ((s & 0xFFFF) << n);
                self.set_reg(cog, ins.d, r);
            }
            Movbyts => {
                let b = d.to_le_bytes();
                let r = u32::from_le_bytes([
                    b[(s & 3) as usize],
                    b[((s >> 2) & 3) as usize],
                    b[((s >> 4) & 3) as usize],
                    b[((s >> 6) & 3) as usize],
                ]);
                self.set_reg(cog, ins.d, r);
            }
            Rev => {
                let r = d.reverse_bits();
                self.set_reg(cog, ins.d, r);
            }
            Fle => {
                let r = if d > s { s } else { d };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Fges => {
                let r = if (d as i32) < (s as i32) { s } else { d };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Fles => {
                let r = if (d as i32) > (s as i32) { s } else { d };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Muxc => {
                let m = if self.cogs[cog].c { u32::MAX } else { 0 };
                let r = (d & !s) | (m & s);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = r.count_ones() & 1 != 0;
                }
            }
            Bith | Bitl | Bitnot => {
                let bit = 1u32 << (s & 31);
                let r = match ins.op {
                    Bith => d | bit,
                    Bitl => d & !bit,
                    _ => d ^ bit,
                };
                self.set_reg(cog, ins.d, r);
            }
            Testb | Testbn => {
                let set = (d >> (s & 31)) & 1 != 0;
                let v = if ins.op == Testb { set } else { !set };
                if ins.c {
                    self.cogs[cog].c = v;
                }
                if ins.z {
                    self.cogs[cog].z = v;
                }
            }
            Wrz => {
                let v = self.cogs[cog].z as u32;
                self.set_reg(cog, ins.d, v);
            }
            Wrnz => {
                let v = !self.cogs[cog].z as u32;
                self.set_reg(cog, ins.d, v);
            }
            Wrc => {
                let v = self.cogs[cog].c as u32;
                self.set_reg(cog, ins.d, v);
            }

            // ---- hub memory
            Rdlong | Rdbyte | Rdword => {
                let scale = match ins.op {
                    Rdlong => 4,
                    Rdword => 2,
                    _ => 1,
                };
                let elements = match (ins.op, self.cogs[cog].setq) {
                    (Rdlong, Some(count)) => count.min(COG_LONGS as u32 - 1) + 1,
                    _ => 1,
                };
                let s = self.ptr_operand(cog, ins, s, scale, elements);
                self.cogs[cog].clocks += CLOCKS_HUB_ACCESS;
                if ins.op == Rdlong {
                    if let Some(count) = self.cogs[cog].setq.take() {
                        // A block transfer cannot exceed the register file.
                        let n = count.min(COG_LONGS as u32 - 1);
                        self.check_hub(cog, s)?;
                        for k in 0..=n {
                            let v = self.rd_long(s.wrapping_add(k.wrapping_mul(4)));
                            self.set_reg(cog, ins.d.wrapping_add(k as u16), v);
                        }
                        return Ok(false);
                    }
                }
                self.check_hub(cog, s)?;
                let v = match ins.op {
                    Rdlong => self.rd_long(s),
                    Rdbyte => self.rd_byte(s),
                    _ => self.rd_word(s),
                };
                self.set_reg(cog, ins.d, v);
                self.wz(cog, ins, v);
            }
            Wrlong | Wrbyte | Wrword => {
                let scale = match ins.op {
                    Wrlong => 4,
                    Wrword => 2,
                    _ => 1,
                };
                let elements = match (ins.op, self.cogs[cog].setq) {
                    (Wrlong, Some(count)) => count.min(COG_LONGS as u32 - 1) + 1,
                    _ => 1,
                };
                let s = self.ptr_operand(cog, ins, s, scale, elements);
                self.cogs[cog].clocks += CLOCKS_HUB_ACCESS;
                if ins.op == Wrlong {
                    if let Some(count) = self.cogs[cog].setq.take() {
                        let n = count.min(COG_LONGS as u32 - 1);
                        self.check_hub(cog, s)?;
                        for k in 0..=n {
                            let v = self.reg(cog, ins.d.wrapping_add(k as u16));
                            let a = s.wrapping_add(k.wrapping_mul(4));
                            self.note_write(cog, a, v, 4);
                            self.wr_long(a, v);
                        }
                        return Ok(false);
                    }
                }
                self.check_hub(cog, s)?;
                match ins.op {
                    Wrlong => {
                        self.note_write(cog, s, d, 4);
                        self.wr_long(s, d)
                    }
                    Wrbyte => {
                        self.note_write(cog, s, d, 1);
                        self.wr_byte(s, d)
                    }
                    _ => {
                        self.note_write(cog, s, d, 2);
                        self.wr_word(s, d)
                    }
                }
            }

            // ---- hub write FIFO
            //
            // `WRFAST`/`WFLONG` appear only inside `builtin_longfill_`. Modelled
            // as a plain write cursor with no FIFO depth: a partial depth model
            // would be worse than none, and `RDFAST`/`RF*` are absent and trap.
            Wrfast => {
                self.cogs[cog].fifo = s;
            }
            Wflong => {
                let addr = self.cogs[cog].fifo;
                self.note_write(cog, addr, d, 4);
                self.wr_long(addr, d);
                self.cogs[cog].fifo = addr.wrapping_add(4);
            }

            // ---- prefixes
            Augs => {
                self.cogs[cog].aug_s = Some(ins.imm << 9);
            }
            Augd => {
                self.cogs[cog].aug_d = Some(ins.imm << 9);
            }
            Setq | Setq2 => {
                // The operand is D; S holds the sub-opcode selector ($28).
                self.cogs[cog].setq = Some(d);
            }

            // ---- field substitution
            Altd | Alts => {
                // The S operand is two fields, not one addend:
                //   S[8:0]   offset added to D to form the next instruction's
                //            substituted D (ALTD) or S (ALTS) field;
                //   S[17:9]  a SIGNED increment written back to the D register.
                //
                // flexspin's FCACHE relies on the second half: its `ret_instr_`
                // (`_ret_ cmp inb,#0` = $0207FE00) is chosen so that as ALTD's S
                // it offsets by 0 *and post-decrements PA* -- its own source
                // calls it "a return instruction that also works as an ALTD
                // post-decrement" (backends/asm/outasm.c:6213). Without the
                // writeback the following `setq pa` loads one long too many and
                // overwrites the terminator ALTD just placed.
                //
                // spinsim implements only the substitution (ss_pasmsim2.c:2344),
                // so it agrees on the field and is silent on the writeback.
                let field = (d.wrapping_add(s) & 0x1FF) as u16;
                if ins.op == Altd {
                    self.cogs[cog].alt_d = Some(field);
                } else {
                    self.cogs[cog].alt_s = Some(field);
                }
                let inc = ((((s >> 9) & 0x1FF) as i32) << 23) >> 23;
                if inc != 0 && !Self::d_is_literal(ins) {
                    let updated = (d as i32).wrapping_add(inc) as u32;
                    self.set_reg(cog, ins.d, updated);
                }
            }

            // ---- control flow
            Jmp => {
                // Two encodings share the mnemonic: the 20-bit branch form and
                // the register-indirect misc-block form, which carries D.
                self.cogs[cog].pc = if ins.form == Form::OperandJmp {
                    self.branch_target(cog, ins, word, pc)
                } else {
                    d
                };
                branched = true;
            }
            Call => {
                let ret = Self::next_pc(pc);
                self.push_ret(cog, ret);
                self.cogs[cog].pc = if ins.form == Form::OperandCall {
                    self.branch_target(cog, ins, word, pc)
                } else {
                    d
                };
                branched = true;
            }
            Ret => {
                let r = self.pop_ret(cog);
                self.cogs[cog].pc = r;
                branched = true;
            }
            Callpa | Callpb => {
                let reg = if ins.op == Callpa { REG_PA } else { REG_PB };
                self.set_reg(cog, reg, d);
                let ret = Self::next_pc(pc);
                self.push_ret(cog, ret);
                self.cogs[cog].pc = self.rel9_target(ins, s, pc);
                branched = true;
            }
            Jmprel => {
                let base = self.cogs[cog].pc;
                let step = if base < HUB_BASE { 1 } else { 4 };
                self.cogs[cog].pc = (base as i32 + d as i32 * step) as u32;
                branched = true;
            }
            Djnz => {
                let r = d.wrapping_sub(1);
                self.set_reg(cog, ins.d, r);
                if r != 0 {
                    self.cogs[cog].pc = self.rel9_target(ins, s, pc);
                    branched = true;
                }
            }
            Djz => {
                let r = d.wrapping_sub(1);
                self.set_reg(cog, ins.d, r);
                if r == 0 {
                    self.cogs[cog].pc = self.rel9_target(ins, s, pc);
                    branched = true;
                }
            }
            Djf => {
                let r = d.wrapping_sub(1);
                self.set_reg(cog, ins.d, r);
                if r == u32::MAX {
                    self.cogs[cog].pc = self.rel9_target(ins, s, pc);
                    branched = true;
                }
            }
            Tjz => {
                if d == 0 {
                    self.cogs[cog].pc = self.rel9_target(ins, s, pc);
                    branched = true;
                }
            }
            Tjnz => {
                if d != 0 {
                    self.cogs[cog].pc = self.rel9_target(ins, s, pc);
                    branched = true;
                }
            }
            Push => {
                self.push_ret(cog, d);
            }
            Pop => {
                let v = self.pop_ret(cog);
                self.set_reg(cog, ins.d, v);
                self.wz(cog, ins, v);
            }
            Rep => {
                let count = d;
                let len = s;
                if count == 0 || len == 0 {
                    self.cogs[cog].rep = None;
                } else {
                    let first = self.cogs[cog].pc;
                    let step = if first < HUB_BASE { 1 } else { 4 };
                    let last = first + (len - 1) * step;
                    self.cogs[cog].rep = Some((count, first, last));
                }
            }

            // ---- CORDIC, as plain functions
            Qmul => {
                let p = (d as u64) * (s as u64);
                self.cogs[cog].qx = p as u32;
                self.cogs[cog].qy = (p >> 32) as u32;
            }
            Qdiv => {
                // A preceding SETQ supplies the upper 32 bits of a 64-bit
                // dividend -- `_getus` divides the full cycle count this way.
                let hi = self.cogs[cog].setq.take().unwrap_or(0) as u64;
                let dividend = (hi << 32) | d as u64;
                if s == 0 {
                    self.cogs[cog].qx = u32::MAX;
                    self.cogs[cog].qy = 0;
                } else {
                    let q = dividend / s as u64;
                    self.cogs[cog].qx = if q > u32::MAX as u64 { u32::MAX } else { q as u32 };
                    self.cogs[cog].qy = (dividend % s as u64) as u32;
                }
            }
            Qsqrt => {
                self.cogs[cog].qx = (d as f64).sqrt() as u32;
            }
            Qrotate => {
                let theta = (s as f64) * std::f64::consts::TAU / 4_294_967_296.0;
                self.cogs[cog].qx = ((d as f64) * theta.cos()) as i32 as u32;
                self.cogs[cog].qy = ((d as f64) * theta.sin()) as i32 as u32;
            }
            Getqx => {
                let v = self.cogs[cog].qx;
                self.set_reg(cog, ins.d, v);
                self.wz(cog, ins, v);
            }
            Getqy => {
                let v = self.cogs[cog].qy;
                self.set_reg(cog, ins.d, v);
                self.wz(cog, ins, v);
            }

            // ---- cogs
            Cogid => {
                self.set_reg(cog, ins.d, cog as u32);
                if ins.c {
                    self.cogs[cog].c = false;
                }
            }
            Cogstop => {
                let target = (d & 7) as usize;
                self.cogs[target].running = false;
                if target == cog {
                    return Ok(true);
                }
            }
            Coginit => {
                self.coginit(cog, ins, pc, s, d)?;
            }

            // ---- locks
            Locknew => {
                match self.lock_alloc.iter().position(|a| !a) {
                    Some(i) => {
                        self.lock_alloc[i] = true;
                        self.set_reg(cog, ins.d, i as u32);
                        if ins.c {
                            self.cogs[cog].c = false;
                        }
                    }
                    None => {
                        self.set_reg(cog, ins.d, 0);
                        if ins.c {
                            self.cogs[cog].c = true;
                        }
                    }
                }
            }
            Lockret => {
                let id = (d & 15) as usize;
                self.lock_alloc[id] = false;
                self.locks[id] = None;
            }
            Locktry => {
                let id = (d & 15) as usize;
                let got = match self.locks[id] {
                    None => {
                        self.locks[id] = Some(cog as u8);
                        true
                    }
                    Some(owner) => owner == cog as u8,
                };
                if ins.c {
                    self.cogs[cog].c = got;
                }
            }
            Lockrel => {
                let id = (d & 15) as usize;
                if self.locks[id] == Some(cog as u8) {
                    self.locks[id] = None;
                }
                if ins.c {
                    self.cogs[cog].c = false;
                }
            }

            // ---- time
            Getct => {
                // WC selects the HIGH half of the 64-bit cycle counter.
                // `__system___getus` reads `getct x wc` then `getct y` to
                // assemble a 64-bit time.
                let ct = self.cogs[cog].clocks;
                let v = if ins.c { (ct >> 32) as u32 } else { ct as u32 };
                self.set_reg(cog, ins.d, v);
            }
            Addct1 => {
                self.cogs[cog].ct1 = d.wrapping_add(s);
            }
            Waitct1 => {
                let target = self.cogs[cog].ct1;
                let now = self.cogs[cog].clocks as u32;
                let delta = target.wrapping_sub(now);
                if (delta as i32) > 0 {
                    self.cogs[cog].clocks += delta as u64;
                }
            }
            Waitx => {
                // The cog is not executing during a wait: jump the clock
                // instead of spinning, which is exactly what an ISS can do and
                // a HAL-charged native backend cannot.
                self.cogs[cog].clocks += d as u64;
            }
            Hubset => {
                // Clock modes are recorded and the PLL ignored; `clkfreq()`
                // reads hub $14 on demand instead.
            }

            // ---- pins
            Wrpin => self.pins.wrpin((s & 63) as u8, d),
            Wxpin => self.pins.wxpin((s & 63) as u8, d),
            Wypin => self.pins.wypin((s & 63) as u8, d),
            Rdpin | Rqpin => {
                let (v, busy) = self.pins.rdpin((s & 63) as u8);
                self.set_reg(cog, ins.d, v);
                if ins.c {
                    self.cogs[cog].c = busy;
                }
            }
            Akpin => self.pins.akpin((s & 63) as u8),
            Testp => {
                let v = self.pins.testp((d & 63) as u8);
                if ins.c {
                    self.cogs[cog].c = v;
                }
                if ins.z {
                    self.cogs[cog].z = v;
                }
            }
            Dirl | Dirh | Drvl | Drvh | Fltl | Flth | Outl | Outh => {
                let pin = (d & 63) as u8;
                let bit = 1u32 << (pin & 31);
                let (dreg, oreg) = if pin < 32 {
                    (REG_DIRA, REG_OUTA)
                } else {
                    (REG_DIRA + 1, REG_OUTA + 1)
                };
                let (mut dir, mut out) = (self.reg(cog, dreg), self.reg(cog, oreg));
                match ins.op {
                    Dirl => dir &= !bit,
                    Dirh => dir |= bit,
                    Fltl => {
                        dir &= !bit;
                        out &= !bit;
                    }
                    Flth => {
                        dir &= !bit;
                        out |= bit;
                    }
                    Drvl => {
                        dir |= bit;
                        out &= !bit;
                    }
                    Drvh => {
                        dir |= bit;
                        out |= bit;
                    }
                    Outl => out &= !bit,
                    _ => out |= bit,
                }
                self.set_reg(cog, dreg, dir);
                self.set_reg(cog, oreg, out);
            }

            _ => {
                self.cogs[cog].running = false;
                return Err(Trap::Unimplemented {
                    cog: cog as u8,
                    pc,
                    word,
                    mnemonic: ins.op.mnemonic(),
                });
            }
        }

        Ok(branched)
    }
}
