/**
 * The e2e harness's "turn motion on" step (fixtures.mjs, enableMotion)
 * against a model of the Live screen and the machine behind it.
 *
 * The model is the app's own rules: the motion button's label comes from
 * src/domain/motionControl.ts, the badge reads the machine's reported
 * state, and the app hears that state once a second (the protocol's state
 * period, MaDProtocol.yaml). The machine refuses an enable while it is
 * faulted, and reports motion on only when it holds an enable request and
 * has no fault. Time is the page's and moves only while the harness waits,
 * in Playwright-sized polls, so a run is exact and instant.
 *
 * The boot case is the nightly's: a board that has just booted answers with
 * a fault for about 100 ms of board time (COG, then
 * FORCE_GAUGE_COMMUNICATION), the app's first state read lands there when
 * it connects early enough, and Live shows "Disable motion" until the next
 * read a second later.
 */
import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { motionButton } from '@/domain/motionControl';
import { FaultedReason, RestrictedReason, type MachineState } from '@/domain/types';
import { enableMotion } from './fixtures.mjs';

/** The app reads the machine's state once a second. */
const STATE_PERIOD_MS = 1000;
/** How often a waiting locator looks again (Playwright polls at about this). */
const POLL_MS = 100;
/** The harness's device budget (fixtures.mjs, DEVICE_WAIT_MS). */
const DEVICE_WAIT_MS = 20_000;

interface Request {
  atMs: number;
  enable: boolean;
}

/** The machine: its fault as a function of time, and the requests it took. */
class Machine {
  requested: boolean;
  readonly requests: Request[] = [];

  constructor(
    private readonly faultAt: (ms: number) => FaultedReason,
    motionOn: boolean,
  ) {
    this.requested = motionOn;
  }

  state(ms: number): MachineState {
    const faultedReason = this.faultAt(ms);
    return {
      faultedReason,
      restrictedReason: RestrictedReason.NONE,
      testRunning: false,
      motionEnabled: this.requested && faultedReason === FaultedReason.NONE,
    };
  }

  request(enable: boolean, ms: number): void {
    this.requests.push({ atMs: ms, enable });
    // A faulted machine refuses every enable; a disable is always taken.
    if (enable && this.faultAt(ms) !== FaultedReason.NONE) return;
    this.requested = enable;
  }
}

interface Element {
  role: 'button' | 'text';
  text: string;
  enabled: boolean;
  click?: () => void;
}

/** Live as the app renders it from the last state it read. */
class LivePage {
  now: number;

  constructor(
    readonly machine: Machine,
    /** When the app's first state read was answered, in page time. */
    private readonly firstReadMs: number,
    /** When the harness first looks at Live. */
    startMs: number,
  ) {
    this.now = startMs;
  }

  private shown(): MachineState | null {
    if (this.now < this.firstReadMs) return null;
    const reads = Math.floor((this.now - this.firstReadMs) / STATE_PERIOD_MS);
    return this.machine.state(this.firstReadMs + reads * STATE_PERIOD_MS);
  }

  elements(): Element[] {
    const state = this.shown();
    const motion = state ? motionButton(state) : null;
    return [
      { role: 'text', text: `Motion: ${state ? (state.motionEnabled ? 'enabled' : 'disabled') : '—'}`, enabled: true },
      { role: 'text', text: `Fault: ${state ? FaultedReason[state.faultedReason] : '—'}`, enabled: true },
      {
        role: 'button',
        text: motion ? motion.label : 'Motion …',
        enabled: motion !== null,
        click: () => {
          if (motion) this.machine.request(motion.enable, this.now);
        },
      },
    ];
  }

  // The Playwright surface the step and press() use.
  getByRole(role: 'button', { name }: { name: string }): FakeLocator {
    return new FakeLocator(this, (el) => el.role === role && el.text.toLowerCase().includes(name.toLowerCase()), `getByRole('${role}', { name: '${name}' })`);
  }

  getByText(text: string): FakeLocator {
    return new FakeLocator(this, (el) => el.text.toLowerCase().includes(text.toLowerCase()), `getByText('${text}')`);
  }

  /** press() reads the page clock this way (fixtures.mjs, pageNow). */
  async evaluate(): Promise<{ doc: number; now: number }> {
    return { doc: 0, now: this.now };
  }

  isClosed(): boolean {
    return false;
  }
}

class FakeLocator {
  constructor(
    private readonly owner: LivePage,
    readonly matches: (el: Element) => boolean,
    private readonly description: string,
  ) {}

  page(): LivePage {
    return this.owner;
  }

  or(other: FakeLocator): FakeLocator {
    return new FakeLocator(this.owner, (el) => this.matches(el) || other.matches(el), `${this.description}.or(${other.description})`);
  }

