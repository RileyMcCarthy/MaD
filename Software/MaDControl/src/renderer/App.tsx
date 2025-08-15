import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import SideBar from './components/NavBar';
import NotificationComponent from './components/Notifications';
import './App.css';
import 'react-toastify/dist/ReactToastify.css';
import { ThemeProvider, createTheme } from '@mui/material/styles';
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
              <Route path="/" element={<Connect />} />
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
