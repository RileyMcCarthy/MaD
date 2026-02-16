/**
 * Data Manager — CRUD service for sample profiles, motion profiles, sets, and test runs.
 *
 * Storage layout (user-configurable directory, default ~/Documents/MaDControl):
 *   MaDControl/
 *     sampleProfiles/      — one JSON file per sample profile
 *     motionProfiles/      — one JSON file per motion profile
 *     sets/                — one JSON file per saved set
 *     testRuns/            — one JSON + one CSV per test run
 *
 * The chosen data directory path is persisted in:
 *   <userData>/settings.json   (Electron's own userData, always deterministic)
 */

import { ipcMain, app, shell, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  SampleProfile,
  MotionProfile,
  Set,
  SampleProfileEntry,
  MotionProfileEntry,
  TestRunEntry,
} from '@shared/SharedInterface';
import { dataLogger } from '@utils/logger';

// ─── Settings persistence (always in Electron userData) ───────────

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_DATA_DIR = path.join(app.getPath('documents'), 'MaDControl');

interface AppSettings {
  dataDir: string;
}

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as AppSettings;
    }
  } catch {
    dataLogger.warn('Corrupt settings.json — using defaults');
  }
  return { dataDir: DEFAULT_DATA_DIR };
}

function saveSettings(settings: AppSettings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ─── Dynamic paths ───────────────────────────────────────────────

let DATA_DIR = loadSettings().dataDir;
let SAMPLE_PROFILES_DIR = path.join(DATA_DIR, 'sampleProfiles');
let MOTION_PROFILES_DIR = path.join(DATA_DIR, 'motionProfiles');
let SETS_DIR = path.join(DATA_DIR, 'sets');
let TEST_RUNS_DIR = path.join(DATA_DIR, 'testRuns');

function updatePaths(newDataDir: string) {
  DATA_DIR = newDataDir;
  SAMPLE_PROFILES_DIR = path.join(DATA_DIR, 'sampleProfiles');
  MOTION_PROFILES_DIR = path.join(DATA_DIR, 'motionProfiles');
  SETS_DIR = path.join(DATA_DIR, 'sets');
  TEST_RUNS_DIR = path.join(DATA_DIR, 'testRuns');
}

// ─── File-per-profile helpers ─────────────────────────────────────

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SAMPLE_PROFILES_DIR, { recursive: true });
  fs.mkdirSync(MOTION_PROFILES_DIR, { recursive: true });
  fs.mkdirSync(SETS_DIR, { recursive: true });
  fs.mkdirSync(TEST_RUNS_DIR, { recursive: true });
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    }
  } catch {
    dataLogger.warn(`Failed to read ${filePath}`);
  }
  return null;
}

function writeJsonFile(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Sanitise a profile name for use as a filename (no path separators, etc.) */
function sanitizeName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'Untitled';
}

// ── Sample profile file helpers ───────────────────────────────────

function sampleProfilePath(name: string): string {
  return path.join(SAMPLE_PROFILES_DIR, `${sanitizeName(name)}.json`);
}

function loadAllSampleProfiles(): SampleProfileEntry[] {
  ensureDirs();
  const entries: SampleProfileEntry[] = [];
  for (const file of fs.readdirSync(SAMPLE_PROFILES_DIR)) {
    if (!file.endsWith('.json')) continue;
    const entry = readJsonFile<SampleProfileEntry>(path.join(SAMPLE_PROFILES_DIR, file));
    if (entry) entries.push(entry);
  }
  return entries;
}

// ── Motion profile file helpers ───────────────────────────────────

function motionProfilePath(name: string): string {
  return path.join(MOTION_PROFILES_DIR, `${sanitizeName(name)}.json`);
}

function loadAllMotionProfiles(): MotionProfileEntry[] {
  ensureDirs();
  const entries: MotionProfileEntry[] = [];
  for (const file of fs.readdirSync(MOTION_PROFILES_DIR)) {
    if (!file.endsWith('.json')) continue;
    const entry = readJsonFile<MotionProfileEntry>(path.join(MOTION_PROFILES_DIR, file));
    if (entry) entries.push(entry);
  }
  return entries;
}

// ── Set file helpers ──────────────────────────────────────────────

function setFilePath(name: string): string {
  return path.join(SETS_DIR, `${sanitizeName(name)}.json`);
}

// ── Test run file helpers ─────────────────────────────────────────

function testRunPath(testName: string): string {
  return path.join(TEST_RUNS_DIR, `${sanitizeName(testName)}.json`);
}

function testRunCsvPath(testName: string): string {
  return path.join(TEST_RUNS_DIR, `${sanitizeName(testName)}.csv`);
}

