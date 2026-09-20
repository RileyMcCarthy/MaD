import { describe, it, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { commandName, isPeriodicCommand, summariseGcode } from './commandNames';
import {
  MSG_READ_SAMPLE,
  MSG_READ_STATE,
  MSG_WRITE_TEST_RUN,
  MSG_READ_MACHINE_CONFIGURATION,
  MSG_WRITE_MOTION_ENABLE,
} from '@/protocol/generated/protoemb';

describe('commandName', () => {
  behaviour(
    {
      id: 'session.known-command-named-with-id',
      covers: 'src/device/commandNames.ts#commandName',
      given: 'a write that starts a test run',
      expect: {
        'name-with-number': 'the log shows the test-run write\'s name together with its command number',
      },
    },
    () => {
      expect(commandName(MSG_WRITE_TEST_RUN, 'write')).toBe(`WRITE_TEST_RUN(${MSG_WRITE_TEST_RUN})`);
    },
  );

  behaviour(
    {
      id: 'session.unknown-command-keeps-the-number',
      covers: 'src/device/commandNames.ts#commandName',
      given: 'a command number the protocol does not define',
      expect: {
        'number-kept': 'the log entry still shows that number, under a generic command label',
      },
    },
    () => {
      expect(commandName(9999, 'write')).toBe('cmd(9999)');
    },
  );

  behaviour(
    {
      id: 'session.shared-command-named-by-direction',
      covers: 'src/device/commandNames.ts#commandName',
      given: 'a command number shared by a configuration read and a test-run write, one in each direction',
      expect: {
        'read-name': 'reading that number logs the configuration-read name',
        'write-name': 'writing that number logs the test-run name',
      },
      why: {
        'read-name': 'reads and writes share the same numbers, so the direction is what makes the log name true',
        'write-name': 'reads and writes share the same numbers, so the direction is what makes the log name true',
      },
    },
    () => {
      // Reads and writes share the id space, so a single map would mislabel half
      // the traffic — command 2 is READ_MACHINE_CONFIGURATION *and* WRITE_TEST_RUN.
      expect(MSG_READ_MACHINE_CONFIGURATION).toBe(MSG_WRITE_TEST_RUN);
      expect(commandName(MSG_READ_MACHINE_CONFIGURATION, 'read')).toBe('READ_MACHINE_CONFIGURATION(2)');
      expect(commandName(MSG_WRITE_TEST_RUN, 'write')).toBe('WRITE_TEST_RUN(2)');
    },
  );

  behaviour(
    {
      id: 'session.ambiguous-command-shows-both-names',
      covers: 'src/device/commandNames.ts#commandName',
      given: 'a command number that is both a state read and a motion-enable write, with no direction given',
      expect: {
        'both-names-joined': 'the log shows both names joined, with the command number',
      },
      why: {
        'both-names-joined': 'when direction is unknown the log must keep both names so a reader can tell them apart',
      },
    },
    () => {
      expect(commandName(MSG_READ_STATE)).toBe('READ_STATE|WRITE_MOTION_ENABLE(1)');
      expect(MSG_READ_STATE).toBe(MSG_WRITE_MOTION_ENABLE);
    },
  );

  behaviour(
    {
      id: 'session.one-sided-command-single-name',
      covers: 'src/device/commandNames.ts#commandName',
      given: 'a command number used only to write a waveform, with no direction given',
      expect: {
        'single-name': 'the log shows just that one waveform-write name with its command number',
      },
    },
    () => {
      expect(commandName(8)).toBe('WRITE_TEST_WAVEFORM(8)');
    },
  );

  /* claimed by session.shared-command-named-by-direction */
  it('never returns a read name for a write direction', () => {
    expect(commandName(MSG_READ_SAMPLE, 'write')).toBe('WRITE_MACHINE_CONFIGURATION(0)');
    expect(commandName(MSG_READ_SAMPLE, 'read')).toBe('READ_SAMPLE(0)');
  });
});

describe('isPeriodicCommand', () => {
  behaviour(
    {
      id: 'session.periodic-reads-are-sample-and-state',
      covers: 'src/device/commandNames.ts#isPeriodicCommand',
      given: 'the live-sample read, the machine-state read, and a write that starts a test run',
      expect: {
        'reads-high-rate': 'the two reads are treated as high-rate',
        'write-one-time': 'the write is treated as one-time',
      },
      why: {
        'reads-high-rate': 'the live sample and state arrive many times a second, so the log aggregates them',
      },
    },
    () => {
      expect(isPeriodicCommand(MSG_READ_SAMPLE)).toBe(true);
      expect(isPeriodicCommand(MSG_READ_STATE)).toBe(true);
      expect(isPeriodicCommand(MSG_WRITE_TEST_RUN)).toBe(false);
    },
  );
});

describe('summariseGcode', () => {
  behaviour(
    {
      id: 'session.gcode-summary-counts-commands',
      covers: 'src/device/commandNames.ts#summariseGcode',
      given: 'a four-line program of absolute mode, two feed moves, and G122',
      expect: {
        'line-count': 'the summary reports four lines',
        'opcode-counts': 'the summary counts two feed moves and one of each other command',
        'ends-with-g122': 'the summary reports the program as ending with G122',
      },
    },
    () => {
      const s = summariseGcode(['G90', 'G1 X10 F100', 'G1 X0 F100', 'G122']);
      expect(s.lines).toBe(4);
      expect(s.opcodes).toEqual({ G90: 1, G1: 2, G122: 1 });
      expect(s.endsWithG122).toBe(true);
    },
  );

  behaviour(
    {
      id: 'session.program-without-trailing-g122',
      covers: 'src/device/commandNames.ts#summariseGcode',
      given: 'a program of absolute mode and a feed move with no G122 at the end',
      expect: {
        'missing-g122-flagged': 'the summary flags the program as ending without G122',
      },
      why: {
        'missing-g122-flagged': 'the firmware waits on G122 to know the run is complete',
      },
    },
    () => {
      expect(summariseGcode(['G90', 'G1 X10 F100']).endsWithG122).toBe(false);
    },
  );

  behaviour(
    {
      id: 'session.gcode-hash-is-content',
      covers: 'src/device/commandNames.ts#summariseGcode',
      given: 'two identical one-move programs and a third that differs by one millimetre',
      expect: {
        'identical-share-hash': 'the identical programs share a hash',
        'changed-hashes-differently': 'the third program hashes differently',
        'eight-characters': 'the hash is eight hexadecimal characters',
      },
      why: {
        'identical-share-hash': 'two uploads of the same profile must fingerprint the same',
        'changed-hashes-differently': 'a changed program must be visible in the log',
      },
    },
    () => {
      const a = summariseGcode(['G1 X10 F100']);
      const b = summariseGcode(['G1 X10 F100']);
      const c = summariseGcode(['G1 X11 F100']);
      expect(a.hash).toBe(b.hash);
      expect(a.hash).not.toBe(c.hash);
      expect(a.hash).toMatch(/^[0-9a-f]{8}$/);
    },
  );

  behaviour(
    {
      id: 'session.gcode-opcodes-ignore-case-and-padding',
      covers: 'src/device/commandNames.ts#summariseGcode',
      given: 'a lowercase feed-move line with leading spaces, followed by an M5',
      expect: {
        'counted-uppercase-and-trimmed': 'the summary counts one G1 and one M5',
      },
    },
    () => {
      expect(summariseGcode(['  g1 X1', 'M5']).opcodes).toEqual({ G1: 1, M5: 1 });
    },
  );

  behaviour(
    {
      id: 'session.empty-gcode-summarises',
      covers: 'src/device/commandNames.ts#summariseGcode',
      given: 'a program with no lines',
      expect: {
        'empty-counts': 'the summary reports zero lines and no counted commands',
        'no-g122-end': 'the summary marks the program as ending without G122',
      },
    },
    () => {
      const s = summariseGcode([]);
      expect(s.lines).toBe(0);
      expect(s.opcodes).toEqual({});
      expect(s.endsWithG122).toBe(false);
    },
  );

  behaviour(
    {
      id: 'session.gcode-coordinate-only-lines-uncounted',
      covers: 'src/device/commandNames.ts#summariseGcode',
      given: 'a coordinate-only line followed by a feed move',
      expect: {
        'coordinate-line-uncounted': 'the summary counts one G1 and nothing for the coordinate line',
      },
    },
    () => {
      expect(summariseGcode(['X10 Y20', 'G1 X1']).opcodes).toEqual({ G1: 1 });
    },
  );
});
