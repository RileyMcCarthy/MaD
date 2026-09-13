//! A P2 pulse pin, as timed level transitions on a net.
//!
//! The step train is the one signal the firmware produces continuously and at
//! a rate, so it is the seam most tempting to hand across as a number. It is
//! not handed across here: every transition is a [`TheveninDrive`] on the net,
//! resolved like any other, which is what lets a scope component, a series
//! resistor or a second driver on the same net behave the way they would on
//! the bench.
//!
//! # The two modes, from the firmware's own HAL
//!
//! `HAL_pulseOut.c` programs exactly two, and they differ in a way that
//! matters here:
//!
//! | mode | X | Y | shape |
//! |---|---|---|---|
//! | `P_TRANSITION` | half-period in clocks | transition **count** | a finite train |
//! | `P_NCO_FREQ` | 1 | NCO word | a continuous square wave |
//!
//! `P_TRANSITION` terminates, so its cost is bounded by the move. `P_NCO_FREQ`
//! does not: it runs until the firmware stops it, and every edge is an engine
//! event. That is the case a rate-carried (`Periodic`) drive would collapse to
//! one event per rate *change* — see `docs/dev/sil-unified-drive.md`. Until
//! that exists, this emits the edges, and [`PulseDriver::emitted`] is how much
//! it cost.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use embsim_board::{
    digital_drive, Level, PinHandle, PulseDirection, PulseSegment, PulseTrain, PulseTx,
};

/// A pulse pin driving a net.
#[derive(Debug)]
pub struct PulseDriver {
    pin: u8,
    handle: PinHandle,
    /// The rate channel this pin publishes on, when the net routes one.
    ///
    /// A step train is a *rate*, not a level history: driving it edge by edge
    /// makes every step a wheel deadline, and any service that arrives late
    /// collapses the edges it missed into one `set_drive` of the final level —
    /// an even number of them is no change at all, so a consumer that counts
    /// transitions loses them silently. At 20 mm/s that lost all but ~1.5% of
    /// the commanded distance. Published as a segment instead, the consumer
    /// integrates the rate and no step can be dropped.
    tx: Option<PulseTx>,
    /// The last segment published, for folding its count into the next one.
    published: Mutex<Option<PulseTrain>>,
    state: Mutex<TrainState>,
    /// Transitions put on the net. The cost of not having a periodic drive,
    /// counted rather than estimated.
    emitted: AtomicU64,
}

/// What the pin is currently doing.
#[derive(Debug, Default, Clone, Copy)]
struct TrainState {
    /// Nanoseconds between transitions. Zero means "not running".
    period_ns: u64,
    /// Transitions still owed, or `None` for a continuous wave.
    remaining: Option<u64>,
    /// When the next transition is due.
    next_ns: u64,
    /// The level currently driven.
    level: bool,
}

impl PulseDriver {
    /// Attach the rate channel. Without it the driver falls back to edges.
    pub fn with_tx(mut self, tx: Option<PulseTx>) -> Self {
        self.tx = tx;
        self
    }

    /// Publish a constant-rate segment, folding the outgoing one's count in.
    ///
    /// `freq_hz` of 0 holds the channel (a stopped train).
    fn publish(&self, now_ns: u64, freq_hz: u32, total: Option<u64>) -> bool {
        let Some(tx) = self.tx.as_ref() else {
            return false;
        };
        let now_us = now_ns / 1_000;
        let mut published = self.published.lock().expect("pulse state never poisoned");
        let emitted = published
            .as_ref()
            .map_or(0, |previous| previous.emitted_at(now_us));
        let train = PulseTrain {
            pulses: PulseSegment {
                emitted,
                freq_hz,
                total,
                since_us: now_us,
            },
            // The drive reads its own DIR pin, so the segment carries no
            // direction of its own (`TrainDirection::DirPin`).
            direction: PulseDirection::Forward,
        };
        *published = Some(train);
        drop(published);
        tx.set_train(train);
        true
    }

    pub fn new(pin: u8, handle: PinHandle) -> Self {
        Self {
            pin,
            handle,
            tx: None,
            published: Mutex::new(None),
            state: Mutex::new(TrainState::default()),
            emitted: AtomicU64::new(0),
        }
    }

    pub fn pin(&self) -> u8 {
        self.pin
    }

    /// Transitions this pin has put on its net.
    pub fn emitted(&self) -> u64 {
        self.emitted.load(Ordering::Relaxed)
    }

