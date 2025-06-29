import { createRoot } from 'react-dom/client';
import App from './App';
import { componentLogger } from './utils/logger';

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);
root.render(<App />);

// calling IPC exposed from preload script
window.electron.ipcRenderer.once('ipc-example', (arg) => {
  // eslint-disable-next-line no-console
  componentLogger.info(String(arg));
});
window.electron.ipcRenderer.sendMessage('ipc-example', ['ping']);
