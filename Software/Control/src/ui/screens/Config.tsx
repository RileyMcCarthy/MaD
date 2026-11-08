import { useEffect, useState } from 'react';
import { useStore } from '@/store/useStore';
import { MachineConfiguration, NotificationType } from '@/domain';
import NumberField from '@/ui/components/NumberField';
import MotorCalibrationPanel from '@/ui/components/MotorCalibrationPanel';
import ForceZeroPanel from '@/ui/components/ForceZeroPanel';
import LoadCellSensitivityPanel from '@/ui/components/LoadCellSensitivityPanel';
import { useSavedFlash, useUnsavedWork } from '@/ui/useUnsavedWork';

const NUMERIC_FIELDS: Array<keyof MachineConfiguration> = [
  'Encoder (step/mm)',
  'Servo (step/mm)',
  'Load Cell Capacity (N)',
  'Load Cell Sensitivity (mV/V)',
  'Load Cell Zero Balance (mV/V)',
  'Position Max (mm)',
  'Velocity Max (mm/s)',
  'Acceleration Max (mm/s^2)',
  'Tensile Force Max (N)',
  'Homing Velocity (mm/s)',
  'Homing Offset (mm)',
  'Jaw Offset (mm)',
  'Restricted Velocity (mm/s)',
  'Servo Kp (1/s)',
  'Servo Ki (1/s^2)',
];

/** Machine configuration editor. Rendered as a section inside Settings
 *  (`embedded`), or standalone with its own page heading. */
export default function Config({ embedded = false }: { embedded?: boolean }) {
  const connected = useStore((s) => s.connection === 'connected');
  const config = useStore((s) => s.config);
  const refreshConfig = useStore((s) => s.refreshConfig);
  const saveConfig = useStore((s) => s.saveConfig);

  const [draft, setDraft] = useState<MachineConfiguration | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const notify = useStore((s) => s.notify);
  const [justSaved, flashSaved] = useSavedFlash();
  // Unsaved: the draft differs from what the machine last reported. Only while
  // connected, since the editor is not shown otherwise.
  const unsaved = connected && draft !== null && config !== null && JSON.stringify(draft) !== JSON.stringify(config);
  const { confirmDiscard } = useUnsavedWork('machine configuration', unsaved);

  useEffect(() => {
    if (config) setDraft(config);
  }, [config]);

  // Fetch on mount when connected but not yet loaded (e.g. navigating here directly).
  useEffect(() => {
    if (connected && !config) void refreshConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const onSave = async () => {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    const ok = await saveConfig(draft);
    setSaving(false);
    if (ok) {
      flashSaved();
      setMessage({ text: `Written to the machine at ${new Date().toLocaleTimeString()}.`, tone: 'ok' });
      notify(NotificationType.SUCCESS, 'Machine configuration written to the machine.');
    } else {
      setMessage({ text: 'Not saved: the machine rejected the configuration.', tone: 'error' });
      notify(NotificationType.ERROR, 'Machine configuration was not saved: the machine rejected it.');
    }
  };

  // Motor calibration judges the steps/mm being edited above, against the profile saved on the machine.
  const motor = draft && (
    <div className="panel">
      <h2>Motor calibration</h2>
      <MotorCalibrationPanel
        profile={{
          encoderStepsPerMM: draft['Encoder (step/mm)'],
          servoStepsPerMM: draft['Servo (step/mm)'],
        }}
        saved={{
          encoderStepsPerMM: config?.['Encoder (step/mm)'] ?? 0,
          servoStepsPerMM: config?.['Servo (step/mm)'] ?? 0,
          maxPositionMm: config?.['Position Max (mm)'] ?? 0,
          maxVelocityMmPerS: config?.['Velocity Max (mm/s)'] ?? 0,
          maxAccelMmPerS2: config?.['Acceleration Max (mm/s^2)'] ?? 0,
          servoKp: config?.['Servo Kp (1/s)'] ?? 0,
          servoKi: config?.['Servo Ki (1/s^2)'] ?? 0,
        }}
      />
    </div>
  );

  const savedLoadCell = {
    capacityN: config?.['Load Cell Capacity (N)'] ?? 0,
    sensitivityMvV: config?.['Load Cell Sensitivity (mV/V)'] ?? 0,
    zeroBalanceMvV: config?.['Load Cell Zero Balance (mV/V)'] ?? 0,
  };

  // Load cell calibration is its own panel, but edits the same draft: the zero
  // it reads goes into the profile here and is written with it.
  const loadCell = draft && (
    <div className="panel">
      <h2>Load cell calibration</h2>
      <ForceZeroPanel
        saved={savedLoadCell}
        onUseZero={(zero) => setDraft((d) => (d ? { ...d, 'Load Cell Zero Balance (mV/V)': zero } : d))}
      />
      <LoadCellSensitivityPanel
        saved={savedLoadCell}
        onUseSensitivity={(sensitivity) =>
          setDraft((d) => (d ? { ...d, 'Load Cell Sensitivity (mV/V)': sensitivity } : d))
        }
      />
    </div>
  );

  // `embedded` → <h2> sections within a page; standalone → its own <h1> page.
  const wrap = (panel: React.ReactNode) =>
    embedded ? (
      <>
        <div className="panel">
          <h2>Machine configuration</h2>
          {panel}
        </div>
        {connected && motor}
        {connected && loadCell}
      </>
    ) : (
      <div>
        <h1>Machine configuration</h1>
        <div className="panel">{panel}</div>
        {connected && motor}
        {connected && loadCell}
      </div>
    );

  if (!connected) {
    return wrap(<p className="muted">Connect a device to read its configuration.</p>);
  }

  return wrap(
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <button
          onClick={() => {
            if (confirmDiscard()) void refreshConfig();
          }}
        >
          Read from device
        </button>
        <button
          className={justSaved ? 'ok' : 'primary'}
          onClick={onSave}
          disabled={!draft || saving}
          data-testid="save-machine-config"
        >
          {saving ? 'Writing…' : justSaved ? 'Saved ✓' : 'Write to device'}
        </button>
        {unsaved && (
          <span className="badge tone-warn" data-testid="unsaved-badge" title="Write to the device to keep these changes">
            Unsaved changes
          </span>
        )}
      </div>
      {message && (
        <p className={message.tone === 'ok' ? 'save-ok' : 'run-error'} style={{ marginTop: 0 }}>
          {message.text}
        </p>
      )}

      {draft ? (
        <>
          <div className="grid cols-2">
            <label className="field">
              Name
              <input
                value={draft.Name}
                onChange={(e) => setDraft({ ...draft, Name: e.target.value })}
              />
            </label>
            {NUMERIC_FIELDS.map((field) => (
              <NumberField
                key={field}
                label={field}
                value={draft[field] as number}
                onChange={(n) => setDraft((d) => (d ? { ...d, [field]: n } : d))}
              />
            ))}
            <label className="field">
              Drive enable
              <select
                value={draft['Drive Enable Active Low'] ? 'low' : 'high'}
                onChange={(e) => setDraft({ ...draft, 'Drive Enable Active Low': e.target.value === 'low' })}
              >
                <option value="high">High enables (servo drives, DMM DYN4 default)</option>
                <option value="low">Low enables (most stepper drivers)</option>
              </select>
            </label>
          </div>
        </>
      ) : (
        <p className="muted">Reading configuration…</p>
      )}
    </>,
  );
}
