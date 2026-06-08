//! Protocol framing layer
//!
//! Handles the wire format:
//! ```text
//! READ request:   [0x55] [TYPE=0x00] [COMMAND]
//! WRITE request:  [0x55] [TYPE=0x01] [COMMAND] [LEN_LO] [LEN_HI] [DATA...] [CRC8]
//! NACK response:  [0x55] [TYPE=0x00] [COMMAND]
//! ACK response:   [0x55] [TYPE=0x01] [COMMAND]
//! DATA response:  [0x55] [TYPE=0x02] [COMMAND] [LEN_LO] [LEN_HI] [DATA...] [CRC8]
//! NOTIFICATION:   [0x55] [TYPE=0x03] [0x00]    [LEN_LO] [LEN_HI] [DATA...] [CRC8]
//! ```

/// Sync byte that starts every frame
pub const SYNC_BYTE: u8 = 0x55;

/// Maximum payload size (16-bit length field)
pub const MAX_PAYLOAD_SIZE: usize = 4096;

// ── Frame type bytes ──

/// Incoming (host→device) and outgoing (device→host) frame type constants
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameType {
    /// Incoming: READ request (3 bytes, no payload)
    /// Outgoing: NACK response (3 bytes, no payload)
    NackOrRead = 0x00,
    /// Incoming: WRITE request (has payload)
    /// Outgoing: ACK response (3 bytes, no payload)
    AckOrWrite = 0x01,
    /// Outgoing: DATA response (has payload)
    Data = 0x02,
    /// Outgoing: NOTIFICATION (has payload)
    Notification = 0x03,
}

impl FrameType {
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            0x00 => Some(Self::NackOrRead),
            0x01 => Some(Self::AckOrWrite),
            0x02 => Some(Self::Data),
            0x03 => Some(Self::Notification),
            _ => None,
        }
    }

    /// Does this frame type carry a payload (LENGTH + DATA + CRC)?
    pub fn has_payload(self, direction: Direction) -> bool {
        match direction {
            Direction::Incoming => matches!(self, Self::AckOrWrite),
            Direction::Outgoing => matches!(self, Self::Data | Self::Notification),
        }
    }
}

/// Direction of communication for disambiguating frame types
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Messages coming FROM the transport (device → host)
    Incoming,
    /// Messages going TO the transport (host → device)
    Outgoing,
}

// ── Parsed frame ──

/// A fully parsed and validated frame
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedFrame {
    /// NACK response — command byte only
    Nack(u8),
    /// ACK response — command byte only
    Ack(u8),
    /// DATA response — command byte + payload
    Data { command: u8, payload: Vec<u8> },
    /// NOTIFICATION — payload
    Notification(Vec<u8>),
}

// ── CRC-8 (MAXIM/Dallas 1-Wire, poly 0x8C reflected) ──

/// Compute CRC-8/MAXIM over a byte slice.
/// Polynomial: 0x8C (reflected form of 0x31).
pub fn crc8(data: &[u8]) -> u8 {
    let mut crc: u8 = 0;
    for &byte in data {
        let mut inbyte = byte;
        for _ in 0..8 {
            let mix = (crc ^ inbyte) & 0x01;
            crc >>= 1;
            if mix != 0 {
                crc ^= 0x8C;
            }
            inbyte >>= 1;
        }
    }
    crc
}

// ── Frame builder functions ──

/// Build a READ request frame (3 bytes, no payload).
///
/// `[SYNC] [TYPE=0x00] [COMMAND]`
pub fn build_read_frame(command: u8) -> Vec<u8> {
    vec![SYNC_BYTE, 0x00, command]
}

/// Build a WRITE request frame with payload.
///
/// `[SYNC] [TYPE=0x01] [COMMAND] [LEN_LO] [LEN_HI] [DATA...] [CRC8]`
pub fn build_write_frame(command: u8, data: &[u8]) -> Vec<u8> {
    let len = data.len() as u16;
    let crc = crc8(data);
    let mut frame = Vec::with_capacity(6 + data.len());
    frame.push(SYNC_BYTE);
    frame.push(0x01);
    frame.push(command);
    frame.push(len as u8);        // LEN_LO
    frame.push((len >> 8) as u8); // LEN_HI
    frame.extend_from_slice(data);
    frame.push(crc);
    frame
}

// ── Frame parser (state machine) ──

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParseState {
    Sync,
    Type,
    Command,
    LengthLo,
    LengthHi,
    Data,
    Crc,
}

