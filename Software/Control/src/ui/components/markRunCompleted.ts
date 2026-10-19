import { NotificationType } from '@/domain';
import type { DataStore } from '@/storage/DataStore';

export type Notify = (type: NotificationType, message: string) => void;

/**
 * Record that the firmware finished `testName`. When the run has no record in
 * the data folder (its file was moved or deleted) nothing can be saved, and the
 * operator is warned once, by name, instead of the completion vanishing.
 *
 * Resolves whether the completion was saved.
 */
export async function markRunCompleted(
  store: Pick<DataStore, 'updateTestRun'>,
  testName: string,
  notify: Notify,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const saved = await store.updateTestRun(testName, {
    status: 'completed',
    completedAt: now().toISOString(),
  });
  if (!saved) {
    notify(
      NotificationType.WARN,
      `Test ${testName} finished, but its run record is missing from the data folder, so the completion was not saved.`,
    );
  }
  return saved;
}
