//! Pulse Out — Timed pulse emission peripheral.
//!
//! Simplified design:
//!   - `start()` fires a per-channel callback with (pulses, frequency)
//!     so the wiring/model layer can immediately process the motion.
//!   - `run()` tracks elapsed virtual time since start and returns the
//!     cumulative pulse count. Returns done when all pulses are accounted for.
//!   - No sleeping or timing in callbacks — timing is purely in `run()`.

use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tracing::trace;

/// Tick sleep period for run() polling (10ms wall time).
const RUN_POLL_US: u64 = 10_000;

/// Maximum pulse out channels supported.
const MAX_CHANNELS: usize = 16;

/// Configured channel count.
static CHANNEL_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Per-channel start callbacks.
static CALLBACKS: Mutex<Vec<Option<Box<dyn Fn(u32, u32) + Send>>>> = Mutex::new(Vec::new());

/// Per-channel state.
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

/// Configure the pulse out peripheral with the number of channels.
pub fn init(count: usize) {
    assert!(count <= MAX_CHANNELS, "PulseOut count {} exceeds max {}", count, MAX_CHANNELS);
    CHANNEL_COUNT.store(count, Ordering::Relaxed);
    let mut cbs = CALLBACKS.lock().unwrap();
    cbs.resize_with(count, || None);
}

/// Register a per-channel callback fired when a pulse sequence starts.
pub fn on_start(channel: usize, cb: impl Fn(u32, u32) + Send + 'static) {
    if channel < MAX_CHANNELS {
        let mut cbs = CALLBACKS.lock().unwrap();
        if channel >= cbs.len() {
            cbs.resize_with(channel + 1, || None);
        }
        cbs[channel] = Some(Box::new(cb));
    }
}

// ============================================================
// Core API
// ============================================================

/// Start a pulse sequence. Records timing state and fires the on_start callback.
pub fn start(channel: usize, pulses: u32, frequency: u32) {
    if channel >= CHANNEL_COUNT.load(Ordering::Relaxed) {
        return;
    }
    let freq = frequency.max(1);

    trace!(
        "pulse_out::start(ch={}, pulses={}, freq={})",
        channel, pulses, freq
    );

    // Record timing state
    {
        let mut state = PULSE_STATE.lock().unwrap();
        state[channel].total_pulses = pulses;
        state[channel].frequency = freq;
        state[channel].start_us = embsim_core::virtual_clock::virtual_us();
    }

    // Fire start callback so wiring/models can process the motion
    if let Ok(cbs) = CALLBACKS.lock() {
        if channel < cbs.len() {
            if let Some(cb) = cbs[channel].as_ref() {
                cb(pulses, freq);
            }
        }
    }
}

/// Poll a running pulse sequence. Returns (emitted_pulses, done).
/// Calculates cumulative pulses based on elapsed virtual time.
/// Sleeps briefly to avoid busy-looping.
pub fn run(channel: usize) -> (u32, bool) {
    if channel >= CHANNEL_COUNT.load(Ordering::Relaxed) {
        return (0, true);
    }

    let state = PULSE_STATE.lock().unwrap();
    let total = state[channel].total_pulses;
    let freq = state[channel].frequency as u64;
    let start_time = state[channel].start_us;
    drop(state);

    if total == 0 {
        return (0, true);
    }

    // Calculate how many pulses have elapsed based on virtual time
    let now = embsim_core::virtual_clock::virtual_us();
    let elapsed_us = now.saturating_sub(start_time);
    let emitted = ((elapsed_us * freq) / 1_000_000).min(total as u64) as u32;
    let done = emitted >= total;

    trace!(
        "pulse_out::run(ch={}): {}/{} elapsed={}us done={}",
        channel, emitted, total, elapsed_us, done
    );

    // Sleep briefly to avoid busy-looping
    if !done {
        let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(RUN_POLL_US);
        if wall_us > 0 {
            std::thread::sleep(std::time::Duration::from_micros(wall_us));
        }
    }

    (emitted, done)
}

/// Stop a running pulse sequence.
pub fn stop(channel: usize) {
    trace!("pulse_out::stop(ch={})", channel);
    if channel < CHANNEL_COUNT.load(Ordering::Relaxed) {
        let mut state = PULSE_STATE.lock().unwrap();
        state[channel].total_pulses = 0;
    }
}
