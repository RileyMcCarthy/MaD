//! Pulse Out — generic timed pulse emission peripheral.
//!
//! Models the abstract behavior every pulse-output peripheral exposes:
//! "emit `N` pulses at frequency `F` starting now, tell me how many have
//! gone out so far, stop on request." It is intentionally hardware-agnostic
//! — whether a real MCU implements the channel with a smart pin, a hardware
//! timer, DMA, or software bit-bang is irrelevant to anything downstream of
//! `HAL_pulseOut_run`. All of those produce the same observable behavior:
//! a monotonically-increasing emitted count that reaches `N` after `N / F`
//! seconds.
//!
//! ## Single source of truth
//!
//! `run()` integrates `frequency × elapsed_virtual_time` and is what firmware
//! reads through `HAL_pulseOut_run`. Encoder feedback and kinematic models
//! subscribe via [`on_progress`] and receive the **same integer** the firmware
//! sees on the same call, so they cannot drift from the firmware's view.
//!
//! ## Core occupancy
//!
//! `run()` sleeps for [`POLL_TICK_US`] of virtual time between polls when the
//! sequence is still in progress. This bounds the calling core's polling rate
//! without tying it to the pulse frequency, and lets the scheduler service
//! other cores while the pulse train continues. When the sequence is complete
//! the call returns immediately so the core can move on to the next move.
//!
//! ## Concurrency
//!
//! Per-channel state is protected by a single global mutex held only across
//! field reads/writes — never across a sleep — so multiple cores can drive
//! independent channels in parallel without false serialization. Two cores
//! driving the *same* channel is undefined (just like sharing an output pin
//! on real hardware).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tracing::trace;

/// Polling cadence of `run()` while a sequence is in progress (virtual µs).
///
/// Bounds core occupancy without coupling to the configured pulse frequency.
/// On every poll, `on_progress` fires the running emitted count so the encoder
/// atomic and downstream physics stay in sync with virtual time. Anything that
/// reads the encoder afterwards will see a value at most `POLL_TICK_US` stale.
///
/// This must be **substantially finer** than the rate at which the encoder is
/// read by firmware (a typical monitor loop runs at ~1 ms). A matching cadence aliases
/// against the read clock and produces visible "stutter" — every few samples
/// land in the same encoder window and report a 0-µm delta. 250 µs gives a
/// clean 4:1 oversample of the 1 ms read rate, eliminating the artifact while
/// keeping trace volume manageable.
const POLL_TICK_US: u64 = 250;

/// Maximum pulse out channels supported (hard ceiling of the backing array).
pub const MAX_CHANNELS: usize = 16;

static CHANNEL_COUNT: AtomicUsize = AtomicUsize::new(0);

static START_CALLBACKS: Mutex<Vec<Option<Box<dyn Fn(u32, u32) + Send>>>> = Mutex::new(Vec::new());
static STOP_CALLBACKS: Mutex<Vec<Option<Box<dyn Fn() + Send>>>> = Mutex::new(Vec::new());
static PROGRESS_CALLBACKS: Mutex<Vec<Option<Box<dyn Fn(u32) + Send>>>> = Mutex::new(Vec::new());

#[derive(Clone, Copy)]
struct PulseState {
    total_pulses: u32,
    frequency: u32,
    start_us: u64,
    /// Continuous-velocity (NCO) mode: an unbounded train whose rate can be
    /// retargeted on the fly. `emitted_base` carries the cumulative pulse count
    /// from before the latest `set_frequency`, so the running total stays
    /// monotonic across rate changes.
    velocity_mode: bool,
    emitted_base: u64,
}

static PULSE_STATE: Mutex<[PulseState; MAX_CHANNELS]> = Mutex::new({
    const INIT: PulseState = PulseState {
        total_pulses: 0,
        frequency: 1,
        start_us: 0,
        velocity_mode: false,
        emitted_base: 0,
    };
    [INIT; MAX_CHANNELS]
});

// ============================================================
// Initialization
// ============================================================

/// Configure the peripheral with the number of channels.
/// Resets all per-channel callbacks and pulse state, so re-init is a clean start.
pub fn init(count: usize) {
    assert!(
        count <= MAX_CHANNELS,
        "PulseOut count {} exceeds max {}",
        count,
        MAX_CHANNELS
    );
    reset();
    CHANNEL_COUNT.store(count, Ordering::Relaxed);
    START_CALLBACKS.lock().unwrap().resize_with(count, || None);
    STOP_CALLBACKS.lock().unwrap().resize_with(count, || None);
    PROGRESS_CALLBACKS.lock().unwrap().resize_with(count, || None);
}