    /// Drive the idle level, so the net has a reference before the first edge.
    pub fn idle(&self) {
        self.handle.set_drive(Some(digital_drive(Level::Low)));
    }

    /// Start a finite train: `transitions` edges, `half_period_clocks` apart.
    ///
    /// This is `P_TRANSITION`, where the firmware asks for `pulses * 2`
    /// transitions — a pulse being a rising and a falling edge.
    pub fn start_transitions(
        &self,
        now_ns: u64,
        transitions: u64,
        half_period_clocks: u32,
        clkfreq: u32,
    ) {
        let period_ns = clocks_to_ns(half_period_clocks.max(1), clkfreq);
        // Two transitions to a pulse, so the channel's rate is half the
        // transition rate and its ceiling half the transition count.
        let pulses = transitions / 2;
        let freq_hz = (1_000_000_000f64 / (2.0 * period_ns as f64))
            .round()
            .max(0.0) as u32;
        let banked = self
            .published
            .lock()
            .expect("pulse state never poisoned")
            .as_ref()
            .map_or(0, |previous| previous.emitted_at(now_ns / 1_000));
        if self.publish(now_ns, freq_hz, Some(banked.saturating_add(pulses))) {
            let mut state = self.state.lock().expect("pulse state never poisoned");
            *state = TrainState {
                level: state.level,
                ..TrainState::default()
            };
            return;
        }
        let mut state = self.state.lock().expect("pulse state never poisoned");
        *state = TrainState {
            period_ns,
            remaining: Some(transitions),
            next_ns: now_ns.saturating_add(period_ns),
            level: state.level,
        };
    }

    /// Start (or retune) a continuous square wave from an NCO word.
    ///
    /// The P2 adds `Y` to a 32-bit accumulator every clock and toggles on
    /// overflow, so the output frequency is `Y * clkfreq / 2^32` and there are
    /// two transitions per period. Retuning replaces the rate without
    /// restarting the phase, which is what `_wypin` on a live NCO pin does.
    pub fn set_nco(&self, now_ns: u64, nco_word: u32, clkfreq: u32) {
        let mut state = self.state.lock().expect("pulse state never poisoned");
        if nco_word == 0 {
            *state = TrainState {
                level: state.level,
                ..TrainState::default()
            };
            drop(state);
            self.publish(now_ns, 0, None);
            return;
        }
        // The rate channel carries pulses, not transitions: one pulse per NCO
        // overflow, `Y * clkfreq / 2^32` of them a second.
        let pulses_per_s = f64::from(nco_word) * f64::from(clkfreq) / 4_294_967_296.0;
        if self.publish(now_ns, pulses_per_s.round().max(0.0) as u32, None) {
            // The channel carries the whole train; the pin holds its level.
            *state = TrainState {
                level: state.level,
                ..TrainState::default()
            };
            return;
        }
        // transitions/s = 2 * freq = 2 * Y * clkfreq / 2^32
        let transitions_per_s = 2.0 * f64::from(nco_word) * f64::from(clkfreq) / 4_294_967_296.0;
        if transitions_per_s <= 0.0 {
            return;
        }
        let period_ns = (1e9 / transitions_per_s).round().max(1.0) as u64;
        // Keep the existing deadline when only the rate changed, so retuning
        // mid-train does not stretch the edge already scheduled.
        let next_ns = if state.period_ns == 0 {
            now_ns.saturating_add(period_ns)
        } else {
            state.next_ns
        };
        *state = TrainState {
            period_ns,
            remaining: None,
            next_ns,
            level: state.level,
        };
    }

    /// Stop the train, holding the current level.
    ///
    /// `now_ns` because the rate channel must be told: a segment published
    /// with `total: None` runs until something supersedes it, so a driver
    /// that only cleared its local edge state would leave the sink
    /// integrating the last rate forever — the carriage would keep moving
    /// after `_pinclear` handed the pin back, which is exactly what this
    /// call exists to prevent (a disable or an e-stop at speed).
    pub fn stop(&self, now_ns: u64) {
        {
            let mut state = self.state.lock().expect("pulse state never poisoned");
            *state = TrainState {
                level: state.level,
                ..TrainState::default()
            };
        }
        self.publish(now_ns, 0, None);
    }

