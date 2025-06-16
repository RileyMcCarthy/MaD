import { TextField, Button, MenuItem, Box, Grid, Typography, Autocomplete } from '@mui/material';
import { useState, useEffect } from 'react';

export default function Connect() {
  const baudRates = [9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
  const [ports, setPorts] = useState<string[]>([]);
  const [responseMessage, setResponseMessage] = useState<string | null>(null);

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

  const handleConnect = (event) => {
    event.preventDefault(); // Prevent the default form submission behavior
    const formData = new FormData(event.target);
    const selectedPort = formData.get('port');
    const baudRate = parseInt(formData.get('baudRate'), 10);

    window.electron.ipcRenderer
      .invoke('device-connect', selectedPort, baudRate)
      .then((response) => {
        console.log(response)
        setResponseMessage(response);
        return; // Passes the value to the next then block
      })
      .catch((error) => {
        setResponseMessage(`Failed to connect: ${error.message}`);
        console.error('Failed to connect:', error);
      });
  };

  return (
    <Grid
      container
      justifyContent="center"
      alignItems="center"
      minHeight="100vh"
    >
      <Grid item xs={6}>
        <Box
          display="flex"
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
          height="100%"
          gap={2}
          component="form"
          onSubmit={handleConnect}
        >
          <Typography variant="h4" component="h1">
            Connect to Device
          </Typography>
          <Box width={1}>
            <Autocomplete
              freeSolo
              options={ports}
              defaultValue="/dev/serial0" // Set default port
              renderInput={(params) => (
                <TextField {...params} label="Port" name="port" fullWidth />
              )}
            />
          </Box>
          <TextField
            select
            label="Baud Rate"
            name="baudRate"
            defaultValue={230400} // Set default baud rate
            fullWidth
          >
            {baudRates.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>

          <Button type="submit" variant="contained" color="primary">
            Connect
          </Button>

          {responseMessage && (
            <Typography variant="body1" color="textSecondary" align="center">
              {responseMessage}
            </Typography>
          )}
        </Box>
      </Grid>
    </Grid>
  );
}