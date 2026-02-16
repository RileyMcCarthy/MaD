/**
 * @brief Shared styled MUI components used across dashboard panels.
 */
import { Paper } from '@mui/material';
import { styled } from '@mui/material/styles';

/**
 * Styled Paper card used as a container for dashboard panels
 * (Control, Parameters, MachineStatus, TestRunner, etc.).
 */
export const CardPanel = styled(Paper)(({ theme }) => ({
  backgroundColor: theme.palette.mode === 'dark' ? '#1A2027' : '#fff',
  ...theme.typography.body2,
  padding: theme.spacing(1),
  textAlign: 'center',
  color: theme.palette.text.secondary,
}));
