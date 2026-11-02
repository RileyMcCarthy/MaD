import { useEffect, useMemo, useRef, useState } from 'react';
import {
  SampleProfileEntry,
  MotionProfileEntry,
  TestProfile,
  TestRunEntry,
  generateTestGcode,
  parseSampleProfileJson,
  sampleProfileNameFromFile,
  RestrictedReason,
} from '@/domain';
import { checkTestLimits } from '@/domain/testLimits';
import { dataStore } from '@/storage/DataStore';
import { deviceClient } from '@/device/session';
import { useStore } from '@/store/useStore';
import Modal from './Modal';
import GcodePreview from './GcodePreview';
import { startTestOnDevice } from './startTestOnDevice';

interface TestRunnerProps {
  /** Called after a run is created/started/completed so the history can refresh. */
  onChanged: () => void;
}

/**
 * Profile-driven test runner: pick a saved sample + motion profile, preview the
 * generated G-code, then run. On run it captures the gauge length / initial
 * machine position (for later strain analysis), pushes the sample profile to
 * firmware, uploads the generated G-code, and marks the run completed when
 * firmware reports `testRunning` has cleared.
 */
export default function TestRunner({ onChanged }: TestRunnerProps) {
  const connected = useStore((s) => s.connection === 'connected');
  const testRunning = useStore((s) => Boolean(s.machineState?.testRunning));
  const folderReady = useStore((s) => s.dataFolderReady);
  const setSampleProfile = useStore((s) => s.setSampleProfile);
  const finishedRun = useStore((s) => s.finishedRun);
  const trackRun = useStore((s) => s.trackRun);
  const confirmRunStarted = useStore((s) => s.confirmRunStarted);
  const dropRun = useStore((s) => s.dropRun);
  const machineConfig = useStore((s) => s.config);
  const latestSample = useStore((s) => s.latestSample);
  const restricted = useStore((s) => (s.machineState?.restrictedReason ?? RestrictedReason.NONE) !== RestrictedReason.NONE);

  const [samples, setSamples] = useState<SampleProfileEntry[]>([]);
  const [motions, setMotions] = useState<MotionProfileEntry[]>([]);
  const [sampleId, setSampleId] = useState('');
  const [motionId, setMotionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  /** The run this runner started and is waiting on (for its messages). The
   *  store decides when it has finished, on whichever screen is open. */
  const activeTestName = useRef<string | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdog = () => {
    if (watchdog.current) {
      clearTimeout(watchdog.current);
      watchdog.current = null;
    }
  };

  const loadProfiles = async () => {
    if (!dataStore.connected) return;
    setSamples(await dataStore.getSampleProfiles());
    setMotions(await dataStore.getMotionProfiles());
  };
  useEffect(() => {
    void loadProfiles();
  }, [folderReady]);

  const selectedSample = samples.find((s) => s.id === sampleId)?.profile;
  const selectedMotion = motions.find((m) => m.id === motionId)?.profile;

  // Reflect the chosen sample as the active profile so the live charts show its
  // force/displacement (and stress/strain) limit lines as soon as it's selected.
  useEffect(() => {
    if (selectedSample) setSampleProfile(selectedSample);
  }, [sampleId, selectedSample, setSampleProfile]);

  // The store marks the run completed when the machine finishes it
  // (src/domain/runTracking.ts); this only reports it.
  useEffect(() => {
    if (finishedRun === null || finishedRun !== activeTestName.current) return;
    activeTestName.current = null;
    clearWatchdog();
    setMessage(`Test ${finishedRun} finished. Download its data from Test runs.`);
    onChanged();
  }, [finishedRun, onChanged]);

  // Losing the UI link mid-test is a non-event: the machine runs the program
  // autonomously from its SD card (and is protected by its own hardware e-stop +
  // sensors). Keep the run 'running' and keep tracking it, so a reconnect can
  // still catch the completion edge (or the operator resolves it from History).
  useEffect(() => {
    if (!connected && activeTestName.current) {
      setMessage(
        `Disconnected during ${activeTestName.current}; the test continues on the machine. Reconnect to monitor.`,
      );
    }
  }, [connected]);

  // Cancel the stuck-run watchdog if the runner unmounts.
  useEffect(() => clearWatchdog, []);

  const importSample = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !dataStore.connected) return;
    try {
      const profile = parseSampleProfileJson(await file.text());
      const entry: SampleProfileEntry = {
        id: crypto.randomUUID(),
        name: sampleProfileNameFromFile(file.name),
        createdAt: new Date().toISOString(),
        profile,
      };
      await dataStore.saveSampleProfile(entry, true);
      await loadProfiles();
      setSampleId(entry.id);
    } catch {
      setMessage('Failed to import sample profile.');
    }
  };

  const importMotion = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !dataStore.connected) return;
    try {
      const profile = JSON.parse(await file.text());
      const entry: MotionProfileEntry = {
        id: crypto.randomUUID(),
        name: profile.name || file.name.replace(/\.mp$/i, '') || 'imported',
        description: profile.description || '',
        createdAt: new Date().toISOString(),
        profile,
      };
      await dataStore.saveMotionProfile(entry, true);
      await loadProfiles();
      setMotionId(entry.id);
    } catch {
      setMessage('Failed to import motion profile.');
    }
  };

  const run = async () => {
    if (!selectedSample || !selectedMotion) return;
    if (!dataStore.connected) {
      setMessage('Choose a data folder in Settings first.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const profile: TestProfile = { ...selectedMotion, sampleProfile: selectedSample };
      const { gcode, time } = generateTestGcode(profile);
      const expectedSec = time.length > 0 ? time[time.length - 1] : 0;

      // Capture gauge length + initial machine position from the latest sample.
      const snap = useStore.getState().latestSample;
      let gaugeLengthMm: number | undefined;
      let initialMachinePositionMm: number | undefined;
      if (snap) {
        const machineMm = snap['Machine Position (mm)'];
        const sampleMm = snap['Sample Position (mm)'];
        if (Number.isFinite(machineMm)) initialMachinePositionMm = machineMm;
        if (Number.isFinite(machineMm) && Number.isFinite(sampleMm)) {
          const g = machineMm - sampleMm;
          if (Number.isFinite(g)) gaugeLengthMm = g;
        }
      }

      const testName = await dataStore.nextTestName();
      const entry: TestRunEntry = {
        id: crypto.randomUUID(),
        testName,
        sampleProfileId: sampleId,
        motionProfileId: motionId,
        sampleProfile: selectedSample,
        motionProfile: selectedMotion,
        gcode,
        ...(gaugeLengthMm !== undefined ? { gaugeLengthMm } : {}),
        ...(initialMachinePositionMm !== undefined ? { initialMachinePositionMm } : {}),
        startedAt: new Date().toISOString(),
        status: 'running',
      };
      await dataStore.createTestRun(entry);
      onChanged();

      // Register the run for completion tracking BEFORE the test starts, so the
      // firmware testRunning true→false transition is never missed — a short
      // test can finish before runTest() resolves, which previously left the run
      // stuck 'running' (machine idle but history still "running").
      activeTestName.current = testName;
      trackRun(testName);

      // Enable motion, push the sample profile, then upload + start the test.
      // A refused sample profile write fails the start before runTest(), so a
      // test never runs on the previous profile's limits.
      const started = await startTestOnDevice(deviceClient, dataStore, selectedSample, {
        gcode,
        gcodeId: testName,
        testDataId: testName,
        ...(gaugeLengthMm !== undefined ? { gaugeLengthMm } : {}),
      });

      if (!started.ok) {
        // startTestOnDevice already marked the run 'error'.
        activeTestName.current = null;
        dropRun(testName);
        clearWatchdog();
        setMessage(started.error);
      } else {
        confirmRunStarted(testName, gcode);
        setMessage(`Test ${testName} started.`);
        // Stuck-run watchdog: if firmware never reports completion well past
        // the profile's expected duration, tell the user instead of waiting
        // forever (resolution is manual — History has mark done/failed).
        const watchdogMs = Math.max(30_000, expectedSec * 2 * 1000 + 15_000);
        clearWatchdog();
        watchdog.current = setTimeout(() => {
          if (activeTestName.current === testName) {
            setMessage(
              `${testName} has run ~${Math.round(watchdogMs / 1000)}s (expected ~${Math.max(1, Math.round(expectedSec))}s). ` +
                'The firmware may be stuck — you can mark the run done or failed in History.',
            );
          }
        }, watchdogMs);
      }
      onChanged();
    } catch (err) {
      // If we'd already registered the run, don't leave it dangling (it would
      // never complete and could spuriously complete on a later test's edge).
      const name = activeTestName.current;
      if (name) {
        activeTestName.current = null;
        dropRun(name);
        clearWatchdog();
        void dataStore.updateTestRun(name, { status: 'error' }).then(onChanged);
      }
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const previewProfile: TestProfile | null =
    selectedSample && selectedMotion
      ? { ...selectedMotion, sampleProfile: selectedSample }
      : null;

  const runDisabled = !connected || busy || testRunning || !selectedSample || !selectedMotion;

  // Where the test asks for more than the machine or the sample allows. Checked
  // against the machine's live configuration and state, so it updates as they do.
  const machineMm = latestSample?.['Machine Position (mm)'];
  const extensionMm = latestSample?.['Sample Position (mm)'];
  const gaugeLengthMm =
    machineMm !== undefined && extensionMm !== undefined && Number.isFinite(machineMm - extensionMm)
      ? machineMm - extensionMm
      : null;
  const roundedGauge = gaugeLengthMm === null ? null : Math.round(gaugeLengthMm * 10) / 10;
  const roundedExtension = Math.round((extensionMm ?? 0) * 10) / 10;
  const restrictedVelocity = restricted ? (machineConfig?.['Restricted Velocity (mm/s)'] ?? null) : null;
  const limitIssues = useMemo(
    () =>
      previewProfile
        ? checkTestLimits(previewProfile, {
            machine: machineConfig,
            startExtensionMm: roundedExtension,
            gaugeLengthMm: roundedGauge,
            restrictedVelocityMmS: restrictedVelocity,
          })
        : [],
    // previewProfile is rebuilt every render; its parts are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedSample, selectedMotion, machineConfig, roundedExtension, roundedGauge, restrictedVelocity],
  );

  const onRunClick = () => {
    if (limitIssues.length > 0) setConfirmOpen(true);
    else void run();
  };

  return (
    <div className="panel">
      <h2>New test</h2>
      {!folderReady && (
        <p className="muted">Choose a data folder in Settings to load profiles.</p>
      )}
      <div className="grid cols-2">
        <div className="row">
          <select
            value={sampleId}
            onChange={(e) => setSampleId(e.target.value)}
            style={{ flex: 1 }}
          >
            <option value="">Select sample profile…</option>
            {samples.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.profile.maxForce}N, {s.profile.maxDisplacement}mm
              </option>
            ))}
          </select>
          <label className="filebtn">
            Import .sp
            <input type="file" accept=".sp,application/json" hidden onChange={importSample} />
          </label>
        </div>
        <div className="row">
          <select
            value={motionId}
            onChange={(e) => setMotionId(e.target.value)}
            style={{ flex: 1 }}
          >
            <option value="">Select motion profile…</option>
            {motions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.description ? ` — ${m.description}` : ''}
              </option>
            ))}
          </select>
          <label className="filebtn">
            Import .mp
            <input type="file" accept=".mp,application/json" hidden onChange={importMotion} />
          </label>
        </div>
      </div>

      {limitIssues.length > 0 && (
        <div className="limit-warnings" data-testid="limit-warnings">
          <div className="limit-warnings-title">This test goes beyond the machine or sample limits</div>
          <ul>
            {limitIssues.map((issue) => (
              <li key={issue.id} data-issue={issue.id}>
                <span className="limit-source">{issue.source === 'machine' ? 'Machine' : 'Sample'}</span>
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="primary"
          onClick={onRunClick}
          disabled={runDisabled}
          data-testid="run-test"
        >
          {testRunning ? 'Test running…' : busy ? 'Starting…' : 'Run test'}
        </button>
        <button onClick={() => setPreviewOpen(true)} disabled={!previewProfile}>
          Preview G-code
        </button>
        {!connected && <span className="muted">Connect a device to run.</span>}
        {message && <span className="muted">{message}</span>}
      </div>

      <Modal open={confirmOpen} title="Run past the limits?" onClose={() => setConfirmOpen(false)} width={520}>
        <ul className="limit-confirm-list">
          {limitIssues.map((issue) => (
            <li key={issue.id}>{issue.message}</li>
          ))}
        </ul>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => setConfirmOpen(false)}>Cancel</button>
          <button
            className="primary"
            data-testid="run-anyway"
            onClick={() => {
              setConfirmOpen(false);
              void run();
            }}
          >
            Run anyway
          </button>
        </div>
      </Modal>

      <Modal open={previewOpen} title="Generated G-code & Motion" onClose={() => setPreviewOpen(false)}>
        {previewProfile && <GcodePreview profile={previewProfile} />}
      </Modal>
    </div>
  );
}
