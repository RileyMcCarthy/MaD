import { useEffect, useState } from 'react';
import { useStore } from '@/store/useStore';
import {
  NotificationType,
  SampleProfile,
  SampleProfileEntry,
  EMPTY_SAMPLE_PROFILE,
  parseSampleProfileJson,
  sampleProfileNameFromFile,
} from '@/domain';
import { dataStore } from '@/storage/DataStore';
import NumberField from '@/ui/components/NumberField';
import { useSavedFlash, useUnsavedWork } from '@/ui/useUnsavedWork';

/** What counts as the editor's content, for telling saved from unsaved. */
const fingerprint = (draft: SampleProfile, name: string): string => JSON.stringify({ draft, name });

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
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' | 'muted' } | null>(null);
  const say = (text: string, tone: 'ok' | 'error' | 'muted' = 'muted') => setMessage({ text, tone });
  const notify = useStore((s) => s.notify);
  // What the editor held when last saved, loaded or imported; a blank editor
  // counts as saved, since there is nothing to lose.
  const [savedSnapshot, setSavedSnapshot] = useState(() => fingerprint(EMPTY_SAMPLE_PROFILE, ''));
  const unsaved = fingerprint(draft, name) !== savedSnapshot;
  const { confirmDiscard } = useUnsavedWork(`sample profile "${name.trim() || 'untitled'}"`, unsaved);
  const [justSaved, flashSaved] = useSavedFlash();

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
    if (!confirmDiscard()) return;
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
        setSavedSnapshot(fingerprint(profile, importedName));
        say(`Imported ${file.name} and saved it to the data folder.`, 'ok');
      } else {
        say(`Imported ${file.name} into the editor (not saved: no data folder).`);
      }
    } catch {
      say('Failed to import sample profile (.sp must be JSON).', 'error');
    }
  };

  const saveToDisk = async () => {
    if (!dataStore.connected) {
      say('Choose a data folder in Settings first.', 'error');
      return;
    }
    if (!name.trim()) {
      say('Enter a sample name before saving.', 'error');
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
    let ok = false;
    let why = 'the data folder refused it';
    try {
      ok = await dataStore.saveSampleProfile(entry, true);
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    if (!ok) {
      say(`Not saved: ${why}.`, 'error');
      notify(NotificationType.ERROR, `Sample profile "${name.trim()}" was not saved: ${why}.`);
      return;
    }
    setSavedSnapshot(fingerprint(draft, name));
    flashSaved();
    say(`Saved "${name.trim()}" at ${new Date().toLocaleTimeString()}.`, 'ok');
    notify(NotificationType.SUCCESS, `Sample profile "${name.trim()}" saved.`);
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
          <button className={justSaved ? 'ok' : 'primary'} onClick={saveToDisk} data-testid="save-sample-profile">
            {justSaved ? 'Saved ✓' : 'Save sample profile'}
          </button>
          {unsaved && (
            <span className="badge tone-warn" data-testid="unsaved-badge" title="Save to keep these changes">
              Unsaved changes
            </span>
          )}
          <label className="filebtn">
            Import .sp
            <input type="file" accept=".sp,application/json" hidden onChange={importSp} />
          </label>
        </div>
        {message && (
          <p className={message.tone === 'ok' ? 'save-ok' : message.tone === 'error' ? 'run-error' : 'muted'}>
            {message.text}
          </p>
        )}
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
                        if (!confirmDiscard()) return;
                        setDraft(p.profile);
                        setName(p.name);
                        setSavedSnapshot(fingerprint(p.profile, p.name));
                        setMessage(null);
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
