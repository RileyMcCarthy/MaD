import { useEffect, useState } from 'react';
import {
  EMPTY_SAMPLE_PROFILE,
  MotionProfile,
  MotionProfileEntry,
  Move,
  NotificationType,
  Set as MotionSet,
  TestProfile,
  WaveformFn,
  replaceSetAt,
  chirpCycles,
  planSigmoid,
  sinePeakVelocity,
  sinePeakAcceleration,
} from '@/domain';
import { dataStore } from '@/storage/DataStore';
import { useStore } from '@/store/useStore';
import SortableList, { reorder } from '@/ui/components/SortableList';
import Modal from '@/ui/components/Modal';
import GcodePreview from '@/ui/components/GcodePreview';
import NumberField from '@/ui/components/NumberField';
import { useSavedFlash, useUnsavedWork } from '@/ui/useUnsavedWork';

/* The G-code generator/preview only reads sets; sample limits are applied at
 * run time by the Test Runner (sample profiles live on the Samples page). */
const newMove = (): Move => ({
  moveType: 'linear',
  moveParameters: { position: 0, velocity: 0, time: 0 },
});

/** What counts as the editor's content, for telling saved from unsaved. */
const profileFingerprint = (profile: MotionProfile, sets: MotionSet[]): string =>
  JSON.stringify({ name: profile.name, description: profile.description, sets });

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
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' | 'muted' } | null>(null);
  const say = (text: string, tone: 'ok' | 'error' | 'muted' = 'muted') => setMessage({ text, tone });
  /* What the editor held when it was last saved or loaded. Anything else on
   * screen is unsaved, which the page shows and the app asks about before you
   * leave. A blank new profile counts as saved: there is nothing to lose. */
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    profileFingerprint({ name: '', description: '', sets: [] }, [newSet('Set 1')]),
  );
  const [justSaved, flashSaved] = useSavedFlash();
  const notify = useStore((s) => s.notify);

  // Reactive: re-renders + reloads once the folder is restored at startup.
  const folderReady = useStore((s) => s.dataFolderReady);
  /* Machine limits, read from the device on connect. Null when offline — the
   * envelope check below is skipped rather than guessed at. */
  const machine = useStore((s) => s.config);

  const loadSaved = async () => {
    if (!dataStore.connected) return;
    setSavedMotions(await dataStore.getMotionProfiles());
  };
  useEffect(() => {
    void loadSaved();
  }, [folderReady]);

  const requireFolder = (): boolean => {
    if (!dataStore.connected) {
      say('Choose a data folder in Settings first.', 'error');
      return false;
    }
    return true;
  };

  // ── Motion profile ──
  const saveMotionProfile = async () => {
    if (!requireFolder()) return;
    if (!motionProfile.name) {
      say('Enter a motion profile name before saving.', 'error');
      return;
    }
    const entry: MotionProfileEntry = {
      id: crypto.randomUUID(),
      name: motionProfile.name,
      description: motionProfile.description,
      createdAt: new Date().toISOString(),
      profile: { ...motionProfile, sets },
    };
    try {
      const ok = await dataStore.saveMotionProfile(entry, false);
      if (!ok && !window.confirm(`A motion profile "${motionProfile.name}" exists. Replace it?`)) return;
      if (!ok) await dataStore.saveMotionProfile(entry, true);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      say(`Not saved: ${why}`, 'error');
      notify(NotificationType.ERROR, `Motion profile "${motionProfile.name}" was not saved: ${why}`);
      return;
    }
    setSavedSnapshot(profileFingerprint(motionProfile, sets));
    flashSaved();
    say(`Saved "${motionProfile.name}" at ${new Date().toLocaleTimeString()}.`, 'ok');
    notify(NotificationType.SUCCESS, `Motion profile "${motionProfile.name}" saved.`);
    await loadSaved();
  };

  // Unsaved work: shown here, and asked about by the app before leaving.
  const unsaved = profileFingerprint(motionProfile, sets) !== savedSnapshot;
  const { confirmDiscard: discardOk } = useUnsavedWork(`motion profile "${motionProfile.name || 'untitled'}"`, unsaved);

  const loadMotionProfile = (id: string) => {
    if (!discardOk()) return;
    setSelectedMotionId(id);
    const entry = savedMotions.find((p) => p.id === id);
    if (entry) {
      const loadedSets = entry.profile.sets.length > 0 ? entry.profile.sets : [newSet('Set 1')];
      setMotionProfile(entry.profile);
      setSets(loadedSets);
      setSavedSnapshot(profileFingerprint(entry.profile, loadedSets));
      setMessage(null);
    }
  };

  const importMotion = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!discardOk()) return;
    try {
      const parsed = JSON.parse(await file.text()) as MotionProfile;
      setMotionProfile(parsed);
      setSets(parsed.sets.length > 0 ? parsed.sets : [newSet('Set 1')]);
      say('Motion profile imported (not yet saved).');
    } catch {
      say('Failed to import motion profile.', 'error');
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
        idx === mi
          ? {
              ...m,
              moveParameters: {
                ...m.moveParameters,
                waveform: fn,
                // Start a sigmoid from usable numbers rather than a zero-length step.
                ...(fn === 'sigmoid'
                  ? {
                      velocity: m.moveParameters.velocity || 5,
                      acceleration: m.moveParameters.acceleration || 50,
                    }
                  : {}),
                ...(fn === 'chirp'
                  ? {
                      frequency: m.moveParameters.frequency || 0.1,
                      endFrequency: m.moveParameters.endFrequency || 1,
                      duration: m.moveParameters.duration || 30,
                    }
                  : {}),
              },
            }
          : m,
      ),
    });

  const saveSet = async (i: number) => {
    if (!requireFolder()) return;
    const set = sets[i];
    if (!set.name) {
      say('Enter a set name before saving.', 'error');
      return;
    }
    const ok = await dataStore.saveSet(set, false);
    if (!ok && !window.confirm(`A set "${set.name}" exists. Replace it?`)) return;
    if (!ok) await dataStore.saveSet(set, true);
    say(`Set "${set.name}" saved.`, 'ok');
  };

  const openLoadSet = async (i: number) => {
    if (!requireFolder()) return;
    setSavedSets(await dataStore.getSets());
    setLoadSetTarget(i);
  };

  const applyLoadedSet = (set: MotionSet) => {
    if (loadSetTarget === null) return;
    updateSets(replaceSetAt(sets, loadSetTarget, set));
    setLoadSetTarget(null);
  };

  const moveParamInputs = (m: Move, si: number, mi: number) => {
    const p = m.moveParameters;
    const field = (label: string, key: Exclude<keyof Move['moveParameters'], 'waveform'>) => (
      <NumberField
        key={key}
        label={label}
        value={p[key] ?? 0}
        onChange={(n) => updateMoveParam(si, mi, key, n)}
      />
    );
    if (m.moveType === 'dwell') return field('Time (ms)', 'time');
    if (m.moveType === 'math') {
      const fn: WaveformFn = p.waveform === 'sigmoid' || p.waveform === 'chirp' ? p.waveform : 'sine';
      // What the wave asks of the machine, against the machine's own limits
      // (the servo enforces them, so a wave over them runs clipped rather than
      // failing). Only when the machine has told us its limits. A sigmoid's
      // distance depends on where the gantry starts, so its peak speed here
      // assumes a start from zero length.
      const plan = fn === 'sigmoid' ? planSigmoid(p.position ?? 0, p.velocity ?? 0, p.acceleration ?? 0) : null;
      // A chirp peaks at its faster end, and runs whole cycles.
      const topFreq = fn === 'chirp' ? Math.max(p.frequency ?? 0, p.endFrequency ?? 0) : (p.frequency ?? 0);
      const sweep = chirpCycles(p.frequency ?? 0, p.endFrequency ?? 0, p.duration ?? 0);
      const peakV = fn === 'sigmoid' ? (plan?.peakVelocity ?? 0) : sinePeakVelocity(p.amplitude ?? 0, topFreq);
      const peakA = fn === 'sigmoid' ? (p.acceleration ?? 0) : sinePeakAcceleration(p.amplitude ?? 0, topFreq);
      const durationS =
        fn === 'sigmoid'
          ? (plan?.duration ?? 0)
          : fn === 'chirp'
            ? sweep.duration
            : (p.frequency ?? 0) > 0
              ? 1 / (p.frequency ?? 1)
              : 0;
      const machineMaxV = machine?.['Velocity Max (mm/s)'] ?? 0;
      const machineMaxA = machine?.['Acceleration Max (mm/s^2)'] ?? 0;
      const overV = machineMaxV > 0 && peakV > machineMaxV;
      const overA = machineMaxA > 0 && peakA > machineMaxA;
      return (
        <>
          <label className="field">
            Waveform
            <select value={fn} onChange={(e) => setWaveformFn(si, mi, e.target.value as WaveformFn)}>
              <option value="sine">Sine</option>
              <option value="sigmoid">Sigmoid</option>
              <option value="chirp">Chirp</option>
            </select>
          </label>
          {fn === 'sine' ? (
            <>
              {field('Amplitude (mm)', 'amplitude')}
              {field('Frequency (Hz)', 'frequency')}
            </>
          ) : fn === 'chirp' ? (
            <>
              {field('Amplitude (mm)', 'amplitude')}
              {field('Start (Hz)', 'frequency')}
              {field('End (Hz)', 'endFrequency')}
              {field('Duration (s)', 'duration')}
            </>
          ) : (
            <>
              {field('Position (mm)', 'position')}
              {field('Velocity (mm/s)', 'velocity')}
              {field('Acceleration (mm/s²)', 'acceleration')}
            </>
          )}
          <span className={`muted${overV || overA ? ' fault' : ''}`} style={{ alignSelf: 'flex-end' }}>
            ~{peakV.toFixed(1)} mm/s · {peakA.toFixed(0)} mm/s² peak · {durationS.toFixed(2)} s
            {fn === 'sine' ? ' per cycle' : ''}
            {fn === 'chirp' && sweep.cycles > 0 ? ` · ${sweep.cycles} cycles` : ''}
            {overV ? ` · over machine max ${machineMaxV} mm/s` : ''}
            {overA ? ` · over machine max ${machineMaxA} mm/s²` : ''}
          </span>
        </>
      );
    }
    return (
      <>
        {field('Position (mm)', 'position')}
        {field('Velocity (mm/s)', 'velocity')}
      </>
    );
  };

  const testProfile: TestProfile = { ...motionProfile, sets, sampleProfile: EMPTY_SAMPLE_PROFILE };

  return (
    <div>
      <h1>Motion profiles</h1>
      <p className="muted">
        Build the motion a test will run. Sample profiles (material limits and dimensions)
        live on the <strong>Sample profiles</strong> page; the two are combined when you run a test.
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
        <h2>Motion profile</h2>
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
                      Set name
                      <input value={set.name} onChange={(e) => updateSet(si, { name: e.target.value })} />
                    </label>
                    <NumberField
                      label="Executions"
                      value={set.executions}
                      min={1}
                      integer
                      onChange={(n) => updateSet(si, { executions: n })}
                    />
                  </div>
                  <button className="danger" onClick={() => updateSets(sets.filter((_, i) => i !== si))}>
                    Delete set
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
                  <button onClick={() => updateSet(si, { moves: [...set.moves, newMove()] })}>+ Add move</button>
                  <button onClick={() => saveSet(si)}>Save set</button>
                  <button onClick={() => openLoadSet(si)}>Load set</button>
                </div>
              </div>
            )}
          />
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => updateSets([...sets, newSet(`Set ${sets.length + 1}`)])}>+ Add set</button>
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
          <button
            className={justSaved ? 'ok' : 'primary'}
            onClick={saveMotionProfile}
            data-testid="save-motion-profile"
          >
            {justSaved ? 'Saved ✓' : 'Save motion profile'}
          </button>
          {unsaved && (
            <span className="badge tone-warn" data-testid="unsaved-badge" title="Save to keep these changes">
              Unsaved changes
            </span>
          )}
          <label className="filebtn">
            Import .mp
            <input type="file" accept=".mp,application/json" hidden onChange={importMotion} />
          </label>
          <button onClick={() => setPreviewOpen(true)}>Preview G-code</button>
        </div>
        {message && (
          <p className={message.tone === 'ok' ? 'save-ok' : message.tone === 'error' ? 'run-error' : 'muted'} data-testid="create-message">
            {message.text}
          </p>
        )}
      </div>

      <Modal open={previewOpen} title="Generated G-code & Motion" onClose={() => setPreviewOpen(false)}>
        <GcodePreview profile={testProfile} />
      </Modal>

      <Modal open={loadSetTarget !== null} title="Load set" onClose={() => setLoadSetTarget(null)}>
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
