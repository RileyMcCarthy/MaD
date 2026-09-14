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
pub mod flash;
pub mod generated;
pub mod model;
pub mod pins;
pub mod probe;
pub mod sdcard;
pub mod smartbus;
pub mod smartpin;
pub mod spi;
pub mod trap;

pub use board::Board;
pub use flash::SpiFlash;
pub use generated::decode::{decode, Decoded, Form, Op};
pub use model::SmartPins;
pub use pins::{NullPins, PinBus};
pub use probe::{
    is_probe_safe, op_bucket, probe_encodings, probe_grid_ops, probe_skip_reason, OpBucket,
    ProbeEncoding,
};
pub use sdcard::SdCard;
pub use smartbus::SmartBus;
pub use smartpin::{baud_matches, PinMode, SmartPin};
pub use spi::SpiShift;
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
    /// Instructions this cog has executed (throughput accounting).
    pub instructions: u64,
    /// Idle-poll detection — see [`Machine::note_loop_edge`].
    poll: PollState,
    /// Hub FIFO pointer, shared by the read and write directions.
    ///
    /// The silicon FIFO is a 19-stage prefetch machine; what code depends on
    /// is only its *addressing*: `WRFAST`/`RDFAST` set a hub byte address and
    /// each `WF*`/`RF*` moves it by the access size. The boot ROM builds its
    /// base64 table and loads the application through it.
    pub fifo_addr: u32,
    /// The 8-level hardware call stack (a ring on silicon too).
    pub stack: [u32; 8],
    pub sp: usize,
    pub running: bool,
    /// `SKIP` pattern still to be applied, LSB first: a 1 cancels the
    /// instruction at that position. Shifted right once per instruction.
    skip_pattern: u32,
    /// How many of the 32 patterned instructions remain.
    skip_left: u8,
    /// Pending `AUGS`/`AUGD` prefix, consumed by the next instruction.
    aug_s: Option<u32>,
    /// Whether the instruction now executing had an `AUGS` prefix. On silicon
    /// an augmented S is a full literal: the `PTRA`/`PTRB` expression encoding
    /// (bit 8 of a bare 9-bit immediate) does NOT apply. Without this flag,
    /// `rdlong reg, ##addr` for any address with bit 8 set silently turns
    /// into a pointer-indexed access — the boot ROM's own self-load reads
    /// from the wrong place and the cog executes its constant pool.
    aug_s_active: bool,
    aug_d: Option<u32>,
    /// Pending `SETQ`/`SETQ2` value, consumed by the next instruction.
    setq: Option<u32>,
    /// A pending `SETQ2` — the LUT-destination block prefix.
    setq2: Option<u32>,
    /// `REP` block: (remaining iterations, first pc, last pc).
    rep: Option<(u32, u32, u32)>,
    /// CORDIC results, filled by QMUL/QDIV/... and read by GETQX/GETQY.
    qx: u32,
    qy: u32,
    /// Hub write-FIFO cursor for `WRFAST`/`WFLONG`.
    /// `ADDCT1` target for `WAITCT1`.
    ct1: u32,
    /// Pending `ALTD`/`ALTS` field substitution for the next instruction.
    alt_d: Option<u16>,
    alt_s: Option<u16>,
    /// Guest clocks this cog has retired.
    pub clocks: u64,
}

/// Per-cog bookkeeping for **idle-poll fast-forward**.
///
/// A cog that spins in a short loop — `testp / jmp`, a `locktry` retry, a
/// `getct` busy-wait — is free on silicon and 95% of an interpreter's budget
/// here. An iteration of such a loop is *identical* to the last unless
/// something outside the loop changes, and nothing outside it can change
/// until another cog runs or the net engine wakes. So once a loop has closed
/// twice with no side effects and no state carried across the back-edge, the
/// cog's clock is advanced to the next instant anything can differ (see
/// [`Machine::fast_forward_poller`]) and the skipped iterations are never
/// executed. What makes this exact rather than a heuristic:
///
/// - **side effects** — any hub/pin/lock/smart-pin write in the iteration
///   disqualifies it (the PURE set below is a whitelist);
/// - **loop-carried state** — a register or flag *read before it is written*
///   in an iteration, having been written in the previous one, means the
///   iterations differ (`djnz`-bounded polls keep their count; a `getct`
///   temp does not carry).
#[derive(Debug, Default, Clone, Copy)]
struct PollState {
    /// Where the current candidate loop starts (target of the last back-edge).
    loop_pc: Option<u32>,
    /// Pure, non-carrying iterations closed in a row.
    iters: u32,
    /// Registers written so far this iteration / during the previous one.
    written: [u64; 8],
    written_prev: [u64; 8],
    flags_written: bool,
    flags_written_prev: bool,
    /// Disqualifiers observed this iteration.
    carried: bool,
    side_effect: bool,
    /// This iteration read an *external* input — a pin. Only the peripheral's
    /// own schedule decides when that changes, and this model cannot see it
    /// from inside the CPU, so the loop must not be fast-forwarded.
    external: bool,
}

impl PollState {
    #[inline]
    fn mark_write(&mut self, reg: u16) {
        let r = usize::from(reg & 0x1FF);
        self.written[r >> 6] |= 1u64 << (r & 63);
    }
    #[inline]
    fn note_read(&mut self, reg: u16) {
        let r = usize::from(reg & 0x1FF);
        let bit = 1u64 << (r & 63);
        if self.written[r >> 6] & bit == 0 && self.written_prev[r >> 6] & bit != 0 {
            self.carried = true;
        }
    }
    /// Confirmed idle-polling: two identical, side-effect-free iterations.
    fn confirmed(&self) -> bool {
        self.iters >= 2
    }
    fn reset(&mut self) {
        *self = PollState::default();
    }
}

