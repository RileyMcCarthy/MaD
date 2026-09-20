# Moving `p2core` and `p2iss` into embsim

Scope for promoting the P2 instruction-set simulator out of MaD and into
[embsim](https://github.com/RileyMcCarthy/embsim), so that embsim becomes the
library of MCUs we can simulate and its CI is what proves the ISS matches
silicon. This is the promotion step the P4 entry in
[embsim-improvements.md](embsim-improvements.md) planned for
("Spike may live in MaD `SIL/p2core/` then promote").

Scoped 2026-09-18 against `feat/iss-rom-serial-flash` (uncommitted WIP included)
and embsim `origin/main` at `21a25d5`.

**Bottom line:** feasible and mostly mechanical. `p2core` was written dep-free
for exactly this, and embsim already carries `embsim-cpu-oracle` as the generic
half of the silicon-golden method. The silicon, ROM and pure tests replay from
committed assets, so they gate embsim CI with no board and no MaD firmware.
The acceptance tests that need MaD's `propeller2_debug/program` stay in MaD.
Three things need untangling first: the MaD-specific bits inside the crates,
the flash-stub fixture the ISS tests borrow from the PWA, and the Vibes path
dependency.

---

## Inventory

| Piece | Size | Notes |
|---|---|---|
| `p2core/src` | ~10.5k lines incl. the generated decoder | zero dependencies by design |
| `p2core/tests` | 15 files, ~3.2k lines | 11 portable, 3 need MaD firmware or its flexcc listing, 1 reads the PWA's vendored loadp2 stub |
| `p2core/examples` | 30 files | 8 default to the MaD firmware path |
| `p2core/hwtest` | 5 FlexC/Spin programs, 1.5 MB goldens, 2 baselines, 2 capture tools | replay needs nothing; capture needs flexcc + loadp2 + a P2-EVAL |
| `p2core/vendor/parseUtils.ts` | 238 KB | PNut-TS encoding table, MIT per README, no in-file header |
| `p2iss/src` | ~1.6k lines | depends on `embsim-board` + `embsim-core` |
| `p2iss/tests` | 7 files, ~1.6k lines | 2 portable, 5 need MaD firmware |
| `p2iss/rom` | ROM booter + stage1, `.bin` + `.spin2` | Parallax's published ROM source, trimmed for flexspin |
| Tests across both crates | 94 (`--all-targets`) | unit tests in `flash`, `sdimage`, `pulse`, `smartbus`, `flashimage` move with their modules |

---

## What moves, what stays

| Piece | Destination | Notes |
|---|---|---|
| `SIL/p2core` src, generated decoder, vendored table | embsim `mcus/p2/iss/` as **`embsim-p2-iss`** | the name P4 reserved |
| `SIL/p2core/hwtest/` programs, goldens, baselines, `hw_probe.py`, `hw_compare.py`, `gen_decoder.py` | with the ISS crate | the P2 adapter `embsim-cpu-oracle`'s README already points at |
| `SIL/p2iss/rom/` binaries + sources, `make bootrom` | into the ISS crate as a script | `p2core` tests already reach into `../p2iss/rom` from six places |
| `SIL/p2iss` | embsim `mcus/p2/iss-net/` as **`embsim-p2-iss-net`** | name is a call to make; it depends on `embsim-board`, so it stays a second crate |
| `p2iss::sdimage::mad_card` | stays in `SIL/MaDSim` | generic `sdimage::build` and `Dir` go upstream |
| 10 firmware acceptance tests, `decoder_golden.rs`, `tools/gen_golden.py` | stay in MaD under `SIL/MaDSim/tests/` | need the MaD P2 image and its flexcc listing |
| `SIL/MaDSim/src/{main,iss_description}.rs`, `SIL/makefile`, `Software/Control/e2e/run-all.mjs` FW-ISS, four `docs/dev/sil-*.md`, `CLAUDE.md` | edited in the MaD bump PR | imports rename to the new crate names |

Optional later: relocate `platforms/p2` to `mcus/p2/hal/` so the MCU library has
one shape (native HAL trampolines, ISS, ISS-on-nets under one directory).

---

## Tests: what each file needs

| Input needed | `p2core/tests` | `p2iss/tests` | Goes to embsim CI |
|---|---|---|---|
| Silicon goldens only | `op_coverage`, `probe_coverage`, `silicon_oracle`, `silicon_probe`, `silicon_reports` | | **yes** |
| P2 boot ROM only | `rom_boot_chain`, `rom_serial` | `rom_boot_net`, `rom_serial_net` | **yes** |
| P2 boot ROM + loadp2's `flash_loader.bin`, read today from `Software/Control/src/firmware/image.ts` | `flash_program` | | **yes**, once the stub is vendored upstream |
| Nothing | `poll_fast_forward`, `sd_block_write` | | **yes** |
| MaD `propeller2_debug/program` | `block_fill`, `boot`, `per_cog_dir`, `sd_spi_words` | `level_pins`, `protocol_on_levels`, `pty_protocol`, `sd_mount`, `sd_node` | no, stays in MaD |
| MaD image **and** its flexcc `.p2asm` listing | `decoder_golden` | | no, stays in MaD |

The silicon rows are the point of the move: `probe.txt` holds 1550
one-instruction records from a P2-EVAL, the two baselines record the 98 cases
in 12 mnemonics that still diverge, and the gate fails on any *unlisted*
divergence and on any listed one that starts matching. That burn-down list
becomes embsim's.

---

## embsim CI

No new jobs. `cargo test --workspace --all-targets` on ubuntu and macOS picks
the crates up. Measured cost on MaD main, debug mode, ubuntu: the probe replay
is 53 s and the whole silicon suite about a minute.

Add:

- [ ] a **"goldens are unmodified"** step for `hwtest/golden/` and the two
      baseline files, mirroring the existing `board/tests/fixtures/traces` check,
      so a replay that rewrites its own oracle cannot pass.
- [ ] a **TESTING.md** section: silicon goldens are the spec; recapture needs a
      P2-EVAL and the PlatformIO flexcc + loadp2 packages (`P2_PORT` selects the
      FTDI); baseline lines are burned down and deleted, never added to hide a
      regression. State that the goldens and ROM are chip-level fixtures, so the
      "every crate is firmware-free" rule still holds.
- [ ] `README.md` crate table rows for both crates.

Gates checked 2026-09-18 on this branch:

| Gate | Result | Action |
|---|---|---|
| `cargo fmt --check` | clean | none |
| `cargo clippy --all-targets -D warnings` | 3 errors, all in the uncommitted WIP | fix in the WIP; main is clean because MaD CI already gates it |
| `cargo doc -D warnings` | 1 broken intra-doc link to `crate::board::tests` in `p2core` | fix before PR A; MaD never gated docs so it never surfaced |
| MSRV `cargo +1.88 build` | builds | none |
| `cargo deny check` | `p2core` has no deps; `p2iss` adds `nix` + `libc`, both already allowed | none |
| licence hygiene | `vendor/parseUtils.ts` has no header; ROM is Parallax's published source | add `vendor/LICENSE` (MIT, Iron Sheep Productions / Parallax) and a ROM provenance NOTICE; confirm redistribution terms for an MIT repo |

---

## Coupling to remove before the `git mv`

- [ ] **`p2core/src/board.rs` is titled "A MaD board".** Pins 58–63 are the P2
      boot-pin convention (flash/SD SPI, ROM serial), so the struct is really a
      P2 reference board. Only the protocol link on 53/55 (`PIN_PROTO_TX/RX`) is
      MaD. Rename, and make the protocol pins a constructor parameter.
- [ ] **`p2iss::sdimage::mad_card`** builds MaD's FAT layout (profile record and
      two directories). Keep `build`/`Dir` upstream; move `mad_card` and its unit
      test `the_mad_card_has_the_directories_the_firmware_opens_into` to MaDSim.
