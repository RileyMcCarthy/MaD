//! `CMD24` must actually take the block the host sends.
//!
//! The card answers `CMD24` with R1 and *then* waits for the data packet. The
//! model set `Phase::ReceivingBlock` inside the command, but the caller that
//! had just run the command immediately overwrote it with `Phase::Responding`
//! because a response was now queued — and draining that response returned the
//! card to `Phase::Command`. `ReceivingBlock` was unreachable, so every write
//! failed twice over: the host read `$FF` where `xmit_datablock` wants the
//! `$05` data-accepted token and gave up with `RES_ERROR`, and the 512 payload
//! bytes were fed to the command collector, which latches on any byte matching
//! `%01xxxxxx` and manufactured commands out of file data (the "BIN " of a
//! directory entry decodes as `CMD2`).
//!
//! What the guest saw: `disk_write` -> `RES_ERROR` -> `FR_DISK_ERR` -> errno 12
//! (`EIO` in FlexC's non-standard `errno.h`), so `fopen(..., "wb")` failed and
//! no test run could ever store its G-code. Reads were fine throughout, which
//! is what made it look like a filesystem or firmware fault.

use p2core::sdcard::BLOCK_LEN;
use p2core::SdCard;

/// Drive one byte the way `sdmm.cc` does, discarding what comes back.
fn send(card: &mut SdCard, b: u8) -> u8 {
    card.xfer(b)
}

/// A 6-byte command frame: %01 + index, 4-byte argument, CRC (ignored here).
fn command(card: &mut SdCard, index: u8, arg: u32) {
    send(card, 0x40 | index);
    for shift in [24, 16, 8, 0] {
        send(card, (arg >> shift) as u8);
    }
    send(card, 0x95);
}

/// Clock until a byte with bit 7 clear appears, which is how the host finds R1.
fn r1(card: &mut SdCard) -> u8 {
    for _ in 0..16 {
        let b = send(card, 0xFF);
        if b & 0x80 == 0 {
            return b;
        }
    }
    panic!("no R1 response within 16 byte times");
}

#[test]
fn cmd24_stores_the_block_and_returns_the_data_accepted_token() {
    let mut card = SdCard::blank(64 * BLOCK_LEN);
    // A payload whose bytes include the `%01xxxxxx` patterns that used to be
    // mistaken for command frames — this is a FAT directory entry's shape.
    let payload: Vec<u8> = (0..BLOCK_LEN).map(|i| b"000001  BIN "[i % 12]).collect();

    command(&mut card, 24, 3);
    assert_eq!(r1(&mut card), 0x00, "CMD24 is accepted");

    // `xmit_datablock`: start token, 512 bytes, two CRC bytes, then read the
    // data-response byte.
    send(&mut card, 0xFE);
    for &b in &payload {
        send(&mut card, b);
    }
    send(&mut card, 0xFF);
    send(&mut card, 0xFF);
    let response = send(&mut card, 0xFF);

    assert_eq!(
        response & 0x1F,
        0x05,
        "the card must answer the data-accepted token; sdmm.cc treats anything \
         else as a failed write"
    );
    assert_eq!(
        &card.blocks[3 * BLOCK_LEN..4 * BLOCK_LEN],
        &payload[..],
        "the block is stored where CMD24 addressed it"
    );
    assert_eq!(
        card.commands,
        vec![24],
        "the payload must not be parsed as commands"
    );
}

#[test]
fn releasing_chip_select_mid_block_abandons_the_write() {
    let mut card = SdCard::blank(64 * BLOCK_LEN);

    command(&mut card, 24, 1);
    assert_eq!(r1(&mut card), 0x00);
    send(&mut card, 0xFE);
    for _ in 0..64 {
        send(&mut card, 0xAA);
    }

    // The host gives up and releases the card. On the net side no bytes are
    // exchanged at all while CS is high, so the release itself has to clear
    // the half-received block — see `SdCard::set_selected`.
    card.set_selected(false);
    card.set_selected(true);

    // A fresh command must be seen as a command, not as more payload.
    command(&mut card, 17, 0);
    assert_eq!(r1(&mut card), 0x00, "the next command is understood");
    assert_eq!(
        card.commands,
        vec![24, 17],
        "an abandoned write leaves no half-block behind"
    );
}

