import { describe, it, expect } from 'vitest';
import { commandName, isPeriodicCommand, summariseGcode } from './commandNames';
import {
  MSG_READ_SAMPLE,
  MSG_READ_STATE,
  MSG_WRITE_TEST_RUN,
  MSG_READ_MACHINE_CONFIGURATION,
  MSG_WRITE_MOTION_ENABLE,
} from '@/protocol/generated/protoemb';

describe('commandName', () => {
  it('names a known command and keeps the id visible', () => {
    expect(commandName(MSG_WRITE_TEST_RUN, 'write')).toBe(`WRITE_TEST_RUN(${MSG_WRITE_TEST_RUN})`);
  });

  it('degrades to a readable placeholder for an unmapped id', () => {
    expect(commandName(9999, 'write')).toBe('cmd(9999)');
  });

  it('resolves ids that exist on BOTH sides by direction', () => {
    // Reads and writes share the id space, so a single map would mislabel half
    // the traffic — command 2 is READ_MACHINE_CONFIGURATION *and* WRITE_TEST_RUN.
    expect(MSG_READ_MACHINE_CONFIGURATION).toBe(MSG_WRITE_TEST_RUN);
    expect(commandName(MSG_READ_MACHINE_CONFIGURATION, 'read')).toBe('READ_MACHINE_CONFIGURATION(2)');
    expect(commandName(MSG_WRITE_TEST_RUN, 'write')).toBe('WRITE_TEST_RUN(2)');
  });

  it('shows the ambiguity rather than guessing when direction is unknown', () => {
    // A confidently wrong name is worse in a bug report than a hedged one.
    expect(commandName(MSG_READ_STATE)).toBe('READ_STATE|WRITE_MOTION_ENABLE(1)');
    expect(MSG_READ_STATE).toBe(MSG_WRITE_MOTION_ENABLE);
  });

  it('does not hedge an id that exists on only one side', () => {
    expect(commandName(8)).toBe('WRITE_TEST_WAVEFORM(8)');
  });

  it('never returns a read name for a write direction', () => {
    expect(commandName(MSG_READ_SAMPLE, 'write')).toBe('WRITE_MACHINE_CONFIGURATION(0)');
    expect(commandName(MSG_READ_SAMPLE, 'read')).toBe('READ_SAMPLE(0)');
  });
});

describe('isPeriodicCommand', () => {
  it('covers exactly the two high-rate reads', () => {
    expect(isPeriodicCommand(MSG_READ_SAMPLE)).toBe(true);
    expect(isPeriodicCommand(MSG_READ_STATE)).toBe(true);
    expect(isPeriodicCommand(MSG_WRITE_TEST_RUN)).toBe(false);
  });
});

describe('summariseGcode', () => {
  it('counts lines, bytes and opcodes', () => {
    const s = summariseGcode(['G90', 'G1 X10 F100', 'G1 X0 F100', 'G122']);
    expect(s.lines).toBe(4);
    expect(s.opcodes).toEqual({ G90: 1, G1: 2, G122: 1 });
    expect(s.endsWithG122).toBe(true);
  });

  it('flags a program missing its terminating G122', () => {
    // The firmware contract requires G122 to signal completion; a program
    // without it hangs the run, so this is the check worth having.
    expect(summariseGcode(['G90', 'G1 X10 F100']).endsWithG122).toBe(false);
  });

  it('hashes content, not identity', () => {
    const a = summariseGcode(['G1 X10 F100']);
    const b = summariseGcode(['G1 X10 F100']);
    const c = summariseGcode(['G1 X11 F100']);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is case-insensitive about opcodes and tolerates leading whitespace', () => {
    expect(summariseGcode(['  g1 X1', 'M5']).opcodes).toEqual({ G1: 1, M5: 1 });
  });

  it('handles an empty program without throwing', () => {
    const s = summariseGcode([]);
    expect(s.lines).toBe(0);
    expect(s.opcodes).toEqual({});
    expect(s.endsWithG122).toBe(false);
  });

  it('ignores lines that carry no opcode', () => {
    expect(summariseGcode(['X10 Y20', 'G1 X1']).opcodes).toEqual({ G1: 1 });
  });
});
