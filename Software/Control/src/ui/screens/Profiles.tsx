import { useEffect, useState } from 'react';
import { useStore } from '@/store/useStore';
import {
  SampleProfile,
  SampleProfileEntry,
  EMPTY_SAMPLE_PROFILE,
  parseSampleProfileJson,
  sampleProfileNameFromFile,
} from '@/domain';
import { dataStore } from '@/storage/DataStore';
import NumberField from '@/ui/components/NumberField';

const FIELDS: Array<{ key: keyof SampleProfile; label: string }> = [
  { key: 'maxForce', label: 'Max force (N)' },
  { key: 'maxVelocity', label: 'Max velocity (mm/s)' },
  { key: 'maxDisplacement', label: 'Max displacement (mm)' },
  { key: 'sampleWidth', label: 'Sample width (mm)' },
  { key: 'sampleThickness', label: 'Sample thickness (mm)' },
];

export default function Profiles() {
  const folderReady = useStore((s) => s.dataFolderReady);

  const [draft, setDraft] = useState<SampleProfile>(EMPTY_SAMPLE_PROFILE);
  const [saved, setSaved] = useState<SampleProfileEntry[]>([]);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const loadSaved = async () => {
    if (dataStore.connected) setSaved(await dataStore.getSampleProfiles());
  };
  useEffect(() => {
    void loadSaved();
  }, [folderReady]);

  const importSp = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const profile = parseSampleProfileJson(await file.text());
      const importedName = sampleProfileNameFromFile(file.name);
      setDraft(profile);
      setName(importedName);
      if (dataStore.connected) {
        const entry: SampleProfileEntry = {
          id: crypto.randomUUID(),
          name: importedName,
          createdAt: new Date().toISOString(),
          profile,
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
      <h1>Sample profiles</h1>

      <div className="panel">
        <h2>Editor</h2>
        <div className="grid cols-2">
          {FIELDS.map((f) => (
            <NumberField
              key={f.key}
              label={f.label}
              value={draft[f.key] as number}
              onChange={(n) => setDraft((d) => ({ ...d, [f.key]: n }))}
            />
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
          {/* No device read/write here: a test writes its sample profile to the
              machine when it starts, and the limits only apply during a test. */}
          <button className="primary" onClick={saveToDisk}>
            Save sample profile
          </button>
          <label className="filebtn">
            Import .sp
            <input type="file" accept=".sp,application/json" hidden onChange={importSp} />
          </label>
          {message && <span className="muted">{message}</span>}
        </div>
      </div>

      <div className="panel">
        <h2>Saved sample profiles</h2>
        {saved.length === 0 ? (
          <p className="muted">No saved sample profiles yet.</p>
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
