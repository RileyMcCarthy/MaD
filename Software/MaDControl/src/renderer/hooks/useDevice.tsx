import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import {
  MachineState,
  SampleData,
  MachineConfiguration,
  SampleProfile,
} from '@shared/SharedInterface';
import useDeviceStatusQuery from './useDeviceStatusQuery';

interface DeviceState {
  isConnected: boolean;
  isResponding: boolean;
  machineState: MachineState | null;
  latestSampleData: SampleData | null;
  machineConfiguration: MachineConfiguration | null;
  sampleProfile: SampleProfile | null;
  liveSamplePeriodMs: number;
  liveSampleBufferSize: number;
}

interface DeviceActions {
  connect: (portPath: string, baudRate: number) => Promise<string>;
  listPorts: () => Promise<string[]>;
  getMachineConfiguration: () => Promise<MachineConfiguration>;
  saveMachineConfiguration: (config: MachineConfiguration) => Promise<boolean>;
  setMotionEnabled: (enabled: boolean) => Promise<boolean>;
  manualMove: (mm: number, speed: number) => Promise<boolean>;
  homeAxis: () => Promise<boolean>;
  zeroForce: () => Promise<boolean>;
  zeroLength: () => Promise<boolean>;
  getSampleProfile: () => Promise<SampleProfile>;
  saveSampleProfile: (profile: SampleProfile) => Promise<boolean>;
  streamGCode: (gcode: string) => Promise<{ success: boolean; error?: string }>;
  getAllDeviceData: () => Promise<SampleData[]>;
  getCachedDeviceData: (limit?: number) => Promise<SampleData[]>;
  getFirmwareVersion: () => Promise<string>;
  flashFirmwareFromFile: () => Promise<{ success: boolean; error?: string }>;
  cancelFirmwareFlash: () => Promise<{ success: boolean; error?: string }>;
  downloadTestFile: (testName: string, savePath: string) => Promise<{ success: boolean; error?: string; filePath?: string; fileSize?: number }>;
}

interface DeviceContextType {
  deviceState: DeviceState;
  actions: DeviceActions;
}

// Create context
const DeviceContext = createContext<DeviceContextType | undefined>(undefined);

