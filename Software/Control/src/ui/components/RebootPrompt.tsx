import { useState } from 'react';
import { useStore } from '@/store/useStore';
import Modal from './Modal';

/**
 * Asks to reboot the machine after settings it only loads at startup were
 * saved (the machine configuration). Shown app-wide so it follows the operator.
 */
export default function RebootPrompt() {
  const rebootNeeded = useStore((s) => s.rebootNeeded);
  const connected = useStore((s) => s.connection === 'connected');
  const testRunning = useStore((s) => Boolean(s.machineState?.testRunning));
  const dismiss = useStore((s) => s.dismissReboot);
  const rebootMachine = useStore((s) => s.rebootMachine);
  const [rebooting, setRebooting] = useState(false);
  const [failed, setFailed] = useState(false);

  const reboot = async () => {
    setRebooting(true);
    setFailed(false);
    const ok = await rebootMachine();
    setRebooting(false);
    setFailed(!ok);
  };

  return (
    <Modal
      open={rebootNeeded && (connected || rebooting || failed)}
      title="Reboot needed"
      onClose={() => {
        if (rebooting) return;
        setFailed(false);
        dismiss();
      }}
      width={460}
    >
      <p>
        The machine configuration is saved to the SD card. The machine loads it when it starts, so the new
        settings apply after a reboot.
      </p>
      {testRunning && <p className="muted">A test is running. Reboot once it has finished.</p>}
      {failed && (
        <p className="run-error" data-testid="reboot-failed">
          The app could not reconnect after the reboot. Reconnect from the Connect page, or power-cycle the machine.
        </p>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button
          onClick={() => {
            setFailed(false);
            dismiss();
          }}
          disabled={rebooting}
          data-testid="reboot-later"
        >
          Do it later
        </button>
        <button
          className="primary"
          onClick={() => void reboot()}
          disabled={rebooting || testRunning}
          aria-busy={rebooting}
          data-testid="reboot-now"
        >
          {rebooting ? (
            <>
              <span className="spinner" aria-hidden="true" /> Rebooting…
            </>
          ) : (
            'Reboot now'
          )}
        </button>
      </div>
    </Modal>
  );
}
