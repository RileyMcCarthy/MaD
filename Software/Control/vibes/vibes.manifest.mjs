// Control — Vibes manifest. MECHANICS ONLY.
//
// Identity, root, enabled, dependsOn and generates live in /vibes.config.mjs
// and are hard errors if declared here. This file owns only: how to produce,
// where it lands, how to compare, and what it claims to witness.
//
// Path anchors:
//   producers[].out  → relative to Software/Control/vibes
//   producers[].cwd  → relative to Software/Control   (default '.')
//   witnesses, ingest→ relative to Software/Control
export default {
  component: 'control', // cross-checked against the registry; not a declaration

  producers: [
    {
      // VERIFIED 2026-08-21: `npx vite-node --config vitest.config.ts <f>.mts`
      // works and resolves the '@' alias. Plain `node` CANNOT import
      // src/protocol/generated/protoemb.ts even on node 23.10
      // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). vite-node ships in
      // node_modules/.bin via vitest 2.1.9 — no new dependency.
      name: 'gcode-corpus',
      description:
        'Motion profiles → G-code → machine move buffers for the fixed corpus. ' +
        'Exercises generateTestGcode / gcodeLinesToProgram / batchMoveBuffers / ' +
        'parseGcodeWaveform (src/domain/{testProfile,gcode}.ts).',
      cmd: 'npx vite-node --config vitest.config.ts vibes/producers/gcode-corpus.mts',
      out: 'snapshots/gcode',
      minCases: 19, // current corpus size; any shrink must be justified
      ciJob: 'wasm-control-ci',
      tier: 'pr',
    },
    // NOT YET WRITTEN — deliberately absent rather than declared.
    // A producer whose script does not exist fails every run, and a permanently
    // red check is one everybody learns to ignore. Add them back with the file:
    //   csv-export     — sample streams -> CSV via src/domain/{exportCsv,sample}.ts
    //   proto-mapping  — proto<->display + state labels via src/domain/{mapping,stateLabels}.ts
  ],

  // Every producer is `exact` by inheritance from the root defaults, and that
  // is deliberate.
  //
  // MEASURED 2026-08-21: Math.sin differs by 1 ULP between arm64 and x64 on the
  // SAME Node version (Math.sin(2π×0.5625) → -0.3826834323650896 on arm64 vs
  // -0.38268343236508967 on x64). Node 20 vs 23 is NOT a factor; the CPU is.
  // Riley develops on Apple Silicon, CI runs ubuntu x64, so this is a live split.
  //
  // It does not bite here, because src/domain/ quantizes at the source:
  // round3() (testProfile.ts:24) wraps both the emitted G-code (:132, :136) and
  // the preview series (:148), and round3 collapses both values to -0.383.
  // waveformPeakVelocity uses 2π·A·f — multiplication only, IEEE-deterministic.
  //
  // THE RULE THAT KEEPS THIS TRUE: producers snapshot what the source EMITS.
  // A producer calling waveformSample() directly would reintroduce the drift.
  //
  // Starting `exact` and loosening on evidence is the right default: a loosened
  // epsilon is a governance event that shows up in the report, whereas starting
  // loose hides drift permanently and silently.

  // ROOT-relative, matched against git-TRACKED paths only. src/protocol/generated/**
  // and src/wasm/** can never be claimed here — both are gitignored
  // (Software/Control/.gitignore:9,12; verified 0 tracked files). That gap is
  // covered by `protocol.generates` in the registry, NOT by a witness.
  witnesses: [
    'src/domain/**',
    'src/store/deviceEventReduce.ts',
    'src/device/sessionPolicy.ts',
  ],

  ingest: {
    // VERIFIED: vitest 2.1.9 ships the junit reporter.
    // `lcov` is deliberately OMITTED: @vitest/coverage-v8 is absent from both
    // node_modules and package.json, so this component renders as
    // "tests: yes, coverage: not configured" — by name, never as zero coverage.
    cmd: 'npx vitest run --config vitest.config.ts'
       + ' --reporter=junit --outputFile=vibes/artifacts/vitest-junit.xml',
    junit: 'vibes/artifacts/vitest-junit.xml',
    required: true,
  },
};
