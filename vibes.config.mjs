// MaD — Vibes component registry.
//
// `.mjs` is mandatory: there is no package.json at this repo root, or anywhere
// up the tree to /, so Node resolves a root-level `.js` as CommonJS and
// `export default` is a SyntaxError. (Verified 2026-08-21.)
//
// THIS FILE IS THE REGISTRY. Adding, removing, rescoping or suppressing a
// component is a diff hunk here, in one reviewed file — that is the whole
// point. Producer mechanics live in each component's own manifest, next to
// the code they measure.
export default {
  version: 1,

  // NOTE: `origin/main` does NOT resolve in CI today — no workflow sets
  // fetch-depth, so actions/checkout clones at depth 1. The Vibes CI job MUST
  // set `fetch-depth: 0`. Vibes fails loudly rather than falling back to HEAD,
  // because a HEAD fallback would certify a fully-changed PR as unchanged.
  baseRef: 'origin/main',

  report: {
    out: '.vibes/report',
    formats: ['md', 'html', 'json'],
    title: 'MaD behaviour report',
    maxInlineDiffLines: 200,
  },

  // The SIL emulator is single-instance (CLAUDE.md). Keep at 1 while `sil` is
  // active; resource tokens enforce the real exclusion, this is belt-and-braces.
  concurrency: 1,

  failOn: {
    producerError: true,
    ingestMissing: true,
    honestyViolation: true,
    governanceWeakened: true,
    snapshotDrift: false,
  },

  defaults: {
    compare: { kind: 'exact' },
    timeoutMs: 600_000,
    runWhen: 'changed',
  },

  components: [
    {
      id: 'control',
      title: 'Control — Web Serial + WASM PWA (shipped)',
      root: 'Software/Control',
      // src/domain/{gcode,mapping,sample}.ts import '@/protocol/generated/protoemb',
      // which is gitignored (Software/Control/.gitignore:12) and therefore
      // INVISIBLE to any witnesses glob. `protocol.generates` covers it and
      // forces this component to run on a schema change. Verified: 0 tracked
      // files under src/protocol/generated/.
      dependsOn: ['protocol'],
      submodules: ['Protocol/ProtoEmb'],
    },
    {
      id: 'protocol',
      title: 'Protocol — MaDProtocol.yaml → C / TS / Rust',
      root: 'Protocol',
      submodules: ['Protocol/ProtoEmb'],
      // Repo-root-relative artifact globs. Any component whose root intersects
      // one of these is forced to runWhen:'always'. This is what stops a
      // schema-only PR from rendering `control` as skipped-unchanged.
      generates: [
        'Software/Control/src/protocol/generated/**',
        'Firmware/MaDCore/src/Generated/**',
        'Protocol/rust/src/generated/**',
      ],
    },
    {
      id: 'firmware',
      title: 'Firmware — MaDCore (Propeller 2)',
      root: 'Firmware/MaDCore',
      dependsOn: ['protocol'],
    },
    {
      id: 'sil',
      title: 'SIL — emulator + physics models',
      root: 'SIL',
      // SIL links libfirmware.a from `pio run -e native_emulator` and consumes
      // the generated Rust codec, so firmware behaviour is observed HERE.
      dependsOn: ['firmware', 'protocol'],
      submodules: ['SIL/embsim'],
    },
    {
      id: 'hardware',
      title: 'Hardware — EdgeBoard + DS2Addon (KiCad)',
      root: 'Hardware',
      enabled: false,
      disabledReason:
        'KiBot runs only inside the INTI-CMNB/KiBot container in the build-hardware ' +
        'CI job; no host-runnable producer exists. Board behaviour is NOT measured.',
      disabledUntil: '2026-12-31',
    },
  ],
};
