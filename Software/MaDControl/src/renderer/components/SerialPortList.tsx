import React, { useState, useEffect } from 'react';

function SerialPortList(): JSX.Element {
  const [ports, setPorts] = useState([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [baudRate, setBaudRate] = useState(9600); // Default baud rate

  useEffect(() => {
    window.electron.ipcRenderer
      .invoke('device-list-ports')
      .then((newPorts) => {
        setPorts(newPorts);
        return null; // Passes the value to the next then block
      })
      .catch((error) => {
        console.error('Failed to list ports:', error);
      });
  }, []);

  const handlePortSelect = (event) => {
    setSelectedPort(event.target.value);
  };

  const handleBaudRateSelect = (event) => {
    const parsedBaudRate = parseInt(event.target.value, 10);

    if (!Number.isNaN(parsedBaudRate)) {
      setBaudRate(parsedBaudRate);
    } else {
      console.error('Invalid baud rate:', event.target.value);
    }
  };

  const handleConnectClick = () => {
    window.electron.ipcRenderer.sendMessage('connect-port', selectedPort, baudRate);
  };

  return (
    <div>
      <input
        list="port-list"
        value={selectedPort}
        onChange={handlePortSelect}
        placeholder="/tmp/tty.rpi"
      />
      <datalist id="port-list">
        {ports.map((port) => (
          <option key={port} value={port} />
        ))}
      </datalist>
      <select value={baudRate} onChange={handleBaudRateSelect}>
        <option value={9600}>9600</option>
        <option value={14400}>14400</option>
        <option value={19200}>19200</option>
        <option value={38400}>38400</option>
        <option value={57600}>57600</option>
        <option value={115200}>115200</option>
      </select>
      <button onClick={handleConnectClick} disabled={!selectedPort}>Connect</button>
    </div>
  );
}

export default SerialPortList;
