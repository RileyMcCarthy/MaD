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
      then: 'a write that starts a test run is logged as WRITE_TEST_RUN with its command number shown',
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
      then: 'an unknown command number is logged with the number still visible',
    },
    () => {
      expect(commandName(9999, 'write')).toBe('cmd(9999)');
    },
  );

  behaviour(
    {
      id: 'session.shared-command-named-by-direction',
      covers: 'src/device/commandNames.ts#commandName',
      given: 'a command number that is a configuration read in one direction and a test-run write in the other',
      then: 'a command number shared by a configuration read and a test-run write is named by the direction of the traffic',
      why: 'reads and writes share the same numbers, so the direction is what makes the log name true',
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
      then: 'a command number that is both a state read and a motion-enable write is logged with both names when direction is unknown',
      why: 'when direction is unknown the log must keep both names so a reader can tell them apart',
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
      then: 'a command number used only to write a waveform is logged under that one name when direction is unknown',
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
      then: 'the live-sample read and the machine-state read are the high-rate commands, and a write that starts a test run is a one-time command',
      why: 'the live sample and state arrive many times a second, so the log aggregates them',
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
      then: 'a four-line program of absolute mode, two feed moves, and G122 is summarised as four lines, those three command kinds, and ending with G122',
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
      then: 'a program of absolute mode and a feed move that does not end with G122 is reported as not ending with G122',
      why: 'the firmware waits on G122 to know the run is complete',
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
      then: 'two identical G-code programs share an eight-character content hash, and a program that differs by one millimetre of travel has a different hash',
      why: 'two uploads of the same profile must fingerprint the same, so a changed program is visible in the log',
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
      then: 'a lowercase feed-move with leading spaces is counted as G1, and an M5 is counted as M5',
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
      then: 'an empty program is summarised as zero lines, no commands, and not ending with G122',
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
      then: 'a line of bare coordinates next to a feed move is omitted from the command counts, and the feed move is counted as G1',
    },
    () => {
      expect(summariseGcode(['X10 Y20', 'G1 X1']).opcodes).toEqual({ G1: 1 });
    },
  );
});
