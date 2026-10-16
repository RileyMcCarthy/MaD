import { NotificationType, TestRunEntry } from '@/domain';
import { dataStore } from '@/storage/DataStore';
import { useStore } from '@/store/useStore';

/**
 * Save a run's new status, and warn the operator when its record is no longer
 * in the data folder (moved or deleted by hand): the update can't be saved, so
 * History won't show it, and nothing else would say why.
 *
 * `outcome` leads the warning, e.g. "Test 000012 finished" → "Test 000012
 * finished: its run record was not found in the data folder …".
 */
export async function updateRunRecord(
  testName: string,
  patch: Partial<TestRunEntry>,
  outcome: string,
): Promise<void> {
  if (await dataStore.updateTestRun(testName, patch)) return;
  useStore
    .getState()
    .notify(
      NotificationType.WARN,
      `${outcome}: its run record was not found in the data folder (moved or deleted?), so History was not updated.`,
    );
}
