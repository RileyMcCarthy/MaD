import React, { useState, useEffect } from 'react';
import { Box, Button, Grid, TextField, Typography } from '@mui/material';
import { MachineConfiguration } from '@shared/SharedInterface';
import { useDevice } from '@renderer/hooks';
import { componentLogger } from '../utils/logger';

export default function MachineConfigPage() {
  const [deviceState, actions] = useDevice();
  const [config, setConfig] = useState<MachineConfiguration | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const machineConfig = await actions.getMachineConfiguration();
        setConfig(machineConfig);
        setLoading(false);
      } catch (error) {
        componentLogger.error('Failed to get machine configuration:', error);
        setLoading(false);
      }
    };

    loadConfig();
  }, [actions]);

  // Also update local config when device state changes
  useEffect(() => {
    if (deviceState.machineConfiguration && !config) {
      setConfig(deviceState.machineConfiguration);
      setLoading(false);
    }
  }, [deviceState.machineConfiguration, config]);

  const handleChange = (field: keyof MachineConfiguration) => (event: React.ChangeEvent<HTMLInputElement>) => {
    if (config) {
      const value = event.target.value;
      setConfig({
        ...config,
        [field]: typeof config[field] === 'number' ? parseFloat(value) : value,
      });
    }
  };

  const handleSave = async () => {
    if (config) {
      try {
        await actions.saveMachineConfiguration(config);
        componentLogger.info('Machine configuration saved successfully');
      } catch (error) {
        componentLogger.error('Failed to save machine configuration:', error);
        alert('Failed to save machine configuration');
      }
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