/// Clear all channel callbacks and pulse state (used by `init` and teardown).
pub fn reset() {
    CHANNEL_COUNT.store(0, Ordering::Relaxed);
    START_CALLBACKS.lock().unwrap().clear();
    STOP_CALLBACKS.lock().unwrap().clear();
    PROGRESS_CALLBACKS.lock().unwrap().clear();
    let mut state = PULSE_STATE.lock().unwrap();
    for s in state.iter_mut() {
        *s = PulseState {
            total_pulses: 0,
            frequency: 1,
            start_us: 0,
            velocity_mode: false,
            emitted_base: 0,
        };
    }
}

// ============================================================
// Callback registration
// ============================================================

/// Register a per-channel callback fired when `start()` is called. Useful
/// for snapshotting baseline state (encoder origin, GPIO direction).
pub fn on_start(channel: usize, cb: impl Fn(u32, u32) + Send + 'static) {
    register(&START_CALLBACKS, channel, Box::new(cb));
}

/// Register a per-channel callback fired when `stop()` is called.
pub fn on_stop(channel: usize, cb: impl Fn() + Send + 'static) {
    register(&STOP_CALLBACKS, channel, Box::new(cb));
}

/// Register a per-channel callback fired with the cumulative `emitted` pulse
/// count every time progress is re-evaluated. The argument is the **same
/// integer** the firmware will read from `HAL_pulseOut_run` on the same call,
/// so subscribers (encoders, physics models) cannot drift from that view.
pub fn on_progress(channel: usize, cb: impl Fn(u32) + Send + 'static) {
    register(&PROGRESS_CALLBACKS, channel, Box::new(cb));
}

fn register<F: ?Sized>(slot: &Mutex<Vec<Option<Box<F>>>>, channel: usize, cb: Box<F>) {
    if channel >= MAX_CHANNELS {
        return;
    }
    let mut cbs = slot.lock().unwrap();
    if channel >= cbs.len() {
        cbs.resize_with(channel + 1, || None);
    }
    cbs[channel] = Some(cb);
}

fn fire_progress(channel: usize, emitted: u32) {
    if let Ok(cbs) = PROGRESS_CALLBACKS.lock() {
        if let Some(cb) = cbs.get(channel).and_then(|c| c.as_ref()) {
            cb(emitted);
        }
    }
}

// ============================================================
// Core API
// ============================================================

/// Start a pulse sequence. Records timing state and fires `on_start` followed
/// by an initial `on_progress(0)` so subscribers can align with the start
/// position before any pulses elapse.
pub fn start(channel: usize, pulses: u32, frequency: u32) {
    if channel >= CHANNEL_COUNT.load(Ordering::Relaxed) {
        return;
    }
    let freq = frequency.max(1);

    trace!(
        "pulse_out::start(ch={}, pulses={}, freq={})",
        channel, pulses, freq
    );

    {
        let mut state = PULSE_STATE.lock().unwrap();
        state[channel] = PulseState {
            total_pulses: pulses,
            frequency: freq,
            start_us: embsim_core::virtual_clock::virtual_us(),
            velocity_mode: false,
            emitted_base: 0,
        };
    }

    if let Ok(cbs) = START_CALLBACKS.lock() {
        if let Some(cb) = cbs.get(channel).and_then(|c| c.as_ref()) {
            cb(pulses, freq);
        }
    }
    fire_progress(channel, 0);
}

