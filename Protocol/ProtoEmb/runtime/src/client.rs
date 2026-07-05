//! Protocol client — request/response orchestration over a transport.
//!
//! The [`Client`] manages the full lifecycle:
//! 1. Accept read/write requests into a [`PriorityQueue`]
//! 2. Send one message at a time on the wire
//! 3. Parse incoming bytes via [`FrameParser`]
//! 4. Match responses to the pending request
//! 5. Emit parsed events via a callback
//!
//! The client runs a **single-threaded poll loop** — call [`Client::poll`]
//! from your event loop, or use [`Client::run`] to spin in a dedicated thread.
//!
//! This module is protocol-agnostic: it works with raw `u8` command IDs
//! and `Vec<u8>` payloads. Project-specific decoding happens in the caller.

use std::io;
use std::time::Duration;

// `Instant` needs a monotonic clock. On wasm32 `std::time::Instant` panics, so
// use `web_time::Instant` (backed by `performance.now()`) there instead.
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;
#[cfg(target_arch = "wasm32")]
use web_time::Instant;

use protoemb_framing::{self, build_read_frame, build_write_frame, FrameParser, ParsedFrame};

use crate::queue::{Priority, PriorityQueue, QueuedMessage};
use crate::storage::DataStore;
use crate::transport::Transport;

/// Default timeout for pending responses (ms).
const DEFAULT_TIMEOUT_MS: u64 = 2000;

/// Read buffer size for serial reads.
const READ_BUF_SIZE: usize = 4096;

/// Events emitted by the client to the caller.
///
/// On wasm the enum is serialized to a tagged JS object (`{ event, ... }`)
/// via `serde-wasm-bindgen`, matching the shape the TypeScript layer expects.
#[derive(Debug, Clone)]
#[cfg_attr(target_arch = "wasm32", derive(serde::Serialize))]
#[cfg_attr(target_arch = "wasm32", serde(tag = "event", rename_all = "lowercase"))]
pub enum Event {
    /// ACK received for a write command.
    Ack { command: u8 },
    /// NACK received for a command.
    Nack { command: u8 },
    /// DATA response received (command + decoded payload bytes).
    Data {
        command: u8,
        // serialize as a JS `Uint8Array` (not a boxed `number[]`) on wasm — far
        // cheaper to marshal at the ~100 Hz sample rate.
        #[cfg_attr(target_arch = "wasm32", serde(with = "serde_bytes"))]
        payload: Vec<u8>,
    },
    /// Unsolicited NOTIFICATION received.
    Notification {
        #[cfg_attr(target_arch = "wasm32", serde(with = "serde_bytes"))]
        payload: Vec<u8>,
    },
    /// The pending request timed out waiting for a response.
    Timeout {
        #[cfg_attr(target_arch = "wasm32", serde(with = "serde_bytes"))]
        frame: Vec<u8>,
    },
    /// Transport error occurred.
    Error { message: String },
}

/// Configuration for the client.
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// Timeout for pending responses.
    pub response_timeout: Duration,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            response_timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
        }
    }
}

/// Protocol client that orchestrates request/response communication
/// over a [`Transport`] using the ProtoEmb framing layer.
pub struct Client {
    transport: Box<dyn Transport>,
    parser: FrameParser,
    queue: PriorityQueue,
    config: ClientConfig,

    /// The frame currently in-flight (waiting for response).
    pending: Option<PendingRequest>,

    /// Per-command periodic read scheduling.
    periodic: Vec<PeriodicEntry>,

    /// Storage for periodic data responses.
    store: DataStore,
}

struct PendingRequest {
    frame: Vec<u8>,
    command: u8,
    sent_at: Instant,
}

/// A periodic read registration.
struct PeriodicEntry {
    /// Command ID to read.
    command: u8,
    /// Interval between reads.
    interval: Duration,
    /// Coalesce key for the priority queue.
    coalesce_key: String,
    /// Last time a read was enqueued.
    last_enqueued: Option<Instant>,
}

impl Client {
    /// Create a new client with the given transport and default config.
    pub fn new(transport: Box<dyn Transport>) -> Self {
        Self::with_config(transport, ClientConfig::default())
    }

    /// Create a new client with custom configuration.
    pub fn with_config(transport: Box<dyn Transport>, config: ClientConfig) -> Self {
        Self {
            transport,
            parser: FrameParser::new(),
            queue: PriorityQueue::new(),
            config,
            pending: None,
            periodic: Vec::new(),
            store: DataStore::new(),
        }
    }