    /// Emit every transition due by `now_ns`, returning when the next one is.
    pub fn service(&self, now_ns: u64) -> Option<u64> {
        let mut state = self.state.lock().expect("pulse state never poisoned");
        let step = state.advance(now_ns);
        if step.fired > 0 {
            self.emitted.fetch_add(step.fired, Ordering::Relaxed);
            let level = state.level;
            drop(state);
            self.handle.set_drive(Some(digital_drive(if level {
                Level::High
            } else {
                Level::Low
            })));
        }
        step.next_ns
    }
}

/// What one `advance` did.
#[derive(Debug, PartialEq, Eq)]
struct Step {
    /// Transitions emitted.
    fired: u64,
    /// When the next is due, or `None` if the train is finished.
    next_ns: Option<u64>,
}

impl TrainState {
    /// Advance to `now_ns`, toggling for every transition that came due.
    ///
    /// Catch-up is bounded: the engine can hand back a `now_ns` many periods
    /// past the last, and driving each separately would be both slow and
    /// pointless — the net only holds the final level. The **count** still
    /// advances past the cap, because a plant integrates edges and losing them
    /// would lose distance.
    fn advance(&mut self, now_ns: u64) -> Step {
        const CATCH_UP_MAX: u64 = 256;

        if self.period_ns == 0 {
            return Step {
                fired: 0,
                next_ns: None,
            };
        }
        let mut fired = 0u64;
        while self.next_ns <= now_ns {
            if self.remaining == Some(0) {
                self.period_ns = 0;
                return Step {
                    fired,
                    next_ns: None,
                };
            }
            if let Some(remaining) = self.remaining {
                self.remaining = Some(remaining - 1);
            }
            self.level = !self.level;
            self.next_ns = self.next_ns.saturating_add(self.period_ns);
            fired += 1;
            if fired >= CATCH_UP_MAX {
                break;
            }
        }
        Step {
            fired,
            next_ns: Some(self.next_ns),
        }
    }
}

/// Clocks to nanoseconds at `clkfreq`, rounded to at least one.
fn clocks_to_ns(clocks: u32, clkfreq: u32) -> u64 {
    let hz = if clkfreq == 0 { 160_000_000 } else { clkfreq } as u64;
    (u64::from(clocks) * 1_000_000_000 / hz).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A train of `n` transitions emits exactly `n`, then stops asking to be
    /// woken. One edge too many is a step the firmware did not command.
    #[test]
    fn a_finite_train_emits_exactly_what_was_asked_for() {
        let mut train = TrainState {
            period_ns: 100,
            remaining: Some(6),
            next_ns: 100,
            level: false,
        };
        // Well past the end: everything comes due at once.
        let step = train.advance(10_000);
        assert_eq!(step.fired, 6, "six transitions were asked for");
        assert_eq!(step.next_ns, None, "and the train is finished");
        // A finished train stays finished.
        assert_eq!(
            train.advance(20_000),
            Step {
                fired: 0,
                next_ns: None
            }
        );
    }

    /// Transitions land on their deadlines, not on the wake that noticed them.
    #[test]
    fn transitions_are_paced_by_the_programmed_period() {
        let mut train = TrainState {
            period_ns: 100,
            remaining: Some(4),
            next_ns: 100,
            level: false,
        };
        assert_eq!(
            train.advance(99),
            Step {
                fired: 0,
                next_ns: Some(100)
            }
        );
        assert_eq!(
            train.advance(100),
            Step {
                fired: 1,
                next_ns: Some(200)
            }
        );
        assert!(train.level, "the first transition drives high");
        assert_eq!(
            train.advance(250),
            Step {
                fired: 1,
                next_ns: Some(300)
            }
        );
        assert!(!train.level, "and the second drives back low");
    }

    /// A continuous wave never finishes, and catch-up is bounded — but the
    /// count is not, because the plant integrates edges into distance.
    #[test]
    fn a_continuous_wave_catches_up_without_running_away() {
        let mut train = TrainState {
            period_ns: 10,
            remaining: None,
            next_ns: 10,
            level: false,
        };
        // 100_000 ns at 10 ns per transition is 10_000 due at once.
        let step = train.advance(100_000);
        assert_eq!(step.fired, 256, "catch-up is capped");
        assert!(step.next_ns.is_some(), "a continuous wave never finishes");
    }

    #[test]
    fn a_half_period_in_clocks_becomes_nanoseconds() {
        // 160 MHz: one clock is 6.25 ns, so 800 clocks is 5 µs.
        assert_eq!(clocks_to_ns(800, 160_000_000), 5_000);
        // Never zero: a zero period would spin the scheduler.
        assert_eq!(clocks_to_ns(0, 160_000_000), 1);
    }
}
