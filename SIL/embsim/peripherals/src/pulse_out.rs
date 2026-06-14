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
}

static PULSE_STATE: Mutex<[PulseState; MAX_CHANNELS]> = Mutex::new({
    const INIT: PulseState = PulseState {
        total_pulses: 0,
        frequency: 1,
        start_us: 0,
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
        *s = PulseState { total_pulses: 0, frequency: 1, start_us: 0 };
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
        };
    }

    if let Ok(cbs) = START_CALLBACKS.lock() {
        if let Some(cb) = cbs.get(channel).and_then(|c| c.as_ref()) {
            cb(pulses, freq);
        }
    }
    fire_progress(channel, 0);
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
        Arc, Mutex as StdMutex, OnceLock,
    };

    /// All tests share global peripheral state — serialize them and recover
    /// from any panic-induced lock poisoning.
    static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn lock_or_recover() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|p| {
            TEST_LOCK.clear_poison();
            p.into_inner()
        })
    }

    fn test_setup(channels: usize) {
        static CLOCK: OnceLock<()> = OnceLock::new();
        CLOCK.get_or_init(|| embsim_core::virtual_clock::init(1.0, 180_000_000));

        START_CALLBACKS.clear_poison();
        STOP_CALLBACKS.clear_poison();
        PROGRESS_CALLBACKS.clear_poison();
        PULSE_STATE.clear_poison();

        // `init` now fully resets per-channel callbacks and pulse state, so no
        // manual per-channel clearing is needed here.
        init(channels);
    }

    #[test]
    fn out_of_range_channel_is_a_no_op() {
        let _g = lock_or_recover();
        test_setup(1);
        // Channel 99 was never configured; calls return safely.
        start(99, 100, 1000);
        assert_eq!(run(99), (0, true));
        stop(99);
    }

    #[test]
    fn idle_channel_reports_done_immediately() {
        let _g = lock_or_recover();
        test_setup(1);
        // start() never called → total_pulses == 0 → run() reports done.
        assert_eq!(run(0), (0, true));
    }

    #[test]
    fn start_fires_initial_progress_at_zero() {
        let _g = lock_or_recover();
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
        let _g = lock_or_recover();
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
    fn stop_cancels_in_flight_sequence() {
        let _g = lock_or_recover();
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
        let _g = lock_or_recover();
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
        let _g = lock_or_recover();
        test_setup(1);
        // Frequency of 0 would divide-by-zero; the driver clamps to 1 Hz.
        start(0, 5, 0);
        let (emitted, _) = run(0);
        assert!(emitted <= 5);
    }
}
