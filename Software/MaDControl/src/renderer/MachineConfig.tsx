import React, { useState, useEffect } from 'react';
import { Box, Button, Grid, TextField, Typography } from '@mui/material';
import { MachineConfiguration } from '@shared/SharedInterface';

export default function MachineConfigPage() {
  const [config, setConfig] = useState<MachineConfiguration | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.electron.ipcRenderer
      .invoke('get-machine-configuration')
      .then((machineConfig: MachineConfiguration) => {
        setConfig(machineConfig);
        setLoading(false);
      })
      .catch((error) => {
        console.error('Failed to get machine configuration:', error);
        setLoading(false);
      });
  }, []);

  const handleChange = (field: keyof MachineConfiguration) => (event: React.ChangeEvent<HTMLInputElement>) => {
    if (config) {
      const value = event.target.value;
      setConfig({
        ...config,
        [field]: typeof config[field] === 'number' ? parseFloat(value) : value,
      });
    }
  };

  const handleSave = () => {
    if (config) {
      window.electron.ipcRenderer
        .invoke('save-machine-configuration', config)
        .catch((error) => {
          console.error('Failed to save machine configuration:', error);
          alert('Failed to save machine configuration');
        });
    }
  };

  if (loading) {
    return <Typography>Loading...</Typography>;
  }

  if (!config) {
    return <Typography>Failed to load machine configuration</Typography>;
  }

  return (
    <Box sx={{ p: 2 }}>
      <Grid container spacing={2}>
        {Object.keys(config).map((key) => (
          <Grid item xs={12} sm={6} key={key}>
            <TextField
              label={key}
              value={config[key as keyof MachineConfiguration]}
              onChange={handleChange(key as keyof MachineConfiguration)}
              fullWidth
              type={typeof config[key as keyof MachineConfiguration] === 'number' ? 'number' : 'text'}
            />
          </Grid>
        ))}
      </Grid>
      <Box sx={{ mt: 2 }}>
        <Button variant="contained" color="primary" onClick={handleSave}>
          Save Configuration
        </Button>
      </Box>
    </Box>
  );
};