/// Begin (or re-baseline) a continuous-velocity (NCO) pulse train at `frequency`
/// steps/s. Resets the emitted counter to 0 and fires `on_start` so subscribers
/// snapshot the current direction/baseline — callers re-invoke this on a
/// direction reversal (where the rate is ~0) so `pos = base + dir × emitted`
/// stays correct across the reversal. `frequency` 0 holds (no pulses).
pub fn start_velocity(channel: usize, frequency: u32) {
    if channel >= CHANNEL_COUNT.load(Ordering::Relaxed) {
        return;
    }
    trace!("pulse_out::start_velocity(ch={}, freq={})", channel, frequency);
    {
        let mut state = PULSE_STATE.lock().unwrap();
        state[channel] = PulseState {
            total_pulses: u32::MAX, // unbounded; velocity mode never "completes"
            frequency,
            start_us: embsim_core::virtual_clock::virtual_us(),
            velocity_mode: true,
            emitted_base: 0,
        };
    }
    if let Ok(cbs) = START_CALLBACKS.lock() {
        if let Some(cb) = cbs.get(channel).and_then(|c| c.as_ref()) {
            cb(0, frequency);
        }
    }
    fire_progress(channel, 0);
}

/// Retarget the continuous-velocity rate without resetting the emitted counter.
/// The pulses already emitted at the previous rate are banked into `emitted_base`
/// so the running total stays monotonic. No-op outside velocity mode.
pub fn set_frequency(channel: usize, frequency: u32) {
    if channel >= CHANNEL_COUNT.load(Ordering::Relaxed) {
        return;
    }
    let mut state = PULSE_STATE.lock().unwrap();
    let s = &mut state[channel];
    if !s.velocity_mode {
        return;
    }
    let now = embsim_core::virtual_clock::virtual_us();
    let elapsed = now.saturating_sub(s.start_us);
    let emitted_at_old = elapsed.saturating_mul(s.frequency as u64) / 1_000_000;
    s.emitted_base = s.emitted_base.saturating_add(emitted_at_old);
    s.frequency = frequency;
    s.start_us = now;
}

/// Poll a running pulse sequence. Returns `(emitted_pulses, done)`.
///
/// `emitted` advances monotonically with virtual time at the configured rate
/// and is clamped to `total`. The call sleeps for [`POLL_TICK_US`] of virtual
/// time when the sequence is still in progress, returning immediately once
/// `done = true` so the caller can move on without an extra tick of latency.
pub fn run(channel: usize) -> (u32, bool) {
    if channel >= CHANNEL_COUNT.load(Ordering::Relaxed) {
        return (0, true);
    }

    // Snapshot state — never hold the lock across a sleep.
    let snapshot = {
        let state = PULSE_STATE.lock().unwrap();
        state[channel]
    };

    if snapshot.total_pulses == 0 {
        return (0, true);
    }

    let now = embsim_core::virtual_clock::virtual_us();
    let elapsed_us = now.saturating_sub(snapshot.start_us);

    // Continuous-velocity mode: cumulative emitted = banked + rate × elapsed.
    // Never completes (the caller stops it); still yields the core via the poll
    // sleep and fires progress so the encoder/physics track virtual time.
    if snapshot.velocity_mode {
        let emitted = snapshot
            .emitted_base
            .saturating_add(elapsed_us.saturating_mul(snapshot.frequency as u64) / 1_000_000)
            as u32;
        fire_progress(channel, emitted);
        sleep_virtual_us(POLL_TICK_US);
        return (emitted, false);
    }

    let emitted = ((elapsed_us.saturating_mul(snapshot.frequency as u64)) / 1_000_000)
        .min(snapshot.total_pulses as u64) as u32;
    let done = emitted >= snapshot.total_pulses;

    trace!(
        "pulse_out::run(ch={}): {}/{} elapsed={}us done={}",
        channel, emitted, snapshot.total_pulses, elapsed_us, done
    );

    fire_progress(channel, emitted);

    if !done {
        sleep_virtual_us(POLL_TICK_US);
    }

    (emitted, done)
}

/// Stop a running pulse sequence and fire the `on_stop` callback.
pub fn stop(channel: usize) {
    trace!("pulse_out::stop(ch={})", channel);
    if channel >= CHANNEL_COUNT.load(Ordering::Relaxed) {
        return;
    }
    {
        let mut state = PULSE_STATE.lock().unwrap();
        state[channel].total_pulses = 0;
        state[channel].velocity_mode = false;
    }
    if let Ok(cbs) = STOP_CALLBACKS.lock() {
        if let Some(cb) = cbs.get(channel).and_then(|c| c.as_ref()) {
            cb();
        }
    }
}