/// `CMD18` / `CMD25` — the multi-block forms `sdmm.cc` uses for every transfer
/// of more than one sector.
///
/// `disk_read` picks `CMD18` whenever FatFs asks for `count > 1`, and
/// `disk_write` picks `CMD25` (after `ACMD23`), so a file of any size goes
/// through them. The model answered both with `R1_ILLEGAL`, which
/// `send_cmd() == 0` reads as failure: `RES_ERROR` -> `FR_DISK_ERR` -> errno 12.
/// Single-sector metadata writes worked, so a file would be created and then
/// fail on its contents — which read as an intermittent filesystem fault.
#[test]
fn cmd18_streams_blocks_until_cmd12_stops_it() {
    let mut card = SdCard::blank(64 * BLOCK_LEN);
    for b in 0..3usize {
        let at = (10 + b) * BLOCK_LEN;
        card.blocks[at..at + BLOCK_LEN].fill(0xB0 + b as u8);
    }

    command(&mut card, 18, 10);
    assert_eq!(r1(&mut card), 0x00, "CMD18 is accepted");

    for b in 0..3usize {
        // `rcvr_datablock` waits for the start token, then takes 512 + 2.
        let mut token = 0xFFu8;
        for _ in 0..8 {
            token = send(&mut card, 0xFF);
            if token != 0xFF {
                break;
            }
        }
        assert_eq!(token, 0xFE, "block {b} starts with a data token");
        let block: Vec<u8> = (0..BLOCK_LEN).map(|_| send(&mut card, 0xFF)).collect();
        send(&mut card, 0xFF);
        send(&mut card, 0xFF);
        assert!(
            block.iter().all(|&v| v == 0xB0 + b as u8),
            "block {b} carries the right sector"
        );
    }

    command(&mut card, 12, 0);
    assert_eq!(r1(&mut card), 0x00, "CMD12 stops the stream");
    assert_eq!(card.commands, vec![18, 12], "no phantom commands");
}

#[test]
fn cmd25_takes_blocks_until_the_stop_token() {
    let mut card = SdCard::blank(64 * BLOCK_LEN);

    command(&mut card, 25, 20);
    assert_eq!(r1(&mut card), 0x00, "CMD25 is accepted");

    for b in 0..2usize {
        send(&mut card, 0xFC); // multi-write start token
        for _ in 0..BLOCK_LEN {
            send(&mut card, 0xC0 + b as u8);
        }
        send(&mut card, 0xFF);
        send(&mut card, 0xFF);
        assert_eq!(send(&mut card, 0xFF) & 0x1F, 0x05, "block {b} is accepted");
        // The busy byte before the card is ready again.
        assert_eq!(send(&mut card, 0xFF), 0xFF);
    }

    send(&mut card, 0xFD); // stop transmission
    send(&mut card, 0xFF);

    for b in 0..2usize {
        let at = (20 + b) * BLOCK_LEN;
        assert!(
            card.blocks[at..at + BLOCK_LEN]
                .iter()
                .all(|&v| v == 0xC0 + b as u8),
            "block {b} landed at its own address"
        );
    }
    assert!(
        card.blocks[22 * BLOCK_LEN..23 * BLOCK_LEN]
            .iter()
            .all(|&v| v == 0),
        "the stop token ends the run rather than writing a third block"
    );
    assert_eq!(card.commands, vec![25], "payload is not parsed as commands");
}

