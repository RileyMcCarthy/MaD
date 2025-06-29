import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { MachineState, SampleData, MachineConfiguration } from '@shared/SharedInterface';
import useDeviceStatusQuery from './useDeviceStatusQuery';

interface DeviceState {
  isConnected: boolean;
  isResponding: boolean;
  machineState: MachineState | null;
  latestSampleData: SampleData | null;
  machineConfiguration: MachineConfiguration | null;
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
  streamGCode: (gcode: string) => Promise<{ success: boolean; error?: string }>;
  getAllDeviceData: () => Promise<SampleData[]>;
  getFirmwareVersion: () => Promise<string>;
  flashFirmwareFromFile: () => Promise<{ success: boolean; error?: string }>;
  cancelFirmwareFlash: () => Promise<{ success: boolean; error?: string }>;
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

  const [deviceState, setDeviceState] = useState<DeviceState>({
    isConnected: false,
    isResponding: false,
    machineState: null,
    latestSampleData: null,
    machineConfiguration: null,
  });

  // Update device state when status changes
  useEffect(() => {
    if (deviceStatus.data) {
      setDeviceState(prev => ({
        ...prev,
        isConnected: deviceStatus.data?.connected || false,
        isResponding: deviceStatus.data?.responding || false,
      }));
    }
  }, [deviceStatus.data]);

  // Listen for other device events (sample data, machine state, etc.)
  useEffect(() => {
    const handleSampleData = (...args: unknown[]) => {
      const data = args[0] as SampleData;
      setDeviceState(prev => ({
        ...prev,
        latestSampleData: data,
      }));
    };

    const handleMachineState = (...args: unknown[]) => {
      const state = args[0] as MachineState;
      setDeviceState(prev => ({
        ...prev,
        machineState: state,
      }));
    };

    const handleMachineConfiguration = (...args: unknown[]) => {
      const config = args[0] as MachineConfiguration;
      setDeviceState(prev => ({ ...prev, machineConfiguration: config }));
    };

    // Set up IPC listeners with standardized event names
    window.electron.ipcRenderer.on('sample-data-updates', handleSampleData);
    window.electron.ipcRenderer.on('machine-state-updates', handleMachineState);
    window.electron.ipcRenderer.on('machine-configuration-updates', handleMachineConfiguration);

    // Cleanup listeners on unmount
    return () => {
      window.electron.ipcRenderer.removeAllListeners('sample-data-updates');
      window.electron.ipcRenderer.removeAllListeners('machine-state-updates');
      window.electron.ipcRenderer.removeAllListeners('machine-configuration-updates');
    };
  }, []);

  // Device actions
  const connect = useCallback(async (portPath: string, baudRate: number): Promise<string> => {
    try {
      return await window.electron.ipcRenderer.invoke('device-connect', portPath, baudRate);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Connection failed');
    }
  }, []);

  const listPorts = useCallback(async (): Promise<string[]> => {
    try {
      return await window.electron.ipcRenderer.invoke('device-list-ports');
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to list ports');
    }
  }, []);

  const getMachineConfiguration = useCallback(async (): Promise<MachineConfiguration> => {
    try {
      return await window.electron.ipcRenderer.invoke('get-machine-configuration');
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to get machine configuration');
    }
  }, []);

  const saveMachineConfiguration = useCallback(async (config: MachineConfiguration): Promise<boolean> => {
    try {
      return await window.electron.ipcRenderer.invoke('save-machine-configuration', config);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to save machine configuration');
    }
  }, []);

  const setMotionEnabled = useCallback(async (enabled: boolean): Promise<boolean> => {
    try {
      return await window.electron.ipcRenderer.invoke('set-motion-enabled', enabled);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to set motion enabled');
    }
  }, []);

  const manualMove = useCallback(async (mm: number, speed: number): Promise<boolean> => {
    try {
      return await window.electron.ipcRenderer.invoke('manual-move', mm, speed);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to execute manual move');
    }
  }, []);

  const homeAxis = useCallback(async (): Promise<boolean> => {
    try {
      return await window.electron.ipcRenderer.invoke('home-axis');
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to home axis');
    }
  }, []);

  const zeroForce = useCallback(async (): Promise<boolean> => {
    try {
      return await window.electron.ipcRenderer.invoke('zero-force');
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to zero force');
    }
  }, []);

  const streamGCode = useCallback(async (gcode: string): Promise<{ success: boolean; error?: string }> => {
    try {
      return await window.electron.ipcRenderer.invoke('stream-gcode', gcode);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stream G-code'
      };
    }
  }, []);

  const getAllDeviceData = useCallback(async (): Promise<SampleData[]> => {
    try {
      return await window.electron.ipcRenderer.invoke('device-data-all');
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to get all device data');
    }
  }, []);

  const getFirmwareVersion = useCallback(async (): Promise<string> => {
    try {
      return await window.electron.ipcRenderer.invoke('get-firmware-version');
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to get firmware version');
    }
  }, []);

  const flashFirmwareFromFile = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    try {
      return await window.electron.ipcRenderer.invoke('flash-from-file');
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to flash firmware from file'
      };
    }
  }, []);

  const cancelFirmwareFlash = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    try {
      return await window.electron.ipcRenderer.invoke('cancel-firmware-flash');
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel firmware flash'
      };
    }
  }, []);

  const actions: DeviceActions = {
    connect,
    listPorts,
    getMachineConfiguration,
    saveMachineConfiguration,
    setMotionEnabled,
    manualMove,
    homeAxis,
    zeroForce,
    streamGCode,
    getAllDeviceData,
    getFirmwareVersion,
    flashFirmwareFromFile,
    cancelFirmwareFlash,
  };

  const contextValue: DeviceContextType = {
    deviceState,
    actions,
  };

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