/// Streaming frame parser.
///
/// Feed bytes one at a time via [`FrameParser::feed`]. When a complete
/// frame is recognized, it returns `Some(ParsedFrame)`.
///
/// This parser expects frames in the incoming direction (device → host),
/// so TYPE byte is interpreted as: 0=NACK, 1=ACK, 2=DATA, 3=NOTIFICATION.
#[derive(Debug)]
pub struct FrameParser {
    state: ParseState,
    frame_type: u8,
    command: u8,
    data_len: u16,
    data_received: u16,
    buf: Vec<u8>,
}

impl Default for FrameParser {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameParser {
    pub fn new() -> Self {
        Self {
            state: ParseState::Sync,
            frame_type: 0,
            command: 0,
            data_len: 0,
            data_received: 0,
            buf: Vec::with_capacity(256),
        }
    }

    /// Reset the parser to initial state.
    pub fn reset(&mut self) {
        self.state = ParseState::Sync;
        self.frame_type = 0;
        self.command = 0;
        self.data_len = 0;
        self.data_received = 0;
        self.buf.clear();
    }

    /// Feed a single byte into the parser.
    ///
    /// Returns `Some(ParsedFrame)` when a complete frame has been received.
    pub fn feed(&mut self, byte: u8) -> Option<ParsedFrame> {
        match self.state {
            ParseState::Sync => {
                if byte == SYNC_BYTE {
                    self.state = ParseState::Type;
                }
                None
            }

            ParseState::Type => {
                self.frame_type = byte;
                if byte > 0x03 {
                    // Invalid type, reset
                    self.state = ParseState::Sync;
                    return None;
                }
                self.state = ParseState::Command;
                None
            }

            ParseState::Command => {
                self.command = byte;

                match self.frame_type {
                    // NACK (0x00) or ACK (0x01) — short frames, no payload
                    0x00 => {
                        self.state = ParseState::Sync;
                        Some(ParsedFrame::Nack(self.command))
                    }
                    0x01 => {
                        self.state = ParseState::Sync;
                        Some(ParsedFrame::Ack(self.command))
                    }
                    // DATA (0x02) or NOTIFICATION (0x03) — has payload
                    0x02 | 0x03 => {
                        self.state = ParseState::LengthLo;
                        None
                    }
                    _ => {
                        self.state = ParseState::Sync;
                        None
                    }
                }
            }

            ParseState::LengthLo => {
                self.data_len = byte as u16;
                self.state = ParseState::LengthHi;
                None
            }

            ParseState::LengthHi => {
                self.data_len |= (byte as u16) << 8;

                if self.data_len == 0 {
                    // Zero-length payload — go straight to CRC
                    self.buf.clear();
                    self.data_received = 0;
                    self.state = ParseState::Crc;
                } else if self.data_len as usize > MAX_PAYLOAD_SIZE {
                    // Payload too large, reject
                    self.state = ParseState::Sync;
                } else {
                    self.buf.clear();
                    self.buf.reserve(self.data_len as usize);
                    self.data_received = 0;
                    self.state = ParseState::Data;
                }
                None
            }

            ParseState::Data => {
                self.buf.push(byte);
                self.data_received += 1;
                if self.data_received >= self.data_len {
                    self.state = ParseState::Crc;
                }
                None
            }

            ParseState::Crc => {
                let expected_crc = crc8(&self.buf);
                self.state = ParseState::Sync;

                if byte != expected_crc {
                    // CRC mismatch — discard frame
                    return None;
                }

                let payload = std::mem::take(&mut self.buf);
                match self.frame_type {
                    0x02 => Some(ParsedFrame::Data {
                        command: self.command,
                        payload,
                    }),
                    0x03 => Some(ParsedFrame::Notification(payload)),
                    _ => None,
                }
            }
        }
    }

    /// Feed a slice of bytes, collecting all parsed frames.
    pub fn feed_bytes(&mut self, bytes: &[u8]) -> Vec<ParsedFrame> {
        let mut frames = Vec::new();
        for &b in bytes {
            if let Some(frame) = self.feed(b) {
                frames.push(frame);
            }
        }
        frames
    }
}

// ============================================================
// Tests
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crc8_empty() {
        assert_eq!(crc8(&[]), 0);
    }

    #[test]
    fn test_crc8_known_values() {
        // CRC-8/MAXIM test vector
        assert_eq!(crc8(&[0x00]), 0x00);
        assert_eq!(crc8(&[0x01]), 0x5E);
        // Multi-byte
        let data = [0x01, 0x02, 0x03];
        let c = crc8(&data);
        // Verify it's deterministic
        assert_eq!(crc8(&data), c);
    }

    #[test]
    fn test_build_read_frame() {
        let frame = build_read_frame(0x02);
        assert_eq!(frame, vec![0x55, 0x00, 0x02]);
    }

