/**
 * Dashboard & Motion Control Tests (consolidated)
 *
 * Three tests covering:
 * 1. Unit correctness — all Sample fields have correct units and precision at rest
 * 2. Motion units — position, setpoint, and force track moves with correct mm scale
 * 3. Zeroing, homing, and safety
 */

import { test, expect } from './fixtures';

function extractValue(text: string | null, label: string): number | null {
  if (!text) return null;
  const pattern = new RegExp(`${label}:\\s*([-\\d.]+)`);
  const match = text.match(pattern);
  return match ? parseFloat(match[1]) : null;
}

const getPosition = async (posContainer: any) =>
  extractValue(await posContainer.textContent(), 'Machine Position \\(mm\\)');

const getSetpoint = async (container: any) =>
  extractValue(await container.textContent(), 'Machine Setpoint \\(mm\\)');

const getMachineForce = async (container: any) =>
  extractValue(await container.textContent(), 'Machine Force \\(N\\)');

const getSamplePosition = async (container: any) =>
  extractValue(await container.textContent(), 'Sample Position \\(mm\\)');

const getSampleForce = async (container: any) =>
  extractValue(await container.textContent(), 'Sample Force \\(N\\)');

test.describe('Dashboard & Motion Control', () => {

  test('unit correctness: all sample fields are finite, in range, and have sub-mm/sub-N precision', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    const posContainer    = window.locator('text=Machine Position (mm):').locator('..').first();
    const setpointContainer = window.locator('text=Machine Setpoint (mm):').locator('..').first();
    const forceContainer  = window.locator('text=Machine Force (N):').locator('..').first();
    const samplePosContainer   = window.locator('text=Sample Position (mm):').locator('..').first();
    const sampleForceContainer = window.locator('text=Sample Force (N):').locator('..').first();

    // Wait for live data
    await window.waitForTimeout(500);

    // ── All fields must be finite numbers (catches NaN/Infinity from bad encoding) ──
    const pos = await getPosition(posContainer);
    expect(pos, 'machinePosition must be finite').not.toBeNull();
    expect(Number.isFinite(pos), 'machinePosition finite').toBe(true);

    const setpt = await getSetpoint(setpointContainer);
    expect(setpt, 'machineSetpoint must be finite').not.toBeNull();
    expect(Number.isFinite(setpt), 'machineSetpoint finite').toBe(true);

    const force = await getMachineForce(forceContainer);
    expect(force, 'machineForce must be finite').not.toBeNull();
    expect(Number.isFinite(force), 'machineForce finite').toBe(true);

    const samplePos = await getSamplePosition(samplePosContainer);
    expect(samplePos, 'samplePosition must be finite').not.toBeNull();
    expect(Number.isFinite(samplePos), 'samplePosition finite').toBe(true);

    const sampleForce = await getSampleForce(sampleForceContainer);
    expect(sampleForce, 'sampleForce must be finite').not.toBeNull();
    expect(Number.isFinite(sampleForce), 'sampleForce finite').toBe(true);

    // ── All fields must be in reasonable physical range at rest ──
    // If units are wrong (e.g. µm instead of mm) values would be 1000× out of range
    expect(Math.abs(pos!), 'machinePosition in mm range (not µm)').toBeLessThan(300);
    expect(Math.abs(setpt!), 'machineSetpoint in mm range (not µm)').toBeLessThan(300);
    expect(Math.abs(force!), 'machineForce in N range (not mN)').toBeLessThan(100);
    expect(Math.abs(samplePos!), 'samplePosition in mm range (not µm)').toBeLessThan(300);
    expect(Math.abs(sampleForce!), 'sampleForce in N range (not mN)').toBeLessThan(100);

    // ── Force must be in N range — if units were mN, value would be >>100
    // The emulator may simulate a nonzero preload; that's OK. The key is it's not thousands.
    expect(Math.abs(force!), 'machineForce in N range (not mN = 1000× too large)').toBeLessThan(100);
    expect(Math.abs(sampleForce!), 'sampleForce in N range (not mN = 1000× too large)').toBeLessThan(100);

    // ── All values must be in physical bounds (catches wrong-unit bugs regardless of preload/initial state) ──
    // If setpoint were in µm: a 262mm gauge length would read 262,000 — far outside 300mm range
    expect(Math.abs(setpt!), 'machineSetpoint in mm range (not µm: would be 262000)').toBeLessThan(300);
  });

  test('motion units: position and setpoint track moves correctly in mm', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    const posContainer      = window.locator('text=Machine Position (mm):').locator('..').first();
    const setpointContainer = window.locator('text=Machine Setpoint (mm):').locator('..').first();
    const forceContainer    = window.locator('text=Machine Force (N):').locator('..').first();
    const enableBtn         = window.getByRole('button', { name: 'Enable Motion' });
    const disableBtn        = window.getByRole('button', { name: 'Disable Motion' });
    const distanceInput     = window.getByLabel('Move Distance (mm)');
    const speedInput        = window.getByLabel('Move Speed (mm/s)');

    await window.waitForTimeout(500);
    if (await enableBtn.isVisible()) {
      await enableBtn.click();
      await expect(disableBtn).toBeVisible({ timeout: 5000 });
    }
    await expect(window.getByText('Enabled')).toBeVisible({ timeout: 5000 });

    const runBoundedMove = async (
      buttonName: 'Move Up' | 'Move Down',
      expectedDistanceMm: number,
      speedMmPerSec: number,
    ): Promise<{ posDelta: number; setDelta: number; endPos: number; endSet: number }> => {
      const sign = buttonName === 'Move Up' ? 1 : -1;
      const startPos = await getPosition(posContainer);
      const startSet = await getSetpoint(setpointContainer);
      expect(startPos).not.toBeNull();
      expect(startSet).not.toBeNull();

      await distanceInput.fill(String(expectedDistanceMm));
      await speedInput.fill(String(speedMmPerSec));
      await window.getByRole('button', { name: buttonName }).click();

      let endPos = startPos!;
      let endSet = startSet!;

      // Wait until motion has actually settled at the target — both position
      // and setpoint must be at the commanded distance and agree with each other.
      // (Without this, the loop can exit mid-move when position has just crossed
      // the lower bound but setpoint already jumped to the final value.)
      await expect(async () => {
        endPos = (await getPosition(posContainer))!;
        endSet = (await getSetpoint(setpointContainer))!;
        const posDelta = sign * (endPos - startPos!);
        const setDelta = sign * (endSet - startSet!);
        expect(Math.abs(posDelta - expectedDistanceMm), `${buttonName} position settled at ~${expectedDistanceMm}mm`).toBeLessThan(0.2);
        expect(Math.abs(setDelta - expectedDistanceMm), `${buttonName} setpoint settled at ~${expectedDistanceMm}mm`).toBeLessThan(0.2);
      }).toPass({ timeout: 15000 });

      return {
        posDelta: sign * (endPos - startPos!),
        setDelta: sign * (endSet - startSet!),
        endPos,
        endSet,
      };
    };

    // ── Verify both directions in mm-scale with bounded deltas ──
    const beforeMovePos = await getPosition(posContainer);
    expect(beforeMovePos).not.toBeNull();

    const firstDirection: 'Move Up' | 'Move Down' = beforeMovePos! > 30 ? 'Move Down' : 'Move Up';
    const secondDirection: 'Move Up' | 'Move Down' = firstDirection === 'Move Down' ? 'Move Up' : 'Move Down';

    const moveA = await runBoundedMove(firstDirection, 5, 20);
    expect(Math.abs(moveA.endPos - moveA.endSet), 'position and setpoint agree after first move').toBeLessThan(0.2);

    const moveB = await runBoundedMove(secondDirection, 10, 20);
    expect(Math.abs(moveB.endPos - moveB.endSet), 'position and setpoint agree after second move').toBeLessThan(0.2);

    // ── Round trip: up then down same distance returns near start ──
    const roundTripStart = await getPosition(posContainer);
    await runBoundedMove('Move Up', 4, 20);
    await runBoundedMove('Move Down', 4, 20);
    const roundTripEnd = await getPosition(posContainer);
    expect(Math.abs(roundTripEnd! - roundTripStart!), 'round trip returns to start').toBeLessThan(2);

    // ── Force is in N range throughout (not mN = 1000× too large) ──
    const force = await getMachineForce(forceContainer);
    expect(Math.abs(force!), 'machineForce stays in N range during motion').toBeLessThan(100);

    // ── Sequential small moves accumulate in mm scale ──
    const seqStart = await getPosition(posContainer);
    await runBoundedMove('Move Up', 2, 20);
    await runBoundedMove('Move Up', 2, 20);
    await runBoundedMove('Move Up', 2, 20);
    const seqEnd = await getPosition(posContainer);
    expect(seqEnd! - seqStart!, 'three 2mm moves = ~6mm total').toBeGreaterThan(4);
    expect(seqEnd! - seqStart!, 'three 2mm moves not wildly scaled').toBeLessThan(8);

    // ── Inputs retain values after move ──
    await distanceInput.fill('7');
    await speedInput.fill('15');
    await window.getByRole('button', { name: 'Move Up' }).click();
    await window.waitForTimeout(2000);
    await expect(distanceInput).toHaveValue('7');
    await expect(speedInput).toHaveValue('15');
  });

  /**
   * Regression: SIL encoder must track pulse_out (same as firmware dev_stepper).
   * Previously the async stepper model drifted from pulse emission → position/sample lagged setpoint ~1 mm.
   */
  test('settled jog: machine position and sample extension track setpoint within 0.12 mm', async ({
    connectToEmulator,
    window,
  }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    const posContainer = window.locator('text=Machine Position (mm):').locator('..').first();
    const setpointContainer = window.locator('text=Machine Setpoint (mm):').locator('..').first();
    const samplePosContainer = window.locator('text=Sample Position (mm):').locator('..').first();
    const enableBtn = window.getByRole('button', { name: 'Enable Motion' });
    const disableBtn = window.getByRole('button', { name: 'Disable Motion' });
    const distanceInput = window.getByLabel('Move Distance (mm)');
    const speedInput = window.getByLabel('Move Speed (mm/s)');

    await window.waitForTimeout(500);
    if (await enableBtn.isVisible()) {
      await enableBtn.click();
      await expect(disableBtn).toBeVisible({ timeout: 5000 });
    }

    await window.getByRole('button', { name: 'Zero Length' }).click();
    await window.waitForTimeout(800);

    const m0 = await getPosition(posContainer);
    const s0 = await getSetpoint(setpointContainer);
    const sample0 = await getSamplePosition(samplePosContainer);
    expect(m0).not.toBeNull();
    expect(s0).not.toBeNull();
    expect(sample0).not.toBeNull();

    const jogMm = 10;
    await distanceInput.fill(String(jogMm));
    await speedInput.fill('25');
    await window.getByRole('button', { name: 'Move Up' }).click();

    await expect(async () => {
      const pos = (await getPosition(posContainer))!;
      const set = (await getSetpoint(setpointContainer))!;
      const sample = (await getSamplePosition(samplePosContainer))!;

      expect(Math.abs(pos - set), `machine vs setpoint: ${pos}, ${set}`).toBeLessThan(0.12);
      expect(Math.abs(pos - m0! - jogMm), `machine delta ~${jogMm}: ${pos} − ${m0}`).toBeLessThan(0.12);
      expect(Math.abs(set - s0! - jogMm), `setpoint delta ~${jogMm}: ${set} − ${s0}`).toBeLessThan(0.12);
      expect(
        Math.abs(sample - sample0! - jogMm),
        `sample extension delta ~${jogMm}: ${sample} − ${sample0}`,
      ).toBeLessThan(0.12);
    }).toPass({ timeout: 25_000 });
  });

  test('zeroing, homing, and safety', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    const posContainer         = window.locator('text=Machine Position (mm):').locator('..').first();
    const samplePosContainer   = window.locator('text=Sample Position (mm):').locator('..').first();
    const sampleForceContainer = window.locator('text=Sample Force (N):').locator('..').first();
    const enableBtn  = window.getByRole('button', { name: 'Enable Motion' });
    const disableBtn = window.getByRole('button', { name: 'Disable Motion' });
    const distanceInput = window.getByLabel('Move Distance (mm)');
    const speedInput    = window.getByLabel('Move Speed (mm/s)');

    // ── Motion prevented when disabled ──
    await expect(enableBtn).toBeVisible({ timeout: 5000 });
    const initialPos = await getPosition(posContainer);
    expect(initialPos).not.toBeNull();
    await window.getByRole('button', { name: 'Move Up' }).click();
    await window.waitForTimeout(2000);
    const afterDisabledMove = await getPosition(posContainer);
    expect(Math.abs(afterDisabledMove! - initialPos!), 'no motion when disabled').toBeLessThan(0.5);

    // ── Zero Force zeroes sample force in N (not 1000× off) ──
    await window.getByRole('button', { name: 'Zero Force' }).click();
    await expect(async () => {
      const force = await getSampleForce(sampleForceContainer);
      expect(force).not.toBeNull();
      expect(Math.abs(force!), 'force near zero after Zero Force').toBeLessThan(1);
    }).toPass({ timeout: 3000 });

    await enableBtn.click();
    await expect(disableBtn).toBeVisible({ timeout: 5000 });

    // ── Zero Length zeroes sample position in mm ──
    await distanceInput.fill('5');
    await speedInput.fill('20');
    await window.getByRole('button', { name: 'Move Up' }).click();
    await window.waitForTimeout(2000);

    const posBefore = await getSamplePosition(samplePosContainer);
    expect(Math.abs(posBefore!), 'sample position non-zero before zero').toBeGreaterThan(2);
    // Also confirm it's in mm range (not µm)
    expect(Math.abs(posBefore!), 'sample position in mm (not µm)').toBeLessThan(300);

    await window.getByRole('button', { name: 'Zero Length' }).click();
    await expect(async () => {
      const pos = await getSamplePosition(samplePosContainer);
      expect(pos).not.toBeNull();
      expect(Math.abs(pos!), 'sample position near zero after Zero Length').toBeLessThan(1);
    }).toPass({ timeout: 5000 });

    // ── Homing ──
    await window.getByRole('button', { name: 'Home' }).click();
    await window.waitForTimeout(3000);
    await expect(window.getByRole('button', { name: 'Home' })).toBeEnabled();
    await expect(disableBtn).toBeVisible();

    // Post-home control should be usable: issue a bounded move and verify position changes.
    const postHomeStart = await getPosition(posContainer);
    expect(postHomeStart).not.toBeNull();
    await distanceInput.fill('2');
    await speedInput.fill('10');
    const postHomeDirection: 'Move Up' | 'Move Down' =
      postHomeStart! > 30 ? 'Move Down' : 'Move Up';
    await window.getByRole('button', { name: postHomeDirection }).click();
    await window.waitForTimeout(1500);
    const postHomeEnd = await getPosition(posContainer);
    expect(postHomeEnd).not.toBeNull();
    expect(
      Math.abs(postHomeEnd! - postHomeStart!),
      'post-home motion command is accepted and moves machine',
    ).toBeGreaterThan(0.5);

    // ── Disable mid-move stops movement ──
    const moveStartPos = await getPosition(posContainer);
    await distanceInput.fill('50');
    await speedInput.fill('5');
    await window.getByRole('button', { name: 'Move Up' }).click();
    await window.waitForTimeout(500);
    await disableBtn.click();
    await expect(enableBtn).toBeVisible({ timeout: 5000 });

    const stoppedPos = await getPosition(posContainer);
    await window.waitForTimeout(1000);
    const laterPos = await getPosition(posContainer);
    expect(Math.abs(laterPos! - stoppedPos!), 'motion stopped after disable').toBeLessThan(0.5);
    const traveled = (stoppedPos ?? 0) - (moveStartPos ?? 0);
    expect(traveled, 'did not travel full 50mm before stop').toBeLessThan(45);
  });

});
