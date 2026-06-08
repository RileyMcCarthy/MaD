//! NDJSON stdio bridge — JSON-RPC-like interface over stdin/stdout.
//!
//! Allows a host process (e.g. Electron, Python, etc.) to control
//! the ProtoEmb serial client by sending newline-delimited JSON
//! commands on stdin and receiving JSON events on stdout.
//!
//! # Protocol
//!
//! ## Requests (stdin → bridge)
//!
//! ```json
//! {"cmd": "connect", "port": "/dev/cu.usbserial", "baud": 115200}
//! {"cmd": "disconnect"}
//! {"cmd": "read", "command": 0, "priority": "low", "coalesce_key": "sample"}
//! {"cmd": "read", "command": 2, "priority": "high"}
//! {"cmd": "write", "command": 1, "data": [1]}
//! {"cmd": "write", "command": 4, "data": [0,0,...]}
//! {"cmd": "register_periodic", "command": 0, "interval_ms": 100, "storage_count": 100}
//! {"cmd": "unregister_periodic", "command": 0}
//! {"cmd": "get_stored", "command": 0}
//! {"cmd": "get_stored_since", "command": 0, "since_seq": 42}
//! {"cmd": "list_ports"}
//! {"cmd": "quit"}
//! ```
//!
//! ## Events (bridge → stdout)
//!
//! ```json
//! {"event": "connected", "port": "/dev/cu.usbserial"}
//! {"event": "disconnected"}
//! {"event": "ack", "command": 1}
//! {"event": "nack", "command": 1}
//! {"event": "data", "command": 0, "payload": [1,2,3,...]}
//! {"event": "notification", "payload": [1,2,3,...]}
//! {"event": "timeout"}
//! {"event": "error", "message": "..."}
//! {"event": "ports", "ports": ["/dev/cu.usbserial-1", ...]}
//! {"event": "stored", "command": 0, "entries": [[1,2,3],[4,5,6]], "seq": 5}
//! ```

use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};

use crate::client::{Client, ClientConfig, Event};
use crate::queue::Priority;
use crate::transport::{SerialTransport, Transport};

// ── Request types (stdin) ──

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    Connect {
        port: String,
        baud: u32,
    },
    Disconnect,
    Read {
        command: u8,
        #[serde(default = "default_priority")]
        priority: PriorityJson,
        coalesce_key: Option<String>,
    },
    Write {
        command: u8,
        data: Vec<u8>,
    },
    RegisterPeriodic {
        command: u8,
        interval_ms: u64,
        storage_count: usize,
    },
    UnregisterPeriodic {
        command: u8,
    },
    GetStored {
        command: u8,
    },
    GetStoredSince {
        command: u8,
        since_seq: u64,
    },
    ListPorts,
    Quit,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PriorityJson {
    #[default]
    High,
    Low,
}

fn default_priority() -> PriorityJson {
    PriorityJson::High
}

impl From<PriorityJson> for Priority {
    fn from(p: PriorityJson) -> Self {
        match p {
            PriorityJson::High => Priority::High,
            PriorityJson::Low => Priority::Low,
        }
    }
}

// ── Event types (stdout) ──

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum EventJson {
    Connected { port: String },
    Disconnected,
    Ack { command: u8 },
    Nack { command: u8 },
    Data { command: u8, payload: Vec<u8> },
    Notification { payload: Vec<u8> },
    Timeout,
    Error { message: String },
    Ports { ports: Vec<String> },
    Stored {
        command: u8,
        entries: Vec<Vec<u8>>,
        seq: u64,
    },
}

/// The NDJSON stdio bridge.
///
/// Reads JSON commands from stdin, drives a [`Client`], and writes
/// JSON events to stdout.
pub struct StdioBridge {
    client: Option<Client>,
    config: ClientConfig,
}

impl StdioBridge {
    /// Create a new bridge with default client config.
    pub fn new() -> Self {
        Self {
            client: None,
            config: ClientConfig::default(),
        }
    }

    /// Create a new bridge with custom client config.
    pub fn with_config(config: ClientConfig) -> Self {
        Self {
            client: None,
            config,
        }
    }

