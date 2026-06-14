import { useEffect, useState } from 'react';
import {
  SampleProfile,
  MotionProfile,
  MotionProfileEntry,
  Move,
  Set as MotionSet,
  TestProfile,
  WaveformFn,
  waveformPeakVelocity,
} from '@/domain';
import { dataStore } from '@/storage/DataStore';
import { useStore } from '@/store/useStore';
import SortableList, { reorder } from '@/ui/components/SortableList';
import Modal from '@/ui/components/Modal';
import GcodePreview from '@/ui/components/GcodePreview';

/* The G-code generator/preview only reads sets; sample limits are applied at
 * run time by the Test Runner (sample profiles live on the Samples page). */
const EMPTY_SAMPLE: SampleProfile = {
  maxForce: 0,
  maxVelocity: 0,
  maxDisplacement: 0,
  sampleWidth: 0,
  sampleThickness: 0,
  serial: '',
};

const newMove = (): Move => ({
  moveType: 'linear',
  absoluteOrRelative: 'absolute',
  moveParameters: { position: 0, velocity: 0, distance: 0, time: 0 },
});

const newSet = (name: string): MotionSet => ({
  name,
  executions: 1,
  moves: [newMove()],
});

export default function Create() {
  const [motionProfile, setMotionProfile] = useState<MotionProfile>({
    name: '',
    description: '',
    sets: [],
  });
  const [sets, setSets] = useState<MotionSet[]>([newSet('Set 1')]);

  const [savedMotions, setSavedMotions] = useState<MotionProfileEntry[]>([]);
  const [selectedMotionId, setSelectedMotionId] = useState('');

  const [previewOpen, setPreviewOpen] = useState(false);
  const [loadSetTarget, setLoadSetTarget] = useState<number | null>(null);
  const [savedSets, setSavedSets] = useState<MotionSet[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  // Reactive: re-renders + reloads once the folder is restored at startup.
  const folderReady = useStore((s) => s.dataFolderReady);

  const loadSaved = async () => {
    if (!dataStore.connected) return;
    setSavedMotions(await dataStore.getMotionProfiles());
  };
  useEffect(() => {
    void loadSaved();
  }, [folderReady]);

  const requireFolder = (): boolean => {
    if (!dataStore.connected) {
      setMessage('Choose a data folder in Settings first.');
      return false;
    }
    return true;
  };

  // ── Motion profile ──
  const saveMotionProfile = async () => {
    if (!requireFolder()) return;
    if (!motionProfile.name) {
      setMessage('Enter a motion profile name before saving.');
      return;
    }
    const entry: MotionProfileEntry = {
      id: crypto.randomUUID(),
      name: motionProfile.name,
      description: motionProfile.description,
      createdAt: new Date().toISOString(),
      profile: { ...motionProfile, sets },
    };
    const ok = await dataStore.saveMotionProfile(entry, false);
    if (!ok && !window.confirm(`A motion profile "${motionProfile.name}" exists. Replace it?`)) return;
    if (!ok) await dataStore.saveMotionProfile(entry, true);
    setMessage(`Motion profile "${motionProfile.name}" saved.`);
    await loadSaved();
  };

  const loadMotionProfile = (id: string) => {
    setSelectedMotionId(id);
    const entry = savedMotions.find((p) => p.id === id);
    if (entry) {
      setMotionProfile(entry.profile);
      setSets(entry.profile.sets.length > 0 ? entry.profile.sets : [newSet('Set 1')]);
    }
  };

  const importMotion = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as MotionProfile;
      setMotionProfile(parsed);
      setSets(parsed.sets.length > 0 ? parsed.sets : [newSet('Set 1')]);
      setMessage('Motion profile imported (not yet saved).');
    } catch {
      setMessage('Failed to import motion profile.');
    }
  };

  // ── Sets / moves ──
  const updateSets = (next: MotionSet[]) => {
    setSets(next);
    setMotionProfile((p) => ({ ...p, sets: next }));
  };

  const updateSet = (i: number, patch: Partial<MotionSet>) =>
    updateSets(sets.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const updateMove = (si: number, mi: number, patch: Partial<Move>) =>
    updateSet(si, { moves: sets[si].moves.map((m, idx) => (idx === mi ? { ...m, ...patch } : m)) });

  // Numeric move-parameter keys (everything except the string `waveform`).
  const updateMoveParam = (
    si: number,
    mi: number,
    key: Exclude<keyof Move['moveParameters'], 'waveform'>,
    value: number,
  ) =>
    updateSet(si, {
      moves: sets[si].moves.map((m, idx) =>
        idx === mi ? { ...m, moveParameters: { ...m.moveParameters, [key]: value } } : m,
      ),
    });

  const setWaveformFn = (si: number, mi: number, fn: WaveformFn) =>
    updateSet(si, {
      moves: sets[si].moves.map((m, idx) =>
        idx === mi ? { ...m, moveParameters: { ...m.moveParameters, waveform: fn } } : m,
      ),
    });

  const saveSet = async (i: number) => {
    if (!requireFolder()) return;
    const set = sets[i];
    if (!set.name) {
      setMessage('Enter a set name before saving.');
      return;
    }
    const ok = await dataStore.saveSet(set, false);
    if (!ok && !window.confirm(`A set "${set.name}" exists. Replace it?`)) return;
    if (!ok) await dataStore.saveSet(set, true);
    setMessage(`Set "${set.name}" saved.`);
  };

  const openLoadSet = async (i: number) => {
    if (!requireFolder()) return;
    setSavedSets(await dataStore.getSets());
    setLoadSetTarget(i);
  };

  const applyLoadedSet = (set: MotionSet) => {
    if (loadSetTarget === null) return;
    updateSets(sets.map((s, idx) => (idx === loadSetTarget ? set : s)));
    setLoadSetTarget(null);
  };

  const moveParamInputs = (m: Move, si: number, mi: number) => {
    const p = m.moveParameters;
    const field = (label: string, key: Exclude<keyof Move['moveParameters'], 'waveform'>) => (
      <label className="field" key={key}>
        {label}
        <input
          type="number"
          value={p[key] ?? 0}
          onChange={(e) => updateMoveParam(si, mi, key, Number(e.target.value))}
        />
      </label>
    );
    if (m.moveType === 'dwell') return field('Time (ms)', 'time');
    if (m.moveType === 'math') {
      const fn: WaveformFn = p.waveform === 'triangle' ? 'triangle' : 'sine';
      const peakV = waveformPeakVelocity(fn, p.amplitude ?? 0, p.frequency ?? 0);
      const durationS = (p.frequency ?? 0) > 0 ? (p.cycles ?? 0) / (p.frequency ?? 1) : 0;
      const tooFast = peakV > 100; // schema Move.f max (mm/s)
      return (
        <>
          {m.absoluteOrRelative === 'absolute'
            ? field('Centre (mm)', 'position')
            : field('Centre offset (mm)', 'distance')}
          <label className="field">
            Waveform
            <select value={fn} onChange={(e) => setWaveformFn(si, mi, e.target.value as WaveformFn)}>
              <option value="sine">Sine</option>
              <option value="triangle">Triangle</option>
            </select>
          </label>
          {field('Amplitude (mm)', 'amplitude')}
          {field('Frequency (Hz)', 'frequency')}
          {field('Cycles', 'cycles')}
          <span className={`muted${tooFast ? ' fault' : ''}`} style={{ alignSelf: 'flex-end' }}>
            ~{peakV.toFixed(1)} mm/s peak · {durationS.toFixed(1)} s
            {tooFast ? ' · exceeds 100 mm/s limit' : ''}
          </span>
        </>
      );
    }
    const posOrDist =
      m.absoluteOrRelative === 'absolute'
        ? field('Position (mm)', 'position')
        : field('Distance (mm)', 'distance');
    return (
      <>
        {posOrDist}
        {field('Velocity (mm/s)', 'velocity')}
      </>
    );
  };

  const testProfile: TestProfile = { ...motionProfile, sets, sampleProfile: EMPTY_SAMPLE };

  return (
    <div>
      <h1>Motion Profiles</h1>
      <p className="muted">
        Build the motion a test will run. Sample profiles (material limits and dimensions)
        live on the <strong>Samples</strong> page; the two are combined when you run a test.
      </p>
      {!folderReady && (
        <div className="panel" style={{ borderColor: 'var(--warn)' }}>
          <span className="muted">
            No data folder selected — choose one in <strong>Settings</strong> to save profiles.
          </span>
        </div>
      )}

      {/* Motion profile */}
      <div className="panel">
        <h2>Motion Profile</h2>
        <div className="grid cols-2">
          <label className="field">
            Name
            <input
              value={motionProfile.name}
              onChange={(e) => setMotionProfile({ ...motionProfile, name: e.target.value })}
            />
          </label>
          <label className="field">
            Description
            <input
              value={motionProfile.description}
              onChange={(e) => setMotionProfile({ ...motionProfile, description: e.target.value })}
            />
          </label>
        </div>

        <div style={{ marginTop: 16 }}>
          <SortableList
            items={sets}
            getKey={(_, i) => `set-${i}`}
            onReorder={(from, to) => updateSets(reorder(sets, from, to))}
            renderItem={(set, si, handle) => (
              <div className="set-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="row">
                    <span className="drag-handle" {...handle} title="Drag to reorder">
                      ⠿
                    </span>
                    <label className="field">
                      Set Name
                      <input value={set.name} onChange={(e) => updateSet(si, { name: e.target.value })} />
                    </label>
                    <label className="field">
                      Executions
                      <input
                        type="number"
                        min={1}
                        value={set.executions}
                        onChange={(e) => updateSet(si, { executions: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <button className="danger" onClick={() => updateSets(sets.filter((_, i) => i !== si))}>
                    Delete Set
                  </button>
                </div>

                <SortableList
                  items={set.moves}
                  getKey={(_, i) => `move-${si}-${i}`}
                  onReorder={(from, to) => updateSet(si, { moves: reorder(set.moves, from, to) })}
                  renderItem={(move, mi, moveHandle) => (
                    <div className="move-row">
                      <span className="drag-handle" {...moveHandle} title="Drag to reorder">
                        ⠿
                      </span>
                      <select
                        value={move.moveType}
                        onChange={(e) => updateMove(si, mi, { moveType: e.target.value as Move['moveType'] })}
                      >
                        <option value="linear">Linear</option>
                        <option value="dwell">Dwell</option>
                        <option value="math">Waveform</option>
                      </select>
                      {move.moveType !== 'dwell' && (
                        <select
                          value={move.absoluteOrRelative}
                          onChange={(e) =>
                            updateMove(si, mi, {
                              absoluteOrRelative: e.target.value as Move['absoluteOrRelative'],
                            })
                          }
                        >
                          <option value="absolute">Absolute</option>
                          <option value="relative">Relative</option>
                        </select>
                      )}
                      {moveParamInputs(move, si, mi)}
                      <button
                        className="danger"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => updateSet(si, { moves: set.moves.filter((_, i) => i !== mi) })}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                />

                <div className="row" style={{ marginTop: 8 }}>
                  <button onClick={() => updateSet(si, { moves: [...set.moves, newMove()] })}>+ Add Move</button>
                  <button onClick={() => saveSet(si)}>Save Set</button>
                  <button onClick={() => openLoadSet(si)}>Load Set</button>
                </div>
              </div>
            )}
          />
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => updateSets([...sets, newSet(`Set ${sets.length + 1}`)])}>+ Add Set</button>
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <select value={selectedMotionId} onChange={(e) => loadMotionProfile(e.target.value)}>
            <option value="">Load saved profile…</option>
            {savedMotions.map((mp) => (
              <option key={mp.id} value={mp.id}>
                {mp.name}
                {mp.description ? ` — ${mp.description}` : ''}
              </option>
            ))}
          </select>
          {selectedMotionId && (
            <button
              className="danger"
              onClick={async () => {
                await dataStore.deleteMotionProfile(selectedMotionId);
                setSelectedMotionId('');
                await loadSaved();
              }}
            >
              Delete
            </button>
          )}
          <button className="primary" onClick={saveMotionProfile}>
            Save Motion Profile
          </button>
          <label className="filebtn">
            Import .mp
            <input type="file" accept=".mp,application/json" hidden onChange={importMotion} />
          </label>
          <button onClick={() => setPreviewOpen(true)}>Preview G-code</button>
        </div>
        {message && <p className="muted">{message}</p>}
      </div>

      <Modal open={previewOpen} title="Generated G-code & Motion" onClose={() => setPreviewOpen(false)}>
        <GcodePreview profile={testProfile} />
      </Modal>

      <Modal open={loadSetTarget !== null} title="Load Set" onClose={() => setLoadSetTarget(null)}>
        {savedSets.length === 0 ? (
          <p className="muted">No saved sets.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Moves</th>
                <th>Executions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {savedSets.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{s.moves.length}</td>
                  <td>{s.executions}</td>
                  <td>
                    <button onClick={() => applyLoadedSet(s)}>Load</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
    </div>
  );
}
