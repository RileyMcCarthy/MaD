//! WebAssembly bindings for the protocol client.
//!
//! In the browser, **JavaScript owns the serial port** (Web Serial API) and the
//! WASM module owns all protocol state (framing, CRC, priority queue, ring-buffer
//! storage, request/response timeouts). The two communicate through an in-memory
//! [`BufferTransport`]:
//!
//! ```text
//! JS reads port.readable  ──► WasmClient::feed_bytes(&[u8])  ──► rx buffer
//! WasmClient::poll() drives the Client, which reads rx and writes tx
//! tx buffer ──► WasmClient::take_outgoing() -> Uint8Array ──► JS writes port.writable
//! ```
//!
//! Typical JS loop:
//! ```js
//! client.feed_bytes(chunkFromSerial);
//! const events = client.poll();          // Array<{event, ...}>
//! const out = client.take_outgoing();    // Uint8Array — write to the port
//! ```

use std::cell::RefCell;
use std::collections::VecDeque;
use std::io;
use std::rc::Rc;
use std::time::Duration;

use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::client::{Client, ClientConfig};
use crate::queue::Priority;
use crate::transport::Transport;

/// Upper bound on buffered, not-yet-parsed received bytes (~256 KiB). Far above
/// any real backlog at 230400 baud; a backstop against unbounded growth.
const RX_CAP: usize = 256 * 1024;

/// In-memory transport bridging the sync [`Client`] to async JS serial I/O.
///
/// `rx` holds bytes received from the device (pushed by JS via `feed_bytes`).
/// `tx` collects bytes the client wants to send (drained by JS via
/// `take_outgoing`). Both are `Rc<RefCell<…>>` so [`WasmClient`] keeps a handle
/// after moving the transport into the `Client`.
struct BufferTransport {
    rx: Rc<RefCell<VecDeque<u8>>>,
    tx: Rc<RefCell<Vec<u8>>>,
}

impl Transport for BufferTransport {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        self.tx.borrow_mut().extend_from_slice(data);
        Ok(())
    }

    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut rx = self.rx.borrow_mut();
        let n = buf.len().min(rx.len());
        for slot in buf.iter_mut().take(n) {
            *slot = rx.pop_front().unwrap();
        }
        Ok(n)
    }

    fn set_read_timeout(&mut self, _timeout: Option<Duration>) -> io::Result<()> {
        Ok(())
    }

    fn close(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn name(&self) -> &str {
        "webserial"
    }
}

/// A batch of stored ring-buffer entries plus the current sequence number.
#[derive(Serialize)]
struct StoredBatch {
    /// `ByteBuf` marshals each entry as a JS `Uint8Array` instead of a boxed
    /// `number[]`, which matters for the multi-thousand-entry ring snapshot.
    entries: Vec<serde_bytes::ByteBuf>,
    /// `u64` would marshal to a JS `BigInt`; sequence counts stay well within
    /// `f64` integer range, so expose it as a number for ergonomics.
    seq: f64,
}

/// Protocol client exposed to JavaScript.
#[wasm_bindgen]
pub struct WasmClient {
    client: Client,
    rx: Rc<RefCell<VecDeque<u8>>>,
    tx: Rc<RefCell<Vec<u8>>>,
}

#[wasm_bindgen]
impl WasmClient {
    /// Create a client with the given response timeout (ms).
    #[wasm_bindgen(constructor)]
    pub fn new(response_timeout_ms: u32) -> WasmClient {
        console_error_panic_hook::set_once();

        let rx = Rc::new(RefCell::new(VecDeque::new()));
        let tx = Rc::new(RefCell::new(Vec::new()));
        let transport = Box::new(BufferTransport {
            rx: Rc::clone(&rx),
            tx: Rc::clone(&tx),
        });
        let config = ClientConfig {
            response_timeout: Duration::from_millis(response_timeout_ms as u64),
        };
        WasmClient {
            client: Client::with_config(transport, config),
            rx,
            tx,
        }
    }

    /// Push bytes received from the serial port into the parser's input buffer.
    ///
    /// Bounded: if the buffer ever exceeds [`RX_CAP`] (the poll loop fell far
    /// behind, e.g. a long-backgrounded tab), the oldest bytes are dropped to
    /// cap memory. The frame parser resynchronises on the next valid frame, so a
    /// dropped span costs at most a partial frame rather than unbounded growth.
    pub fn feed_bytes(&mut self, bytes: &[u8]) {
        let mut rx = self.rx.borrow_mut();
        rx.extend(bytes.iter().copied());
        if rx.len() > RX_CAP {
            let overflow = rx.len() - RX_CAP;
            rx.drain(0..overflow);
        }
    }

    /// Drain and return all bytes the client wants written to the serial port.
    pub fn take_outgoing(&mut self) -> Vec<u8> {
        std::mem::take(&mut *self.tx.borrow_mut())
    }

    /// Enqueue a READ request.
    pub fn read(&mut self, command: u8, high_priority: bool, coalesce_key: Option<String>) {
        let priority = if high_priority {
            Priority::High
        } else {
            Priority::Low
        };
        self.client.read(command, priority, coalesce_key);
    }

    /// Enqueue a WRITE request (always high priority).
    pub fn write(&mut self, command: u8, data: &[u8]) {
        self.client.write(command, data);
    }

    /// Register a command for periodic polling with ring-buffer storage.
    pub fn register_periodic(&mut self, command: u8, interval_ms: u32, storage_count: usize) {
        self.client
            .register_periodic(command, Duration::from_millis(interval_ms as u64), storage_count);
    }

    /// Stop periodic polling for a command.
    pub fn unregister_periodic(&mut self, command: u8) {
        self.client.unregister_periodic(command);
    }

    /// Run one poll cycle. Returns `Array<{ event, ... }>` of protocol events.
    pub fn poll(&mut self) -> Result<JsValue, JsValue> {
        let events = self.client.poll();
        // Fast path for the common idle tick (no events): skip the serde marshal
        // and hand back an empty JS array directly. poll() runs every ~4 ms.
        if events.is_empty() {
            return Ok(js_sys::Array::new().into());
        }
        serde_wasm_bindgen::to_value(&events).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Return all stored ring-buffer entries for `command` as
    /// `{ entries: number[][], seq }`.
    pub fn get_stored(&self, command: u8) -> Result<JsValue, JsValue> {
        let entries: Vec<serde_bytes::ByteBuf> = self
            .client
            .store()
            .read_all(command)
            .into_iter()
            .map(|v| serde_bytes::ByteBuf::from(v.clone()))
            .collect();
        let seq = self.client.store().seq(command) as f64;
        serde_wasm_bindgen::to_value(&StoredBatch { entries, seq })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Return ring-buffer entries added since `since_seq` as
    /// `{ entries: number[][], seq }` (where `seq` is the new sequence number).
    pub fn get_stored_since(&self, command: u8, since_seq: f64) -> Result<JsValue, JsValue> {
        let (entries, seq) = self.client.store().read_since(command, since_seq as u64);
        let entries: Vec<serde_bytes::ByteBuf> = entries
            .into_iter()
            .map(|v| serde_bytes::ByteBuf::from(v.clone()))
            .collect();
        serde_wasm_bindgen::to_value(&StoredBatch {
            entries,
            seq: seq as f64,
        })
        .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Whether a request is currently in-flight awaiting a response.
    pub fn is_pending(&self) -> bool {
        self.client.is_pending()
    }

    /// Clear all queued (not-yet-sent) messages.
    pub fn clear_queue(&mut self) {
        self.client.clear_queue();
    }
}