impl Default for Cog {
    fn default() -> Self {
        Self {
            fifo_addr: 0,
            instructions: 0,
            skip_pattern: 0,
            skip_left: 0,
            poll: PollState::default(),
            regs: [0; COG_LONGS],
            lut: [0; LUT_LONGS],
            pc: 0,
            c: false,
            z: false,
            stack: [0; 8],
            sp: 0,
            running: false,
            aug_s: None,
            aug_s_active: false,
            aug_d: None,
            setq: None,
            setq2: None,
            rep: None,
            qx: 0,
            qy: 0,
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
    /// **Off by default, and not a soundness check.** Silicon masks hub
    /// addresses to the 512 KB map, and the firmware relies on it: FlexC builds
    /// tagged pointers with an `augs`/`or` pair (e.g. `$0004B8A0 | $02D00000`)
    /// and lets the hardware ignore the tag. Enabling this flags those as
    /// out-of-range, which is a false positive.
    ///
    /// It remains useful during bring-up on code known not to tag pointers,
    /// where a genuinely wild address would otherwise alias onto live memory
    /// and corrupt something far from the culprit.
    pub strict_hub: bool,
    /// Upper bound for an idle-poll fast-forward: the current `step_until`
    /// deadline in clocks (`u64::MAX` when stepping by count).
    ff_deadline_clocks: u64,
    /// Idle-poll fast-forward off (`P2CORE_NO_FF`) — for A/B and safety.
    ff_disabled: bool,
    /// Optional hub write watchpoint: `(start, len)`.
    pub watch: Option<(u32, u32)>,
    /// Writes that landed in the watched range, oldest first.
    pub watch_hits: Vec<WatchHit>,
    /// Optional register watchpoint: record every write of any value to this
    /// cog register. Registers are where corrupted pointers first appear, and
    /// a hub watchpoint cannot see them.
    pub reg_watch: Option<u16>,
    /// Writes seen by [`Self::reg_watch`]: `(pc, value)`.
    pub reg_hits: Vec<(u32, u32)>,
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
    /// Boot the way silicon does: nothing in hub but the ROM.
    ///
    /// Real power-on loads the 16 KB boot ROM into the **top** of hub RAM and
    /// starts COG 0 executing from hub at `$FC000` — which, with 512 KB of
    /// RAM and wrap-around addressing, is the same bytes at `$7C000`. The
    /// application arrives later, over a wire: the ROM samples pull-ups on
    /// P59/P60/P61 to pick serial, SPI flash or SD, loads from there,
    /// verifies, and launches. [`Machine::new`] skips all of that by
    /// construction; this constructor exists so the skipped part can be
    /// executed and tested like everything else.
    pub fn with_boot_rom(rom: &[u8], pins: P) -> Self {
        let mut m = Self::new(&[], pins);
        m.hub.iter_mut().for_each(|b| *b = 0);
        let top = HUB_BYTES - (16 * 1024);
        let n = rom.len().min(16 * 1024);
        m.hub[top..top + n].copy_from_slice(&rom[..n]);
        for cog in m.cogs.iter_mut() {
            *cog = Default::default();
        }
        // COG 0 boots the way every coginit does: its 512 registers loaded
        // from the target — here the base of the ROM — and execution from cog
        // address 0. Getting this wrong is instructive: launched in hub-exec
        // at `$FC000` instead, the ROM *almost* works, because most of its
        // preamble is position-independent — right up until the first
        // `callpa #pin,#check_pullup`, whose 9-bit relative offset is counted
        // in cog longs. From hub the same encoding lands ~$3B4 bytes ahead
        // into unrelated code, the pull-up sampling never runs, and the boot
        // walks into the serial path with garbage timing.
        for i in 0..COG_LONGS {
            let a = top + i * 4;
            m.cogs[0].regs[i] =
                u32::from_le_bytes([m.hub[a], m.hub[a + 1], m.hub[a + 2], m.hub[a + 3]]);
        }
        m.cogs[0].running = true;
        m.cogs[0].pc = 0;
        m
    }

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
            strict_hub: false,
            ff_deadline_clocks: u64::MAX,
            ff_disabled: std::env::var_os("P2CORE_NO_FF").is_some(),
            watch: None,
            watch_hits: Vec::new(),
            reg_watch: None,
            reg_hits: Vec::new(),
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

    /// Hub reads and writes are UNALIGNED-capable on the P2.
    ///
    /// `sdmm.cc`'s `send_cmd` builds its command frame with
    /// `*(DWORD*)(buf+1) = __builtin_bswap32(arg)` — a 32-bit store at an odd
    /// offset. Masking the address to a long boundary silently redirects that
    /// onto `buf[0..3]` and wipes the `0x40` start token, so every command
    /// frame leaves with a zero command index.
    fn rd_long(&self, addr: u32) -> u32 {
        let a = addr as usize;
        u32::from_le_bytes([
            self.hub_byte(a),
            self.hub_byte(a + 1),
            self.hub_byte(a + 2),
            self.hub_byte(a + 3),
        ])
    }
    fn wr_long(&mut self, addr: u32, v: u32) {
        for (i, b) in v.to_le_bytes().iter().enumerate() {
            self.set_hub_byte(addr as usize + i, *b);
        }
    }

    #[inline]
    fn hub_byte(&self, a: usize) -> u8 {
        self.hub[a & (HUB_BYTES - 1)]
    }
    #[inline]
    fn set_hub_byte(&mut self, a: usize, b: u8) {
        self.hub[a & (HUB_BYTES - 1)] = b;
    }
    fn rd_byte(&self, addr: u32) -> u32 {
        self.hub[(addr as usize) & (HUB_BYTES - 1)] as u32
    }
    fn wr_byte(&mut self, addr: u32, v: u32) {
        self.hub[(addr as usize) & (HUB_BYTES - 1)] = v as u8;
    }
    fn rd_word(&self, addr: u32) -> u32 {
        let a = addr as usize;
        u16::from_le_bytes([self.hub_byte(a), self.hub_byte(a + 1)]) as u32
    }
    fn wr_word(&mut self, addr: u32, v: u32) {
        for (i, b) in (v as u16).to_le_bytes().iter().enumerate() {
            self.set_hub_byte(addr as usize + i, *b);
        }
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
        if self.reg_watch == Some(idx as u16) {
            let pc = self.cogs[cog].pc;
            self.reg_hits.push((pc, v));
        }
        self.cogs[cog].regs[idx] = v;
        self.cogs[cog].poll.mark_write(idx as u16);
        if (REG_DIRA..=REG_OUTA + 1).contains(&(idx as u16)) {
            self.pins.dir_out_changed(cog, idx as u16, v);
        }
    }

    /// Ops with no effect outside the cog's own registers and flags: reads,
    /// arithmetic, control flow, pin *tests*, `locktry` (a failed try changes
    /// nothing), `waitx` (time only). Everything else is a side effect.
    fn is_pure(op: Op) -> bool {
        use Op::*;
        matches!(
            op,
            Rdlong
                | Rdbyte
                | Rdword
                | Rdlut
                | Testp
                | Testpn
                | Getct
                | Cmp
                | Cmps
                | Cmpr
                | Cmpm
                | Cmpx
                | Cmpsx
                | Test
                | Testn
                | Testb
                | Testbn
                | Jmp
                | Jmprel
                | Tjz
                | Tjnz
                | Tjf
                | Tjnf
                | Tjs
                | Tjns
                | Tjv
                | Djz
                | Djnz
                | Djf
                | Djnf
                | Call
                | Ret
                | Callpa
                | Callpb
                | Mov
                | Add
                | Adds
                | Addx
                | Addsx
                | Sub
                | Subs
                | Subx
                | Subsx
                | Subr
                | And
                | Andn
                | Or
                | Xor
                | Not
                | Neg
                | Abs
                | Shl
                | Shr
                | Sar
                | Sal
                | Rol
                | Ror
                | Rcl
                | Rcr
                | Zerox
                | Signx
                | Encod
                | Decod
                | Bith
                | Bitl
                | Bitnot
                | Bitc
                | Bitnc
                | Bitz
                | Bitnz
                | Getbyte
                | Setbyte
                | Getword
                | Setword
                | Getnib
                | Setnib
                | Rev
                | Muxc
                | Muxnc
                | Muxz
                | Muxnz
                | Mul
                | Muls
                | Sca
                | Scas
                | Ones
                | Nop
                | Augs
                | Augd
                | Setq
                | Setq2
                | Altd
                | Alts
                | Altr
                | Altb
                | Alti
                | Loc
                | Locktry
                | Waitx
                | Cogid
                | Getqx
                | Getqy
                | Qdiv
                | Qmul
                | Qfrac
                | Qsqrt
                | Qrotate
                | Qvector
                | Qlog
                | Qexp
                | Rep
                | Skip
                | Skipf
                | Fltl
                | Flth
                | Modc
                | Modz
                | Modcz
                | Wrc
                | Wrnc
                | Wrz
                | Wrnz
                | Rqpin
                | Pollct1
                | Pollct2
                | Pollct3
                | Pollse1
                | Pollse2
                | Pollse3
                | Pollse4
                | Jct1
                | Jnct1
                | Jse1
                | Jnse1
                | Getptr
                | Rdfast
        )
    }

    /// Ops that observe a pin. Pure — they change nothing — but what they
    /// read comes from outside the CPU, so a loop containing one is never a
    /// candidate for fast-forward. See [`PollState::external`].
    fn reads_pin(op: Op) -> bool {
        use Op::*;
        matches!(op, Testp | Testpn | Rdpin | Rqpin)
    }

    /// Ops that only *write* D (never read its old value).
    fn is_dest_only(op: Op) -> bool {
        use Op::*;
        matches!(
            op,
            Mov | Rdlong
                | Rdbyte
                | Rdword
                | Rdlut
                | Getct
                | Getqx
                | Getqy
                | Rqpin
                | Rdpin
                | Neg
                | Not
                | Abs
                | Decod
                | Encod
                | Loc
                | Cogid
                | Getptr
                | Ones
                | Rev
                | Rflong
                | Rfbyte
                | Rfword
                | Getnib
                | Getbyte
                | Getword
                | Rdfast
        )
    }

    fn always_sets_flags(op: Op) -> bool {
        use Op::*;
        matches!(
            op,
            Cmp | Cmps
                | Cmpr
                | Cmpm
                | Cmpx
                | Cmpsx
                | Test
                | Testn
                | Testb
                | Testbn
                | Testp
                | Testpn
                | Locktry
        )
    }

    /// After an instruction at `pc`: if it closed a short backward loop, judge
    /// the iteration and fast-forward a confirmed idle poller.
    fn note_loop_edge(&mut self, cog: usize, pc: u32) {
        let new_pc = self.cogs[cog].pc;
        let step = if pc < HUB_BASE { 1 } else { 4 };
        let is_back_edge = new_pc <= pc && pc.wrapping_sub(new_pc) <= 64 * step;
        if !is_back_edge {
            return;
        }
        let p = &mut self.cogs[cog].poll;
        if p.loop_pc == Some(new_pc) {
            if !p.side_effect && !p.carried {
                p.iters = p.iters.saturating_add(1);
            } else {
                p.iters = 0;
            }
        } else {
            // A new candidate loop: forget whether the old one read a pin.
            p.loop_pc = Some(new_pc);
            p.iters = 0;
            p.external = false;
        }
        p.written_prev = p.written;
        p.written = [0; 8];
        p.flags_written_prev = p.flags_written;
        p.flags_written = false;
        p.carried = false;
        p.side_effect = false;
        let waits_on_pin = p.external;
        // A pin spin may still be fast-forwarded when nothing is clocking:
        // the level can then only change on a net wake, which ends the slice
        // anyway. It must NOT be while a transfer is in flight -- that is the
        // case where skipping the cog's clock starves the transfer and trips
        // the driver's own timeout.
        if p.confirmed()
            && !self.ff_disabled
            && !(waits_on_pin && self.pins.external_transfer_busy())
        {
            self.fast_forward_poller(cog, waits_on_pin);
        }
    }

    /// Advance a confirmed idle poller to the next instant anything it can
    /// observe might change: the earliest non-polling running cog (which has
    /// to execute to change hub state or a lock), or — when every running cog
    /// is polling — the current slice deadline, since only a net wake can
    /// change a pin level by then. Its skipped iterations were identical.
    ///
    /// `waits_on_pin` says the loop read a *pin*, which has a second source:
    /// the outside world, whose next chance is the slice deadline. Such a wait
    /// takes whichever of the two bounds comes first, because another cog's
    /// clock alone does not bound it — see the note at the clamp below.
    fn fast_forward_poller(&mut self, cog: usize, waits_on_pin: bool) {
        let mine = self.cogs[cog].clocks;
        let mut next: Option<u64> = None;
        for (i, c) in self.cogs.iter().enumerate() {
            if i != cog && c.running && !c.poll.confirmed() {
                next = Some(next.map_or(c.clocks, |n: u64| n.min(c.clocks)));
            }
        }
        let mut target = match next {
            Some(t) => t.saturating_add(1),
            None => self.ff_deadline_clocks,
        };
        // A *pin* is not only changed by another cog — the outside world drives
        // it too, and the outside world's next chance is the end of this slice.
        // Another cog's clock is therefore the wrong bound on its own: a peer
        // parked on a long `WAITX` sits arbitrarily far ahead while still
        // counting as running, and following it carries this cog past every
        // instant in between at which a peripheral would have answered. Since
        // `GETCT` reads the stepped cog's own clock, a driver's receive
        // timeout then expires having sampled the pin barely at all — which
        // looks exactly like a peripheral that went quiet. Take whichever
        // bound comes first. (`ff_deadline_clocks` is `u64::MAX` while
        // count-stepping, where it correctly means "no bound".)
        if waits_on_pin {
            target = target.min(self.ff_deadline_clocks);
        }
        if target != u64::MAX && target > mine {
            self.cogs[cog].clocks = target;
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

    /// The system counter: what `GETCT` reads.
    ///
    /// One counter for the whole chip, **not** per cog. On a P2 the system
    /// counter is a single free-running register every cog samples, so two
    /// cogs reading it agree. Returning a cog's own executed-instruction count
    /// instead makes each cog live in its own timeline: one narrates a log
    /// line stamped 0.154 s while another is at 1.545 s, a timestamp written
    /// by one cog reads as the future or the distant past to another, and code
    /// that diffs two samples decides time ran backwards.
    ///
    /// Max over ALL cogs, not just running ones: time must not go backwards
    /// when a cog stops, and after `cogexit` there may be none running.
    /// The machine's time: the **frontier** — the clock of the least-advanced
    /// running cog.
    ///
    /// Cogs run concurrently on silicon; here they are interleaved, and the
    /// interleaving must be by *time*, not by turn. [`Self::step_until`]
    /// always steps the running cog with the smallest clock, so a cog that
    /// waits (its clock jumps ahead) is simply not chosen again until the
    /// others reach it. Taking the *maximum* instead — as this once did —
    /// let one cog's `waitx`/`waitct1` drag the whole machine's "now" forward
    /// and freeze every other cog for the length of the wait: a force-gauge
    /// conversion timeout or an SD `wait_ready` stalled the protocol cog for
    /// seconds, and the cog manager's `getct` deltas swallowed other cogs'
    /// jumps and reported phantom scheduling overruns.
    pub fn system_clocks(&self) -> u64 {
        self.cogs
            .iter()
            .filter(|c| c.running)
            .map(|c| c.clocks)
            .min()
            .or_else(|| self.cogs.iter().map(|c| c.clocks).max())
            .unwrap_or(0)
    }

    /// The running cog with the smallest clock — the one whose turn it is.
    fn frontier_cog(&self) -> Option<usize> {
        let mut best: Option<(usize, u64)> = None;
        for (i, c) in self.cogs.iter().enumerate() {
            if c.running && best.is_none_or(|(_, t)| c.clocks < t) {
                best = Some((i, c.clocks));
            }
        }
        best.map(|(i, _)| i)
    }

    /// Virtual microseconds elapsed, from the system counter.
    pub fn now_us(&self) -> u64 {
        let hz = match self.clkfreq() {
            0 => 160_000_000,
            f => f,
        } as u64;
        self.system_clocks() * 1_000_000 / hz
    }

    /// Run every running cog until `deadline_us`, or until one traps.
    ///
    /// Round-robin in a single OS thread: no locking on hub RAM, and the
    /// interleaving is a pure function of the image, which is what makes a run
    /// bit-reproducible.
    pub fn step_until(&mut self, deadline_us: u64) -> Result<(), Trap> {
        let hz = match self.clkfreq() {
            0 => 160_000_000,
            f => f,
        } as u64;
        let deadline_clocks = deadline_us.saturating_mul(hz) / 1_000_000;
        self.ff_deadline_clocks = deadline_clocks;
        // Round-robin over the running cogs, but skip any that have already
        // reached the deadline — chiefly the idle-poll fast-forwarded ones,
        // whose clock has jumped to it. Keeping the round-robin *order* and the
        // per-pass net-yield check (rather than stepping strictly the
        // least-advanced cog) is what a bit-banged net device depends on: it
        // needs the driver cog to keep getting turns across a yield, not to be
        // starved by a peer that is momentarily behind.
        loop {
            if self.now_us() >= deadline_us {
                break;
            }
            let mut stepped = false;
            for cog in 0..NUM_COGS {
                // Gate each cog on the *same* microsecond rounding as the
                // pass-level `now_us()` check, so a cog whose clock lands
                // exactly on the deadline is "done" both ways. A per-cog gate
                // in raw clocks rounds differently and can leave the pass
                // wanting to continue while every cog is individually blocked —
                // an early return that stalls a single-cog bit-bang boot.
                let cog_us = self.cogs[cog].clocks.saturating_mul(1_000_000) / hz;
                if self.cogs[cog].running && cog_us < deadline_us {
                    self.step_one(cog)?;
                    stepped = true;
                    if self.pins.take_net_yield() {
                        return Ok(());
                    }
                }
            }
            if !stepped {
                break;
            }
        }
        Ok(())
    }

    /// Execute at most `n` instructions, round-robin. Returns how many ran.
    pub fn step(&mut self, n: u64) -> Result<u64, Trap> {
        self.ff_deadline_clocks = u64::MAX;
        let mut ran = 0;
        while ran < n {
            let Some(cog) = self.frontier_cog() else {
                break;
            };
            self.step_one(cog)?;
            ran += 1;
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

    /// WC on logic ops: C is the parity of the result (P2-EVAL andn_wc / ones_*).
    fn wc_parity(&mut self, cog: usize, ins: &Decoded, result: u32) {
        if ins.c && !Self::l_at_bit19(ins.form) {
            self.cogs[cog].c = result.count_ones() & 1 != 0;
        }
    }

    fn step_one(&mut self, cog: usize) -> Result<(), Trap> {
        self.cogs[cog].instructions += 1;
        let pc = self.cogs[cog].pc;
        // The PC is 20 bits and hub addressing wraps: `$FC000` executes the
        // bytes at `$7C000`, which is precisely how the chip runs its boot
        // ROM — 16 KB copied to the top of RAM, COG 0 launched at `$FC000`.
        // Only a PC outside the 20-bit space is a trap.
        if pc >= 1 << 20 {
            self.cogs[cog].running = false;
            return Err(Trap::PcOutOfRange { cog: cog as u8, pc });
        }
        let word = self.fetch(cog, pc);
        let np = Self::next_pc(pc);

        // `SKIP` cancels instructions by pattern, one bit per instruction,
        // ahead of and independent of the condition field.
        //
        // This has to happen BEFORE the decode, not after it: a cancelled slot
        // is never decoded on silicon, and compilers use exactly that to step
        // over inline DATA. loadp2's flash stub opens with `SKIP` over its own
        // header — a checksum long and a flag long — and decoding those first
        // trapped on the checksum, whose value depends on the payload, so the
        // failure looked like a bad instruction rather than a skipped word.
        //
        // A cancelled instruction still costs its time (this is `SKIP`, not
        // `SKIPF`) and still swallows any pending prefix, like a failed
        // condition.
        if self.cogs[cog].skip_left > 0 {
            let cancel = self.cogs[cog].skip_pattern & 1 != 0;
            self.cogs[cog].skip_pattern >>= 1;
            self.cogs[cog].skip_left -= 1;
            if cancel {
                self.cogs[cog].clocks += CLOCKS_PER_INSTRUCTION;
                self.retired += 1;
                self.cogs[cog].pc = np;
                if let Some(ins) = decode(word) {
                    self.clear_prefixes(cog, &ins);
                }
                return Ok(());
            }
        }

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
                Some(a) => {
                    self.cogs[cog].aug_s_active = true;
                    a | base
                }
                None => {
                    self.cogs[cog].aug_s_active = false;
                    base
                }
            }
        } else {
            self.cogs[cog].aug_s_active = false;
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

        // Idle-poll accounting: which registers/flags this instruction READS
        // before writing them (loop-carried state), and whether it is pure.
        {
            let p = &mut self.cogs[cog].poll;
            if !ins.i {
                p.note_read(ins.s);
            }
            if !Self::d_is_literal(&ins) && !Self::is_dest_only(ins.op) {
                p.note_read(ins.d);
            }
            if ins.cond != 0xF && ins.cond != 0 && !p.flags_written && p.flags_written_prev {
                p.carried = true;
            }
            if !Self::is_pure(ins.op) {
                p.side_effect = true;
            }
            // Reading a pin makes this loop's exit depend on the outside
            // world. A driver spinning on `testp` for a smart-pin transfer is
            // waiting on edges that only the peripheral schedule produces, and
            // it times itself out with `_cnt()` deltas: skip the cog's clock
            // ahead and the timeout expires while the transfer has barely
            // moved. That is how the SD driver came to report a read error
            // without the card ever seeing a write command.
            // Only the S operand is checked for `INA`/`INB`: an unused D field
            // is filled with `$1FF`, which is `INB`, so testing D would call
            // every `jmp #imm` an external read.
            if Self::reads_pin(ins.op) || (!ins.i && matches!(ins.s & 0x1FF, REG_INA | REG_INB)) {
                p.external = true;
            }
        }
        self.cogs[cog].pc = np;
        let advanced = self.execute(cog, &ins, word, pc, s_val, d_val)?;
        if ins.c || ins.z || Self::always_sets_flags(ins.op) {
            self.cogs[cog].poll.flags_written = true;
        }
        self.note_loop_edge(cog, pc);

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
        // Q survives an intervening AUG prefix: `setq / augs / rdlong ##addr`
        // is exactly how the boot ROM copies its cog image into place, and
        // clearing Q at the AUGS reduced that block copy to a single long.
        if !matches!(ins.op, Op::Setq | Op::Setq2 | Op::Augs | Op::Augd) {
            self.cogs[cog].setq = None;
            self.cogs[cog].setq2 = None;
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
    fn ptr_operand(&mut self, cog: usize, ins: &Decoded, s: u32, scale: i32, elements: u32) -> u32 {
        // An augmented S is a 32-bit literal address, never a PTR expression.
        if !ins.i || s & 0x100 == 0 || self.cogs[cog].aug_s_active {
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
        fresh.poll.reset();
        // A cog starts *now*: it inherits the starter's clock, so `now_us()`
        // (the minimum over running cogs) does not collapse to zero the instant
        // a cog is launched mid-run, and the new cog joins the time frontier
        // instead of burning a catch-up burst.
        fresh.clocks = self.cogs[cog].clocks;
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
                self.wc_parity(cog, ins, r);
            }
            Andn => {
                let r = d & !s;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                self.wc_parity(cog, ins, r);
            }
            Or => {
                let r = d | s;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                self.wc_parity(cog, ins, r);
            }
            Xor => {
                let r = d ^ s;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                self.wc_parity(cog, ins, r);
            }
            Test => {
                let r = d & s;
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = r.count_ones() & 1 != 0;
                }
            }
            Testn => {
                let r = d & !s;
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = r.count_ones() & 1 != 0;
                }
            }

            // ---- arithmetic

            // MUL/MULS are 16x16 -> 32. Silicon: D=$80000000, S=1 gives
            // d=$00000000 (swp_mul_fa03c1e1, swp_muls_fa13c1e1) -- the upper
            // half of each operand is discarded, not multiplied, so a full
            // 32x32 product is wrong. Bit 20 is the MULS selector here, NOT a
            // WC bit: `ins.c` is set on every MULS encoding, and C is left
            // alone (all 16 probe cases enter C=0 and leave C=0).

            // Same arm as MUL -- MULS is bit 20 of the same opcode, so both
            // land here. See the comment on the Mul | Muls arm above: 16x16,
            // C untouched (ins.c IS the MULS selector), Z = result==0 on WZ.
            Mul | Muls => {
                let r = if ins.op == Mul {
                    (d & 0xFFFF).wrapping_mul(s & 0xFFFF)
                } else {
                    i32::from(d as i16).wrapping_mul(i32::from(s as i16)) as u32
                };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Add => {
                let (r, carry) = d.overflowing_add(s);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = carry;
                }
            }
            // The signed adds and subtracts do NOT report carry/borrow. C is
            // the CORRECT SIGN of the true result — the sign the answer would
            // have with infinite precision, which is the result's bit 31 only
            // while there is no signed overflow. That is what makes ADDS/ADDSX
            // chain: the top word's C is the sign of the whole multi-long
            // value. Silicon: $80000000 + 1 = $80000001 with C=1, where an
            // overflow flag would have said 0 and a carry flag would too.
            Adds => {
                let true_sum = i64::from(d as i32) + i64::from(s as i32);
                let r = d.wrapping_add(s);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = true_sum < 0;
                }
            }
            Sub => {
                let (r, borrow) = d.overflowing_sub(s);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = borrow;
                }
            }
            Subs => {
                let true_diff = i64::from(d as i32) - i64::from(s as i32);
                let r = d.wrapping_sub(s);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = true_diff < 0;
                }
            }
            // Reverse subtract is the UNSIGNED one (it pairs with `Sub`, not
            // `Subs`), and it does write C: silicon gives 1 - $80000000 a
            // borrow. This wrote no C at all, so every `subr wc` left the flag
            // holding whatever the previous instruction put there.
            Subr => {
                let (r, borrow) = s.overflowing_sub(d);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = borrow;
                }
            }
            Addx => {
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
            // As `Adds`: C is the true sign, not the carry out. Z still ANDs,
            // so a multi-long compare accumulates across words.
            Addsx => {
                let cin = self.cogs[cog].c;
                let true_sum = i64::from(d as i32) + i64::from(s as i32) + i64::from(cin);
                let r = d.wrapping_add(s).wrapping_add(u32::from(cin));
                self.set_reg(cog, ins.d, r);
                if ins.z {
                    self.cogs[cog].z = self.cogs[cog].z && r == 0;
                }
                if ins.c {
                    self.cogs[cog].c = true_sum < 0;
                }
            }
            Subx => {
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
            Subsx => {
                let cin = self.cogs[cog].c;
                let true_diff = i64::from(d as i32) - i64::from(s as i32) - i64::from(cin);
                let r = d.wrapping_sub(s).wrapping_sub(u32::from(cin));
                self.set_reg(cog, ins.d, r);
                if ins.z {
                    self.cogs[cog].z = self.cogs[cog].z && r == 0;
                }
                if ins.c {
                    self.cogs[cog].c = true_diff < 0;
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

            // SUMC/SUMNC/SUMZ/SUMNZ sum S into D, negating S when the named
            // flag is set: SUMC subtracts on C=1, SUMNC on C=0, SUMZ on Z=1,
            // SUMNZ on Z=0. They are the SIGNED sums, so -- exactly as with
            // ADDS/SUBS -- C is the CORRECT SIGN of the true result, never a
            // carry or a borrow. Silicon: $80000000 + 1 = $80000001 sets C
            // (an unsigned carry would be 0), and $80000000 - 1 = $7FFFFFFF
            // sets C too (the result's own bit 31 is 0). This arm wrote no C
            // at all, so every `sumc wc` left the flag holding the last value.
            Sumc | Sumnc | Sumz | Sumnz => {
                let take = match ins.op {
                    Sumc => self.cogs[cog].c,
                    Sumnc => !self.cogs[cog].c,
                    Sumz => self.cogs[cog].z,
                    _ => !self.cogs[cog].z,
                };
                let (r, true_result) = if take {
                    (d.wrapping_sub(s), i64::from(d as i32) - i64::from(s as i32))
                } else {
                    (d.wrapping_add(s), i64::from(d as i32) + i64::from(s as i32))
                };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = true_result < 0;
                }
            }
            Negc | Negnc | Negz | Negnz => {
                let take = match ins.op {
                    Negc => self.cogs[cog].c,
                    Negnc => !self.cogs[cog].c,
                    Negz => self.cogs[cog].z,
                    _ => !self.cogs[cog].z,
                };
                let r = if take {
                    (s as i32).wrapping_neg() as u32
                } else {
                    s
                };
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
            // SAL is not SHL. "Shift arithmetic left" fills the vacated low
            // bits with D's ORIGINAL BIT 0 -- the mirror of SAR filling the
            // high bits with bit 31 -- so $FFFFFFFF shifted left by one is
            // still $FFFFFFFF on silicon, where a plain shift gives $FFFFFFFE.
            //
            // This hid for as long as it did because the original silicon
            // sweep used only $80000000 and $00000002 as D, and BOTH have bit
            // 0 clear: fill-with-zero and fill-with-bit-0 are the same answer
            // for every case it captured. $FFFFFFFF and $A5A5A5A5 separate
            // them on the first try.
            Shl | Sal | Rol => {
                let n = s & 31;
                let r = if ins.op == Rol {
                    d.rotate_left(n)
                } else if ins.op == Sal {
                    let fill = if d & 1 != 0 { u32::MAX } else { 0 };
                    let low = if n == 0 { 0 } else { fill >> (32 - n) };
                    d.wrapping_shl(n) | low
                } else {
                    d.wrapping_shl(n)
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
            Rcl | Rcr => {
                // Rotate *carry* through D: the vacated bits fill with copies
                // of C, and C takes the last bit shifted out. The boot ROM
                // leans on `RCL x, #1` to assemble bits sampled off a pin —
                // its RNG seed and its SPI receive both come in this way.
                let n = s & 31;
                let c = self.cogs[cog].c;
                let fill = if c && n > 0 { (1u64 << n) - 1 } else { 0 } as u32;
                let (r, out) = if ins.op == Rcl {
                    let r = d.wrapping_shl(n) | fill;
                    let out = if n == 0 { c } else { (d >> (32 - n)) & 1 != 0 };
                    (r, out)
                } else {
                    let r = d.wrapping_shr(n) | fill.wrapping_shl(32u32.wrapping_sub(n) & 31);
                    let r = if n == 0 { d } else { r };
                    let out = if n == 0 { c } else { (d >> (n - 1)) & 1 != 0 };
                    (r, out)
                };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = out;
                }
            }
            Sar => {
                let n = s & 31;
                let r = ((d as i32) >> n) as u32;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    let probe = if n == 0 {
                        d as i32
                    } else {
                        (d as i32) >> (n - 1)
                    };
                    self.cogs[cog].c = probe & 1 != 0;
                }
            }
            Zerox => {
                let bit = s & 31;
                let r = if bit == 31 {
                    d
                } else {
                    d & ((1u32 << (bit + 1)) - 1)
                };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }

            Signx => {
                let sh = 31 - (s & 31);
                let r = (((d << sh) as i32) >> sh) as u32;
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                // WC reports the sign that got extended, which is the
                // result's MSB. Silicon: `signx $00000002,#1 wc` (enc
                // $f777c001) returned $fffffffe with C=1, while the same
                // encoding on $80000000 returned $00000000 with C=0.
                if ins.c {
                    self.cogs[cog].c = r >> 31 != 0;
                }
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
                let r = if bit == 31 {
                    u32::MAX
                } else {
                    (1u32 << (bit + 1)) - 1
                };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
            }
            Ones => {
                let r = s.count_ones();
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                // WC: C is the LSB of the count (odd population of S), not
                // the parity of that 6-bit integer's bits.
                if ins.c {
                    self.cogs[cog].c = r & 1 != 0;
                }
            }
            // GETNIB/GETBYTE/GETWORD take field N of S into D, and N lives
            // in the instruction, not in an operand: the `ds*get` forms encode
            // it in the C/Z bits (and, for the 3-bit nibble index, bit 21).
            // Reading the index from S and the source from D made
            // `getbyte cmd_lo, cmd, #0` return 1 instead of 0, so `send_cmd`
            // built every SD frame with command index 1.
            Getnib => {
                let n = (((word >> 21) & 1) << 2) | ((ins.c as u32) << 1) | ins.z as u32;
                let r = (s >> (n * 4)) & 0xF;
                self.set_reg(cog, ins.d, r);
            }
            Getbyte => {
                let n = ((ins.c as u32) << 1) | ins.z as u32;
                let r = (s >> (n * 8)) & 0xFF;
                self.set_reg(cog, ins.d, r);
            }
            Getword => {
                let n = ins.z as u32;
                let r = (s >> (n * 16)) & 0xFFFF;
                self.set_reg(cog, ins.d, r);
            }
            // The SET* counterparts write S's low field into field N of D.
            Setnib => {
                let n = (((word >> 21) & 1) << 2) | ((ins.c as u32) << 1) | ins.z as u32;
                let sh = n * 4;
                let r = (d & !(0xFu32 << sh)) | ((s & 0xF) << sh);
                self.set_reg(cog, ins.d, r);
            }
            Setbyte => {
                let n = ((ins.c as u32) << 1) | ins.z as u32;
                let sh = n * 8;
                let r = (d & !(0xFFu32 << sh)) | ((s & 0xFF) << sh);
                self.set_reg(cog, ins.d, r);
            }

            // Opcode %1001001 is shared: bit 20 picks GETWORD (1) over
            // SETWORD (0) and bit 19 is N. Neither writes a flag.
            // Silicon: enc $f93bc1e1 (bit20=1, N=1) on D=$80000000,
            // S=$00000001 returned $00000000 -- word 1 of S -- not the
            // $00010000 a SETWORD would have written.
            //
            // The generated S1_REG still routes that slot here: index 295
            // says Setword where it must say Getword (see notes -- the
            // real fix is in tools/gen_decoder.py's row-fill). This guard
            // is correct on its own and stays correct once that lands.
            Setword => {
                let n = ins.z as u32;
                let r = if ins.c {
                    (s >> (n * 16)) & 0xFFFF
                } else {
                    let sh = n * 16;
                    (d & !(0xFFFFu32 << sh)) | ((s & 0xFFFF) << sh)
                };
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
                // Silicon reverses all 32 bits of D: $80000000 -> $00000001
                // and $00000002 -> $40000000 (enc $fd63c069).
                //
                // The L=1 spelling of misc sub-op $069 is NOT rev -- enc
                // $fd67c069 left D at $80000000, untouched. We land here for
                // it anyway because decode()'s `S4_MISC[key].or(S4_MISC[s])`
                // fallback drops the L bit from the key; d_is_literal() then
                // feeds in the D *field* ($1E0), and we wrote rev($1E0) =
                // $07800000 straight over the register.
                if !Self::d_is_literal(ins) {
                    let r = d.reverse_bits();
                    self.set_reg(cog, ins.d, r);
                }
            }

            // FGE clamps D up to S, unsigned. Silicon (P2-EVAL swp_fge_*):
            // WC reports the comparison that would have replaced D — C = D < S
            // unsigned — and only when WC is set: the same 2-vs-3 operands
            // leave C=0 without WC (f303c1e1_b) and set C=1 with it
            // (f313c1e1_b). The old arm computed the result but never wrote C.
            Fge => {
                let r = if d < s { s } else { d };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = d < s;
                }
            }

            // FLE clamps D down to S, unsigned. Silicon (P2-EVAL swp_fle_*):
            // C is the *opposite* sense from FGE — C = D > S — which
            // swp_fle_f333c1e1 settles outright: D=80000000, S=1 is D<S false
            // yet C came back 1. WC-gated; the old arm never wrote C at all.
            Fle => {
                let r = if d > s { s } else { d };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = d > s;
                }
            }

            // FGES is FGE with a signed compare, and silicon says WC follows
            // suit: swp_fges_f353c1e1 (D=80000000, S=1) returns D=1, C=1 where
            // the unsigned FGE on the same operands returns D=80000000, C=0.
            // WC-gated; the old arm wrote the right value but no C.
            Fges => {
                let r = if (d as i32) < (s as i32) { s } else { d };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = (d as i32) < (s as i32);
                }
            }

            // FLES is FLE with a signed compare. Silicon (swp_fles_*): C keeps
            // FLE's reversed sense, C = D > S signed — f373c1e1 (D=80000000,
            // S=1) gives C=0 where the unsigned FLE gives C=1, and f377c001_b
            // (D=2, #1) gives C=1. WC-gated; the old arm never wrote C.
            Fles => {
                let r = if (d as i32) > (s as i32) { s } else { d };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = (d as i32) > (s as i32);
                }
            }
            Muxc | Muxnc | Muxz | Muxnz => {
                let bit = match ins.op {
                    Muxc => self.cogs[cog].c,
                    Muxnc => !self.cogs[cog].c,
                    Muxz => self.cogs[cog].z,
                    _ => !self.cogs[cog].z,
                };
                let m = if bit { u32::MAX } else { 0 };
                let r = (d & !s) | (m & s);
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = r.count_ones() & 1 != 0;
                }
            }

            // Same replacement arm as `bitc` — Bith | Bitl | Bitnot | Bitc |
            // Bitnc | Bitz | Bitnz is one arm at lib.rs:1794. Paste it once.

            // Same replacement arm as `bitc`; the Bitz slot is the OR row of
            // the [22:21] logic selector.

            // Same replacement arm as `bitc`; the Bitnz slot is TESTBN + OR.

            // Same replacement arm as `bitc`; the Bitnot slot is TESTBN + XOR
            // (and BITRND, unimplemented here, is the TESTB + XOR twin).
            Bith | Bitl | Bitnot | Bitc | Bitnc | Bitz | Bitnz => {
                let base = s & 31;
                let count = ((s >> 5) & 31) + 1;
                let mut mask = 0u32;
                for i in 0..count {
                    mask |= 1u32 << ((base + i) & 31);
                }
                let bit = (d >> base) & 1 != 0;
                if ins.c != ins.z {
                    // TESTB/TESTBN alias: D untouched. P2-EVAL
                    // `bitnot_f4ebc1e1` (WZ only, D=80000000) came back
                    // d=80000000 z=1 and `bitnot_f4efc001_b` (WZ only,
                    // D=00000002) came back d=00000002 z=0 — a toggle would
                    // have moved D in opposite directions in those two.
                    let t = match ins.op {
                        Bitl | Bitc | Bitz => bit,
                        _ => !bit,
                    };
                    let cur = if ins.c {
                        self.cogs[cog].c
                    } else {
                        self.cogs[cog].z
                    };
                    let v = match ins.op {
                        Bitl | Bith => t,
                        Bitc | Bitnc => cur && t,
                        Bitz | Bitnz => cur || t,
                        _ => cur ^ t,
                    };
                    if ins.c {
                        self.cogs[cog].c = v;
                    } else {
                        self.cogs[cog].z = v;
                    }
                } else {
                    let r = match ins.op {
                        Bith => d | mask,
                        Bitl => d & !mask,
                        Bitnot => d ^ mask,
                        Bitc | Bitnc => {
                            if self.cogs[cog].c == (ins.op == Bitc) {
                                d | mask
                            } else {
                                d & !mask
                            }
                        }
                        _ => {
                            if self.cogs[cog].z == (ins.op == Bitz) {
                                d | mask
                            } else {
                                d & !mask
                            }
                        }
                    };
                    self.set_reg(cog, ins.d, r);
                    if ins.c && ins.z {
                        self.cogs[cog].c = bit;
                        self.cogs[cog].z = bit;
                    }
                }
            }

            // Same replacement arm as `testb` — Testb | Testbn is one arm at
            // lib.rs:1834. Paste it once.
            Testb | Testbn => {
                // WCZ on these two opcodes is the BIT write form, not a test.
                // P2-EVAL `testbn_f43bc1e1` (BITH D,S WCZ, D=80000000) came
                // back d=80000002 c=0 z=0: the span bit was SET and the flags
                // carry the prior D[S[4:0]] un-inverted — a TESTBN reading
                // would have written 1 to both.
                let base = s & 31;
                let bit = (d >> base) & 1 != 0;
                if ins.c && ins.z {
                    let count = ((s >> 5) & 31) + 1;
                    let mut mask = 0u32;
                    for i in 0..count {
                        mask |= 1u32 << ((base + i) & 31);
                    }
                    let r = if ins.op == Testb { d & !mask } else { d | mask };
                    self.set_reg(cog, ins.d, r);
                    self.cogs[cog].c = bit;
                    self.cogs[cog].z = bit;
                } else {
                    let v = if ins.op == Testb { bit } else { !bit };
                    if ins.c {
                        self.cogs[cog].c = v;
                    }
                    if ins.z {
                        self.cogs[cog].z = v;
                    }
                }
            }
            // WRC/WRNC/WRZ/WRNZ put the flag (or its complement) into D as 0
            // or 1 and touch NO flags of their own: with WZ set, silicon left
            // Z clear on `wrc`'s 0 result, where a Z = (result == 0) would
            // have set it. Bit 18 is the misc block's L bit, and with D taken
            // as a literal silicon performs no register write at all -- this
            // arm wrote D unconditionally and clobbered the register on half
            // of the encodings the sweep covers.
            Wrc | Wrnc | Wrz | Wrnz => {
                let v = match ins.op {
                    Wrc => self.cogs[cog].c,
                    Wrnc => !self.cogs[cog].c,
                    Wrz => self.cogs[cog].z,
                    _ => !self.cogs[cog].z,
                };
                if !Self::d_is_literal(ins) {
                    self.set_reg(cog, ins.d, v as u32);
                }
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
                    if let Some(count) = self.cogs[cog].setq2.take() {
                        // Block-fill the LUT.
                        let n = count.min(LUT_LONGS as u32 - 1);
                        self.check_hub(cog, s)?;
                        for k in 0..=n {
                            let v = self.rd_long(s.wrapping_add(k.wrapping_mul(4)));
                            let at = (ins.d as usize + k as usize) & (LUT_LONGS - 1);
                            self.cogs[cog].lut[at] = v;
                        }
                        return Ok(false);
                    }
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
                // WC takes the MSB of the *transfer*, not of the zero-extended
                // register: silicon read $9C9C with WC and set C
                // (`swp_rdword_faf3c1e1`), read $489C and cleared it
                // (`swp_rdword_faf7c001`) -- bit 31 is 0 in both. WZ on its own
                // leaves C alone (`swp_rdword_faebc1e1`, same $9C9C, C=0).
                // RDBYTE and RDLONG follow the family rule: every WC case the
                // corpus has for them reads one value ($9C, bit 7 set) and a
                // long with bit 31 clear, so neither discriminates on its own.
                // (The block paths above return first: a SETQ transfer writes
                // no flags, which no golden case exercises either.)
                if ins.c {
                    self.cogs[cog].c = (v >> (scale * 8 - 1)) & 1 != 0;
                }
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
                            // `SETQ n` + `WRLONG #imm, addr` is a block *fill*:
                            // the immediate is written to every long. flexcc
                            // emits exactly that for `memset(p, 0, len)`
                            // (`setq #len/4-1` / `wrlong #0, p`), and the
                            // firmware's zeroed structs prove the silicon
                            // fills. Copying from cog register 0 upward
                            // instead sprayed FCACHE contents over every
                            // memset-initialised struct at boot.
                            let v = if ins.l {
                                d
                            } else {
                                self.reg(cog, ins.d.wrapping_add(k as u16))
                            };
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

            // ---- prefixes
            Augs => {
                self.cogs[cog].aug_s = Some(ins.imm << 9);
            }
            Augd => {
                self.cogs[cog].aug_d = Some(ins.imm << 9);
            }
            Setq => {
                // The operand is D; S holds the sub-opcode selector ($28).
                self.cogs[cog].setq = Some(d);
            }
            Setq2 => {
                // Same prefix shape, different destination: a SETQ2 block
                // read fills LUT RAM, not the register file. Folding the two
                // together let the boot ROM's LUT load overwrite cog
                // registers $010.. — the very code it had just copied there.
                self.cogs[cog].setq2 = Some(d);
            }

            Setd | Sets => {
                // Self-modifying cog code: patch the D or S field of the
                // instruction held in register D. The ROM builds its pin-test
                // and table-fill loops this way.
                let cur = self.reg(cog, ins.d);
                let r = if ins.op == Setd {
                    (cur & !(0x1FF << 9)) | ((s & 0x1FF) << 9)
                } else {
                    (cur & !0x1FF) | (s & 0x1FF)
                };
                self.set_reg(cog, ins.d, r);
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
            // Decrement and jump if NOT full ($FFFFFFFF) — the counted-loop
            // partner of `Djf`, used by loaders that run a block down to -1.
            Djnf => {
                let r = d.wrapping_sub(1);
                self.set_reg(cog, ins.d, r);
                if r != u32::MAX {
                    self.cogs[cog].pc = self.rel9_target(ins, s, pc);
                    branched = true;
                }
            }
            // Load a 32-instruction cancellation pattern. Compilers emit this
            // to fold several short alternatives into one straight-line block
            // and select between them at run time -- which is why a stub whose
            // very first instruction is `SKIP` does nothing recognisable
            // without it.
            Skip => {
                self.cogs[cog].skip_pattern = d;
                self.cogs[cog].skip_left = 32;
            }
            // The hub FIFO's current byte address. `RDFAST`/`WRFAST` set it and
            // every `RF*`/`WF*` moves it; a loader reads it back to find out
            // where a streamed block ended.
            Getptr => {
                let a = self.cogs[cog].fifo_addr;
                self.set_reg(cog, ins.d, a);
                self.wz(cog, ins, a);
                if ins.c {
                    self.cogs[cog].c = a >> 31 != 0;
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
                // REP D,S repeats D instructions S times: D is the block
                // LENGTH, S the repeat count. Swapping them made the block
                // one instruction too long, so an FCACHE'd loop ran its
                // trailing `_ret_` on every iteration -- popping the call
                // stack each time until it underflowed and returned to the
                // address after `call #_main`, ending the program.
                let len = d;
                let count = s;
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
                    self.cogs[cog].qx = if q > u32::MAX as u64 {
                        u32::MAX
                    } else {
                        q as u32
                    };
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
            Locknew => match self.lock_alloc.iter().position(|a| !a) {
                Some(i) => {
                    self.lock_alloc[i] = true;
                    self.set_reg(cog, ins.d, i as u32);
                    if ins.c {
                        self.cogs[cog].c = false;
                    }
                }
                None => {
                    // P2-EVAL `_locknew` after 16 allocations writes 15 into D
                    // (the last valid id), not 0 and not "leave D unchanged"
                    // (the extra dest is a different register, starts at 0).
                    self.set_reg(cog, ins.d, (NUM_LOCKS - 1) as u32);
                }
            },
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
                // The cog being stepped IS the frontier, so its own clock is
                // the machine's time — and every cog reads a consistent one.
                let ct = self.cogs[cog].clocks;
                let v = if ins.c { (ct >> 32) as u32 } else { ct as u32 };
                self.set_reg(cog, ins.d, v);
            }

            // Silicon writes D as well as arming the event: enc $fa63c1e1
            // with D=$00000002,S=$00000003 read back D=$00000005, and
            // $fa67c001 (S=#1) turned $80000000 into $80000001. Bits 20:19
            // are the CT1/2/3 selector, not WC/WZ, so no flag is written.
            // ADDCT2/ADDCT3 show the same D in the goldens and until now
            // fell through to the Unimplemented trap; they share `ct1`'s
            // deadline because JCT2/JCT3 already read that one field.

            // ADDCT2/ADDCT3 WRITE D -- they do not merely arm a timer.
            // Silicon: swp_addct2_fa6bc1e1 $80000000 + reg $1E1 (=1) -> d=80000001,
            // ..._b 2 + 3 -> d=00000005, swp_addct3_fa77c001_b 2 + #1 -> d=00000003,
            // with c/z unchanged in all 8 cases. Bits 20:19 are the CT1/CT2/CT3
            // selector, not WC/WZ -- the decoder already spent them, so ins.z
            // (ADDCT2) and ins.c (ADDCT3) read as set here and MUST be ignored.

            // Covered by the same arm as ADDCT2 (paste once, not twice):
            //
            // ADDCT2/ADDCT3 WRITE D -- they do not merely arm a timer.
            // Silicon: swp_addct3_fa73c1e1 $80000000 + reg $1E1 (=1) -> d=80000001,
            // ..._b 2 + 3 -> d=00000005, swp_addct3_fa77c001_b 2 + #1 -> d=00000003,
            // with c/z unchanged in all 8 cases. Bits 20:19 are the CT1/CT2/CT3
            // selector, not WC/WZ -- the decoder already spent them, so ins.z
            // (ADDCT2) and ins.c (ADDCT3) read as set here and MUST be ignored.
            // ADDCT1/2/3 arm a deadline: D + S goes BOTH into the deadline
            // register and back into D (silicon: din $80000000 + 1 leaves
            // d=$80000001). Bits 20:19 select which of CT1/CT2/CT3 is armed
            // rather than meaning WC/WZ, so these never touch the flags.
            // Three deadline registers on silicon; only `ct1` is modelled
            // here, so 2 and 3 alias onto it.
            // TODO: give `Cog` real `ct2`/`ct3` fields and route each here.
            //
            // Addct1 must stay in this arm. It was briefly dropped while
            // applying silicon-conformance patches, and the firmware stopped
            // booting instantly -- `addct1` is how every timed loop in the
            // firmware arms its next wake, so the whole image traps on the
            // first one.
            Addct1 | Addct2 | Addct3 => {
                let v = d.wrapping_add(s);
                self.set_reg(cog, ins.d, v);
                self.cogs[cog].ct1 = v;
            }
            Waitct1 => {
                let target = self.cogs[cog].ct1;
                // Against the same counter `GETCT` reads: the cog's own clock.
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

            // ---- conditional jumps on events
            //
            // The two families the boot ROM uses:
            //   J{n}ct1/2/3 — timer events, which are REAL: `addct1` sets a
            //     deadline and the serial timeout loops `jct1` on it. Modelled
            //     against the same counter GETCT reads.
            //   everything else (SE1-4, INT, ATN, PAT, FBW, XMT/XFI/XRO/XRL,
            //     QMT) — event sources nothing in this model raises. The
            //     "jump if event" form never jumps; the "jump if not" form
            //     always does.
            Jct1 | Jct2 | Jct3 => {
                let now = self.system_clocks() as u32;
                let passed = (now.wrapping_sub(self.cogs[cog].ct1) as i32) >= 0;
                if passed {
                    self.cogs[cog].pc = self.rel9_target(ins, s, pc);
                    branched = true;
                }
            }
            Jnct1 | Jnct2 | Jnct3 => {
                let now = self.system_clocks() as u32;
                let passed = (now.wrapping_sub(self.cogs[cog].ct1) as i32) >= 0;
                if !passed {
                    self.cogs[cog].pc = self.rel9_target(ins, s, pc);
                    branched = true;
                }
            }
            Jint | Jse1 | Jse2 | Jse3 | Jse4 | Jpat | Jfbw | Jxmt | Jxfi | Jxro | Jxrl | Jatn
            | Jqmt => {
                // No such event ever fires here; never jump. (JQMT is the one
                // to watch: it means "CORDIC result waiting", and the boot ROM
                // does not use the CORDIC, so idle is correct.)
            }
            Jnint | Jnse1 | Jnse2 | Jnse3 | Jnse4 | Jnpat | Jnfbw | Jnxmt | Jnxfi | Jnxro
            | Jnxrl | Jnatn | Jnqmt => {
                self.cogs[cog].pc = self.rel9_target(ins, s, pc);
                branched = true;
            }

            // ---- selectable events
            Setse1 | Setse2 | Setse3 | Setse4 => {
                // Configure an event source. This model does not raise the
                // events, so configuration is inert; the consumers below
                // report "never happened", which is the correct answer when
                // nothing on the bus has fired one.
            }
            Pollse1 | Pollse2 | Pollse3 | Pollse4 => {
                // Poll-and-clear: no event pending, so C/Z report not-set.
                if ins.c {
                    self.cogs[cog].c = false;
                }
                if ins.z {
                    self.cogs[cog].z = false;
                }
            }

            // ---- interrupts
            Setint1 | Setint2 | Setint3 => {
                // Accepted and inert. Nothing in this model raises an
                // interrupt, so arming one changes nothing — the boot ROM's
                // autobaud ISR simply never fires, exactly as it never fires
                // on hardware when no host is wired to the serial pins.
            }

            // ---- hub FIFO
            Wrfast | Rdfast => {
                // D is the block-wrap count (0 = unlimited); the ROM and the
                // loaders only ever pass 0, so only the start address matters.
                self.cogs[cog].fifo_addr = s;
            }
            Wfbyte => {
                let a = self.cogs[cog].fifo_addr;
                self.wr_byte(a, d);
                self.cogs[cog].fifo_addr = a.wrapping_add(1);
            }
            Wfword => {
                let a = self.cogs[cog].fifo_addr;
                self.wr_byte(a, d & 0xFF);
                self.wr_byte(a.wrapping_add(1), (d >> 8) & 0xFF);
                self.cogs[cog].fifo_addr = a.wrapping_add(2);
            }
            Wflong => {
                let a = self.cogs[cog].fifo_addr;
                self.note_write(cog, a, d, 4);
                self.wr_long(a, d);
                self.cogs[cog].fifo_addr = a.wrapping_add(4);
            }
            Rfbyte | Rfword | Rflong => {
                let a = self.cogs[cog].fifo_addr;
                let (v, step) = match ins.op {
                    Rfbyte => (self.rd_byte(a), 1),
                    Rfword => (self.rd_byte(a) | (self.rd_byte(a.wrapping_add(1)) << 8), 2),
                    _ => (self.rd_long(a), 4),
                };
                self.cogs[cog].fifo_addr = a.wrapping_add(step);
                self.set_reg(cog, ins.d, v);
                self.wz(cog, ins, v);
                if ins.c {
                    // C takes the top bit of the value at its size.
                    let top = match ins.op {
                        Rfbyte => 7,
                        Rfword => 15,
                        _ => 31,
                    };
                    self.cogs[cog].c = (v >> top) & 1 != 0;
                }
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
            Akpin => {
                if std::env::var("P2ISS_SPI_DEBUG").is_ok() {
                    eprintln!("[cog] AKPIN pin={}", s & 63);
                }
                self.pins.akpin((s & 63) as u8)
            }
            Testp => {
                let v = self.pins.testp((d & 63) as u8);
                if ins.c {
                    self.cogs[cog].c = v;
                }
                if ins.z {
                    self.cogs[cog].z = v;
                }
            }
            Dirl | Dirh | Drvl | Drvh | Fltl | Flth | Outl | Outh | Drvc | Drvnc | Drvz | Drvnz
            | Drvnot => {
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
                    Outh => out |= bit,
                    // Drive to a flag: the ROM's `spi_cmd` shifts the command
                    // bit into C and `drvc`s it onto the data line.
                    Drvc | Drvnc => {
                        let level = self.cogs[cog].c == (ins.op == Drvc);
                        dir |= bit;
                        if level {
                            out |= bit;
                        } else {
                            out &= !bit;
                        }
                    }
                    Drvz | Drvnz => {
                        let level = self.cogs[cog].z == (ins.op == Drvz);
                        dir |= bit;
                        if level {
                            out |= bit;
                        } else {
                            out &= !bit;
                        }
                    }
                    _ => {
                        // DRVNOT: toggle.
                        dir |= bit;
                        out ^= bit;
                    }
                }
                // One instruction, one pin change. Each `set_reg` on a
                // `DIR`/`OUT` register publishes to the pins, so writing them
                // in a fixed order makes `DRVH`/`DRVL` glitch: the pin is
                // briefly driven with the *previous* level. Commit the edge
                // that releases the pad first and the one that drives it last,
                // so the intermediate state is never a wrong drive.
                if dir & bit != 0 {
                    self.set_reg(cog, oreg, out);
                    self.set_reg(cog, dreg, dir);
                } else {
                    self.set_reg(cog, dreg, dir);
                    self.set_reg(cog, oreg, out);
                }
            }

            // ROLNIB: D = {D[27:0], S.NIBBLE[N]} -- a *shift* left by a nibble,
            // not a rotate. Silicon turned d=$80000000 s=$00000001 into
            // $00000001, not $00000009 (swp_rolnib_f883c1e1). N rides in the
            // instruction exactly as GETNIB's does (bit 21 plus the C/Z bits),
            // so C/Z are index bits here, not WC/WZ, and no flag is written.
            Rolnib => {
                let n = (((word >> 21) & 1) << 2) | ((ins.c as u32) << 1) | ins.z as u32;
                let r = (d << 4) | ((s >> (n * 4)) & 0xF);
                self.set_reg(cog, ins.d, r);
            }
            // ROLBYTE: D = {D[23:0], S.BYTE[N]}. Shift, not rotate --
            // d=$80000000 s=$00000001 gave $00000001, not $00000081
            // (swp_rolbyte_f903c1e1). N is the C/Z pair, as in GETBYTE, so
            // nothing here writes C or Z.
            Rolbyte => {
                let n = ((ins.c as u32) << 1) | ins.z as u32;
                let r = (d << 8) | ((s >> (n * 8)) & 0xFF);
                self.set_reg(cog, ins.d, r);
            }
            // ROLWORD: D = {D[15:0], S.WORD[N]}, N = the Z bit alone (as
            // GETWORD). Shift, not rotate: d=$80000000 s=$00000001 gave
            // $00000001 (swp_rolword_f943c1e1). No flag is written.
            Rolword => {
                let n = ins.z as u32;
                let r = (d << 16) | ((s >> (n * 16)) & 0xFFFF);
                self.set_reg(cog, ins.d, r);
            }
            // RCZR/RCZL shift C and Z into D -- right: {C, Z, D[31:2]},
            // left: {D[29:0], C, Z} -- and WC/WZ report the bits that fell out
            // of the OLD D, not a property of the result. Silicon: `rczr d wcz`
            // with d=$00000002 gave d=0 with C=1 (old D[1]) and Z=0, so WZ here
            // must NOT go through `wz()` (swp_rczr_fd7bc06a_b); `rczl d wc` with
            // d=$80000000 gave C=1 (old D[31], swp_rczl_fd73c06b). With L=1
            // (bit 18, D a literal) the chip wrote nothing at all -- d, C and Z
            // all came back untouched (swp_rczr_fd67c06a and the other seven
            // L=1 cases per op).

            // (Same arm as RCZR -- see the `Rczr | Rczl` match arm above; the
            // RCZL half is `(D << 2) | (C << 1) | Z`, with C = old D[31] and
            // Z = old D[30], proven by swp_rczl_fd73c06b / fd7bc06b, and the
            // whole instruction suppressed when bit 18 (L) is set.)
            Rczr | Rczl => {
                if !Self::d_is_literal(ins) {
                    let (c0, z0) = (self.cogs[cog].c, self.cogs[cog].z);
                    let (r, nc, nz) = match ins.op {
                        Rczr => (
                            ((c0 as u32) << 31) | ((z0 as u32) << 30) | (d >> 2),
                            (d >> 1) & 1 != 0,
                            d & 1 != 0,
                        ),
                        _ => (
                            (d << 2) | ((c0 as u32) << 1) | z0 as u32,
                            (d >> 31) & 1 != 0,
                            (d >> 30) & 1 != 0,
                        ),
                    };
                    self.set_reg(cog, ins.d, r);
                    if ins.c {
                        self.cogs[cog].c = nc;
                    }
                    if ins.z {
                        self.cogs[cog].z = nz;
                    }
                }
            }
            // CMPR is the *reverse* unsigned compare -- it pairs with `Subr`,
            // not with `Cmp`. Silicon: $80000000 vs #1 gives C=1 where plain
            // `cmp` gives C=0, and 2 vs S=3 gives C=0 where `cmp` gives C=1,
            // so C is the borrow of (S - D). D and S are left alone.
            Cmpr => {
                let (r, borrow) = s.overflowing_sub(d);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = borrow;
                }
            }
            // CMPSUB subtracts only when it fits. Silicon: $80000000 - #1 =
            // $7FFFFFFF with C=1, while D=2 against S=3 is left at 2 with C=0.
            // The WC=0 cases show the same D, so the writeback is NOT gated on
            // WC -- only the flag is.
            Cmpsub => {
                let fits = d >= s;
                let r = if fits { d.wrapping_sub(s) } else { d };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, d.wrapping_sub(s));
                if ins.c {
                    self.cogs[cog].c = fits;
                }
            }
            // INCMOD counts 0..S and wraps to 0 at S. Every probe case had
            // D != S, so silicon only shows the plain path -- $80000000 ->
            // $80000001 and 2 -> 3, both with C=0 -- and the +1 is the same
            // whatever S is, which rules out D+S. The D == S wrap (D = 0,
            // C = 1) is documented but NOT covered by the golden set.
            Incmod => {
                let wrap = d == s;
                let r = if wrap { 0 } else { d.wrapping_add(1) };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = wrap;
                }
            }
            // DECMOD counts S..0 and reloads S at 0. Every probe case had
            // D != 0, so silicon only shows the plain path -- $80000000 ->
            // $7FFFFFFF and 2 -> 1, both with C=0 -- and the -1 is the same
            // whatever S is, which rules out D-S. The D == 0 wrap (D = S,
            // C = 1) is documented but NOT covered by the golden set.
            Decmod => {
                let wrap = d == 0;
                let r = if wrap { s } else { d.wrapping_sub(1) };
                self.set_reg(cog, ins.d, r);
                self.wz(cog, ins, r);
                if ins.c {
                    self.cogs[cog].c = wrap;
                }
            }
            // CRCBIT/CRCNIB share opcode %1001110 with DECOD/BMASK: the WC and
            // WZ bits select the sub-op (00/01/10/11), so neither can write a
            // flag -- and `self.wz` must NOT be called here, since `ins.z` is 1
            // for every CRCNIB. C is an input: the bit fed into the CRC.
            Crcbit => {
                let feed = self.cogs[cog].c ^ (d & 1 != 0);
                let mut r = d >> 1;
                if feed {
                    r ^= s;
                }
                self.set_reg(cog, ins.d, r);
            }
            Crcnib => {
                // Four CRCBIT steps in one instruction, taking the data bit
                // from the top of Q (MSB first) instead of C. Silicon:
                // $F9DFC001 with D=2, S=#1 gave $00000001 -- `(D >> 1) ^ S`;
                // xor-BEFORE-shift would have produced 0, so the shift comes
                // first. Q was 0 in every probe case ($80000000 -> $08000000 is
                // four bare shifts), so the Q path is the documented behaviour,
                // not silicon-derived. NOTE: `setq` is a one-shot prefix here,
                // so `setq / crcnib / crcnib` sees Q=0 on the second one --
                // that needs a persistent `q` in `Cog`.
                let mut r = d;
                let mut q = self.cogs[cog].setq.unwrap_or(0);
                for _ in 0..4 {
                    let feed = (q >> 31 != 0) ^ (r & 1 != 0);
                    r >>= 1;
                    if feed {
                        r ^= s;
                    }
                    q = q.rotate_left(1);
                }
                self.set_reg(cog, ins.d, r);
            }
            // SCA/SCAS do not write D: silicon returned D and S untouched in
            // all 16 probe cases. Bit 20 is opcode here (SCA vs SCAS), not WC,
            // so C is never written -- WZ is the only flag. Z is the zero flag
            // of the UNSHIFTED 16x16 product, not of the scaled result:
            // `sca $00000002,#3 wz` left Z=0 (fa2bc1e1_b) even though
            // (2*3)>>16 is 0, while $80000000 -- low word 0 -- gave Z=1
            // (fa2bc1e1). The scaled value is meant to substitute the NEXT
            // instruction's S operand; alt_s carries a register address, not a
            // value, so that half is not modelled, and no probe case can see
            // it (every product in the corpus is 0).

            // (same arm as SCA -- see the Sca | Scas arm above; SCAS is
            // selected by bit 20 of the encoding, and only the signed multiply
            // differs. Silicon: fa3bc1e1 (WZ, D=$80000000 so the low word is 0)
            // -> z=1, D untouched; fa3bc1e1_b (D=$2, S=$3) -> z=0 even though
            // the scaled result would be 0, so Z is the unshifted product.)
            Sca | Scas => {
                let prod = if ins.op == Sca {
                    (d & 0xFFFF).wrapping_mul(s & 0xFFFF)
                } else {
                    (d as u16 as i16 as i32).wrapping_mul(s as u16 as i16 as i32) as u32
                };
                self.wz(cog, ins, prod);
            }
            // BITRND shares opcode %0100110 with `TESTB D,{#}S XORC/XORZ`:
            // silicon picks between them with the C and Z bits, and the
            // decoder hands both here (TESTB_BY_OP covers only %0100000 and
            // %0100001). C != Z is the TESTB -- the flag takes flag ^ D[S[4:0]]
            // and D is NOT written (f4d7c001_b: bit 1 of $00000002 is 1, so
            // C = 0^1 = 1 and D stayed $00000002). C == Z is the bit write over
            // the ADDBITS span, and with WCZ both flags take the ORIGINAL base
            // bit, not the bit just written (f4dfc001_b: $00000002 -> $00000000
            // with C=Z=1). The written bit is silicon's RND: the eight C == Z
            // goldens captured real entropy (RND came out 1,0,1,0,0,1,1,0, the
            // same encoding drawing both), so they can never be replayed -- we
            // stir the cog's own clock counter, arbitrary but repeatable.
            Bitrnd => {
                let base = s & 31;
                let prior = (d >> base) & 1 != 0;
                if ins.c != ins.z {
                    if ins.c {
                        self.cogs[cog].c ^= prior;
                    } else {
                        self.cogs[cog].z ^= prior;
                    }
                } else {
                    let count = ((s >> 5) & 31) + 1;
                    let mut rnd = self.cogs[cog].clocks ^ 0x2545_F491_4F6C_DD1D;
                    let mut r = d;
                    for i in 0..count {
                        rnd = rnd
                            .wrapping_mul(0x5851_F42D_4C95_7F2D)
                            .wrapping_add(0x1405_7B7E_F767_814F);
                        let m = 1u32 << ((base + i) & 31);
                        if (rnd >> 33) & 1 != 0 {
                            r |= m;
                        } else {
                            r &= !m;
                        }
                    }
                    self.set_reg(cog, ins.d, r);
                    if ins.c {
                        self.cogs[cog].c = prior;
                    }
                    if ins.z {
                        self.cogs[cog].z = prior;
                    }
                }
            }
            // ADDPIX/MULPIX/BLNPIX/MIXPIX share one opcode: bits 20/19 SELECT
            // the op, so they are never WC/WZ here -- do not call self.wz().
            // Silicon: $80000000 + $00000001 -> $80000001, $02 + $03 -> $05,
            // with C and Z left exactly as they were.
            Addpix => {
                let db = d.to_le_bytes();
                let sb = s.to_le_bytes();
                let mut out = [0u8; 4];
                for (i, o) in out.iter_mut().enumerate() {
                    // Independent byte lanes, saturating at $FF.
                    *o = ((db[i] as u32) + (sb[i] as u32)).min(0xFF) as u8;
                }
                self.set_reg(cog, ins.d, u32::from_le_bytes(out));
            }
            // MULPIX: per-byte multiply with $FF = 1.0. The P2-EVAL returns $01
            // for BOTH $02*$03 and $02*$01, so the product rounds up -- the
            // textbook (a*b+128)>>8 / div-255 forms return 0 there. "+$FF then
            // >>8" is also exactly what makes $FF*$FF come back as $FF.
            // Lanes are independent: $80000000 * $00000001 is 0, not the
            // 32-bit product. C/Z are opcode bits here, so no flag write.
            Mulpix => {
                let db = d.to_le_bytes();
                let sb = s.to_le_bytes();
                let mut out = [0u8; 4];
                for (i, o) in out.iter_mut().enumerate() {
                    *o = (((db[i] as u32) * (sb[i] as u32) + 0xFF) >> 8) as u8;
                }
                self.set_reg(cog, ins.d, u32::from_le_bytes(out));
            }
            // RGBSQZ squeezes the 8:8:8 value in D[31:8] into 5:6:5 in D[15:0]
            // and clears D[31:16]; D[7:0] is discarded ($80000000 -> $00008000,
            // $00000002 -> 0). This encoding has no WC/WZ form and silicon
            // agrees: with WZ set, a zero result still leaves Z clear. With the
            // L bit set (D a literal) silicon writes nothing at all -- the
            // fd67/fd6f/fd77/fd7f cases return D untouched.
            Rgbsqz => {
                if !Self::d_is_literal(ins) {
                    let r = ((d >> 27) & 0x1F) << 11 | ((d >> 18) & 0x3F) << 5 | ((d >> 11) & 0x1F);
                    self.set_reg(cog, ins.d, r);
                }
            }
            // RGBEXP expands the 5:6:5 value in D[15:0] into 8:8:8 in D[31:8]
            // with D[7:0] cleared ($00000002 -> $00001000, i.e. B=%00010 became
            // $10; $80000000 -> 0 because D[15:0] is empty). Like RGBSQZ it has
            // no WC/WZ form -- with WZ set, a zero result still leaves Z clear
            // -- and with the L bit set silicon writes nothing at all.
            Rgbexp => {
                if !Self::d_is_literal(ins) {
                    let (r5, g6, b5) = ((d >> 11) & 0x1F, (d >> 5) & 0x3F, d & 0x1F);
                    let r = ((r5 << 3 | r5 >> 2) << 24)
                        | ((g6 << 2 | g6 >> 4) << 16)
                        | ((b5 << 3 | b5 >> 2) << 8);
                    self.set_reg(cog, ins.d, r);
                }
            }
            // SPLITB/SPLITW de-interleave D; MERGEB/MERGEW are their inverses.
            // P2-EVAL: $00000002 -> splitb $00000100, mergeb $00000010,
            // splitw $00010000, mergew $00000004, and $80000000 is a fixed
            // point for all four. Bits 20/19 look like WC/WZ but are inert
            // here: with bit 20 set and a result whose MSB *and* parity are 1
            // the chip still reported C=0, and the same misc block's
            // RGBSQZ/RGBEXP report Z=0 on a zero result with bit 19 set.
            // With L (bit 18) set, D is a literal and nothing is written back.
            Splitb | Mergeb | Splitw | Mergew => {
                if !Self::d_is_literal(ins) {
                    // The bit at MSB-position p lands at MSB-position
                    // (p % m) * (32 / m) + p / m.
                    let m: u32 = match ins.op {
                        Splitb => 4,
                        Mergeb => 8,
                        Splitw => 2,
                        _ => 16,
                    };
                    let mut r = 0u32;
                    for p in 0..32u32 {
                        if (d >> (31 - p)) & 1 != 0 {
                            r |= 1 << (31 - ((p % m) * (32 / m) + p / m));
                        }
                    }
                    self.set_reg(cog, ins.d, r);
                }
            }
            // MUXNITS/MUXNIBS merge S into D under a mask built from S itself:
            // each 2-bit (NITS) or 4-bit (NIBS) field of S that is non-zero
            // selects S there, the rest keep D. Bits 20/19 are opcode bits
            // (%1001111 CZ picks MUXNITS/MUXNIBS/MUXQ/MOVBYTS), NOT WC/WZ, so
            // nothing here may touch the flags -- silicon returned C=0 Z=0 on
            // every case, and ins.z is set for MUXNIBS by the selector alone.
            // P2-EVAL: D=$00000002 S=$00000003 -> $00000003, but D=$00000002
            // S=#1 -> $00000001, which is what rules out a plain OR.
            Muxnits | Muxnibs => {
                let w: usize = if ins.op == Muxnits { 2 } else { 4 };
                let field = (1u32 << w) - 1;
                let mut mask = 0u32;
                for i in (0..32usize).step_by(w) {
                    if (s >> i) & field != 0 {
                        mask |= field << i;
                    }
                }
                let r = (d & !mask) | (s & mask);
                self.set_reg(cog, ins.d, r);
            }
            // ---- LUT RAM
            Rdlut => {
                // Silicon: D = LUT[S[8:0]]. The probe read $1E0 back from LUT
                // 0 and 1 -- exactly what its own `wrlut #$1E0,#0/#1` cases
                // (the L=1 encodings) had stored there in an EARLIER capture
                // session: a cog's LUT survives COGSTOP/COGINIT and reset, and
                // the sweep runs RDLUT (op $55) before WRLUT (op $61). So the
                // goldens prove RDLUT reads what WRLUT wrote, but only across
                // sessions -- a fresh Machine starts with a zeroed LUT.
                // S is a plain 9-bit LUT address, NOT a PTR expression:
                // $100..$1FF are real LUT addresses, and the boot ROM's
                // circular receive buffer (`rdlut x,tail`) uses the register
                // form.
                let v = self.cogs[cog].lut[(s as usize) & (LUT_LONGS - 1)];
                self.set_reg(cog, ins.d, v);
                self.wz(cog, ins, v);
                if ins.c {
                    self.cogs[cog].c = v >> 31 != 0;
                }
            }
            Wrlut => {
                // Silicon: LUT[S[8:0]] = D and nothing else moves -- d, s, C
                // and Z all came back unchanged for every encoding. WRLUT's
                // bit 20 is an opcode selector (WYPIN is the C=0 half of
                // opcode $61), so no WRLUT encoding can ask for WC; bit 19 is
                // L, and the L=1 cases stored the literal $1E0 -- which the
                // RDLUT cases then read back.
                let at = (s as usize) & (LUT_LONGS - 1);
                self.cogs[cog].lut[at] = d;
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