  first(): FakeLocator {
    return this;
  }

  async count(): Promise<number> {
    return this.owner.elements().filter(this.matches).length;
  }

  async waitFor({ state = 'visible', timeout = 30_000 }: { state?: string; timeout?: number } = {}): Promise<void> {
    const start = this.owner.now;
    for (;;) {
      const n = await this.count();
      if (state === 'hidden' || state === 'detached' ? n === 0 : n > 0) return;
      if (this.owner.now - start >= timeout) {
        throw new Error(`${this.description} was not ${state} within ${timeout} ms of page time`);
      }
      this.owner.now += POLL_MS;
    }
  }

  /** An action resolves to exactly one element, as Playwright's strict mode demands. */
  private one(): Element {
    const found = this.owner.elements().filter(this.matches);
    if (found.length !== 1) throw new Error(`${this.description} resolved to ${found.length} elements`);
    return found[0]!;
  }

  async isEnabled(): Promise<boolean> {
    return this.one().enabled;
  }

  /** press() asks whether a click at the element's centre lands on it: it does. */
  async evaluate(): Promise<string> {
    this.one();
    return '';
  }

  async click(): Promise<void> {
    this.one().click?.();
  }

  toString(): string {
    return this.description;
  }
}

/** A board that has just booted: COG, then the gauge's fault, clear after 100 ms. */
function bootFault(ms: number): FaultedReason {
  if (ms < 70) return FaultedReason.COG;
  if (ms < 100) return FaultedReason.FORCE_GAUGE_COMMUNICATION;
  return FaultedReason.NONE;
}

describe('the e2e harness turning motion on', () => {
  behaviour(
    {
      id: 'e2e.enable-motion-after-boot-fault',
      covers: 'e2e/fixtures.mjs#enableMotion',
      given:
        'the e2e harness turns motion on for a machine that has just booted, whose first state the app reads carries the boot fault and whose next, a second later, is clear',
      expect: {
        'motion-on': 'the machine ends with motion on',
        'asked-once-after-clear': 'the harness asks the machine once, to turn motion on, after the fault has cleared',
      },
      why: {
        'asked-once-after-clear':
          'Live offers a faulted machine only "Disable motion", so "Enable motion" appears with the first clear state',
      },
    },
    async () => {
      // The app's first read answered 24 ms after the boot line; the harness
      // reaches Live about 600 ms later, as in the nightly's logs.
      const machine = new Machine(bootFault, false);
      const page = new LivePage(machine, 24, 624);
      expect(await page.getByText('Motion: disabled').count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Disable motion' }).count()).toBe(1);

      await enableMotion(page);

      expect(machine.state(page.now).motionEnabled).toBe(true);
      expect(await page.getByText('Motion: enabled').count()).toBe(1);
      expect(machine.requests).toHaveLength(1);
      expect(machine.requests[0]!.enable).toBe(true);
      expect(machine.requests[0]!.atMs).toBeGreaterThanOrEqual(24 + STATE_PERIOD_MS);
    },
  );

  behaviour(
    {
      id: 'e2e.enable-motion-already-on',
      covers: 'e2e/fixtures.mjs#enableMotion',
      given: 'the e2e harness turns motion on for a machine that already has it on',
      expect: {
        'nothing-asked': 'the harness asks the machine nothing, and motion stays on',
      },
    },
    async () => {
      const machine = new Machine(() => FaultedReason.NONE, true);
      const page = new LivePage(machine, 24, 624);

      await enableMotion(page);

      expect(machine.requests).toHaveLength(0);
      expect(await page.getByText('Motion: enabled').count()).toBe(1);
    },
  );

  behaviour(
    {
      id: 'e2e.enable-motion-fault-never-clears',
      covers: 'e2e/fixtures.mjs#enableMotion',
      given:
        'the e2e harness turns motion on for a machine whose force gauge never answers, so every state it reports carries that fault',
      expect: {
        'gives-up-in-budget': 'the harness stops with an error once its 20 s device budget of page time has passed',
        'nothing-asked': 'the harness asks the machine nothing',
      },
    },
    async () => {
      const machine = new Machine(() => FaultedReason.FORCE_GAUGE_COMMUNICATION, false);
      const page = new LivePage(machine, 24, 624);

      await expect(enableMotion(page)).rejects.toThrow(/within 20000 ms/);
      expect(page.now - 624).toBeGreaterThanOrEqual(DEVICE_WAIT_MS);
      expect(page.now - 624).toBeLessThan(DEVICE_WAIT_MS + STATE_PERIOD_MS);
      expect(machine.requests).toHaveLength(0);
    },
  );
});