// Provider component
export function DeviceProvider({ children }: { children: React.ReactNode }) {
  // Use the standard naming convention for device status - SINGLE INSTANCE
  const deviceStatus = useDeviceStatusQuery();
  const ONE_MINUTE_MS = 60_000;
  const DEFAULT_SAMPLE_PERIOD_MS = 100;
  const computeLiveBufferSize = (periodMs: number) =>
    Math.max(1, Math.ceil(ONE_MINUTE_MS / periodMs));
  const initialLiveSampleBufferSize = computeLiveBufferSize(
    DEFAULT_SAMPLE_PERIOD_MS,
  );

  const [deviceState, setDeviceState] = useState<DeviceState>({
    isConnected: false,
    isResponding: false,
    machineState: null,
    latestSampleData: null,
    machineConfiguration: null,
    sampleProfile: null,
    liveSamplePeriodMs: DEFAULT_SAMPLE_PERIOD_MS,
    liveSampleBufferSize: initialLiveSampleBufferSize,
  });
  const liveSampleBufferSizeRef = useRef(initialLiveSampleBufferSize);
  const sampleCacheRef = useRef<SampleData[]>([]);
  const sampleCacheLoadPromiseRef = useRef<Promise<SampleData[]> | null>(null);

  // Update device state when status changes
  useEffect(() => {
    if (deviceStatus.data) {
      setDeviceState((prev) => ({
        ...prev,
        isConnected: deviceStatus.data?.connected || false,
        isResponding: deviceStatus.data?.responding || false,
      }));
    }
  }, [deviceStatus.data]);

  useEffect(() => {
    const loadSamplePeriod = async () => {
      try {
        const periodMs = await window.electron.ipcRenderer.invoke(
          'device-sample-period-ms',
        );
        const numericPeriod = Number(periodMs);
        if (!Number.isFinite(numericPeriod) || numericPeriod <= 0) return;

        const nextLiveSampleBufferSize = computeLiveBufferSize(numericPeriod);
        liveSampleBufferSizeRef.current = nextLiveSampleBufferSize;
        sampleCacheRef.current = sampleCacheRef.current.slice(
          -nextLiveSampleBufferSize,
        );
        setDeviceState((prev) => ({
          ...prev,
          liveSamplePeriodMs: numericPeriod,
          liveSampleBufferSize: nextLiveSampleBufferSize,
        }));
      } catch {
        // Leave defaults if protocol period query fails.
      }
    };

    loadSamplePeriod();
  }, []);

  // Listen for other device events (sample data, machine state, etc.)
  useEffect(() => {
    const handleSampleData = (...args: unknown[]) => {
      const data = args[0] as SampleData;
      sampleCacheRef.current = [...sampleCacheRef.current, data].slice(
        -liveSampleBufferSizeRef.current,
      );
      setDeviceState((prev) => ({
        ...prev,
        latestSampleData: data,
      }));
    };

    const handleMachineState = (...args: unknown[]) => {
      const state = args[0] as MachineState;
      setDeviceState((prev) => ({
        ...prev,
        machineState: state,
      }));
    };

    const handleMachineConfiguration = (...args: unknown[]) => {
      const config = args[0] as MachineConfiguration;
      setDeviceState((prev) => ({ ...prev, machineConfiguration: config }));
    };

    const handleSampleProfile = (...args: unknown[]) => {
      const profile = args[0] as SampleProfile;
      setDeviceState((prev) => ({ ...prev, sampleProfile: profile }));
    };

    // Set up IPC listeners with standardized event names
    window.electron.ipcRenderer.on('sample-data-updates', handleSampleData);
    window.electron.ipcRenderer.on('machine-state-updates', handleMachineState);
    window.electron.ipcRenderer.on(
      'machine-configuration-updates',
      handleMachineConfiguration,
    );
    window.electron.ipcRenderer.on(
      'sample-profile-updates',
      handleSampleProfile,
    );

    // Cleanup listeners on unmount
    return () => {
      window.electron.ipcRenderer.removeAllListeners('sample-data-updates');
      window.electron.ipcRenderer.removeAllListeners('machine-state-updates');
      window.electron.ipcRenderer.removeAllListeners(
        'machine-configuration-updates',
      );
      window.electron.ipcRenderer.removeAllListeners('sample-profile-updates');
    };
  }, []);

  // Device actions
  const connect = useCallback(
    async (portPath: string, baudRate: number): Promise<string> => {
      try {
        return await window.electron.ipcRenderer.invoke(
          'device-connect',
          portPath,
          baudRate,
        );
      } catch (error) {
        throw new Error(
          error instanceof Error ? error.message : 'Connection failed',
        );
      }
    },
    [],
  );

  const listPorts = useCallback(async (): Promise<string[]> => {
    try {
      return await window.electron.ipcRenderer.invoke('device-list-ports');
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'Failed to list ports',
      );
    }
  }, []);

  const getMachineConfiguration =
    useCallback(async (): Promise<MachineConfiguration> => {
      try {
        return await window.electron.ipcRenderer.invoke(
          'get-machine-configuration',
        );
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? error.message
            : 'Failed to get machine configuration',
        );
      }
    }, []);

  const saveMachineConfiguration = useCallback(
    async (config: MachineConfiguration): Promise<boolean> => {
      try {
        return await window.electron.ipcRenderer.invoke(
          'save-machine-configuration',
          config,
        );
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? error.message
            : 'Failed to save machine configuration',
        );
      }
    },
    [],
  );

  const setMotionEnabled = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      try {
        return await window.electron.ipcRenderer.invoke(
          'set-motion-enabled',
          enabled,
        );
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? error.message
            : 'Failed to set motion enabled',
        );
      }
    },
    [],
  );

  const manualMove = useCallback(
    async (mm: number, speed: number): Promise<boolean> => {
      try {
        return await window.electron.ipcRenderer.invoke(
          'manual-move',
          mm,
          speed,
        );
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? error.message
            : 'Failed to execute manual move',
        );
      }
    },
    [],
  );

  const homeAxis = useCallback(async (): Promise<boolean> => {
    try {
      return await window.electron.ipcRenderer.invoke('home-axis');
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'Failed to home axis',
      );
    }
  }, []);

  const zeroForce = useCallback(async (): Promise<boolean> => {
    try {
      return await window.electron.ipcRenderer.invoke('zero-force');
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'Failed to zero force',
      );
    }
  }, []);

  const zeroLength = useCallback(async (): Promise<boolean> => {
    try {
      return await window.electron.ipcRenderer.invoke('zero-length');
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'Failed to zero length',
      );
    }
  }, []);

  const getSampleProfile = useCallback(async (): Promise<SampleProfile> => {
    try {
      return await window.electron.ipcRenderer.invoke('get-sample-profile');
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'Failed to get sample profile',
      );
    }
  }, []);

  const saveSampleProfile = useCallback(
    async (profile: SampleProfile): Promise<boolean> => {
      try {
        return await window.electron.ipcRenderer.invoke(
          'save-sample-profile',
          profile,
        );
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? error.message
            : 'Failed to save sample profile',
        );
      }
    },
    [],
  );

  const streamGCode = useCallback(
    async (gcode: string): Promise<{ success: boolean; error?: string }> => {
      try {
        return await window.electron.ipcRenderer.invoke('stream-gcode', gcode);
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : 'Failed to stream G-code',
        };
      }
    },
    [],
  );

  const getAllDeviceData = useCallback(async (): Promise<SampleData[]> => {
    try {
      return await window.electron.ipcRenderer.invoke('device-data-all');
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : 'Failed to get all device data',
      );
    }
  }, []);

  const hydrateSampleCache = useCallback(async (): Promise<SampleData[]> => {
    if (sampleCacheRef.current.length > 0) {
      return sampleCacheRef.current;
    }

    if (!sampleCacheLoadPromiseRef.current) {
      sampleCacheLoadPromiseRef.current = (async () => {
        const fetchedSamples = await getAllDeviceData();
        sampleCacheRef.current = fetchedSamples.slice(
          -liveSampleBufferSizeRef.current,
        );
        return sampleCacheRef.current;
      })().finally(() => {
        sampleCacheLoadPromiseRef.current = null;
      });
    }

    return sampleCacheLoadPromiseRef.current;
  }, [getAllDeviceData]);

  const getCachedDeviceData = useCallback(
    async (limit?: number): Promise<SampleData[]> => {
      const samples = await hydrateSampleCache();
      if (limit === undefined || limit <= 0) {
        return samples;
      }
      return samples.slice(-limit);
    },
    [hydrateSampleCache],
  );

  const getFirmwareVersion = useCallback(async (): Promise<string> => {
    try {
      return await window.electron.ipcRenderer.invoke('get-firmware-version');
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : 'Failed to get firmware version',
      );
    }
  }, []);

  const flashFirmwareFromFile = useCallback(async (): Promise<{
    success: boolean;
    error?: string;
  }> => {
    try {
      return await window.electron.ipcRenderer.invoke('flash-from-file');
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to flash firmware from file',
      };
    }
  }, []);

  const cancelFirmwareFlash = useCallback(async (): Promise<{
    success: boolean;
    error?: string;
  }> => {
    try {
      return await window.electron.ipcRenderer.invoke('cancel-firmware-flash');
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to cancel firmware flash',
      };
    }
  }, []);

  const downloadTestFile = useCallback(
    async (
      testName: string,
      savePath: string,
    ): Promise<{
      success: boolean;
      error?: string;
      filePath?: string;
      fileSize?: number;
    }> => {
      try {
        return await window.electron.ipcRenderer.invoke('download-test-file', {
          testName,
          savePath,
        });
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to download test file',
        };
      }
    },
    [],
  );

  const actions: DeviceActions = useMemo(() => ({
    connect,
    listPorts,
    getMachineConfiguration,
    saveMachineConfiguration,
    setMotionEnabled,
    manualMove,
    homeAxis,
    zeroForce,
    zeroLength,
    getSampleProfile,
    saveSampleProfile,
    streamGCode,
    getAllDeviceData,
    getCachedDeviceData,
    getFirmwareVersion,
    flashFirmwareFromFile,
    cancelFirmwareFlash,
    downloadTestFile,
  }), [
    connect,
    listPorts,
    getMachineConfiguration,
    saveMachineConfiguration,
    setMotionEnabled,
    manualMove,
    homeAxis,
    zeroForce,
    zeroLength,
    getSampleProfile,
    saveSampleProfile,
    streamGCode,
    getAllDeviceData,
    getCachedDeviceData,
    getFirmwareVersion,
    flashFirmwareFromFile,
    cancelFirmwareFlash,
    downloadTestFile,
  ]);

  const contextValue: DeviceContextType = useMemo(() => ({
    deviceState,
    actions,
  }), [deviceState, actions]);

  return (
    <DeviceContext.Provider value={contextValue}>
      {children}
    </DeviceContext.Provider>
  );
}

// Hook to use the device context
export function useDevice(): [DeviceState, DeviceActions] {
  const context = useContext(DeviceContext);

  if (context === undefined) {
    throw new Error('useDevice must be used within a DeviceProvider');
  }

  return [context.deviceState, context.actions];
}
