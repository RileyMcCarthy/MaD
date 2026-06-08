//! Priority queue for outgoing protocol messages.
//!
//! Two priority levels:
//! - **HIGH** — writes, on-demand reads, commands (sent first, FIFO)
//! - **LOW** — periodic polling reads (sent only when HIGH is empty)
//!
//! Low-priority messages support **coalescing**: if a message with the
//! same coalesce key is already queued, the old one is replaced rather
//! than appending a duplicate. This prevents queue buildup when the
//! serial link is slower than the polling rate.

use std::collections::VecDeque;

/// Priority level for an outgoing message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    /// Writes, on-demand reads, interactive commands.
    High,
    /// Periodic polling (sample, state). Coalesced.
    Low,
}

/// A message waiting to be sent on the wire.
#[derive(Debug, Clone)]
pub struct QueuedMessage {
    /// The raw framed bytes to send.
    pub frame: Vec<u8>,
    /// Priority level.
    pub priority: Priority,
    /// Optional coalesce key. When set, only one message with this key
    /// can exist in the queue at a time — new ones replace the old.
    pub coalesce_key: Option<String>,
}

/// Two-level priority queue with coalescing support.
#[derive(Debug, Default)]
pub struct PriorityQueue {
    high: VecDeque<QueuedMessage>,
    low: VecDeque<QueuedMessage>,
}

impl PriorityQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enqueue a message. If the message has a coalesce key and a message
    /// with the same key already exists in the appropriate queue, the old
    /// one is replaced in-place.
    pub fn push(&mut self, msg: QueuedMessage) {
        let queue = match msg.priority {
            Priority::High => &mut self.high,
            Priority::Low => &mut self.low,
        };

        if let Some(ref key) = msg.coalesce_key {
            // Replace existing message with same key
            if let Some(pos) = queue.iter().position(|m| {
                m.coalesce_key.as_deref() == Some(key.as_str())
            }) {
                queue[pos] = msg;
                return;
            }
        }

        queue.push_back(msg);
    }

    /// Dequeue the next message to send.
    /// High-priority messages are always drained first.
    pub fn pop(&mut self) -> Option<QueuedMessage> {
        if let Some(msg) = self.high.pop_front() {
            Some(msg)
        } else {
            self.low.pop_front()
        }
    }

    /// Check if there are any messages waiting.
    pub fn is_empty(&self) -> bool {
        self.high.is_empty() && self.low.is_empty()
    }

    /// Number of high-priority messages waiting.
    pub fn high_len(&self) -> usize {
        self.high.len()
    }

    /// Number of low-priority messages waiting.
    pub fn low_len(&self) -> usize {
        self.low.len()
    }

    /// Total number of messages waiting.
    pub fn len(&self) -> usize {
        self.high.len() + self.low.len()
    }

    /// Clear all queued messages.
    pub fn clear(&mut self) {
        self.high.clear();
        self.low.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(frame: &[u8], priority: Priority, key: Option<&str>) -> QueuedMessage {
        QueuedMessage {
            frame: frame.to_vec(),
            priority,
            coalesce_key: key.map(String::from),
        }
    }

    #[test]
    fn test_high_before_low() {
        let mut q = PriorityQueue::new();
        q.push(msg(&[1], Priority::Low, None));
        q.push(msg(&[2], Priority::High, None));
        q.push(msg(&[3], Priority::Low, None));

        assert_eq!(q.pop().unwrap().frame, vec![2]); // high first
        assert_eq!(q.pop().unwrap().frame, vec![1]); // then low FIFO
        assert_eq!(q.pop().unwrap().frame, vec![3]);
        assert!(q.pop().is_none());
    }

    #[test]
    fn test_coalescing() {
        let mut q = PriorityQueue::new();
        q.push(msg(&[1], Priority::Low, Some("sample")));
        q.push(msg(&[2], Priority::Low, Some("state")));
        q.push(msg(&[3], Priority::Low, Some("sample"))); // replaces [1]

        assert_eq!(q.low_len(), 2);
        let first = q.pop().unwrap();
        assert_eq!(first.frame, vec![3]); // coalesced — newest wins
        assert_eq!(first.coalesce_key.as_deref(), Some("sample"));

        let second = q.pop().unwrap();
        assert_eq!(second.frame, vec![2]);
        assert!(q.pop().is_none());
    }

    #[test]
    fn test_no_coalesce_without_key() {
        let mut q = PriorityQueue::new();
        q.push(msg(&[1], Priority::High, None));
        q.push(msg(&[2], Priority::High, None));

        assert_eq!(q.high_len(), 2);
    }

    #[test]
    fn test_mixed_priorities_ordering() {
        let mut q = PriorityQueue::new();
        q.push(msg(&[10], Priority::Low, None));
        q.push(msg(&[20], Priority::High, None));
        q.push(msg(&[30], Priority::High, None));
        q.push(msg(&[40], Priority::Low, None));

        // All high first (FIFO), then all low (FIFO)
        assert_eq!(q.pop().unwrap().frame, vec![20]);
        assert_eq!(q.pop().unwrap().frame, vec![30]);
        assert_eq!(q.pop().unwrap().frame, vec![10]);
        assert_eq!(q.pop().unwrap().frame, vec![40]);
    }

    #[test]
    fn test_clear() {
        let mut q = PriorityQueue::new();
        q.push(msg(&[1], Priority::High, None));
        q.push(msg(&[2], Priority::Low, None));
        assert_eq!(q.len(), 2);

        q.clear();
        assert!(q.is_empty());
        assert_eq!(q.len(), 0);
    }
}
