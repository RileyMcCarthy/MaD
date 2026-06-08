/**
 * Dashboard & Motion Control (consolidated)
 *
 * One large test exercising the dashboard motion surface end-to-end:
 *   1. Unit correctness at rest (all sample fields finite, sub-mm/sub-N range)
 *   2. Motion units: position & setpoint track bounded jogs in mm
 *   3. Round-trip & sequential jogs stay in mm scale
 *   4. Settled jog: machine + sample track setpoint within 0.12 mm
 *      (regression for async stepper encoder drift)
 *   5. Zero Force / Zero Length / Home / disable-mid-move
 *
 * Each test() in this spec spawns a fresh emulator + Electron app, so we
 * deliberately combine validations that share the same dashboard surface.
 */

import { test, expect } from './fixtures';
import type { Locator } from '@playwright/test';

function extractValue(text: string | null, label: string): number | null {
  if (!text) return null;
  const pattern = new RegExp(`${label}:\\s*([-\\d.]+)`);
  const match = text.match(pattern);
  return match ? parseFloat(match[1]) : null;
}

const getPosition       = async (c: Locator) => extractValue(await c.textContent(), 'Machine Position \\(mm\\)');
const getSetpoint       = async (c: Locator) => extractValue(await c.textContent(), 'Machine Setpoint \\(mm\\)');
const getMachineForce   = async (c: Locator) => extractValue(await c.textContent(), 'Machine Force \\(N\\)');
const getSamplePosition = async (c: Locator) => extractValue(await c.textContent(), 'Sample Position \\(mm\\)');
const getSampleForce    = async (c: Locator) => extractValue(await c.textContent(), 'Sample Force \\(N\\)');

