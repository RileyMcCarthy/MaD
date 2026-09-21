//! Probe-safe subset of the ISA, plus a bucket for every other `Op`.
//!
//! The trampoline is `prefix; op; jmp #after`. Anything that is a prefix
//! (`SETQ`/`AUGS`/`ALTD`), a branch, a wait, or a pin/FIFO/debug op is
//! skipped here and belongs in a dedicated report or timed program.

use crate::generated::decode::{decode, Decoded, Op};

/// Where an opcode is supposed to get its silicon evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OpBucket {
    /// One-instruction trampoline (`hwtest/probe.c`).
    Probe,
    /// Trampoline `pre=` slot (`SETQ`/`AUG*`/`ALT*`).
    Prefix,
    /// `hwtest/locks.c`.
    Locks,
    /// `hwtest/cogs.c`.
    Cogs,
    /// GETCT / WAITX / poll — `hwtest/timed.c`.
    Timed,
    Pin,
    Fifo,
    Cordic,
    Control,
    Stack,
    System,
}

impl OpBucket {
    pub fn name(self) -> &'static str {
        match self {
            Self::Probe => "probe",
            Self::Prefix => "prefix",
            Self::Locks => "locks",
            Self::Cogs => "cogs",
            Self::Timed => "timed",
            Self::Pin => "pin",
            Self::Fifo => "fifo",
            Self::Cordic => "cordic",
            Self::Control => "control",
            Self::Stack => "stack",
            Self::System => "system",
        }
    }
}

