// @vitest-environment jsdom
/**
 * The Load cell calibration steps wired into the Machine configuration
 * screen: what a reading is measured against, what is refused, and what
 * reaches the profile being edited. The live samples and the device client
 * are stood in with `vi.mock`; each read's 3 s window runs on fake timers.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import type { MachineConfiguration } from '@/domain';
import type { LiveSample } from '@/store/liveBuffer';
import { STANDARD_GRAVITY } from '@/domain/forceSensitivity';
import { ZERO_READ_MS } from '@/domain/forceZero';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the load cell reads during the next read window. */
const live = vi.hoisted(() => ({ forces: [] as number[] }));

vi.mock('@/store/liveBuffer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/liveBuffer')>()),
  liveClockSeconds: () => 0,
  liveSamplesSince: (): LiveSample[] =>
    live.forces.map((machineForce, i) => ({
      t: i * 0.013,
      machineForce,
      machinePosition: 0,
      machineSetpoint: 0,
      machineCommanded: 0,
      sampleForce: machineForce,
      samplePosition: 0,
    })),
}));
vi.mock('@/device/session', () => ({ DEFAULT_BAUD_RATE: 2_000_000, deviceClient: {} }));
vi.mock('@/storage/DataStore', () => ({ dataStore: {} }));

const { useStore } = await import('@/store/useStore');
const { default: Config } = await import('./Config');

/** A load cell saved as 100 N at 2 mV/V. */
const CONFIG = {
  Name: 'Bench',
  'Encoder (step/mm)': 2400,
  'Servo (step/mm)': 6400,
  'Load Cell Capacity (N)': 100,
  'Load Cell Sensitivity (mV/V)': 2,
  'Load Cell Zero Balance (mV/V)': 0.01,
  'Position Max (mm)': 100,
  'Velocity Max (mm/s)': 5,
  'Acceleration Max (mm/s^2)': 50,
  'Tensile Force Max (N)': 90,
  'Homing Velocity (mm/s)': 2,
  'Homing Offset (mm)': 0,
  'Jaw Offset (mm)': 0,
  'Restricted Velocity (mm/s)': 1,
  'Servo Kp (1/s)': 10,
  'Servo Ki (1/s^2)': 0,
  'Drive Enable Active Low': true,
} as unknown as MachineConfiguration;

/** 100 steady readings around `meanN`, 1 mN either side. */
function steady(meanN: number): number[] {
  return Array.from({ length: 100 }, (_, i) => meanN + (i % 2 === 0 ? 0.001 : -0.001));
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const field = (label: string) =>
  [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))?.querySelector('input') as HTMLInputElement;

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Press a read button with the load cell reading `forces`, and let the read window run out. */
async function readWith(text: string, forces: number[]) {
  live.forces = forces;
  await act(async () => {
    button(text).click();
    await vi.advanceTimersByTimeAsync(ZERO_READ_MS);
  });
}

