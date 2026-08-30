//! The CPU's only outward surface.
//!
//! `p2core` deliberately has no embsim dependency: hub bytes go in, `PinBus`
//! calls come out, and `step_until` moves time. Everything electrical — smart
//! pin state machines, nets, UART peers — lives on the other side of this
//! trait, so promoting the crate into `embsim-p2-iss` later is a `git mv`
//! rather than a refactor.

/// What the interpreter can do to the outside world.
///
/// Implementations model the smart-pin hardware; the CPU only forwards what the
/// firmware executed.
///
/// # Polarity
///
/// - [`PinBus::rdpin`]'s bool becomes C, and C means **busy**, not ready.
///   `__system___txraw` spins on `rdpin #62 wc` / `if_b jmp`, so returning
///   `true` forever hangs the guest.
/// - [`PinBus::testp`] reports the pin's IN flag, and drivers spin with
///   `if_nc jmp` waiting for it, so it must read `true` once an operation has
///   completed.
pub trait PinBus {
    /// Read pin input states 0..31 (`INA`) and 32..63 (`INB`).
    fn ina(&self) -> u32 {
        0
    }
    fn inb(&self) -> u32 {
        0
    }

    /// `DIRA/DIRB/OUTA/OUTB` were written. `reg` is the cog register address so
    /// a model can tell A from B without the CPU interpreting pin semantics.
    fn dir_out_changed(&mut self, _reg: u16, _value: u32) {}

    /// `WRPIN` — set a pin's mode word.
    fn wrpin(&mut self, _pin: u8, _cfg: u32) {}
    /// `WXPIN` — set a pin's X parameter (bit period, mode-specific).
    fn wxpin(&mut self, _pin: u8, _x: u32) {}
    /// `WYPIN` — set a pin's Y parameter (the value/count a mode consumes).
    fn wypin(&mut self, _pin: u8, _y: u32) {}
    /// `RDPIN`/`RQPIN` — read a pin's result; the bool becomes C (busy).
    fn rdpin(&mut self, _pin: u8) -> (u32, bool) {
        (0, false)
    }
    /// `TESTP` — sample a pin's IN flag without consuming it.
    fn testp(&self, _pin: u8) -> bool {
        false
    }
    /// `AKPIN` — acknowledge, clearing a pin's IN flag.
    fn akpin(&mut self, _pin: u8) {}
}

/// A bus where nothing is connected. Enough to boot; hangs any driver that
/// waits on a pin, so prefer [`crate::SmartPins`] for real runs.
#[derive(Debug, Default, Clone, Copy)]
pub struct NullPins;

impl PinBus for NullPins {}
