//! Ring-buffer data storage for periodic responses.
//!
//! When the runtime receives DATA responses for periodic commands
//! (e.g. sample data, machine state), the raw payloads are stored
//! in per-command ring buffers. The host process can then read the
//! latest N entries at any time without missing data points, even
//! if it polls slower than the device sends.
//!
//! This covers **all** live sample data — both idle monitoring and
//! active test runs use the same periodic poll stream. Charts only
//! need the last 100–500 points, so a fixed-size ring buffer is
//! sufficient. Full test data (unbounded) lives on the device's
//! SD card and is retrieved post-test via the file-download command,
//! which is a simple write/response pass-through with no storage.
//!
//! This is protocol-agnostic — it stores raw `Vec<u8>` payloads.
//! Decoding to typed structs happens in the host/caller.

use std::collections::HashMap;

/// A fixed-capacity ring buffer that overwrites the oldest entry
/// when full.
#[derive(Debug, Clone)]
pub struct RingBuffer {
    buf: Vec<Vec<u8>>,
    /// Write position (next slot to overwrite)
    head: usize,
    /// Number of entries currently stored (≤ capacity)
    len: usize,
    /// Maximum number of entries
    capacity: usize,
    /// Monotonic sequence counter — increments on every push
    seq: u64,
}

impl RingBuffer {
    /// Create a new ring buffer with the given capacity.
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "RingBuffer capacity must be > 0");
        Self {
            buf: vec![Vec::new(); capacity],
            head: 0,
            len: 0,
            capacity,
            seq: 0,
        }
    }

    /// Push a payload into the buffer, overwriting the oldest if full.
    pub fn push(&mut self, payload: Vec<u8>) {
        self.buf[self.head] = payload;
        self.head = (self.head + 1) % self.capacity;
        if self.len < self.capacity {
            self.len += 1;
        }
        self.seq += 1;
    }

    /// Get the latest entry (most recently pushed), if any.
    pub fn latest(&self) -> Option<&Vec<u8>> {
        if self.len == 0 {
            return None;
        }
        let idx = if self.head == 0 {
            self.capacity - 1
        } else {
            self.head - 1
        };
        Some(&self.buf[idx])
    }

    /// Read all stored entries in chronological order (oldest first).
    /// Returns up to `capacity` entries.
    pub fn read_all(&self) -> Vec<&Vec<u8>> {
        if self.len == 0 {
            return Vec::new();
        }
        let mut result = Vec::with_capacity(self.len);
        // Start from the oldest entry
        let start = if self.len < self.capacity {
            0
        } else {
            self.head // oldest is at head when full
        };
        for i in 0..self.len {
            let idx = (start + i) % self.capacity;
            result.push(&self.buf[idx]);
        }
        result
    }

    /// Read entries added since the given sequence number.
    /// Returns `(entries, current_seq)`.
    ///
    /// The caller should pass `0` on first call, then pass back
    /// the returned `current_seq` on subsequent calls to get only
    /// new entries since last read.
    pub fn read_since(&self, since_seq: u64) -> (Vec<&Vec<u8>>, u64) {
        if self.len == 0 || since_seq >= self.seq {
            return (Vec::new(), self.seq);
        }

        // How many entries were added since `since_seq`?
        let new_count = (self.seq - since_seq) as usize;
        // Can't return more than we have stored
        let count = new_count.min(self.len);

        let mut result = Vec::with_capacity(count);
        // Walk backwards from head by `count` entries
        for i in 0..count {
            let idx = if self.head >= count - i {
                self.head - (count - i)
            } else {
                self.capacity - (count - i - self.head)
            };
            result.push(&self.buf[idx]);
        }
        (result, self.seq)
    }

    /// Number of entries currently stored.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Maximum capacity.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Current sequence number (total pushes since creation).
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Clear all stored entries and reset sequence counter.
    pub fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
        self.seq = 0;
        for slot in &mut self.buf {
            slot.clear();
        }
    }
}

/// Per-command data store. Maps command IDs to ring buffers.
///
/// Call [`DataStore::register`] to set up storage for a command,
/// then [`DataStore::store`] to push incoming payloads.
#[derive(Debug, Default)]
pub struct DataStore {
    buffers: HashMap<u8, RingBuffer>,
}