/// Test bucket for every decoded mnemonic. Exhaustive on `Op`.
pub fn op_bucket(op: Op) -> OpBucket {
    use Op::*;
    match op {
        Jmp | Jmprel | Call | Calla | Callb | Calld | Callpa | Callpb | Ret | Reta | Retb
        | Reti0 | Reti1 | Reti2 | Reti3 | Resi0 | Resi1 | Resi2 | Resi3 | Djnz | Djz | Djf
        | Djnf | Ijnz | Ijz | Tjz | Tjnz | Tjf | Tjnf | Tjs | Tjns | Tjv | Skip | Skipf | Rep
        | Execf | Loc | Jint | Jct1 | Jct2 | Jct3 | Jse1 | Jse2 | Jse3 | Jse4 | Jpat | Jfbw
        | Jxmt | Jxfi | Jxro | Jxrl | Jatn | Jqmt | Jnint | Jnct1 | Jnct2 | Jnct3 | Jnse1
        | Jnse2 | Jnse3 | Jnse4 | Jnpat | Jnfbw | Jnxmt | Jnxfi | Jnxro | Jnxrl | Jnatn | Jnqmt => {
            OpBucket::Control
        }

        Waitx | Waitint | Waitct1 | Waitct2 | Waitct3 | Waitse1 | Waitse2 | Waitse3 | Waitse4
        | Waitpat | Waitfbw | Waitxmt | Waitxfi | Waitxro | Waitxrl | Waitatn | Pollint
        | Pollct1 | Pollct2 | Pollct3 | Pollse1 | Pollse2 | Pollse3 | Pollse4 | Pollpat
        | Pollfbw | Pollxmt | Pollxfi | Pollxro | Pollxrl | Pollatn | Pollqmt | Getct | Getbrk => {
            OpBucket::Timed
        }

        Coginit | Cogstop | Cogatn | Cogbrk | Cogid => OpBucket::Cogs,

        Locknew | Lockret | Locktry | Lockrel => OpBucket::Locks,

        Dirh | Dirl | Dirnot | Dirc | Dirnc | Dirz | Dirnz | Dirrnd | Drvh | Drvl | Drvnot
        | Drvc | Drvnc | Drvz | Drvnz | Drvrnd | Outh | Outl | Outnot | Outc | Outnc | Outz
        | Outnz | Outrnd | Flth | Fltl | Fltnot | Fltc | Fltnc | Fltz | Fltnz | Fltrnd | Wrpin
        | Wxpin | Wypin | Rdpin | Rqpin | Akpin | Testp | Testpn => OpBucket::Pin,

        Rdfast | Wrfast | Fblock | Xinit | Xzero | Xcont | Xstop | Rfbyte | Rfword | Rflong
        | Rfvar | Rfvars | Wfbyte | Wfword | Wflong | Xoro32 => OpBucket::Fifo,

        Setq | Setq2 | Augs | Augd | Altd | Alts | Altr | Altb | Alti | Altsn | Altgn | Altsb
        | Altgb | Altsw | Altgw => OpBucket::Prefix,

        Qmul | Qdiv | Qfrac | Qsqrt | Qrotate | Qvector | Qlog | Qexp | Getqx | Getqy => {
            OpBucket::Cordic
        }

        Push | Pusha | Pushb | Pop | Popa | Popb => OpBucket::Stack,

        Hubset | Asmclk | Allowi | Stalli | Brk | Debug | Nixint1 | Nixint2 | Nixint3 | Trgint1
        | Trgint2 | Trgint3 | Setint1 | Setint2 | Setint3 | Setse1 | Setse2 | Setse3 | Setse4
        | Setpat | Setcfrq | Setci | Setcmod | Setcq | Setcy | Setdacs | Setpiv | Setpix
        | Setxfrq | Setluts | Setscp | Getscp | Getptr | Getrnd | Getxacc | Setd | Sets | Setr => {
            OpBucket::System
        }

        Abs | Add | Addct1 | Addct2 | Addct3 | Addpix | Adds | Addsx | Addx | And | Andn | Bitc
        | Bith | Bitl | Bitnc | Bitnot | Bitnz | Bitrnd | Bitz | Blnpix | Bmask | Cmp | Cmpm
        | Cmpr | Cmps | Cmpsub | Cmpsx | Cmpx | Crcbit | Crcnib | Decmod | Decod | Encod | Fge
        | Fges | Fle | Fles | Getbyte | Getnib | Getword | Incmod | Mergeb | Mergew | Mixpix
        | Modc | Modcz | Modz | Mov | Movbyts | Mul | Mulpix | Muls | Muxc | Muxnc | Muxnibs
        | Muxnits | Muxnz | Muxq | Muxz | Neg | Negc | Negnc | Negnz | Negz | Nop | Not | Ones
        | Or | Rcl | Rcr | Rczl | Rczr | Rdbyte | Rdlong | Rdlut | Rdword | Rev | Rgbexp
        | Rgbsqz | Rol | Rolbyte | Rolnib | Rolword | Ror | Sal | Sar | Sca | Scas | Setbyte
        | Setnib | Setword | Seussf | Seussr | Shl | Shr | Signx | Splitb | Splitw | Sub | Subr
        | Subs | Subsx | Subx | Sumc | Sumnc | Sumnz | Sumz | Test | Testb | Testbn | Testn
        | Wmlong | Wrbyte | Wrc | Wrlong | Wrlut | Wrnc | Wrnz | Wrword | Wrz | Xor | Zerox => {
            OpBucket::Probe
        }
    }
}

/// Why an op is excluded from the one-instruction probe, or `None` if it
/// can run as the trampoline's `op` slot.
pub fn probe_skip_reason(op: Op) -> Option<&'static str> {
    match op_bucket(op) {
        OpBucket::Probe => None,
        OpBucket::Prefix => Some("prefix (would modify the trampoline's next insn)"),
        OpBucket::Locks => Some("locks (see locks.c)"),
        OpBucket::Cogs => Some("cog control (see cogs.c)"),
        OpBucket::Timed => Some("time / poll (see timed.c)"),
        OpBucket::Pin => Some("pin / smart-pin"),
        OpBucket::Fifo => Some("FIFO / streamer"),
        OpBucket::Cordic => Some("CORDIC (result in Q, not D)"),
        OpBucket::Control => Some("control-flow / trampoline PC"),
        OpBucket::Stack => Some("stack"),
        OpBucket::System => Some("system / interrupt / self-modifying"),
    }
}

