//! A P2 pulse pin, as a square wave its net carries.
//!
//! The step train is the one signal the firmware produces continuously and at
//! a rate. It still crosses the net as voltages: the pin publishes a
//! [`Drive::Periodic`] — the Thevenin port of its high phase, the one of its
//! low phase, and the [`PeriodicSchedule`] that alternates them — and the
//! engine resolves that square wave like any other drive, so a pull-up, a
//! series resistor or a second driver on the same net behaves the way it
//! would on the bench. A stepper model on the far end reads the train off its
//! own `STEP` sense.
//!
//! # One publish per rate change
//!
//! The schedule is published when the rate changes — a `WYPIN` starts or
//! retunes a train, `_pinclear` stops it — and never per edge. Each new
//! segment folds the count of the one it replaces (`emitted`), so a reader
//! that integrates segments loses no pulse at a retune. The schedule counts in
//! **nanoseconds** of virtual time: `since_ns` is the instant the segment
//! began, and [`PeriodicSchedule::emitted_at_ns`] reads the count at a
//! nanosecond instant.
//!
//! # The two modes, from the firmware's own HAL
//!
//! `HAL_pulseOut.c` programs exactly two:
//!
//! | mode | X | Y | shape |
//! |---|---|---|---|
//! | `P_TRANSITION` | half-period in clocks | transition **count** | a finite train |
//! | `P_NCO_FREQ` | 1 | NCO word | a continuous square wave |
//!
//! A schedule counts pulses, not transitions: a `P_TRANSITION` train of `n`
//! transitions is `n / 2` pulses at half the transition rate, and a
//! `P_NCO_FREQ` wave is one pulse per accumulator overflow.

use std::sync::Mutex;

use embsim_board::{digital_drive, Drive, Level, PeriodicSchedule, PinHandle};

/// A pulse pin driving a net.
#[derive(Debug)]
pub struct PulseDriver {
    pin: u8,
    handle: PinHandle,
    /// The last segment published, for folding its count into the next one.
    published: Mutex<Option<PeriodicSchedule>>,
}

impl PulseDriver {
    pub fn new(pin: u8, handle: PinHandle) -> Self {
        Self {
            pin,
            handle,
            published: Mutex::new(None),
        }
    }

    pub fn pin(&self) -> u8 {
        self.pin
    }

    /// Publish a constant-rate segment from `now_ns`, folding the outgoing
    /// one's count in. `freq_hz` of 0 holds the count: a stopped train, whose
    /// net rests at the low phase.
    fn publish(&self, now_ns: u64, freq_hz: u32, total: Option<u64>) {
        let mut published = self.published.lock().expect("pulse state never poisoned");
        let emitted = published
            .as_ref()
            .map_or(0, |previous| previous.emitted_at_ns(now_ns));
        let segment = PeriodicSchedule {
            emitted,
            freq_hz,
            total: total.map(|pulses| emitted.saturating_add(pulses)),
            since_ns: now_ns,
        };
        *published = Some(segment);
        drop(published);
        self.handle.drive(Drive::Periodic {
            hi: digital_drive(Level::High),
            lo: digital_drive(Level::Low),
            segment,
        });
    }

    /// Drive the idle level, so the net has a reference before the first
    /// train.
    pub fn idle(&self) {
        self.handle
            .drive(Drive::Thevenin(digital_drive(Level::Low)));
    }

    /// Start a finite train at `now_ns`: `transitions` edges,
    /// `half_period_clocks` apart at `clkfreq`.
    ///
    /// This is `P_TRANSITION`, where the firmware asks for `pulses * 2`
    /// transitions — a pulse being a rising and a falling edge — so the
    /// schedule's rate is half the transition rate and its ceiling half the
    /// transition count, on top of the pulses already emitted.
    pub fn start_transitions(
        &self,
        now_ns: u64,
        transitions: u64,
        half_period_clocks: u32,
        clkfreq: u32,
    ) {
        let half_period_ns = clocks_to_ns(half_period_clocks.max(1), clkfreq);
        let freq_hz = (1_000_000_000f64 / (2.0 * half_period_ns as f64))
            .round()
            .max(0.0) as u32;
        self.publish(now_ns, freq_hz, Some(transitions / 2));
    }

    /// Start (or retune) a continuous square wave from an NCO word at
    /// `now_ns`.
    ///
    /// The P2 adds `Y` to a 32-bit accumulator every clock and toggles on
    /// overflow, so there is one pulse per overflow, `Y * clkfreq / 2^32` of
    /// them a second. Retuning publishes the new rate from `now_ns` with the
    /// count so far folded in, which is what `_wypin` on a live NCO pin does.
    /// A word of 0 stops the train.
    pub fn set_nco(&self, now_ns: u64, nco_word: u32, clkfreq: u32) {
        let pulses_per_s = f64::from(nco_word) * f64::from(clkfreq) / 4_294_967_296.0;
        self.publish(now_ns, pulses_per_s.round().max(0.0) as u32, None);
    }

    /// Stop the train at `now_ns`.
    ///
    /// Publishes a held segment (`freq_hz` 0) that banks the count so far: a
    /// segment with no ceiling runs until something supersedes it, so without
    /// this the far end would keep integrating the last rate after
    /// `_pinclear` handed the pin back — the carriage would keep moving after
    /// a disable or an e-stop at speed.
    pub fn stop(&self, now_ns: u64) {
        self.publish(now_ns, 0, None);
    }
}

/// Clocks to nanoseconds at `clkfreq`, rounded down to at least one.
fn clocks_to_ns(clocks: u32, clkfreq: u32) -> u64 {
    let hz = if clkfreq == 0 { 160_000_000 } else { clkfreq } as u64;
    (u64::from(clocks) * 1_000_000_000 / hz).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_half_period_in_clocks_becomes_nanoseconds() {
        // 160 MHz: one clock is 6.25 ns, so 800 clocks is 5 µs.
        assert_eq!(clocks_to_ns(800, 160_000_000), 5_000);
        // Never zero: a zero period would be an infinite rate.
        assert_eq!(clocks_to_ns(0, 160_000_000), 1);
    }
}