    /// Enqueue a READ request for the given command ID.
    ///
    /// - `command`: the read command byte
    /// - `priority`: HIGH for on-demand, LOW for periodic polling
    /// - `coalesce_key`: if set, replaces any queued message with the same key
    pub fn read(&mut self, command: u8, priority: Priority, coalesce_key: Option<String>) {
        let frame = build_read_frame(command);
        self.queue.push(QueuedMessage {
            frame,
            priority,
            coalesce_key,
        });
    }

    /// Enqueue a WRITE request for the given command ID with payload data.
    ///
    /// Writes are always HIGH priority.
    pub fn write(&mut self, command: u8, data: &[u8]) {
        let frame = build_write_frame(command, data);
        self.queue.push(QueuedMessage {
            frame,
            priority: Priority::High,
            coalesce_key: None,
        });
    }

    /// Perform one poll cycle:
    /// 1. Read available bytes from transport and parse frames
    /// 2. Check for response timeout
    /// 3. Enqueue any due periodic reads
    /// 4. Send next queued message if nothing is pending
    ///
    /// Returns a vector of events that occurred during this poll.
    /// Call this repeatedly from your event loop.
    pub fn poll(&mut self) -> Vec<Event> {
        let mut events = Vec::new();

        // ── 1. Read incoming bytes and parse frames ──
        // Drain everything available this cycle (loop until a short read). A
        // single fixed read left a backlog if the input arrived faster than the
        // poll cadence (e.g. a throttled background tab on the wasm transport) —
        // the deque then grew and bled off slowly. Reads are non-blocking
        // (Ok(0) on no-data/timeout), so this never stalls the poll.
        let mut buf = [0u8; READ_BUF_SIZE];
        loop {
            match self.transport.read(&mut buf) {
                Ok(0) => break, // nothing more available
                Ok(n) => {
                    let frames = self.parser.feed_bytes(&buf[..n]);
                    for frame in frames {
                        let event = self.handle_frame(frame);
                        events.push(event);
                    }
                    if n < buf.len() {
                        break; // partial fill ⇒ input drained
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::TimedOut => break,
                Err(e) => {
                    events.push(Event::Error {
                        message: format!("Transport read error: {}", e),
                    });
                    break;
                }
            }
        }

        // ── 2. Check for response timeout ──
        if let Some(ref pending) = self.pending {
            if pending.sent_at.elapsed() >= self.config.response_timeout {
                let frame = pending.frame.clone();
                log::warn!("Response timeout — clearing pending flag");
                self.pending = None;
                events.push(Event::Timeout { frame });
            }
        }

        // ── 3. Enqueue due periodic reads ──
        self.enqueue_periodic();

        // ── 4. Flush next queued message ──
        self.try_flush(&mut events);

        events
    }

    /// Handle a parsed frame, match it to the pending request, and emit an event.
    fn handle_frame(&mut self, frame: ParsedFrame) -> Event {
        match frame {
            ParsedFrame::Ack(cmd) => {
                if let Some(expected) = self.pending.as_ref().map(|p| p.command) {
                    if expected != cmd {
                        return Event::Error {
                            message: format!(
                                "Mismatched ACK command: expected {}, got {}",
                                expected, cmd
                            ),
                        };
                    }
                    self.pending = None;
                }
                Event::Ack { command: cmd }
            }
            ParsedFrame::Nack(cmd) => {
                if let Some(expected) = self.pending.as_ref().map(|p| p.command) {
                    if expected != cmd {
                        return Event::Error {
                            message: format!(
                                "Mismatched NACK command: expected {}, got {}",
                                expected, cmd
                            ),
                        };
                    }
                    self.pending = None;
                }
                Event::Nack { command: cmd }
            }
            ParsedFrame::Data { command, payload } => {
                if let Some(ref pending_req) = self.pending {
                    if pending_req.command != command {
                        // Usually a late periodic DATA after we timed out the prior read and
                        // advanced the queue — still useful for registered ring buffers.
                        if self.store.is_registered(command) {
                            self.store.store(command, payload.clone());
                            return Event::Data { command, payload };
                        }
                        return Event::Error {
                            message: format!(
                                "Mismatched DATA command: expected {}, got {}",
                                pending_req.command, command
                            ),
                        };
                    }
                    self.pending = None;
                }

                // Auto-store if this command has registered storage
                if self.store.is_registered(command) {
                    self.store.store(command, payload.clone());
                }
                Event::Data { command, payload }
            }
            ParsedFrame::Notification(payload) => Event::Notification { payload },
        }
    }

    /// If nothing is pending, send the next queued message.
    fn try_flush(&mut self, events: &mut Vec<Event>) {
        if self.pending.is_some() {
            return;
        }

        if let Some(msg) = self.queue.pop() {
            match self.transport.write_all(&msg.frame) {
                Ok(()) => {
                    let command = msg.frame.get(2).copied().unwrap_or_default();
                    self.pending = Some(PendingRequest {
                        frame: msg.frame,
                        command,
                        sent_at: Instant::now(),
                    });
                }
                Err(e) => {
                    events.push(Event::Error {
                        message: format!("Transport write error: {}", e),
                    });
                }
            }
        }
    }

    /// Get a reference to the priority queue (for inspection/stats).
    pub fn queue(&self) -> &PriorityQueue {
        &self.queue
    }

    /// Clear all queued messages.
    pub fn clear_queue(&mut self) {
        self.queue.clear();
    }

    /// Whether a request is currently in-flight awaiting a response.
    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Get the transport name (e.g. serial port path).
    pub fn transport_name(&self) -> &str {
        self.transport.name()
    }

    // ── Periodic read scheduling ──

    /// Register a command for automatic periodic reading.
    ///
    /// - `command`: command ID to read periodically
    /// - `interval`: time between reads
    /// - `storage_count`: number of DATA payloads to retain in the ring buffer
    ///
    /// The client will automatically enqueue LOW-priority read requests
    /// at the given interval, with coalescing to avoid queue buildup.
    /// Incoming DATA responses are stored in a ring buffer of `storage_count`
    /// entries, queryable via [`Client::store`].
    pub fn register_periodic(&mut self, command: u8, interval: Duration, storage_count: usize) {
        // Remove any existing registration for this command
        self.periodic.retain(|e| e.command != command);

        let coalesce_key = format!("periodic_{}", command);
        self.periodic.push(PeriodicEntry {
            command,
            interval,
            coalesce_key,
            last_enqueued: None,
        });

        // Register storage
        self.store.register(command, storage_count);
    }

    /// Unregister a command from periodic reading.
    ///
    /// Storage is preserved — call [`DataStore::clear_all`] on the store
    /// if you want to discard stored data.
    pub fn unregister_periodic(&mut self, command: u8) {
        self.periodic.retain(|e| e.command != command);
    }

    /// Enqueue reads for any periodic entries whose interval has elapsed.
    fn enqueue_periodic(&mut self) {
        let now = Instant::now();
        for entry in &mut self.periodic {
            let due = match entry.last_enqueued {
                Some(last) => now.duration_since(last) >= entry.interval,
                None => true, // First time — immediately due
            };
            if due {
                entry.last_enqueued = Some(now);
                let frame = build_read_frame(entry.command);
                self.queue.push(QueuedMessage {
                    frame,
                    priority: Priority::Low,
                    coalesce_key: Some(entry.coalesce_key.clone()),
                });
            }
        }
    }

    // ── Data store access ──

    /// Get a reference to the data store (for reading stored periodic data).
    pub fn store(&self) -> &DataStore {
        &self.store
    }

    /// Get a mutable reference to the data store.
    pub fn store_mut(&mut self) -> &mut DataStore {
        &mut self.store
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::testing::MemoryTransport;
    use protoemb_framing::ParsedFrame;

    #[test]
    fn test_write_enqueues_and_sends() {
        let transport = Box::new(MemoryTransport::new());
        // We need to inspect tx after the client uses it.
        // Since Client owns the transport, we'll check via poll behavior.
        let mut client = Client::new(transport);

        client.write(0x03, &[0xAA, 0xBB]);
        assert!(!client.queue().is_empty() || client.is_pending());

        // Poll should send the message
        let events = client.poll();
        assert!(client.is_pending());
        // No events yet (no response)
        assert!(events.is_empty());
    }

    #[test]
    fn test_read_enqueue() {
        let transport = Box::new(MemoryTransport::new());
        let mut client = Client::new(transport);

        client.read(0x01, Priority::Low, Some("sample".to_string()));
        client.read(0x02, Priority::High, None);

        // High goes first
        let events = client.poll();
        assert!(client.is_pending());
        assert!(events.is_empty());
    }

    #[test]
    fn test_priority_ordering() {
        let transport = Box::new(MemoryTransport::new());
        let mut client = Client::new(transport);

        // Enqueue low, then high
        client.read(0x00, Priority::Low, Some("sample".to_string()));
        client.read(0x01, Priority::High, None);

        // First poll sends high-priority
        client.poll();
        assert!(client.is_pending());

        // Queue should have the low-priority one left
        assert_eq!(client.queue().low_len(), 1);
        assert_eq!(client.queue().high_len(), 0);
    }

    #[test]
    fn test_register_periodic_enqueues_reads() {
        let transport = Box::new(MemoryTransport::new());
        let mut client = Client::new(transport);

        // Register command 0 at 100ms interval with 10-entry storage
        client.register_periodic(0, Duration::from_millis(100), 10);

        // First poll should enqueue and send a periodic read
        let _events = client.poll();
        assert!(client.is_pending());

        // Storage should be registered
        assert!(client.store().is_registered(0));
    }

    #[test]
    fn test_periodic_data_auto_stored() {
        let transport = Box::new(MemoryTransport::new());
        let mut client = Client::new(transport);

        // Register storage for command 5 (without periodic — just storage)
        client.store_mut().register(5, 3);

        // Simulate receiving a DATA frame by calling handle_frame directly
        let event = client.handle_frame(ParsedFrame::Data {
            command: 5,
            payload: vec![0xAA, 0xBB],
        });

        assert!(matches!(event, Event::Data { command: 5, .. }));
        assert_eq!(client.store().latest(5).unwrap(), &vec![0xAA, 0xBB]);
        assert_eq!(client.store().seq(5), 1);
    }

    #[test]
    fn test_unregister_periodic() {
        let transport = Box::new(MemoryTransport::new());
        let mut client = Client::new(transport);

        client.register_periodic(0, Duration::from_millis(100), 10);
        client.unregister_periodic(0);

        // Poll should NOT enqueue any periodic reads
        let _events = client.poll();
        // Nothing should be pending (no reads enqueued)
        assert!(!client.is_pending());
    }

    #[test]
    fn test_notification_does_not_clear_pending() {
        let transport = Box::new(MemoryTransport::new());
        let mut client = Client::new(transport);

        client.write(0x03, &[0xAA, 0xBB]);
        let _ = client.poll();
        assert!(client.is_pending());

        let event = client.handle_frame(ParsedFrame::Notification(vec![1, 2, 3]));
        assert!(matches!(event, Event::Notification { .. }));
        assert!(client.is_pending());
    }

    #[test]
    fn test_mismatched_response_command_is_rejected_and_keeps_pending() {
        let transport = Box::new(MemoryTransport::new());
        let mut client = Client::new(transport);

        client.write(0x03, &[0xAA]);
        let _ = client.poll();
        assert!(client.is_pending());

        let event = client.handle_frame(ParsedFrame::Ack(0x04));
        assert!(matches!(event, Event::Error { .. }));
        assert!(client.is_pending());
    }

    #[test]
    fn test_matching_response_command_clears_pending() {
        let transport = Box::new(MemoryTransport::new());
        let mut client = Client::new(transport);

        client.write(0x07, &[0x01]);
        let _ = client.poll();
        assert!(client.is_pending());

        let event = client.handle_frame(ParsedFrame::Ack(0x07));
        assert!(matches!(event, Event::Ack { command: 0x07 }));
        assert!(!client.is_pending());
    }

    #[test]
    fn test_poll_parses_a_wire_data_frame_into_an_event() {
        // Contract test: a real on-wire DATA frame fed through the transport must
        // come out of poll() as Event::Data{command,payload}. This is the path the
        // WasmClient exposes to JS (feed_bytes → poll), exercised here natively.
        let payload = vec![0xDE, 0xAD, 0xBE];
        let crc = protoemb_framing::crc8(&payload);
        let mut transport = Box::new(MemoryTransport::new());
        // [SYNC][TYPE=DATA(0x02)][COMMAND][LEN_LO][LEN_HI][DATA...][CRC]
        transport.push_rx(&[0x55, 0x02, 0x05, payload.len() as u8, 0, 0xDE, 0xAD, 0xBE, crc]);
        let mut client = Client::new(transport);

        let events = client.poll();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Event::Data { command: 0x05, payload: p } if *p == vec![0xDE, 0xAD, 0xBE])),
            "expected a Data event, got {:?}",
            events
        );
    }
}
