import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Typography,
  Paper,
  TextField,
  IconButton,
} from '@mui/material';
import {
  FolderOpen as FolderOpenIcon,
  Save as SaveIcon,
} from '@mui/icons-material';

export default function Settings() {
  const [dataDir, setDataDir] = useState('');
  const [savedDir, setSavedDir] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const dir = (await window.electron.ipcRenderer.invoke(
        'data-get-data-dir',
      )) as string;
      setDataDir(dir);
      setSavedDir(dir);
    };
    load();
  }, []);

  const handleChooseFolder = async () => {
    const chosen = await window.electron.ipcRenderer.invoke(
      'data-choose-data-dir',
    );
    if (chosen) {
      setDataDir(chosen as string);
    }
  };

  const handleSave = async () => {
    await window.electron.ipcRenderer.invoke('data-set-data-dir', dataDir);
    setSavedDir(dataDir);
    setStatus('Data directory updated successfully.');
    setTimeout(() => setStatus(null), 3000);
  };

  const handleOpenFolder = () => {
    window.electron.ipcRenderer.invoke('data-open-data-dir');
  };

  const hasChanges = dataDir !== savedDir;

  return (
    <Box sx={{ p: 3, maxWidth: 700 }}>
      <Typography variant="h4" sx={{ mb: 3, fontWeight: 'bold' }}>
        Settings
      </Typography>

      <Paper elevation={2} sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Data Directory
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          All profiles, test runs, and CSV data are stored in this folder. You
          can change it to any location (e.g. a shared drive or cloud-synced
          folder). The app will create the folder if it doesn&apos;t exist.
        </Typography>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
          <TextField
            value={dataDir}
            onChange={(e) => setDataDir(e.target.value)}
            fullWidth
            size="small"
            InputProps={{ readOnly: true }}
          />
          <IconButton onClick={handleChooseFolder} title="Browse…">
            <FolderOpenIcon />
          </IconButton>
          <IconButton onClick={handleOpenFolder} title="Open in Finder">
            <FolderOpenIcon color="action" />
          </IconButton>
        </Box>

        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleSave}
            disabled={!hasChanges}
          >
            Save
          </Button>
          {status && (
            <Typography variant="body2" color="success.main">
              {status}
            </Typography>
          )}
        </Box>
      </Paper>
    </Box>
  );
}