/// The stall that killed the bus: `CMD24` answered, then no data block.
///
/// `sdmm.cc`'s `xmit_datablock` begins with `wait_ready()`, and when that times
/// out it returns without ever sending the `$FE` token — the command has been
/// accepted but no payload follows. `disk_write` then calls `deselect()` and
/// the caller retries. If the card is still waiting for that block when CS
/// comes back down, it takes the retry's six command bytes for payload, and
/// every command after it too: the observed run had the host re-sending
/// `58 00 00 00 a5 01` into a card that answered `$FF` forever, with the SD
/// bus dead for the remaining minutes of the test.
#[test]
fn a_command_that_never_sends_its_block_does_not_deafen_the_card() {
    let mut card = SdCard::blank(256 * BLOCK_LEN);

    command(&mut card, 24, 165);
    assert_eq!(r1(&mut card), 0x00);
    // The host gives up before the token and releases the card.
    card.set_selected(false);
    card.set_selected(true);

    // The retry must be heard.
    command(&mut card, 24, 165);
    assert_eq!(r1(&mut card), 0x00, "the retried CMD24 is heard");
    send(&mut card, 0xFE);
    for _ in 0..BLOCK_LEN {
        send(&mut card, 0x5A);
    }
    send(&mut card, 0xFF);
    send(&mut card, 0xFF);
    assert_eq!(
        send(&mut card, 0xFF) & 0x1F,
        0x05,
        "and the block is accepted"
    );
    assert!(
        card.blocks[165 * BLOCK_LEN..166 * BLOCK_LEN]
            .iter()
            .all(|&v| v == 0x5A),
        "the retried write lands"
    );
    assert_eq!(card.commands, vec![24, 24], "no payload parsed as commands");
}

/// Write a block, then read it back — the sequence every file close/open pair
/// performs, and the one that still failed on the wire.
#[test]
fn a_block_written_reads_back_and_the_bus_stays_in_step() {
    let mut card = SdCard::blank(256 * BLOCK_LEN);
    let payload: Vec<u8> = (0..BLOCK_LEN).map(|i| (i % 251) as u8).collect();

    // Single-block write, exactly as `disk_write(count == 1)` drives it.
    command(&mut card, 24, 130);
    assert_eq!(r1(&mut card), 0x00);
    send(&mut card, 0xFE);
    for &b in &payload {
        send(&mut card, b);
    }
    send(&mut card, 0xFF);
    send(&mut card, 0xFF);
    assert_eq!(send(&mut card, 0xFF) & 0x1F, 0x05, "write accepted");
    // `disk_write` then deselects.
    card.set_selected(false);
    card.set_selected(true);

    // Single-block read back.
    command(&mut card, 17, 130);
    assert_eq!(r1(&mut card), 0x00, "CMD17 after a write is heard");
    let mut token = 0xFFu8;
    for _ in 0..8 {
        token = send(&mut card, 0xFF);
        if token != 0xFF {
            break;
        }
    }
    assert_eq!(token, 0xFE, "the read returns a data token");
    let got: Vec<u8> = (0..BLOCK_LEN).map(|_| send(&mut card, 0xFF)).collect();
    send(&mut card, 0xFF);
    send(&mut card, 0xFF);
    assert_eq!(got, payload, "the block reads back byte for byte");
    assert_eq!(card.commands, vec![24, 17], "no phantom commands");
}

/// A multi-block write followed by a multi-block read of the same run.
#[test]
fn multi_block_write_then_multi_block_read_round_trips() {
    let mut card = SdCard::blank(256 * BLOCK_LEN);

    command(&mut card, 25, 40);
    assert_eq!(r1(&mut card), 0x00);
    for b in 0..3usize {
        send(&mut card, 0xFC);
        for _ in 0..BLOCK_LEN {
            send(&mut card, 0xE0 + b as u8);
        }
        send(&mut card, 0xFF);
        send(&mut card, 0xFF);
        assert_eq!(send(&mut card, 0xFF) & 0x1F, 0x05, "block {b} accepted");
        send(&mut card, 0xFF);
    }
    send(&mut card, 0xFD);
    send(&mut card, 0xFF);
    card.set_selected(false);
    card.set_selected(true);

    command(&mut card, 18, 40);
    assert_eq!(r1(&mut card), 0x00, "CMD18 after a multi-write is heard");
    for b in 0..3usize {
        let mut token = 0xFFu8;
        for _ in 0..8 {
            token = send(&mut card, 0xFF);
            if token != 0xFF {
                break;
            }
        }
        assert_eq!(token, 0xFE, "block {b} token");
        let got: Vec<u8> = (0..BLOCK_LEN).map(|_| send(&mut card, 0xFF)).collect();
        send(&mut card, 0xFF);
        send(&mut card, 0xFF);
        assert!(
            got.iter().all(|&v| v == 0xE0 + b as u8),
            "block {b} reads back"
        );
    }
    command(&mut card, 12, 0);
    assert_eq!(r1(&mut card), 0x00);
    assert_eq!(card.commands, vec![25, 18, 12], "no phantom commands");
}
