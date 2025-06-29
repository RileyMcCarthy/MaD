import { useState, useEffect } from 'react';

interface DeviceStatus {
  connected: boolean;
  responding: boolean;
  message?: string;
}

interface DeviceStatusQueryResult {
  data: DeviceStatus | null;
  isLoading: boolean;
  error: string | null;
}

export default function useDeviceStatusQuery(): DeviceStatusQueryResult {
  const [data, setData] = useState<DeviceStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Initial fetch of device status
    const fetchInitialStatus = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Query initial connection and responding status
        const connected = await window.electron.ipcRenderer.invoke('device-connected');
        const responding = await window.electron.ipcRenderer.invoke('device-responding');

        const status: DeviceStatus = {
          connected,
          responding,
          message: 'Initial status loaded',
        };
        setData(status);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to get device status',
        );
        setData({
          connected: false,
          responding: false,
          message: 'Error loading status',
        });
      } finally {
        setIsLoading(false);
      }
    };

    // Listen for device status updates from the main process
    const handleDeviceStatusUpdate = (...args: unknown[]) => {
      const statusUpdate = args[0] as DeviceStatus;
      setData(statusUpdate);
      setError(null);
    };

    // Set up the event listener
    window.electron.ipcRenderer.on(
      'device-status-updates',
      handleDeviceStatusUpdate,
    );

    // Initial fetch
    fetchInitialStatus();

    // Cleanup listener on unmount
    return () => {
      window.electron.ipcRenderer.removeAllListeners('device-status-updates');
    };
  }, []);

  return {
    data,
    isLoading,
    error,
  };
}
