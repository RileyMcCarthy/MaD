import React, { useState, useEffect, ChangeEvent } from 'react';
import { useDevice } from '@renderer/hooks';
import { componentLogger } from '../utils/logger';

function SerialPortList(): React.JSX.Element {
  const [deviceState, actions] = useDevice();
  const [ports, setPorts] = useState<string[]>([]);
  const [selectedPort, setSelectedPort] = useState<string>('');
  const [selectedBaudRate, setSelectedBaudRate] = useState<string>('115200');

  useEffect(() => {
    // Fetch available ports when component mounts
    const fetchPorts = async () => {
      try {
        const availablePorts = await actions.listPorts();
        setPorts(availablePorts);
      } catch (error) {
        componentLogger.error('Failed to fetch ports:', error);
      }
    };

    fetchPorts();
  }, [actions]);

  const handlePortSelect = (event: ChangeEvent<HTMLInputElement>) => {
    setSelectedPort(event.target.value);
  };

  const handleBaudRateSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    setSelectedBaudRate(event.target.value);
  };

  const handleConnectClick = async () => {
    try {
      await actions.connect(selectedPort, parseInt(selectedBaudRate, 10));
      componentLogger.info(
        `Connected to ${selectedPort} at ${selectedBaudRate} baud`,
      );
    } catch (error) {
      componentLogger.error('Failed to connect:', error);
    }
  };

  return (
    <div>
      <label htmlFor="port-input">
        Serial Port:
        <input
          id="port-input"
          list="ports"
          value={selectedPort}
          onChange={handlePortSelect}
          placeholder="Select a port"
        />
      </label>
      <datalist id="ports">
        {ports.map((port) => (
          <option key={port} value={port} />
        ))}
      </datalist>

      <label htmlFor="baud-select">
        Baud Rate:
        <select
          id="baud-select"
          value={selectedBaudRate}
          onChange={handleBaudRateSelect}
        >
          <option value={9600}>9600</option>
          <option value={14400}>14400</option>
          <option value={19200}>19200</option>
          <option value={38400}>38400</option>
          <option value={57600}>57600</option>
          <option value={115200}>115200</option>
        </select>
      </label>

      <button
        type="button"
        onClick={handleConnectClick}
        disabled={!selectedPort || deviceState.isConnected}
      >
        {deviceState.isConnected ? 'Connected' : 'Connect'}
      </button>
    </div>
  );
}

export default SerialPortList;