function loadAllTestRuns(): TestRunEntry[] {
  ensureDirs();
  const entries: TestRunEntry[] = [];
  for (const file of fs.readdirSync(TEST_RUNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const entry = readJsonFile<TestRunEntry>(path.join(TEST_RUNS_DIR, file));
    if (entry) entries.push(entry);
  }
  return entries;
}

// ─── Public init / cleanup ────────────────────────────────────────

export function initializeDataManager() {
  // ── Sample Profiles CRUD ────────────────────────────────────────

  ipcMain.handle('data-get-sample-profiles', async () => {
    return loadAllSampleProfiles();
  });

  ipcMain.handle('data-save-sample-profile', async (_event, name: string, profile: SampleProfile) => {
    ensureDirs();
    if (!name) name = 'Untitled';
    const filePath = sampleProfilePath(name);
    const exists = fs.existsSync(filePath);

    // If a profile with this name already exists, return a flag so the
    // renderer can ask the user whether to overwrite.
    if (exists) {
      return { exists: true, name };
    }

    const entry: SampleProfileEntry = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      profile,
    };
    writeJsonFile(filePath, entry);
    return { exists: false, entry };
  });

  ipcMain.handle('data-overwrite-sample-profile', async (_event, name: string, profile: SampleProfile) => {
    ensureDirs();
    if (!name) name = 'Untitled';
    const filePath = sampleProfilePath(name);

    // Try to preserve the existing ID
    const existing = readJsonFile<SampleProfileEntry>(filePath);
    const entry: SampleProfileEntry = {
      id: existing?.id || crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      profile,
    };
    writeJsonFile(filePath, entry);
    return entry;
  });

  ipcMain.handle('data-delete-sample-profile', async (_event, id: string) => {
    ensureDirs();
    const all = loadAllSampleProfiles();
    const entry = all.find((p) => p.id === id);
    if (entry) {
      const filePath = sampleProfilePath(entry.name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    return true;
  });

  // ── Motion Profiles CRUD ────────────────────────────────────────

  ipcMain.handle('data-get-motion-profiles', async () => {
    return loadAllMotionProfiles();
  });

  ipcMain.handle('data-save-motion-profile', async (_event, profile: MotionProfile) => {
    ensureDirs();
    const name = profile.name || 'Untitled';
    const filePath = motionProfilePath(name);
    const exists = fs.existsSync(filePath);

    if (exists) {
      return { exists: true, name };
    }

    const entry: MotionProfileEntry = {
      id: crypto.randomUUID(),
      name,
      description: profile.description || '',
      createdAt: new Date().toISOString(),
      profile,
    };
    writeJsonFile(filePath, entry);
    return { exists: false, entry };
  });

  ipcMain.handle('data-overwrite-motion-profile', async (_event, profile: MotionProfile) => {
    ensureDirs();
    const name = profile.name || 'Untitled';
    const filePath = motionProfilePath(name);

    const existing = readJsonFile<MotionProfileEntry>(filePath);
    const entry: MotionProfileEntry = {
      id: existing?.id || crypto.randomUUID(),
      name,
      description: profile.description || '',
      createdAt: new Date().toISOString(),
      profile,
    };
    writeJsonFile(filePath, entry);
    return entry;
  });

  ipcMain.handle('data-delete-motion-profile', async (_event, id: string) => {
    ensureDirs();
    const all = loadAllMotionProfiles();
    const entry = all.find((p) => p.id === id);
    if (entry) {
      const filePath = motionProfilePath(entry.name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    return true;
  });

  // ── Sets CRUD ───────────────────────────────────────────────────

  ipcMain.handle('data-save-set', async (_event, set: Set) => {
    ensureDirs();
    const name = set.name || 'Untitled';
    const filePath = setFilePath(name);
    const exists = fs.existsSync(filePath);

    if (exists) {
      return { exists: true, name };
    }

    writeJsonFile(filePath, set);
    return { exists: false, set };
  });

  ipcMain.handle('data-overwrite-set', async (_event, set: Set) => {
    ensureDirs();
    const name = set.name || 'Untitled';
    const filePath = setFilePath(name);
    writeJsonFile(filePath, set);
    return set;
  });

  ipcMain.handle('data-get-sets', async () => {
    ensureDirs();
    const sets: Set[] = [];
    for (const file of fs.readdirSync(SETS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const set = readJsonFile<Set>(path.join(SETS_DIR, file));
      if (set) sets.push(set);
    }
    return sets;
  });

  // ── Open data directory ──────────────────────────────────────────

  ipcMain.handle('data-open-data-dir', async () => {
    ensureDirs();
    return shell.openPath(DATA_DIR);
  });

  // ── Data directory settings ─────────────────────────────────────

  ipcMain.handle('data-get-data-dir', async () => {
    return DATA_DIR;
  });

  ipcMain.handle('data-choose-data-dir', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose Data Directory',
      defaultPath: DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('data-set-data-dir', async (_event, newDir: string) => {
    updatePaths(newDir);
    saveSettings({ dataDir: newDir });
    ensureDirs();
    sampleRunNumbers.clear();
    loadRunNumbers();
    dataLogger.info(`Data directory changed to: ${newDir}`);
    return DATA_DIR;
  });

  // ── Test Runs CRUD ──────────────────────────────────────────────

  ipcMain.handle('data-get-test-runs', async () => {
    return loadAllTestRuns();
  });

  ipcMain.handle('data-get-test-run', async (_event, id: string) => {
    const all = loadAllTestRuns();
    return all.find((r) => r.id === id) || null;
  });

  ipcMain.handle(
    'data-create-test-run',
    async (
      _event,
      params: {
        testName: string;
        sampleProfileId: string;
        motionProfileId: string;
        sampleProfile: SampleProfile;
        motionProfile: MotionProfile;
        gcode: string[];
      },
    ) => {
      ensureDirs();
      const entry: TestRunEntry = {
        id: crypto.randomUUID(),
        testName: params.testName,
        sampleProfileId: params.sampleProfileId,
        motionProfileId: params.motionProfileId,
        sampleProfile: params.sampleProfile,
        motionProfile: params.motionProfile,
        gcode: params.gcode,
        startedAt: new Date().toISOString(),
        status: 'running',
      };
      writeJsonFile(testRunPath(params.testName), entry);
      return entry;
    },
  );

  ipcMain.handle(
    'data-update-test-run',
    async (_event, id: string, updates: Partial<TestRunEntry>) => {
      const all = loadAllTestRuns();
      const run = all.find((r) => r.id === id);
      if (!run) return null;
      const updated = { ...run, ...updates };
      writeJsonFile(testRunPath(run.testName), updated);
      return updated;
    },
  );

  ipcMain.handle('data-delete-test-run', async (_event, id: string) => {
    const all = loadAllTestRuns();
    const run = all.find((r) => r.id === id);
    if (!run) return true;
    // Delete JSON metadata
    const jsonPath = testRunPath(run.testName);
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    // Delete CSV data
    const csvPath = testRunCsvPath(run.testName);
    if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    return true;
  });

  // ── Save downloaded test data CSV ───────────────────────────────

  ipcMain.handle(
    'data-save-test-csv',
    async (_event, testRunId: string, csvData: Buffer) => {
      const all = loadAllTestRuns();
      const run = all.find((r) => r.id === testRunId);
      if (!run) return { success: false, error: 'Test run not found' };

      const csvPath = testRunCsvPath(run.testName);
      fs.writeFileSync(csvPath, csvData);

      run.dataFilePath = `${sanitizeName(run.testName)}.csv`;
      run.status = 'downloaded';
      run.completedAt = new Date().toISOString();
      writeJsonFile(testRunPath(run.testName), run);

      return { success: true, filePath: csvPath };
    },
  );

  // ── Read test CSV data ───────────────────────────────────────────

  ipcMain.handle('data-read-test-csv', async (_event, testRunId: string) => {
    const all = loadAllTestRuns();
    const run = all.find((r) => r.id === testRunId);
    if (!run) return { success: false, error: 'Test run not found' };

    const csvPath = testRunCsvPath(run.testName);
    if (!fs.existsSync(csvPath))
      return { success: false, error: 'Data file missing' };

    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    return { success: true, data: csvContent };
  });

  // ── Export test run as CSV with metadata ────────────────────────

  ipcMain.handle(
    'data-export-test-csv',
    async (_event, testRunId: string, exportPath: string) => {
      const all = loadAllTestRuns();
      const run = all.find((r) => r.id === testRunId);
      if (!run) return { success: false, error: 'Test run not found' };

      const csvPath = testRunCsvPath(run.testName);
      if (!fs.existsSync(csvPath)) return { success: false, error: 'Data file missing' };

      const rawCsv = fs.readFileSync(csvPath, 'utf-8');

      // Build metadata header
      const allSp = loadAllSampleProfiles();
      const allMp = loadAllMotionProfiles();
      const sp = allSp.find((p) => p.id === run.sampleProfileId);
      const mp = allMp.find((p) => p.id === run.motionProfileId);

      const lines: string[] = [];
      lines.push(`# Test Run: ${run.testName}`);
      lines.push(`# Date: ${run.startedAt}`);
      if (sp) {
        lines.push(`# Sample Profile: ${sp.name}`);
        lines.push(
          `# Max Force: ${sp.profile.maxForce} N, Max Velocity: ${sp.profile.maxVelocity} mm/s, Max Displacement: ${sp.profile.maxDisplacement} mm`,
        );
        lines.push(
          `# Sample Width: ${sp.profile.sampleWidth} mm, Sample Thickness: ${sp.profile.sampleThickness} mm`,
        );
      }
      if (mp) {
        lines.push(`# Motion Profile: ${mp.name}`);
        lines.push(`# Description: ${mp.description}`);
      }
      lines.push(rawCsv);

      fs.writeFileSync(exportPath, lines.join('\n'));
      return { success: true, filePath: exportPath };
    },
  );

  // ── Get test-runs data directory ────────────────────────────────

  ipcMain.handle('data-get-test-runs-dir', async () => {
    return TEST_RUNS_DIR;
  });
}

export function cleanupDataManager() {
  // No-op — reserved for future cleanup tasks
}