    /// Run the bridge event loop. This blocks, reading stdin line by line
    /// and polling the client between reads.
    ///
    /// The loop exits when a "quit" command is received or stdin is closed.
    pub fn run(&mut self) -> io::Result<()> {
        let stdin = io::stdin();
        let stdout = io::stdout();

        // Set stdin to non-blocking would be ideal, but for portability
        // we use a line-buffered approach with a short poll interval.
        // We'll read lines in a loop, polling the client between reads.

        let reader = stdin.lock();
        let mut writer = stdout.lock();

        // We need to handle both stdin and client polling. Since we can't
        // do non-blocking stdin portably, we'll use a thread for stdin
        // and a channel.
        let (tx, rx) = std::sync::mpsc::channel::<String>();

        // Spawn a thread to read stdin lines
        std::thread::Builder::new()
            .name("stdin-reader".into())
            .spawn(move || {
                let stdin = io::stdin();
                let mut reader = stdin.lock();
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break, // EOF
                        Ok(_) => {
                            if tx.send(line.trim().to_string()).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;

        // Drop our reader since the thread now owns stdin
        drop(reader);

        loop {
            // Check for stdin commands (non-blocking via try_recv)
            while let Ok(line) = rx.try_recv() {
                if line.is_empty() {
                    continue;
                }

                match serde_json::from_str::<Request>(&line) {
                    Ok(req) => {
                        let should_quit = matches!(req, Request::Quit);
                        let events = self.handle_request(req);
                        for event in events {
                            self.emit(&mut writer, &event)?;
                        }
                        if should_quit {
                            return Ok(());
                        }
                    }
                    Err(e) => {
                        self.emit(
                            &mut writer,
                            &EventJson::Error {
                                message: format!("Invalid JSON request: {}", e),
                            },
                        )?;
                    }
                }
            }

            // Poll the client if connected
            if let Some(ref mut client) = self.client {
                let events = client.poll();
                for event in events {
                    let json_event = match event {
                        Event::Ack { command } => EventJson::Ack { command },
                        Event::Nack { command } => EventJson::Nack { command },
                        Event::Data { command, payload } => {
                            EventJson::Data { command, payload }
                        }
                        Event::Notification { payload } => {
                            EventJson::Notification { payload }
                        }
                        Event::Timeout { .. } => EventJson::Timeout,
                        Event::Error { message } => EventJson::Error { message },
                    };
                    self.emit(&mut writer, &json_event)?;
                }
            }

            // Small sleep to avoid busy-spinning when idle
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    /// Handle a single request and return events to emit.
    fn handle_request(&mut self, req: Request) -> Vec<EventJson> {
        match req {
            Request::Connect { port, baud } => {
                // Disconnect existing client if any
                self.client = None;

                // Use PtyTransport for PTY paths (macOS/Linux virtual serial ports),
                // SerialTransport for real hardware serial ports.
                #[cfg(unix)]
                let result: Result<Box<dyn Transport>, std::io::Error> = {
                    use crate::transport::PtyTransport;
                    if PtyTransport::is_pty(&port) {
                        PtyTransport::open(&port).map(|t| Box::new(t) as Box<dyn Transport>)
                    } else {
                        SerialTransport::open(&port, baud).map(|t| Box::new(t) as Box<dyn Transport>)
                    }
                };
                #[cfg(not(unix))]
                let result = SerialTransport::open(&port, baud)
                    .map(|t| Box::new(t) as Box<dyn Transport>);

                match result {
                    Ok(transport) => {
                        self.client = Some(Client::with_config(
                            transport,
                            self.config.clone(),
                        ));
                        vec![EventJson::Connected {
                            port: port.clone(),
                        }]
                    }
                    Err(e) => vec![EventJson::Error {
                        message: format!("Failed to open {}: {}", port, e),
                    }],
                }
            }

            Request::Disconnect => {
                self.client = None;
                vec![EventJson::Disconnected]
            }

            Request::Read {
                command,
                priority,
                coalesce_key,
            } => {
                if let Some(ref mut client) = self.client {
                    client.read(command, priority.into(), coalesce_key);
                    vec![]
                } else {
                    vec![EventJson::Error {
                        message: "Not connected".to_string(),
                    }]
                }
            }

            Request::Write { command, data } => {
                if let Some(ref mut client) = self.client {
                    client.write(command, &data);
                    vec![]
                } else {
                    vec![EventJson::Error {
                        message: "Not connected".to_string(),
                    }]
                }
            }

            Request::ListPorts => {
                match serialport::available_ports() {
                    Ok(ports) => {
                        let paths: Vec<String> =
                            ports.into_iter().map(|p| p.port_name).collect();
                        vec![EventJson::Ports { ports: paths }]
                    }
                    Err(e) => vec![EventJson::Error {
                        message: format!("Failed to list ports: {}", e),
                    }],
                }
            }

            Request::RegisterPeriodic {
                command,
                interval_ms,
                storage_count,
            } => {
                if let Some(ref mut client) = self.client {
                    client.register_periodic(
                        command,
                        std::time::Duration::from_millis(interval_ms),
                        storage_count,
                    );
                    vec![]
                } else {
                    vec![EventJson::Error {
                        message: "Not connected".to_string(),
                    }]
                }
            }

            Request::UnregisterPeriodic { command } => {
                if let Some(ref mut client) = self.client {
                    client.unregister_periodic(command);
                    vec![]
                } else {
                    vec![EventJson::Error {
                        message: "Not connected".to_string(),
                    }]
                }
            }

            Request::GetStored { command } => {
                if let Some(ref client) = self.client {
                    let all = client.store().read_all(command);
                    let seq = client.store().seq(command);
                    let entries: Vec<Vec<u8>> = all.into_iter().cloned().collect();
                    vec![EventJson::Stored {
                        command,
                        entries,
                        seq,
                    }]
                } else {
                    vec![EventJson::Error {
                        message: "Not connected".to_string(),
                    }]
                }
            }

            Request::GetStoredSince {
                command,
                since_seq,
            } => {
                if let Some(ref client) = self.client {
                    let (entries_refs, seq) =
                        client.store().read_since(command, since_seq);
                    let entries: Vec<Vec<u8>> =
                        entries_refs.into_iter().cloned().collect();
                    vec![EventJson::Stored {
                        command,
                        entries,
                        seq,
                    }]
                } else {
                    vec![EventJson::Error {
                        message: "Not connected".to_string(),
                    }]
                }
            }

            Request::Quit => {
                self.client = None;
                vec![] // Caller handles exit
            }
        }
    }

    /// Emit a JSON event to the writer (stdout) as a single line.
    fn emit<W: Write>(&self, writer: &mut W, event: &EventJson) -> io::Result<()> {
        let json = serde_json::to_string(event)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        writeln!(writer, "{}", json)?;
        writer.flush()
    }
}

impl Default for StdioBridge {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_request_deserialization() {
        let json = r#"{"cmd": "connect", "port": "/dev/ttyUSB0", "baud": 115200}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert!(matches!(req, Request::Connect { .. }));

        let json = r#"{"cmd": "read", "command": 0, "priority": "low", "coalesce_key": "sample"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert!(matches!(req, Request::Read { .. }));

        let json = r#"{"cmd": "write", "command": 4, "data": [1, 2, 3]}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert!(matches!(req, Request::Write { .. }));

        let json = r#"{"cmd": "list_ports"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert!(matches!(req, Request::ListPorts));

        let json = r#"{"cmd": "quit"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert!(matches!(req, Request::Quit));
    }

    #[test]
    fn test_event_serialization() {
        let event = EventJson::Ack { command: 3 };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"event\":\"ack\""));
        assert!(json.contains("\"command\":3"));

        let event = EventJson::Data {
            command: 0,
            payload: vec![1, 2, 3],
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"event\":\"data\""));
        assert!(json.contains("\"payload\":[1,2,3]"));
    }

    #[test]
    fn test_handle_disconnect_without_connect() {
        let mut bridge = StdioBridge::new();
        let events = bridge.handle_request(Request::Disconnect);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], EventJson::Disconnected));
    }

    #[test]
    fn test_handle_read_without_connect() {
        let mut bridge = StdioBridge::new();
        let events = bridge.handle_request(Request::Read {
            command: 0,
            priority: PriorityJson::Low,
            coalesce_key: None,
        });
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], EventJson::Error { .. }));
    }

    #[test]
    fn test_periodic_request_deserialization() {
        let json = r#"{"cmd": "register_periodic", "command": 0, "interval_ms": 100, "storage_count": 50}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::RegisterPeriodic {
                command,
                interval_ms,
                storage_count,
            } => {
                assert_eq!(command, 0);
                assert_eq!(interval_ms, 100);
                assert_eq!(storage_count, 50);
            }
            _ => panic!("Expected RegisterPeriodic"),
        }

        let json = r#"{"cmd": "unregister_periodic", "command": 0}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert!(matches!(req, Request::UnregisterPeriodic { command: 0 }));

        let json = r#"{"cmd": "get_stored", "command": 0}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert!(matches!(req, Request::GetStored { command: 0 }));

        let json = r#"{"cmd": "get_stored_since", "command": 0, "since_seq": 42}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::GetStoredSince {
                command,
                since_seq,
            } => {
                assert_eq!(command, 0);
                assert_eq!(since_seq, 42);
            }
            _ => panic!("Expected GetStoredSince"),
        }
    }

    #[test]
    fn test_stored_event_serialization() {
        let event = EventJson::Stored {
            command: 0,
            entries: vec![vec![1, 2], vec![3, 4]],
            seq: 5,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"event\":\"stored\""));
        assert!(json.contains("\"command\":0"));
        assert!(json.contains("\"seq\":5"));
        assert!(json.contains("\"entries\":[[1,2],[3,4]]"));
    }

    #[test]
    fn test_handle_periodic_without_connect() {
        let mut bridge = StdioBridge::new();
        let events = bridge.handle_request(Request::RegisterPeriodic {
            command: 0,
            interval_ms: 100,
            storage_count: 10,
        });
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], EventJson::Error { .. }));

        let events = bridge.handle_request(Request::GetStored { command: 0 });
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], EventJson::Error { .. }));
    }
}
