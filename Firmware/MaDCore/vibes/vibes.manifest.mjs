// Firmware — INGEST ONLY in v1, and the report says so by name.
//
// There is deliberately no snapshot producer here yet: `native_test` is a Unity
// suite (it asserts, it does not write), and `native_emulator` builds
// libfirmware.a rather than any host binary that emits files. Firmware
// behaviour is observed through the `sil` component, which links that archive.
//
// An empty producers list renders as `not-configured` — explicitly NOT as
// "verified-unchanged". Claiming firmware behaviour is unchanged because
// nothing looked at it is the exact lie this tool exists to prevent.
export default {
  component: 'firmware',
  producers: [],

  witnesses: [
    'src/APP/**',
    'src/DEV/**',
    'src/IO/**',
    'src/Library/**',
  ],

  ingest: {
    // VERIFIED: `pio test --junit-output-path PATH` exists in PlatformIO 6.1.18.
    // Not wired to a cmd yet — CI's firmware-unit-tests job would need the flag
    // added. Until then this ingests an artifact if one happens to be present.
    junit: 'vibes/artifacts/*.xml',
    required: false,
  },
};
