import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { useState, useEffect } from 'react';
import icon from '../../assets/icon.svg';
import SideBar from './components/NavBar';
import SerialPortList from './components/SerialPortList';
import NotificationComponent from './components/Notifications';
import MachineStatus from './components/MachineStatus';
import './App.css';
import 'react-toastify/dist/ReactToastify.css';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { Grid } from '@mui/material';
import Control from './components/Control';
import Parameters from './components/Parameters';
import BasicLineChart from './components/Graph';
import Dashboard from './pages/Dashboard';
import Connect from './pages/Connect';
import MachineConfigPage from './pages/MachineConfig';
import TestProfileForm from './pages/TestProfile';
import FirmwareUpdate from './pages/FirmwareUpdate';
import { DeviceProvider } from './hooks/useDevice';

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
  },
});

export default function App() {
  return (
    <DeviceProvider>
      <ThemeProvider theme={darkTheme}>
        <Router>
          <SideBar>
            <NotificationComponent />
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/connect" element={<Connect />} />
              <Route path="/config" element={<MachineConfigPage />} />
              <Route path="/create" element={<TestProfileForm />} />
              <Route path="/firmware" element={<FirmwareUpdate />} />
            </Routes>
          </SideBar>
        </Router>
      </ThemeProvider>
    </DeviceProvider>
  );
}