    #[test]
    fn test_build_write_frame() {
        let data = [0xAA, 0xBB];
        let frame = build_write_frame(0x03, &data);
        assert_eq!(frame[0], SYNC_BYTE);
        assert_eq!(frame[1], 0x01); // WRITE type
        assert_eq!(frame[2], 0x03); // command
        assert_eq!(frame[3], 0x02); // LEN_LO
        assert_eq!(frame[4], 0x00); // LEN_HI
        assert_eq!(frame[5], 0xAA);
        assert_eq!(frame[6], 0xBB);
        assert_eq!(frame[7], crc8(&data)); // CRC
    }

    #[test]
    fn test_parse_nack() {
        let mut parser = FrameParser::new();
        let bytes = [SYNC_BYTE, 0x00, 0x05]; // NACK for command 5
        let frames = parser.feed_bytes(&bytes);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], ParsedFrame::Nack(0x05));
    }

    #[test]
    fn test_parse_ack() {
        let mut parser = FrameParser::new();
        let bytes = [SYNC_BYTE, 0x01, 0x03]; // ACK for command 3
        let frames = parser.feed_bytes(&bytes);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], ParsedFrame::Ack(0x03));
    }

    #[test]
    fn test_parse_data_frame() {
        let data = [0x01, 0x02, 0x03, 0x04];
        let crc = crc8(&data);
        let mut frame = vec![
            SYNC_BYTE,
            0x02, // DATA type
            0x01, // command
            0x04, // LEN_LO
            0x00, // LEN_HI
        ];
        frame.extend_from_slice(&data);
        frame.push(crc);

        let mut parser = FrameParser::new();
        let frames = parser.feed_bytes(&frame);
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0],
            ParsedFrame::Data {
                command: 0x01,
                payload: data.to_vec()
            }
        );
    }

    #[test]
    fn test_parse_notification() {
        let data = b"Hello!";
        let crc = crc8(data);
        let mut frame = vec![
            SYNC_BYTE,
            0x03, // NOTIFICATION
            0x00, // command (unused)
            data.len() as u8,
            0x00,
        ];
        frame.extend_from_slice(data);
        frame.push(crc);

        let mut parser = FrameParser::new();
        let frames = parser.feed_bytes(&frame);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], ParsedFrame::Notification(data.to_vec()));
    }

    #[test]
    fn test_parse_bad_crc_discards() {
        let data = [0x01, 0x02];
        let mut frame = vec![SYNC_BYTE, 0x02, 0x00, 0x02, 0x00];
        frame.extend_from_slice(&data);
        frame.push(0xFF); // wrong CRC

        let mut parser = FrameParser::new();
        let frames = parser.feed_bytes(&frame);
        assert_eq!(frames.len(), 0);
    }

    #[test]
    fn test_parse_multiple_frames() {
        let mut parser = FrameParser::new();

        // ACK + NACK back to back
        let bytes = [
            SYNC_BYTE, 0x01, 0x02, // ACK cmd=2
            SYNC_BYTE, 0x00, 0x05, // NACK cmd=5
        ];
        let frames = parser.feed_bytes(&bytes);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], ParsedFrame::Ack(0x02));
        assert_eq!(frames[1], ParsedFrame::Nack(0x05));
    }

    #[test]
    fn test_parse_write_frame_roundtrip() {
        // Build a WRITE frame (host → device direction)
        // Then parse it as if we were the device endpoint (which sees READ/WRITE types)
        // Note: FrameParser is set up for incoming device → host frames (NACK/ACK/DATA/NOTIFICATION)
        // So a WRITE frame (type=0x01) would be parsed as ACK in this parser
        let frame = build_write_frame(0x03, &[0x42]);
        let mut parser = FrameParser::new();
        let frames = parser.feed_bytes(&frame);
        // Type 0x01 = ACK in the parser (short frame), so only SYNC+TYPE+CMD is consumed
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], ParsedFrame::Ack(0x03));
    }

    #[test]
    fn test_parse_invalid_type_resets() {
        let mut parser = FrameParser::new();
        let bytes = [SYNC_BYTE, 0xFF, 0x00]; // invalid type
        let frames = parser.feed_bytes(&bytes);
        assert!(frames.is_empty());
    }

    #[test]
    fn test_parse_oversized_payload_resets() {
        let mut parser = FrameParser::new();
        // Claim a huge payload
        let bytes = [
            SYNC_BYTE, 0x02, 0x00, 0xFF, 0xFF, // len = 65535 > MAX_PAYLOAD_SIZE
        ];
        let frames = parser.feed_bytes(&bytes);
        assert!(frames.is_empty());
    }

    #[test]
    fn test_garbage_before_sync() {
        let mut parser = FrameParser::new();
        let bytes = [0x00, 0x12, 0x34, SYNC_BYTE, 0x01, 0x07]; // garbage then ACK
        let frames = parser.feed_bytes(&bytes);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], ParsedFrame::Ack(0x07));
    }
}
