//! The boot ROM's serial loader, driven with real `>` autobaud bytes.
//!
//! The PWA pulses DTR and sends `> Prop_Chk 0 0 0 0  `; the mask ROM autobauds
//! on `>`, matches the command, and answers `\r\nProp_Ver G\r\n` on P62. That
//! handshake is what UI flashing uses before the hex payload.

use p2core::{Board, Machine, SdCard};
use vibes_behaviour::{behaviour, expect, Test};

fn rom() -> Option<Vec<u8>> {
    std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../p2iss/rom/rom_booter_v33k.bin"),
    )
    .ok()
}

fn dump(m: &Machine<Board>) -> String {
    let c = &m.cogs[0];
    format!(
        "pc={:05X} running={} ijmp1={:05X} se1={:03X} int1={} \
         int1_entries={} pending={} console={:?}",
        c.pc,
        c.running,
        c.regs[0x1F4],
        c.se1_cfg,
        c.int1_src,
        m.int1_entries,
        m.pins.rx_pending(),
        m.pins.console()
    )
}

fn step(m: &mut Machine<Board>, n: u64, trap: &mut Option<String>) {
    match m.step(n) {
        Ok(_) => {}
        Err(e) => *trap = Some(format!("{e:?} pc={:05X}", m.cogs[0].pc)),
    }
}

#[test]
fn the_rom_answers_prop_chk_on_the_programming_uart() {
    behaviour!(Test {
        id: "p2.rom-serial-prop-chk",
        covers: Some("SIL/p2core/src/lib.rs#execute"),
        given: "the mask ROM on an empty flash with the serial strap pulled up, sent the programming-port Prop_Chk command",
    });
    expect!(
        "prop-ver",
        "the ROM autobauds on '>' and answers Prop_Ver G on the programming UART"
    );

    std::env::set_var("P2CORE_NO_FF", "1");
    let Some(rom) = rom() else {
        eprintln!("\n*** SKIPPED: needs `make bootrom`. Asserted NOTHING.\n");
        return;
    };
    let board = Board::new(SdCard::blank(0)).with_flash(vec![0xFF; 1024]);
    let mut m = Machine::with_boot_rom(&rom, board);
    // Pull-up on P59 (SPI DI): the ROM's first strap check jumps to serial.
    m.pins.set_input_level(59, true);

    let mut trap = None;
    for _ in 0..200_000 {
        if m.cogs[0].int1_src == 4 {
            break;
        }
        match m.step(1) {
            Ok(_) if m.cogs[0].running => {}
            Ok(_) => break,
            Err(e) => {
                trap = Some(format!("{e:?}"));
                break;
            }
        }
    }
    assert_eq!(
        m.cogs[0].int1_src,
        4,
        "the ROM must arm INT1 for serial autobaud; {} trap={trap:?}",
        dump(&m)
    );

    // The LUT receive buffer is 16 longs. Wait until get_rx is spinning, then
    // drain each byte before the next so the window is not overwritten.
    for _ in 0..200_000 {
        if matches!(m.cogs[0].pc, 0x29A | 0x29B) && !m.cogs[0].in_int1 {
            break;
        }
        match m.step(1) {
            Ok(_) if m.cogs[0].running => {}
            Ok(_) => break,
            Err(e) => {
                trap = Some(format!("{e:?}"));
                break;
            }
        }
    }
    assert!(
        matches!(m.cogs[0].pc, 0x29A | 0x29B),
        "the ROM must be spinning in get_rx before we send; {} trap={trap:?}",
        dump(&m)
    );

    for b in b"> Prop_Chk 0 0 0 0  " {
        m.pins.push_rx(*b);
        for _ in 0..8_000 {
            match m.step(1) {
                Ok(_) if m.cogs[0].running => {}
                Ok(_) => break,
                Err(e) => {
                    trap = Some(format!("{e:?} pc={:05X}", m.cogs[0].pc));
                    break;
                }
            }
            if m.pins.rx_pending() == 0 {
                break;
            }
        }
        step(&mut m, 2_000, &mut trap);
    }
    step(&mut m, 200_000, &mut trap);
    let console = m.pins.console();
    assert!(
        console.contains("Prop_Ver G"),
        "the ROM must autobaud on '>' and answer Prop_Chk; {} trap={trap:?}",
        dump(&m)
    );
}
