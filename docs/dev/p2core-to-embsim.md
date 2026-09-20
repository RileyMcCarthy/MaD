# Moving `p2core` and `p2iss` into embsim

Scope for promoting the P2 instruction-set simulator out of MaD and into
[embsim](https://github.com/RileyMcCarthy/embsim), so that embsim becomes the
library of MCUs we can simulate and its CI is what proves the ISS matches
silicon. This is the promotion step the P4 entry in
[embsim-improvements.md](embsim-improvements.md) planned for
("Spike may live in MaD `SIL/p2core/` then promote").

Scoped 2026-09-18 against `feat/iss-rom-serial-flash` (uncommitted WIP included)
and embsim `origin/main` at `21a25d5`. Revised 2026-09-19: embsim receives P2
ISS items only, and flashing gets its own embsim test.

**Bottom line:** feasible and mostly mechanical. `p2core` was written dep-free
for exactly this, and embsim already carries `embsim-cpu-oracle` as the generic
half of the silicon-golden method. The silicon, ROM and pure tests replay from
committed assets, so they gate embsim CI with no board and no MaD firmware.
The acceptance tests that need MaD's `propeller2_debug/program` stay in MaD.
Three things need untangling first: the MaD-specific bits inside the crates,
the flash test that borrows its stub from the PWA, and the Vibes path
dependency.

**The rule:** embsim receives **P2 ISS items only**. No MaD tests, no MaD
software, no MaD firmware image, nothing that reads from `Software/` or
`Firmware/`. A test written in MaD that exercises only the chip (ROM, flash,
silicon goldens) is a P2 item and moves. A test that needs MaD's image or the
PWA stays in MaD, and where embsim needs the same coverage it gets its own test
built from P2 parts; see the bootloader test below.

---

## Inventory

| Piece | Size | Notes |
|---|---|---|
| `p2core/src` | ~10.5k lines incl. the generated decoder | zero dependencies by design |
| `p2core/tests` | 15 files, ~3.2k lines | 11 portable, 3 need MaD firmware or its flexcc listing, 1 reads the PWA's vendored loadp2 stub and stays |
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
| `p2core/tests/flash_program.rs` | stays in MaD | reads the PWA's `image.ts`; embsim gets the bootloader test below instead |
| `SIL/MaDSim/src/{main,iss_description}.rs`, `SIL/makefile`, `Software/Control/e2e/run-all.mjs` FW-ISS, four `docs/dev/sil-*.md`, `CLAUDE.md` | edited in the MaD bump PR | imports rename to the new crate names |

Optional later: relocate `platforms/p2` to `mcus/p2/hal/` so the MCU library has
one shape (native HAL trampolines, ISS, ISS-on-nets under one directory).

---

## Tests: what each file needs

| Input needed | `p2core/tests` | `p2iss/tests` | Goes to embsim CI |
|---|---|---|---|
| Silicon goldens only | `op_coverage`, `probe_coverage`, `silicon_oracle`, `silicon_probe`, `silicon_reports` | | **yes** |
| P2 boot ROM only | `rom_boot_chain`, `rom_serial` | `rom_boot_net`, `rom_serial_net` | **yes** |
| P2 boot ROM + loadp2's `flash_loader.bin`, read today from `Software/Control/src/firmware/image.ts` | `flash_program` | | no, stays in MaD; superseded upstream by the bootloader test |
| Nothing | `poll_fast_forward`, `sd_block_write` | | **yes** |
| MaD `propeller2_debug/program` | `block_fill`, `boot`, `per_cog_dir`, `sd_spi_words` | `level_pins`, `protocol_on_levels`, `pty_protocol`, `sd_mount`, `sd_node` | no, stays in MaD |
| MaD image **and** its flexcc `.p2asm` listing | `decoder_golden` | | no, stays in MaD |

The silicon rows are the point of the move: `probe.txt` holds 1550
one-instruction records from a P2-EVAL, the two baselines record the 98 cases
in 12 mnemonics that still diverge, and the gate fails on any *unlisted*
divergence and on any listed one that starts matching. That burn-down list
becomes embsim's.

---

## The Edge-module bootloader test

embsim has to prove the flashing chain works on the Edge module with no MaD
software in the loop: the P2 MCU, its boot ROM, the SPI flash on P58–P61, and
the flashing sequence injected over the serial bus on P62/P63. `flash_program.rs`
proves half of this today, since the real loadp2 stub runs as machine code and
programs the flash, but it takes the stub from the PWA and places the image in
hub by hand, skipping the ROM's serial loader. This test covers the whole chain
and is written from P2 parts only.

**Parts, all P2:**

- the ISS with the boot ROM and the boot straps on P59/P60/P61 set for the
  flash path, as `rom_boot_net` sets them;
- the `SpiFlash` model on the net (`flashnode`), initially blank;
- a host on the programming UART driving bytes as levels onto P63 and reading
  P62, as `rom_serial_net` does through `HostPty`;
- loadp2's `flash_loader.bin`, vendored from
  [totalspectrum/loadp2](https://github.com/totalspectrum/loadp2) (MIT) or
  assembled from its `.spin2` by the same script that builds the ROM. Never
  read from the PWA;
- a tiny payload built like the `hwtest` programs and committed as a binary,
  whose only job is to print a marker on P62.

**Sequence injected on the wire.** This is the ROM's own protocol, the one
loadp2 speaks, not anything of MaD's:

1. reset, then `> Prop_Chk 0 0 0 0  `; expect `\r\nProp_Ver G`;
2. `> Prop_Hex 0 0 0 0` followed by the hex of the stub then the payload, the
   header longs patched the way loadp2 patches them so the checksum lands on
   `"Prop"`, sent in chunks and terminated by `~`;
3. the ROM launches the download from hub `$0`; the stub erases and programs
   the flash over P58–P61 and reboots;
4. the ROM's strap decision now takes the flash path, loads the first
   kilobyte, verifies `"Prop"`, and launches loadp2's stage-1, which loads the
   payload.

**Assert:** the flash holds loadp2's stage-1 at `$000` with a valid checksum
and the payload after it, and after the reboot the payload's marker appears on
P62.

**Work it implies:** the ROM's hex download path executes on the ISS for the
first time, since `rom_serial` stops at `Prop_Chk`; loadp2's production stage-1
uses Fast Read Dual Output, which the flash model does not implement today
(`$03`, `$02`, `$06`, `$20`, `$D8` and `$C7` are there); the stub itself already
runs (`SKIP`, `LOC PTRA`, the streamer on a transition pin), per the
`flash_program` WIP. It lives in `embsim-p2-iss-net`, because "over the serial
bus" means levels on nets; a core-level twin through `Board::push_rx` is cheap
once it passes.

The simulator-only `stage1.spin2` and `flashimage.rs` chain (`rom_boot_chain`,
`rom_boot_net`) stays as a P2 item: it is the fast unit-level boot chain, and
the bootloader test is the acceptance check with the real stage-1. MaD keeps
`FW-ISS` in `run-all.mjs` as its own test of the PWA against this ROM.

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
- [ ] **`flash_program.rs` stays in MaD.** It decodes the base64 in
      `Software/Control/src/firmware/image.ts` on purpose, so it exercises the
      bytes the app ships; that makes it a MaD test. Two cases inside it are pure
      ISS facts and move upstream as plain tests:
      `loc_ptra_writes_the_absolute_hub_address` and
      `skip_cancels_a_slot_without_decoding_it`. The flashing coverage embsim
      needs comes from the bootloader test above, not from this file.
- [ ] **ROM assets** move into the ISS crate; `p2iss` and the tests read them
      from there instead of `../p2iss/rom`.
- [ ] **Vibes.** `flash_program`, `rom_serial` and `rom_serial_net` declare
      behaviours through `vibes-behaviour`, a path dep into MaD's `Vibes`
      submodule that embsim does not have. Eight claims in `behaviours.jsonl`
      cite them and `SIL/vibes.suite.json` runs them. `flash_program` stays, so
      its six claims stay. `rom_serial` and `rom_serial_net` move unannotated;
      drop their two claims and the two suite commands. The Prop_Chk handshake is
      a ROM fact, and MaD's `FW-ISS` e2e suite remains the MaD-side claim for UI
      flashing.
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
       the firmware tests, plus the bootloader test. Can fold into A.
5. [ ] **MaD bump PR:** bump the pin, delete `SIL/p2core` and `SIL/p2iss`, drop
       them from `SIL/Cargo.toml`, re-home the acceptance tests, `flash_program`,
       `decoder_golden`, `gen_golden.py` and `mad_card` into MaDSim, update imports, `makefile`
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