pub fn is_probe_safe(op: Op) -> bool {
    probe_skip_reason(op).is_none()
}

/// One encoding the trampoline can run.
#[derive(Debug, Clone, Copy)]
pub struct ProbeEncoding {
    pub word: u32,
    pub op: Op,
    pub hub: bool,
}

fn s1_word(op7: u32, c: u32, z: u32, i: u32, d: u32, s: u32) -> u32 {
    (0xF << 28) | (op7 << 21) | (c << 20) | (z << 19) | (i << 18) | ((d & 0x1FF) << 9) | (s & 0x1FF)
}

fn consider(word: u32, out: &mut Vec<ProbeEncoding>, seen: &mut std::collections::BTreeSet<u32>) {
    let Some(Decoded { op, .. }) = decode(word) else {
        return;
    };
    if !is_probe_safe(op) {
        return;
    }
    if !seen.insert(word) {
        return;
    }
    let hub = matches!(
        op,
        Op::Wrlong
            | Op::Wrword
            | Op::Wrbyte
            | Op::Wmlong
            | Op::Rdlong
            | Op::Rdword
            | Op::Rdbyte
            | Op::Rdlut
            | Op::Wrlut
    );
    out.push(ProbeEncoding { word, op, hub });
}

/// Every probe-safe encoding in the S1 (op × C × Z × I) and S4 (S-selector)
/// grids, with D=`$1E0` and S=`$1E1` (or S=`#1` when I=1).
pub fn probe_encodings() -> Vec<ProbeEncoding> {
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    const DREG: u32 = 0x1E0;
    const SREG: u32 = 0x1E1;

    for op7 in 0..128u32 {
        for cz in 0..4u32 {
            let c = (cz >> 1) & 1;
            let z = cz & 1;
            for i in 0..2u32 {
                let s = if i == 1 { 1 } else { SREG };
                consider(s1_word(op7, c, z, i, DREG, s), &mut out, &mut seen);
            }
        }
    }
    // Misc block: S is the sub-opcode. Cover every S, not just $1E1.
    const MISC: u32 = 0b1101011;
    for s in 0..512u32 {
        for cz in 0..4u32 {
            let c = (cz >> 1) & 1;
            let z = cz & 1;
            for i in 0..2u32 {
                consider(s1_word(MISC, c, z, i, DREG, s), &mut out, &mut seen);
            }
        }
    }
    out
}

/// Ops the decoder can produce from the probe grids, grouped by skip reason.
pub fn probe_grid_ops() -> Vec<(Op, Option<&'static str>)> {
    let mut map = std::collections::HashMap::new();
    for e in probe_encodings() {
        map.entry(e.op).or_insert(None);
    }
    const DREG: u32 = 0x1E0;
    const SREG: u32 = 0x1E1;
    for op7 in 0..128u32 {
        for cz in 0..4u32 {
            for i in 0..2u32 {
                let s = if i == 1 { 1 } else { SREG };
                let w = s1_word(op7, (cz >> 1) & 1, cz & 1, i, DREG, s);
                if let Some(d) = decode(w) {
                    map.entry(d.op).or_insert(probe_skip_reason(d.op));
                }
            }
        }
    }
    const MISC: u32 = 0b1101011;
    for s in 0..512u32 {
        for cz in 0..4u32 {
            for i in 0..2u32 {
                let w = s1_word(MISC, (cz >> 1) & 1, cz & 1, i, DREG, s);
                if let Some(d) = decode(w) {
                    map.entry(d.op).or_insert(probe_skip_reason(d.op));
                }
            }
        }
    }
    let mut v: Vec<_> = map.into_iter().collect();
    v.sort_by_key(|(op, _)| op.mnemonic());
    v
}