impl DataStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register storage for a command ID with the given ring buffer capacity.
    ///
    /// If already registered, the existing buffer is replaced (data lost).
    pub fn register(&mut self, command: u8, capacity: usize) {
        self.buffers.insert(command, RingBuffer::new(capacity));
    }

    /// Check if a command ID has storage registered.
    pub fn is_registered(&self, command: u8) -> bool {
        self.buffers.contains_key(&command)
    }

    /// Store a payload for a command. No-op if the command isn't registered.
    pub fn store(&mut self, command: u8, payload: Vec<u8>) {
        if let Some(ring) = self.buffers.get_mut(&command) {
            ring.push(payload);
        }
    }

    /// Get the latest entry for a command.
    pub fn latest(&self, command: u8) -> Option<&Vec<u8>> {
        self.buffers.get(&command).and_then(|r| r.latest())
    }

    /// Read all stored entries for a command (oldest first).
    pub fn read_all(&self, command: u8) -> Vec<&Vec<u8>> {
        self.buffers
            .get(&command)
            .map(|r| r.read_all())
            .unwrap_or_default()
    }

    /// Read entries added since a sequence number. Returns `(entries, new_seq)`.
    pub fn read_since(&self, command: u8, since_seq: u64) -> (Vec<&Vec<u8>>, u64) {
        self.buffers
            .get(&command)
            .map(|r| r.read_since(since_seq))
            .unwrap_or((Vec::new(), 0))
    }

    /// Get the current sequence number for a command.
    pub fn seq(&self, command: u8) -> u64 {
        self.buffers.get(&command).map(|r| r.seq()).unwrap_or(0)
    }

    /// Get a reference to the ring buffer for a command (if registered).
    pub fn buffer(&self, command: u8) -> Option<&RingBuffer> {
        self.buffers.get(&command)
    }

    /// Clear all stored data for all commands (keeps registrations).
    pub fn clear_all(&mut self) {
        for ring in self.buffers.values_mut() {
            ring.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ring_buffer_basic() {
        let mut rb = RingBuffer::new(3);
        assert!(rb.is_empty());
        assert_eq!(rb.len(), 0);

        rb.push(vec![1]);
        rb.push(vec![2]);
        assert_eq!(rb.len(), 2);
        assert_eq!(rb.latest().unwrap(), &vec![2]);

        let all = rb.read_all();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0], &vec![1]); // oldest
        assert_eq!(all[1], &vec![2]); // newest
    }

    #[test]
    fn test_ring_buffer_overflow() {
        let mut rb = RingBuffer::new(3);
        rb.push(vec![1]);
        rb.push(vec![2]);
        rb.push(vec![3]);
        rb.push(vec![4]); // overwrites [1]

        assert_eq!(rb.len(), 3);
        assert_eq!(rb.latest().unwrap(), &vec![4]);

        let all = rb.read_all();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0], &vec![2]); // oldest surviving
        assert_eq!(all[1], &vec![3]);
        assert_eq!(all[2], &vec![4]); // newest
    }

    #[test]
    fn test_ring_buffer_read_since() {
        let mut rb = RingBuffer::new(5);
        rb.push(vec![10]);
        rb.push(vec![20]);
        rb.push(vec![30]);

        // Read all since beginning
        let (entries, seq) = rb.read_since(0);
        assert_eq!(entries.len(), 3);
        assert_eq!(seq, 3);
        assert_eq!(entries[0], &vec![10]);
        assert_eq!(entries[2], &vec![30]);

        // Push more
        rb.push(vec![40]);
        rb.push(vec![50]);

        // Read only new ones since seq=3
        let (entries, seq2) = rb.read_since(seq);
        assert_eq!(entries.len(), 2);
        assert_eq!(seq2, 5);
        assert_eq!(entries[0], &vec![40]);
        assert_eq!(entries[1], &vec![50]);

        // Nothing new
        let (entries, seq3) = rb.read_since(seq2);
        assert_eq!(entries.len(), 0);
        assert_eq!(seq3, 5);
    }

    #[test]
    fn test_ring_buffer_read_since_overflow() {
        let mut rb = RingBuffer::new(3);
        // Push 5 items into a capacity-3 buffer
        for i in 0..5u8 {
            rb.push(vec![i]);
        }
        assert_eq!(rb.seq(), 5);
        assert_eq!(rb.len(), 3);

        // Ask for all since seq=0 — only the last 3 are available
        let (entries, seq) = rb.read_since(0);
        assert_eq!(entries.len(), 3);
        assert_eq!(seq, 5);
        assert_eq!(entries[0], &vec![2]);
        assert_eq!(entries[1], &vec![3]);
        assert_eq!(entries[2], &vec![4]);
    }

    #[test]
    fn test_data_store() {
        let mut store = DataStore::new();
        assert!(!store.is_registered(0));

        store.register(0, 10);
        store.register(1, 5);
        assert!(store.is_registered(0));
        assert!(store.is_registered(1));

        store.store(0, vec![0xAA]);
        store.store(0, vec![0xBB]);
        store.store(1, vec![0xCC]);

        // Unregistered command — no-op
        store.store(99, vec![0xFF]);

        assert_eq!(store.latest(0).unwrap(), &vec![0xBB]);
        assert_eq!(store.latest(1).unwrap(), &vec![0xCC]);
        assert!(store.latest(99).is_none());

        assert_eq!(store.read_all(0).len(), 2);
        assert_eq!(store.read_all(1).len(), 1);
    }

    #[test]
    fn test_data_store_clear() {
        let mut store = DataStore::new();
        store.register(0, 5);
        store.store(0, vec![1]);
        store.store(0, vec![2]);
        assert_eq!(store.read_all(0).len(), 2);

        store.clear_all();
        assert_eq!(store.read_all(0).len(), 0);
        assert!(store.is_registered(0)); // registration preserved
    }
}