- [ ] **`flash_program.rs` reads loadp2's flash stub out of the PWA.** It decodes
      the base64 in `Software/Control/src/firmware/image.ts` on purpose, so the
      test exercises the bytes the app ships. embsim cannot reach that file.
      Vendor `flash_loader.bin` (496 bytes, loadp2, MIT) into the ISS crate and
      expose it as a `pub const`; keep a MaD test asserting the app's base64
      decodes to the upstream bytes, which preserves the one-copy intent as a
      cross-check instead of a shared path.
- [ ] **ROM assets** move into the ISS crate; `p2iss` and the tests read them
      from there instead of `../p2iss/rom`.
- [ ] **Vibes.** `flash_program`, `rom_serial` and `rom_serial_net` declare
      behaviours through `vibes-behaviour`, a path dep into MaD's `Vibes`
      submodule that embsim does not have. Eight claims in `behaviours.jsonl`
      cite them and `SIL/vibes.suite.json` runs them. Recommended: move the tests
      unannotated, drop the eight claims and the three suite commands. The
      Prop_Chk handshake is a ROM fact; MaD's `FW-ISS` e2e suite is the MaD-side
      claim for UI flashing. The four `p2.flash-stub-programs-spi` claims are
      worded "given the app's flash stub"; their MaD-side successor is the
      stub-equality test above, which can carry one claim of its own. Alternative:
      thin annotated wrappers kept in MaD.
