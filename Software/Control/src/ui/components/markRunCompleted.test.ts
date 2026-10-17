/**
 * The completion handler TestRunner calls when the firmware reports a test has
 * finished (issue #171): a run whose record is missing must warn the operator
 * by name instead of dropping the completion silently.
 */
import { describe, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { NotificationType } from '@/domain';
import { markRunCompleted } from './markRunCompleted';

const NOW = new Date('2026-10-17T12:00:00.000Z');

describe('markRunCompleted', () => {
  behaviour(
    {
      id: 'test-runner.completion-without-record-warns',
      covers: 'src/ui/components/markRunCompleted.ts#markRunCompleted',
      given: 'the firmware finishes a test whose run record is missing from the data folder',
      expect: {
        'operator-warned-once': 'the operator is warned once, with a warning that names the test',
        'reports-not-saved': 'the handler reports that the completion was not saved',
      },
    },
    async () => {
      const updateTestRun = vi.fn(async () => false);
      const notify = vi.fn();

      const saved = await markRunCompleted({ updateTestRun }, '000042', notify, () => NOW);

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]?.[0]).toBe(NotificationType.WARN);
      expect(String(notify.mock.calls[0]?.[1])).toContain('000042');
      expect(saved).toBe(false);
    },
  );

  behaviour(
    {
      id: 'test-runner.completion-saved',
      covers: 'src/ui/components/markRunCompleted.ts#markRunCompleted',
      given: 'the firmware finishes a test whose run record exists',
      expect: {
        'marked-completed': 'the run is marked completed with the time it finished',
        'no-warning': 'the operator is not warned',
      },
    },
    async () => {
      const updateTestRun = vi.fn(async () => true);
      const notify = vi.fn();

      const saved = await markRunCompleted({ updateTestRun }, '000043', notify, () => NOW);

      expect(updateTestRun).toHaveBeenCalledWith('000043', {
        status: 'completed',
        completedAt: NOW.toISOString(),
      });
      expect(saved).toBe(true);
      expect(notify).not.toHaveBeenCalled();
    },
  );
});
