/**
 * @brief Hook for loading and managing saved sample/motion profiles from the database.
 * @details Provides profile lists, loading, and file-import helpers shared
 *          between TestRunner and TestProfile pages.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  SampleProfile,
  MotionProfile,
  SampleProfileEntry,
  MotionProfileEntry,
} from '@shared/SharedInterface';
import { componentLogger } from '../utils/logger';

export interface UseProfilesResult {
  sampleProfiles: SampleProfileEntry[];
  motionProfiles: MotionProfileEntry[];
  refreshProfiles: () => Promise<void>;
  importSampleProfileFromFile: (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => Promise<SampleProfileEntry | null>;
  importMotionProfileFromFile: (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => Promise<MotionProfileEntry | null>;
}

export function useProfiles(): UseProfilesResult {
  const [sampleProfiles, setSampleProfiles] = useState<SampleProfileEntry[]>(
    [],
  );
  const [motionProfiles, setMotionProfiles] = useState<MotionProfileEntry[]>(
    [],
  );

  const refreshProfiles = useCallback(async () => {
    try {
      const sp = await window.electron.ipcRenderer.invoke(
        'data-get-sample-profiles',
      );
      const mp = await window.electron.ipcRenderer.invoke(
        'data-get-motion-profiles',
      );
      setSampleProfiles(sp || []);
      setMotionProfiles(mp || []);
    } catch (error) {
      componentLogger.error('Failed to load profiles:', error);
    }
  }, []);

  useEffect(() => {
    refreshProfiles();
  }, [refreshProfiles]);

  /**
   * Read a .sp file, save it to the database (overwrite), refresh the list,
   * and return the saved entry (or null on error).
   * Resets the input element so the same file can be re-selected.
   */
  const importSampleProfileFromFile = useCallback(
    async (
      event: React.ChangeEvent<HTMLInputElement>,
    ): Promise<SampleProfileEntry | null> => {
      const file = event.target.files?.[0];
      if (!file) return null;

      try {
        const content = await file.text();
        const parsed = JSON.parse(content);
        const profile: SampleProfile = {
          maxForce: parsed.maxForce,
          maxVelocity: parsed.maxVelocity,
          maxDisplacement: parsed.maxDisplacement,
          sampleWidth: parsed.sampleWidth,
          sampleThickness: parsed.sampleThickness,
        };
        const importName = file.name.replace(/\.sp$/i, '') || 'profile';
        const entry = await window.electron.ipcRenderer.invoke(
          'data-overwrite-sample-profile',
          importName,
          profile,
        );
        await refreshProfiles();
        return entry ?? null;
      } catch (error) {
        componentLogger.error('Error importing sample profile:', error);
        return null;
      } finally {
        // eslint-disable-next-line no-param-reassign
        event.target.value = '';
      }
    },
    [refreshProfiles],
  );

  /**
   * Read a .mp file, save it to the database (overwrite), refresh the list,
   * and return the saved entry (or null on error).
   * Resets the input element so the same file can be re-selected.
   */
  const importMotionProfileFromFile = useCallback(
    async (
      event: React.ChangeEvent<HTMLInputElement>,
    ): Promise<MotionProfileEntry | null> => {
      const file = event.target.files?.[0];
      if (!file) return null;

      try {
        const content = await file.text();
        const profile = JSON.parse(content) as MotionProfile;
        const entry = await window.electron.ipcRenderer.invoke(
          'data-overwrite-motion-profile',
          profile,
        );
        await refreshProfiles();
        return entry ?? null;
      } catch (error) {
        componentLogger.error('Error importing motion profile:', error);
        return null;
      } finally {
        // eslint-disable-next-line no-param-reassign
        event.target.value = '';
      }
    },
    [refreshProfiles],
  );

  return {
    sampleProfiles,
    motionProfiles,
    refreshProfiles,
    importSampleProfileFromFile,
    importMotionProfileFromFile,
  };
}