- [ ] **`tools/gen_golden.py`** defaults to MaD's `program.p2asm`; it stays in
      MaD with `decoder_golden`.
- [ ] **Examples:** 8 of 30 in `p2core` and 3 of 4 in `p2iss` default to the MaD
      firmware path. Make the image path an argument.
- [ ] One doc comment in `p2core/src/lib.rs` ("Every MaD cog runs the same
      kernel") reads as a FlexC ABI fact; reword.

---

## Sequencing

1. [x] **MaD [#110](https://github.com/RileyMcCarthy/MaD/pull/110) merged 2026-09-20.**
       It re-pins embsim to `main`, which already has the UART codec and
       `SerialLevelBridge` that `p2iss` needs. `feat/iss-rom-serial-flash`
       still points its gitlink at a 16-commit side branch with no PR;
       rebase it onto `main`.
2. [ ] **Land this branch's WIP in MaD** with the clippy and rustdoc fixes, so
       the embsim PR is a pure relocation plus the generalisations above.
3. [ ] **embsim PR A: `embsim-p2-iss`** from `p2core`, with `hwtest/`, ROM,
       vendor table + LICENSE, the board rename, the CI step and docs. Dep-free,
       so it can start now.
4. [ ] **embsim PR B: `embsim-p2-iss-net`** from `p2iss` minus `mad_card` and
       the firmware tests. Can fold into A.
5. [ ] **MaD bump PR:** bump the pin, delete `SIL/p2core` and `SIL/p2iss`, drop
       them from `SIL/Cargo.toml`, re-home the acceptance tests, `decoder_golden`,
       `gen_golden.py` and `mad_card` into MaDSim, update imports, `makefile`
       (`bootrom`, `ROM_IMAGE`, `playground-iss*`), `docs/dev/sil-*.md`, the
       Vibes suite and ledger, and `CLAUDE.md`. The existing `embsim-ci` job
       then runs the silicon suite on every SIL PR through the pinned commit.

---

## Outside the move, worth knowing

- The ten acceptance tests **already skip in MaD CI**: `sil-rust` builds only
  `native_emulator`, and the tests skip when `propeller2_debug/program` is
  absent. The release job builds `propeller2_debug` on ubuntu without trouble,
  so un-skipping them is a cheap follow-up once they live in MaDSim.
- On this WIP branch `silicon_probe` ran locally for over seven minutes at low
  CPU before being stopped, against 53 s on `main` in CI. Look before the WIP
  lands.
- The `Vibes` submodule was uninitialised on the scoping machine, with stale
  `dist/` and `node_modules/` from the pre-submodule prototype in its path, so
  the SIL workspace would not load. `git submodule update --init` needs that
  directory empty.