fn sleep_virtual_us(virtual_us: u64) {
    let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(virtual_us);
    if wall_us > 0 {
        std::thread::sleep(std::time::Duration::from_micros(wall_us));
    }
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU32, Ordering as AtomicOrdering},
        Arc,
    };

    /// Take the crate-wide test lock, pin the shared virtual clock, and reset
    /// pulse-out state to a clean `channels`-wide bank. `init` fully clears all
    /// per-channel callbacks and pulse state, so no manual clearing is needed.
    fn test_setup(channels: usize) {
        crate::test_support::ensure_clock();
        init(channels);
    }

    #[test]
    fn out_of_range_channel_is_a_no_op() {
        let _g = crate::test_support::guard();
        test_setup(1);
        // Channel 99 was never configured; calls return safely.
        start(99, 100, 1000);
        assert_eq!(run(99), (0, true));
        stop(99);
    }

    #[test]
    fn idle_channel_reports_done_immediately() {
        let _g = crate::test_support::guard();
        test_setup(1);
        // start() never called → total_pulses == 0 → run() reports done.
        assert_eq!(run(0), (0, true));
    }

    #[test]
    fn start_fires_initial_progress_at_zero() {
        let _g = crate::test_support::guard();
        test_setup(1);
        let progress = Arc::new(AtomicU32::new(u32::MAX));
        {
            let p = Arc::clone(&progress);
            on_progress(0, move |emitted| p.store(emitted, AtomicOrdering::Relaxed));
        }
        start(0, 100, 1000);
        assert_eq!(progress.load(AtomicOrdering::Relaxed), 0);
    }

    #[test]
    fn run_emits_progress_and_eventually_completes() {
        let _g = crate::test_support::guard();
        test_setup(1);
        let progress = Arc::new(AtomicU32::new(0));
        {
            let p = Arc::clone(&progress);
            on_progress(0, move |emitted| p.store(emitted, AtomicOrdering::Relaxed));
        }

        // 50 pulses at 5 kHz = 10ms — easily completes within the test.
        start(0, 50, 5_000);
        let mut last = 0u32;
        for _ in 0..200 {
            let (emitted, done) = run(0);
            assert!(emitted >= last, "emitted must be monotonic");
            assert!(emitted <= 50, "emitted must be clamped to total");
            last = emitted;
            if done {
                assert_eq!(emitted, 50, "done implies all pulses emitted");
                assert_eq!(progress.load(AtomicOrdering::Relaxed), 50);
                return;
            }
        }
        panic!("sequence never completed");
    }

    #[test]
    fn velocity_mode_integrates_continuously_and_retargets() {
        let _g = crate::test_support::guard();
        test_setup(1);
        let progress = Arc::new(AtomicU32::new(0));
        {
            let p = Arc::clone(&progress);
            on_progress(0, move |emitted| p.store(emitted, AtomicOrdering::Relaxed));
        }

        // Continuous 1 kHz train: emitted advances with virtual time, never "done".
        start_velocity(0, 1_000);
        let mut last = 0u32;
        for _ in 0..50 {
            let (emitted, done) = run(0);
            assert!(!done, "velocity mode never completes on its own");
            assert!(emitted >= last, "emitted is monotonic");
            last = emitted;
        }
        assert!(last > 0, "continuous velocity advanced the emitted count");
        assert_eq!(progress.load(AtomicOrdering::Relaxed), last, "progress matches run()");

        // Retarget to 0 (hold) → the cumulative count freezes (no rewind).
        set_frequency(0, 0);
        let (a, _) = run(0);
        let (b, _) = run(0);
        assert_eq!(a, b, "rate 0 holds the emitted count");
        assert!(a >= last, "held count never goes backwards");

        // Stop leaves velocity mode.
        stop(0);
        assert_eq!(run(0), (0, true), "stop ends the velocity train");
    }

    #[test]
    fn stop_cancels_in_flight_sequence() {
        let _g = crate::test_support::guard();
        test_setup(1);
        let stops = Arc::new(AtomicU32::new(0));
        {
            let s = Arc::clone(&stops);
            on_stop(0, move || {
                s.fetch_add(1, AtomicOrdering::Relaxed);
            });
        }
        start(0, 10_000, 1_000);
        stop(0);
        assert_eq!(stops.load(AtomicOrdering::Relaxed), 1);
        // Subsequent run() reports done with no further pulses.
        assert_eq!(run(0), (0, true));
    }

    #[test]
    fn restart_resets_baseline() {
        let _g = crate::test_support::guard();
        test_setup(1);
        start(0, 10, 1_000);
        // Drain to completion.
        loop {
            let (_, done) = run(0);
            if done {
                break;
            }
        }
        // A fresh start re-zeroes the timeline; first poll should be small.
        start(0, 10, 1_000);
        let (emitted, _) = run(0);
        assert!(emitted <= 10);
    }

    #[test]
    fn frequency_zero_is_clamped() {
        let _g = crate::test_support::guard();
        test_setup(1);
        // Frequency of 0 would divide-by-zero; the driver clamps to 1 Hz.
        start(0, 5, 0);
        let (emitted, _) = run(0);
        assert!(emitted <= 5);
    }

    #[test]
    #[should_panic(expected = "exceeds max")]
    fn init_above_max_channels_panics() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        // A count above the backing-array ceiling is a configuration error.
        init(MAX_CHANNELS + 1);
    }

    #[test]
    fn on_start_fires_with_pulses_and_frequency() {
        let _g = crate::test_support::guard();
        test_setup(1);
        // on_start receives the exact (pulses, frequency) passed to start(),
        // with frequency clamped to at least 1.
        let seen = Arc::new(std::sync::Mutex::new((0u32, 0u32)));
        {
            let s = Arc::clone(&seen);
            on_start(0, move |pulses, freq| *s.lock().unwrap() = (pulses, freq));
        }
        start(0, 42, 0); // freq 0 clamps to 1
        assert_eq!(*seen.lock().unwrap(), (42, 1));
    }

    #[test]
    fn callbacks_are_one_per_channel_and_overwrite() {
        let _g = crate::test_support::guard();
        test_setup(1);
        // Re-registering on_start replaces the previous callback (one per channel).
        let first = Arc::new(AtomicU32::new(0));
        let second = Arc::new(AtomicU32::new(0));
        {
            let f = Arc::clone(&first);
            on_start(0, move |_, _| {
                f.fetch_add(1, AtomicOrdering::Relaxed);
            });
        }
        {
            let s = Arc::clone(&second);
            on_start(0, move |_, _| {
                s.fetch_add(1, AtomicOrdering::Relaxed);
            });
        }
        start(0, 1, 1);
        assert_eq!(first.load(AtomicOrdering::Relaxed), 0, "first cb overwritten");
        assert_eq!(second.load(AtomicOrdering::Relaxed), 1, "only second cb fires");
    }

    #[test]
    fn register_out_of_range_channel_is_ignored() {
        let _g = crate::test_support::guard();
        test_setup(1);
        // Registering a callback past MAX_CHANNELS is silently dropped, not a panic.
        let hits = Arc::new(AtomicU32::new(0));
        {
            let h = Arc::clone(&hits);
            on_progress(MAX_CHANNELS, move |_| {
                h.fetch_add(1, AtomicOrdering::Relaxed);
            });
        }
        // Configured channel 0 still works and fires its own (unset) progress.
        start(0, 1, 1);
        assert_eq!(hits.load(AtomicOrdering::Relaxed), 0);
    }

    #[test]
    fn run_clamps_emitted_to_total_after_overrun() {
        let _g = crate::test_support::guard();
        test_setup(1);
        // A tiny, high-frequency sequence finishes well before we poll, so the
        // raw integration would exceed `total`; run() must clamp to exactly total.
        start(0, 1, 1_000_000);
        // Drain to completion; emitted is never allowed above total.
        let mut last = (0u32, false);
        for _ in 0..200 {
            last = run(0);
            assert!(last.0 <= 1, "emitted clamped to total");
            if last.1 {
                break;
            }
        }
        assert_eq!(last, (1, true), "completes with exactly total emitted");
    }

    #[test]
    fn reset_clears_channel_count_and_callbacks() {
        let _g = crate::test_support::guard();
        test_setup(1);
        let hits = Arc::new(AtomicU32::new(0));
        {
            let h = Arc::clone(&hits);
            on_progress(0, move |_| {
                h.fetch_add(1, AtomicOrdering::Relaxed);
            });
        }
        reset();
        // After reset, channel 0 is no longer configured: start/run are no-ops
        // and the previously-registered callback can never fire.
        start(0, 5, 1);
        assert_eq!(run(0), (0, true));
        assert_eq!(hits.load(AtomicOrdering::Relaxed), 0);
    }
}