describe('load cell calibration on the configuration screen', () => {
  let root: Root | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({
      connection: 'connected',
      config: CONFIG,
      refreshConfig: async () => {},
      machineState: { motionEnabled: false, testRunning: false } as never,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(Config, { embedded: true })));
  });
  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  behaviour(
    {
      id: 'ui.load-cell-zero-into-profile',
      covers: 'src/ui/screens/Config.tsx#Config',
      given: 'a load cell reading a steady 0.5 N with nothing on it, zeroed from the Load cell calibration panel',
      expect: {
        'into-profile': 'pressing Use this zero puts the zero balance it read into Load Cell Zero Balance in Machine configuration',
      },
    },
    async () => {
      await readWith('Read zero', steady(0.5));
      act(() => button('Use this zero').click());
      // 0.01 mV/V saved, plus 0.5 N at 2 mV/V per 100 N.
      expect(Number(field('Load Cell Zero Balance').value)).toBeCloseTo(0.02, 9);
    },
  );

  behaviour(
    {
      id: 'ui.load-cell-sensitivity-into-profile',
      covers: 'src/ui/screens/Config.tsx#Config',
      given:
        'a 5 kg weight read 50 N above a 0.3 N unloaded reading, then a 2 kg weight read after the unloaded reading was taken again at 0.5 N',
      expect: {
        'latest-unloaded': 'each weight is measured from the unloaded reading taken most recently before it',
        'into-profile':
          'pressing Use this sensitivity puts the fitted sensitivity into Load Cell Sensitivity in Machine configuration',
      },
    },
    async () => {
      const scale = 50 / (5 * STANDARD_GRAVITY);
      await readWith('1. Read unloaded', steady(0.3));
      type(field('Mass (kg)'), '5');
      await readWith('2. Read with weight', steady(50.3));
      await readWith('Read unloaded again', steady(0.5));
      type(field('Mass (kg)'), '2');
      await readWith('2. Read with weight', steady(0.5 + 2 * STANDARD_GRAVITY * scale));

      const read = [...document.querySelectorAll('[data-testid="sensitivity-result"] tbody tr')].map((r) =>
        Number(r.children[2].textContent),
      );
      expect(read[0]).toBeCloseTo(50, 3);
      expect(read[1]).toBeCloseTo(2 * STANDARD_GRAVITY * scale, 3);

      act(() => button('Use this sensitivity').click());
      expect(Number(field('Load Cell Sensitivity').value)).toBeCloseTo(2 * scale, 6);
    },
  );

  behaviour(
    {
      id: 'ui.load-cell-sensitivity-swinging',
      covers: 'src/ui/components/LoadCellSensitivityPanel.tsx#LoadCellSensitivityPanel',
      given: 'a 5 kg weight whose reading is still creeping upward while it is read',
      expect: {
        'row-flagged': "the weight's row is marked as swinging",
        'warned': 'the result says a weight was still moving, and to read it again once it settles',
      },
    },
    async () => {
      await readWith('1. Read unloaded', steady(0));
      type(field('Mass (kg)'), '5');
      await readWith(
        '2. Read with weight',
        Array.from({ length: 99 }, (_, i) => 49 + i * 0.01),
      );
      const result = byTestId('sensitivity-result')?.textContent ?? '';
      expect(byTestId('sensitivity-result')?.querySelector('tbody .badge')?.textContent).toBe('swinging');
      expect(result).toContain('A weight was still moving while it was read');
    },
  );

  behaviour(
    {
      id: 'ui.load-cell-sensitivity-test-running',
      covers: 'src/ui/components/LoadCellSensitivityPanel.tsx#LoadCellSensitivityPanel',
      given: 'a test running on the machine when the unloaded reading is asked for',
      expect: {
        'refused': 'nothing is read, and the panel says a test is running',
        'no-weight-step': 'reading a weight stays unavailable',
      },
    },
    async () => {
      act(() => useStore.setState({ machineState: { motionEnabled: false, testRunning: true } as never }));
      await readWith('1. Read unloaded', steady(0));
      expect(document.body.textContent).toContain('Not read: a test is running.');
      type(field('Mass (kg)'), '5');
      expect(button('2. Read with weight').disabled).toBe(true);
    },
  );

  behaviour(
    {
      id: 'ui.load-cell-sensitivity-cleared',
      covers: 'src/ui/components/LoadCellSensitivityPanel.tsx#LoadCellSensitivityPanel',
      given: 'a weight already read, and then the load cell values saved on the machine change',
      expect: {
        'points-cleared': 'the weights read so far are cleared',
        'unloaded-cleared': 'the unloaded reading has to be taken again',
      },
      why: { 'points-cleared': 'readings are only comparable on the load cell values they were taken with' },
    },
    async () => {
      await readWith('1. Read unloaded', steady(0));
      type(field('Mass (kg)'), '5');
      await readWith('2. Read with weight', steady(50));
      expect(byTestId('sensitivity-result')).not.toBeNull();
      act(() =>
        useStore.setState({ config: { ...CONFIG, 'Load Cell Sensitivity (mV/V)': 2.04 } as MachineConfiguration }),
      );
      expect(byTestId('sensitivity-result')).toBeNull();
      expect(button('1. Read unloaded')).toBeDefined();
    },
  );
});
