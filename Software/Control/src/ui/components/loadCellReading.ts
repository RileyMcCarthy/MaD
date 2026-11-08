import { useStore } from '@/store/useStore';
import { liveClockSeconds, liveSamplesSince } from '@/store/liveBuffer';
import { ZERO_READ_MS } from '@/domain/forceZero';

/**
 * What the load cell calibration steps share: one read window, one refusal,
 * one way of writing a force. Kept together so the zero and sensitivity steps
 * cannot drift apart.
 */

export function num(v: number, digits: number): string {
  return Number(v.toFixed(digits)).toString();
}

/** Newtons to the precision the firmware reports (1 mN), in mN below 1 N. */
export function forceText(n: number): string {
  return Math.abs(n) < 1 ? `${num(n * 1000, 1)} mN` : `${num(n, 3)} N`;
}

export const TEST_RUNNING_REASON = 'Not read: a test is running.';

/**
 * The machine's raw load cell force over the next ZERO_READ_MS, oldest first,
 * or why it was not read.
 */
export async function readMachineForces(): Promise<{ ok: true; forcesN: number[] } | { ok: false; reason: string }> {
  if (useStore.getState().machineState?.testRunning) return { ok: false, reason: TEST_RUNNING_REASON };
  const t0 = liveClockSeconds();
  await new Promise<void>((resolve) => setTimeout(resolve, ZERO_READ_MS));
  return { ok: true, forcesN: liveSamplesSince(t0).map((s) => s.machineForce) };
}
