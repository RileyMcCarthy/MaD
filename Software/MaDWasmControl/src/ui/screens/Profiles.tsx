import { useEffect, useState } from 'react';
import { useStore } from '@/store/useStore';
import { SampleProfile, SampleProfileEntry } from '@/domain';
import { dataStore } from '@/storage/DataStore';

const FIELDS: Array<{ key: keyof SampleProfile; label: string }> = [
  { key: 'maxForce', label: 'Max Force (N)' },
  { key: 'maxVelocity', label: 'Max Velocity (mm/s)' },
  { key: 'maxDisplacement', label: 'Max Displacement (mm)' },
  { key: 'sampleWidth', label: 'Sample Width (mm)' },
  { key: 'sampleThickness', label: 'Sample Thickness (mm)' },
];

const EMPTY: SampleProfile = {
  maxForce: 0,
  maxVelocity: 0,
  maxDisplacement: 0,
  sampleWidth: 0,
  sampleThickness: 0,
  serial: '',
};

export default function Profiles() {
  const connected = useStore((s) => s.connection === 'connected');
  const deviceProfile = useStore((s) => s.sampleProfile);
  const refreshSampleProfile = useStore((s) => s.refreshSampleProfile);
  const saveSampleProfile = useStore((s) => s.saveSampleProfile);
  const folderReady = useStore((s) => s.dataFolderReady);

  const [draft, setDraft] = useState<SampleProfile>(EMPTY);
  const [saved, setSaved] = useState<SampleProfileEntry[]>([]);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (deviceProfile) setDraft(deviceProfile);
  }, [deviceProfile]);

  const loadSaved = async () => {
    if (dataStore.connected) setSaved(await dataStore.getSampleProfiles());
  };
  useEffect(() => {
    void loadSaved();
  }, [folderReady]);

  const writeToDevice = async () => {
    const ok = await saveSampleProfile(draft);
    setMessage(ok ? 'Written to device.' : 'Device rejected the profile.');
  };

  const importSp = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const profile = JSON.parse(await file.text()) as SampleProfile;
      const importedName = file.name.replace(/\.sp$/i, '') || 'imported';
      setDraft({ ...EMPTY, ...profile });
      setName(importedName);
      if (dataStore.connected) {
        const entry: SampleProfileEntry = {
          id: crypto.randomUUID(),
          name: importedName,
          createdAt: new Date().toISOString(),
          profile: { ...EMPTY, ...profile },
        };
        await dataStore.saveSampleProfile(entry, true);
        await loadSaved();
        setMessage(`Imported ${file.name} and saved to the data folder.`);
      } else {
        setMessage(`Imported ${file.name} into the editor.`);
      }
    } catch {
      setMessage('Failed to import sample profile (.sp must be JSON).');
    }
  };

  const saveToDisk = async () => {
    if (!dataStore.connected) {
      setMessage('Choose a data folder in Settings first.');
      return;
    }
    if (!name.trim()) {
      setMessage('Enter a sample name before saving.');
      return;
    }
    // The single name is both the file name and the profile's label (`serial`,
    // which shows in Test Runs history / the run viewer; it never goes to the device).
    const entry: SampleProfileEntry = {
      id: crypto.randomUUID(),
      name: name.trim(),
      createdAt: new Date().toISOString(),
      profile: { ...draft, serial: name.trim() },
    };
    const ok = await dataStore.saveSampleProfile(entry, true);
    setMessage(ok ? 'Saved to data folder.' : 'Save failed.');
    await loadSaved();
  };

  return (
    <div>
      <h1>Sample Profiles</h1>

      <div className="panel">
        <h2>Editor</h2>
        <div className="grid cols-2">
          {FIELDS.map((f) => (
            <label className="field" key={f.key}>
              {f.label}
              <input
                type="number"
                value={draft[f.key] as number}
                onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
              />
            </label>
          ))}
          <label className="field">
            Sample name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. AL-6061-01"
            />
          </label>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button onClick={() => refreshSampleProfile()} disabled={!connected}>
            Read from device
          </button>
          <button className="primary" onClick={writeToDevice} disabled={!connected}>
            Write to device
          </button>
          <button onClick={saveToDisk}>Save to folder</button>
          <label className="filebtn">
            Import .sp
            <input type="file" accept=".sp,application/json" hidden onChange={importSp} />
          </label>
          {message && <span className="muted">{message}</span>}
        </div>
      </div>

      <div className="panel">
        <h2>Saved profiles</h2>
        {saved.length === 0 ? (
          <p className="muted">No saved profiles (choose a data folder in Settings).</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Max Force</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {saved.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.profile.maxForce} N</td>
                  <td className="muted">{new Date(p.createdAt).toLocaleString()}</td>
                  <td className="row">
                    <button
                      onClick={() => {
                        setDraft(p.profile);
                        setName(p.name);
                      }}
                    >
                      Load
                    </button>
                    <button
                      className="danger"
                      onClick={async () => {
                        await dataStore.deleteSampleProfile(p.id);
                        await loadSaved();
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