test.describe('Dashboard & Motion Control', () => {
  test('dashboard end-to-end: units, jogging, tracking, zeroing, homing, safety', async ({
    connectToEmulator,
    window,
  }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    const posContainer         = window.locator('text=Machine Position (mm):').locator('..').first();
    const setpointContainer    = window.locator('text=Machine Setpoint (mm):').locator('..').first();
    const forceContainer       = window.locator('text=Machine Force (N):').locator('..').first();
    const samplePosContainer   = window.locator('text=Sample Position (mm):').locator('..').first();
    const sampleForceContainer = window.locator('text=Sample Force (N):').locator('..').first();
    const enableBtn            = window.getByRole('button', { name: 'Enable Motion' });
    const disableBtn           = window.getByRole('button', { name: 'Disable Motion' });
    const distanceInput        = window.getByLabel('Move Distance (mm)');
    const speedInput           = window.getByLabel('Move Speed (mm/s)');

    await window.waitForTimeout(500);

    // ── 1. Unit correctness at rest ────────────────────────────────────
    const pos0         = await getPosition(posContainer);
    const setpt0       = await getSetpoint(setpointContainer);
    const force0       = await getMachineForce(forceContainer);
    const samplePos0   = await getSamplePosition(samplePosContainer);
    const sampleForce0 = await getSampleForce(sampleForceContainer);

    for (const [name, v] of Object.entries({ pos0, setpt0, force0, samplePos0, sampleForce0 })) {
      expect(v, `${name} must be finite`).not.toBeNull();
      expect(Number.isFinite(v!), `${name} finite`).toBe(true);
    }
    expect(Math.abs(pos0!), 'machinePosition in mm range').toBeLessThan(300);
    expect(Math.abs(setpt0!), 'machineSetpoint in mm range').toBeLessThan(300);
    expect(Math.abs(force0!), 'machineForce in N range').toBeLessThan(100);
    expect(Math.abs(samplePos0!), 'samplePosition in mm range').toBeLessThan(300);
    expect(Math.abs(sampleForce0!), 'sampleForce in N range').toBeLessThan(100);

    // ── 2. Motion prevented when disabled ──────────────────────────────
    await expect(enableBtn).toBeVisible({ timeout: 5000 });
    const initialPos = await getPosition(posContainer);
    await window.getByRole('button', { name: 'Move Up' }).click();
    await window.waitForTimeout(2000);
    const afterDisabledMove = await getPosition(posContainer);
    expect(
      Math.abs(afterDisabledMove! - initialPos!),
      'no motion when disabled',
    ).toBeLessThan(0.5);

    // ── 3. Enable motion ────────────────────────────────────────────────
    await enableBtn.click();
    await expect(disableBtn).toBeVisible({ timeout: 5000 });
    await expect(window.getByText('Enabled')).toBeVisible({ timeout: 5000 });

    // ── 4. Bounded jogs in both directions track setpoint in mm scale ──
    const runBoundedMove = async (
      buttonName: 'Move Up' | 'Move Down',
      expectedDistanceMm: number,
      speedMmPerSec: number,
    ): Promise<{ posDelta: number; setDelta: number; endPos: number; endSet: number }> => {
      const sign = buttonName === 'Move Up' ? 1 : -1;
      const startPos = (await getPosition(posContainer))!;
      const startSet = (await getSetpoint(setpointContainer))!;

      await distanceInput.fill(String(expectedDistanceMm));
      await speedInput.fill(String(speedMmPerSec));
      await window.getByRole('button', { name: buttonName }).click();

      let endPos = startPos;
      let endSet = startSet;
      await expect(async () => {
        endPos = (await getPosition(posContainer))!;
        endSet = (await getSetpoint(setpointContainer))!;
        expect(Math.abs(sign * (endPos - startPos) - expectedDistanceMm)).toBeLessThan(0.2);
        expect(Math.abs(sign * (endSet - startSet) - expectedDistanceMm)).toBeLessThan(0.2);
      }).toPass({ timeout: 15000 });

      return { posDelta: sign * (endPos - startPos), setDelta: sign * (endSet - startSet), endPos, endSet };
    };

    const beforeMovePos = (await getPosition(posContainer))!;
    const firstDir: 'Move Up' | 'Move Down' = beforeMovePos > 30 ? 'Move Down' : 'Move Up';
    const secondDir = firstDir === 'Move Down' ? 'Move Up' : 'Move Down';

    const moveA = await runBoundedMove(firstDir, 5, 20);
    expect(Math.abs(moveA.endPos - moveA.endSet), 'pos+set agree after first move').toBeLessThan(0.2);

    const moveB = await runBoundedMove(secondDir, 10, 20);
    expect(Math.abs(moveB.endPos - moveB.endSet), 'pos+set agree after second move').toBeLessThan(0.2);

    // ── 5. Round trip returns near start ────────────────────────────────
    const roundTripStart = (await getPosition(posContainer))!;
    await runBoundedMove('Move Up', 4, 20);
    await runBoundedMove('Move Down', 4, 20);
    const roundTripEnd = (await getPosition(posContainer))!;
    expect(Math.abs(roundTripEnd - roundTripStart), 'round trip returns to start').toBeLessThan(2);

    // ── 6. Force stays in N range during motion ─────────────────────────
    const force = (await getMachineForce(forceContainer))!;
    expect(Math.abs(force), 'machineForce stays in N range during motion').toBeLessThan(100);

    // ── 7. Sequential small moves accumulate in mm scale ────────────────
    const seqStart = (await getPosition(posContainer))!;
    await runBoundedMove('Move Up', 2, 20);
    await runBoundedMove('Move Up', 2, 20);
    await runBoundedMove('Move Up', 2, 20);
    const seqEnd = (await getPosition(posContainer))!;
    expect(seqEnd - seqStart, 'three 2mm moves = ~6mm total').toBeGreaterThan(4);
    expect(seqEnd - seqStart, 'three 2mm moves not wildly scaled').toBeLessThan(8);

    // ── 8. Input fields retain values after move ────────────────────────
    await distanceInput.fill('7');
    await speedInput.fill('15');
    await window.getByRole('button', { name: 'Move Up' }).click();
    await window.waitForTimeout(2000);
    await expect(distanceInput).toHaveValue('7');
    await expect(speedInput).toHaveValue('15');

    // ── 9. Settled jog: machine + sample within 0.12 mm of setpoint ────
    //     Regression for async stepper encoder drift (~1 mm lag).
    await window.getByRole('button', { name: 'Zero Length' }).click();
    await window.waitForTimeout(800);

    const m0 = (await getPosition(posContainer))!;
    const s0 = (await getSetpoint(setpointContainer))!;
    const sample0 = (await getSamplePosition(samplePosContainer))!;

    const jogMm = 10;
    await distanceInput.fill(String(jogMm));
    await speedInput.fill('25');
    // Choose direction that keeps us in bounds.
    const settledDir: 'Move Up' | 'Move Down' = m0 > 30 ? 'Move Down' : 'Move Up';
    const settledSign = settledDir === 'Move Up' ? 1 : -1;
    await window.getByRole('button', { name: settledDir }).click();

    await expect(async () => {
      const p = (await getPosition(posContainer))!;
      const s = (await getSetpoint(setpointContainer))!;
      const samp = (await getSamplePosition(samplePosContainer))!;
      expect(Math.abs(p - s)).toBeLessThan(0.12);
      expect(Math.abs(p - m0 - settledSign * jogMm)).toBeLessThan(0.12);
      expect(Math.abs(s - s0 - settledSign * jogMm)).toBeLessThan(0.12);
      expect(Math.abs(samp - sample0 - settledSign * jogMm)).toBeLessThan(0.12);
    }).toPass({ timeout: 25_000 });

    // ── 10. Zero Force returns sample force near 0 ──────────────────────
    await window.getByRole('button', { name: 'Zero Force' }).click();
    await expect(async () => {
      const f = await getSampleForce(sampleForceContainer);
      expect(f).not.toBeNull();
      expect(Math.abs(f!)).toBeLessThan(1);
    }).toPass({ timeout: 3000 });

    // ── 11. Zero Length: move sample then zero ──────────────────────────
    await distanceInput.fill('5');
    await speedInput.fill('20');
    await window.getByRole('button', { name: 'Move Up' }).click();
    await window.waitForTimeout(2000);

    const posBefore = (await getSamplePosition(samplePosContainer))!;
    expect(Math.abs(posBefore), 'sample position non-zero before zero').toBeGreaterThan(2);
    expect(Math.abs(posBefore), 'sample position in mm').toBeLessThan(300);

    await window.getByRole('button', { name: 'Zero Length' }).click();
    await expect(async () => {
      const p = await getSamplePosition(samplePosContainer);
      expect(p).not.toBeNull();
      expect(Math.abs(p!)).toBeLessThan(1);
    }).toPass({ timeout: 5000 });

    // ── 12. Homing and post-home motion ─────────────────────────────────
    await window.getByRole('button', { name: 'Home' }).click();
    await window.waitForTimeout(3000);
    await expect(window.getByRole('button', { name: 'Home' })).toBeEnabled();
    await expect(disableBtn).toBeVisible();

    const postHomeStart = (await getPosition(posContainer))!;
    await distanceInput.fill('2');
    await speedInput.fill('10');
    const postHomeDir: 'Move Up' | 'Move Down' = postHomeStart > 30 ? 'Move Down' : 'Move Up';
    await window.getByRole('button', { name: postHomeDir }).click();
    await window.waitForTimeout(1500);
    const postHomeEnd = (await getPosition(posContainer))!;
    expect(Math.abs(postHomeEnd - postHomeStart), 'post-home motion is accepted').toBeGreaterThan(0.5);

    // ── 13. Disable mid-move stops motion ───────────────────────────────
    const moveStart = (await getPosition(posContainer))!;
    await distanceInput.fill('50');
    await speedInput.fill('5');
    await window.getByRole('button', { name: 'Move Up' }).click();
    await window.waitForTimeout(500);
    await disableBtn.click();
    await expect(enableBtn).toBeVisible({ timeout: 5000 });

    const stoppedPos = (await getPosition(posContainer))!;
    await window.waitForTimeout(1000);
    const laterPos = (await getPosition(posContainer))!;
    expect(Math.abs(laterPos - stoppedPos), 'motion stopped after disable').toBeLessThan(0.5);
    expect(stoppedPos - moveStart, 'did not travel full 50mm').toBeLessThan(45);
  });
});
