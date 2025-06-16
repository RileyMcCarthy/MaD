import { ipcMain } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

// Map to store run numbers for each sample profile
const sampleRunNumbers = new Map<string, number>();
const RUNS_FILE = path.join(process.cwd(), 'sample-runs.json');

// Load existing run numbers from file
async function loadRunNumbers() {
  try {
    const data = await fs.readFile(RUNS_FILE, 'utf-8');
    const runs = JSON.parse(data);
    Object.entries(runs).forEach(([serialNumber, runNumber]) => {
      sampleRunNumbers.set(serialNumber, runNumber as number);
    });
  } catch (error) {
    // File doesn't exist or is invalid, start with empty map
    console.log('No existing run numbers found, starting fresh');
  }
}

// Save run numbers to file
async function saveRunNumbers() {
  const runs = Object.fromEntries(sampleRunNumbers);
  await fs.writeFile(RUNS_FILE, JSON.stringify(runs, null, 2));
}

export function initializeSampleProfiles() {
  // Load existing run numbers when the app starts
  loadRunNumbers();

  // Handle requests for run numbers
  ipcMain.handle('sample-profile-run', async (_, serialNumber: string) => {
    // Get the current run number or start at 0
    const currentRun = sampleRunNumbers.get(serialNumber) || 0;

    // Increment the run number
    const nextRun = currentRun + 1;

    // Store the new run number
    sampleRunNumbers.set(serialNumber, nextRun);

    // Save to file
    await saveRunNumbers();

    return nextRun;
  });
}

// Clean up when the app closes
export function cleanup() {
  return saveRunNumbers();
}
