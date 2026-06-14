import { useEffect, useState } from 'react';
import { useStore } from '@/store/useStore';
import { deviceClient, DEFAULT_BAUD_RATE } from '@/device/session';

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 2000000];

export default function Connect() {
  const connection = useStore((s) => s.connection);
  const responding = useStore((s) => s.responding);
  const error = useStore((s) => s.error);
  const portLabel = useStore((s) => s.portLabel);
  const fw = useStore((s) => s.firmwareVersion);
  const connect = useStore((s) => s.connect);
  const disconnect = useStore((s) => s.disconnect);
  const reconnect = useStore((s) => s.reconnect);
  const canReconnect = useStore((s) => s.canReconnect);

  const [baud, setBaud] = useState(DEFAULT_BAUD_RATE);
  const [grantedPorts, setGrantedPorts] = useState<SerialPort[]>([]);

  const connected = connection === 'connected';
  const connecting = connection === 'connecting';

  const refreshPorts = async () => {
    try {
      setGrantedPorts(await deviceClient.getPorts());
    } catch {
      setGrantedPorts([]);
    }
  };
  useEffect(() => {
    void refreshPorts();
  }, []);

  const portName = (p: SerialPort, i: number) => {
    const info = p.getInfo();
    return info.usbVendorId !== undefined
      ? `USB ${info.usbVendorId.toString(16)}:${(info.usbProductId ?? 0).toString(16)}`
      : `Serial device ${i + 1}`;
  };

  const forgetPort = async (p: SerialPort) => {
    const withForget = p as SerialPort & { forget?: () => Promise<void> };
    try {
      await withForget.forget?.();
    } catch {
      /* not supported / already gone */
    }
    await refreshPorts();
  };
  const canForget = typeof (SerialPort.prototype as { forget?: unknown }).forget === 'function';

  return (
    <div>
      <h1>Connect</h1>
      <div className="panel">
        <h2>Device</h2>
        <p className="muted">
          The MaD tester connects over a USB-to-serial bridge. Pick a baud rate, then connect
          to a previously granted device or add a new one (the browser shows a chooser).
        </p>

        <div className="row" style={{ marginBottom: 12 }}>
          <label className="field">
            Baud rate
            <select value={baud} onChange={(e) => setBaud(Number(e.target.value))} disabled={connected}>
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>
                  {b.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {baud !== DEFAULT_BAUD_RATE && (
            <span className="muted" style={{ alignSelf: 'flex-end' }}>
              Hardware contract is {DEFAULT_BAUD_RATE.toLocaleString()} baud.
            </span>
          )}
        </div>

        {!connected ? (
          <>
            {canReconnect && (
              <div className="row" style={{ marginBottom: 12 }}>
                <span className="fault" style={{ flex: 1 }}>
                  Connection to the device was lost.
                </span>
                <button className="primary" onClick={() => void reconnect()} disabled={connecting}>
                  Reconnect
                </button>
              </div>
            )}
            {grantedPorts.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div className="muted" style={{ marginBottom: 6 }}>Previously granted devices</div>
                {grantedPorts.map((p, i) => (
                  <div className="row" key={i} style={{ marginBottom: 6 }}>
                    <span style={{ flex: 1 }}>{portName(p, i)}</span>
                    <button
                      onClick={() => connect({ port: p, baud })}
                      disabled={connecting}
                      data-testid="connect-granted"
                    >
                      Connect
                    </button>
                    {canForget && (
                      <button onClick={() => void forgetPort(p)} disabled={connecting} title="Revoke this device's permission">
                        Forget
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="row">
              <button
                className="primary"
                onClick={() => connect({ baud }).then(refreshPorts)}
                disabled={connecting}
                data-testid="connect-device"
              >
                {connecting ? 'Connecting…' : grantedPorts.length ? 'Add device…' : 'Connect device'}
              </button>
              <button onClick={refreshPorts} disabled={connecting}>
                Refresh
              </button>
            </div>
          </>
        ) : (
          <div className="row">
            <button className="danger" onClick={() => disconnect()}>
              Disconnect
            </button>
            <span
              className={`badge ${responding ? 'downloaded' : 'error'}`}
            >
              {responding ? 'Responding' : 'Not responding'}
            </span>
          </div>
        )}

        {error && (
          <p className="fault" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
        {connected && (
          <p className="muted" style={{ marginTop: 12 }}>
            {portLabel} {fw ? `· firmware ${fw}` : ''}
          </p>
        )}
      </div>
    </div>
  );
}
