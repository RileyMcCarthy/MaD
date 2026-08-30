// SIL — not configured in v1, honestly.
//
// This is where the behaviour that actually matters lives (motion, force,
// firmware timing), and it is exactly what Vibes cannot measure yet. Two real
// blockers, neither of which Vibes can fix:
//
//   1. The emulator clock is wall-clock derived — embsim/core/src/virtual_clock.rs
//      computes virtual_us() from origin.elapsed(), so `time_us` in every sample
//      frame is jittered real time. Any snapshot indexed on it is 100% red.
//   2. `cargo test` has no stable machine-readable output, and adopting
//      cargo-nextest is a real CI change.
//
// Renders as `not-configured`, never as unchanged.
export default {
  component: 'sil',
  producers: [],

  witnesses: [
    'MaDSim/src/**',
    'models/src/**',
  ],
};
