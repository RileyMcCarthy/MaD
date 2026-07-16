import { useEffect, useState } from 'react';
import { useStore } from '@/store/useStore';
import { MachineConfiguration } from '@/domain';

const NUMERIC_FIELDS: Array<keyof MachineConfiguration> = [
  'Encoder (step/mm)',
  'Servo (step/mm)',
  'Load Cell Capacity (N)',
  'Load Cell Sensitivity (nV/V)',
  'Load Cell Zero Balance (nV/V)',
  'Position Max (mm)',
  'Velocity Max (mm/s)',
  'Acceleration Max (mm/s^2)',
  'Tensile Force Max (N)',
  'Homing Velocity (mm/s)',
  'Homing Offset (mm)',
  'Jaw Offset (mm)',
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
  const [message, setMessage] = useState<string | null>(null);

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
    setMessage(ok ? 'Saved to device.' : 'Device rejected the configuration.');
  };

  // `embedded` → an <h2> section within a page; standalone → its own <h1> page.
  const wrap = (panel: React.ReactNode) =>
    embedded ? (
      <div className="panel">
        <h2>Machine configuration</h2>
        {panel}
      </div>
    ) : (
      <div>
        <h1>Machine Configuration</h1>
        <div className="panel">{panel}</div>
      </div>
    );

  if (!connected) {
    return wrap(<p className="muted">Connect a device to read its configuration.</p>);
  }

  return wrap(
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <button onClick={() => refreshConfig()}>Reload from device</button>
        <button className="primary" onClick={onSave} disabled={!draft || saving}>
          {saving ? 'Saving…' : 'Save to device'}
        </button>
        {message && <span className="muted">{message}</span>}
      </div>

      {draft ? (
        <div className="grid cols-2">
          <label className="field">
            Name
            <input
              value={draft.Name}
              onChange={(e) => setDraft({ ...draft, Name: e.target.value })}
            />
          </label>
          {NUMERIC_FIELDS.map((field) => (
            <label className="field" key={field}>
              {field}
              <input
                type="number"
                value={draft[field] as number}
                onChange={(e) => setDraft({ ...draft, [field]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
      ) : (
        <p className="muted">Reading configuration…</p>
      )}
    </>,
  );
}
