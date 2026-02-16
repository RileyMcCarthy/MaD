import React, { useState } from 'react';
import {
  Box,
  Button,
  Grid,
  TextField,
  Typography,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Divider,
  Paper,
  SelectChangeEvent,
  Snackbar,
  Alert,
  IconButton,
} from '@mui/material';
import {
  Save as SaveIcon,
  FolderOpen as LoadIcon,
  Add as AddIcon,
  Code as CodeIcon,
  DragIndicator,
  FileUpload as ImportIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { styled } from '@mui/material/styles';
import {
  DragDropContext,
  Droppable,
  Draggable,
  DropResult,
} from '@hello-pangea/dnd';
import {
  SampleProfile,
  MotionProfile,
  TestProfile,
  Move,
} from '@shared/SharedInterface';
import GCodeGenerator from '../components/GCodeGenerator';
import { componentLogger } from '../utils/logger';
import { useProfiles } from '../hooks';

const Item = styled(Box)(({ theme }) => ({
  backgroundColor: theme.palette.mode === 'dark' ? '#1A2027' : '#f8f9fa',
  padding: 16,
  textAlign: 'center',
  color: theme.palette.text.secondary,
  position: 'relative',
  cursor: 'grab',
  '&:active': {
    cursor: 'grabbing',
  },
  borderRadius: 4,
  border: `1px solid ${theme.palette.divider}`,
  boxShadow: theme.shadows[1],
  '&:hover': {
    boxShadow: theme.shadows[2],
  },
}));

const MoveItem = styled(Box)(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: 8,
  backgroundColor: theme.palette.mode === 'dark' ? '#1A2027' : '#ffffff',
  borderRadius: 4,
  marginBottom: 8,
  width: '100%',
  flexWrap: 'nowrap',
  border: `1px solid ${theme.palette.divider}`,
  '&:hover': {
    backgroundColor: theme.palette.mode === 'dark' ? '#2A3037' : '#f5f5f5',
  },
}));

const DeleteButton = styled(Button)(({ theme }) => ({
  minWidth: '32px',
  width: '32px',
  height: '32px',
  padding: 0,
  marginLeft: 'auto',
  flexShrink: 0,
  color: theme.palette.error.main,
}));

const FormControlStyled = styled(FormControl)(({ theme }) => ({
  flex: 1,
  minWidth: 0,
  '& .MuiSelect-root': {
    width: '100%',
    color: theme.palette.text.primary,
  },
}));

const TextFieldStyled = styled(TextField)(({ theme }) => ({
  flex: 1,
  minWidth: 0,
  '& .MuiInputBase-root': {
    width: '100%',
    color: theme.palette.text.primary,
  },
  '& .MuiInputLabel-root': {
    color: theme.palette.text.secondary,
  },
}));

const initialMoveParameters = {
  position: 0,
  velocity: 0,
  distance: 0,
  time: 0,
  circularOffset: 0,
};

const initialMove: Move = {
  moveType: 'linear',
  absoluteOrRelative: 'absolute',
  moveParameters: initialMoveParameters,
};

const initialSet = {
  name: 'Set',
  executions: 1,
  moves: [initialMove],
};

const DragHandle = styled('div')(() => ({
  position: 'absolute',
  right: 8,
  top: 8,
  cursor: 'grab',
  zIndex: 2,
  '&:active': {
    cursor: 'grabbing',
  },
}));

const TestProfileForm: React.FC = () => {
  const [sampleProfile, setSampleProfile] = useState<SampleProfile>({
    maxForce: 0,
    maxVelocity: 0,
    maxDisplacement: 0,
    sampleWidth: 0,
    sampleThickness: 0,
  });
  const [sampleName, setSampleName] = useState<string>('');

  const [motionProfile, setMotionProfile] = useState<MotionProfile>({
    name: '',
    description: '',
    sets: [],
  });

  const [sets, setSets] = useState([initialSet]);
  const [openDialog, setOpenDialog] = useState(false);

  // ── Database-backed profile lists (shared hook) ─────────────────
  const {
    sampleProfiles: savedSampleProfiles,
    motionProfiles: savedMotionProfiles,
    refreshProfiles,
  } = useProfiles();

  const [selectedSampleProfileId, setSelectedSampleProfileId] = useState<string>('');
  const [selectedMotionProfileId, setSelectedMotionProfileId] = useState<string>('');

  // ── Feedback ────────────────────────────────────────────────────
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' | 'info' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const showSnackbar = (message: string, severity: 'success' | 'error' | 'info' = 'success') => {
    setSnackbar({ open: true, message, severity });
  };

  // ── Save to database ────────────────────────────────────────────
  const handleSaveSampleProfile = async () => {
    if (!sampleName) {
      showSnackbar('Please enter a sample name before saving', 'error');
      return;
    }
    try {
      const result = await window.electron.ipcRenderer.invoke('data-save-sample-profile', sampleName, sampleProfile) as { exists?: boolean; name?: string; entry?: SampleProfileEntry };
      if (result.exists) {
        // eslint-disable-next-line no-restricted-globals
        const overwrite = confirm(`A sample profile named "${result.name}" already exists. Replace it?`);
        if (!overwrite) return;
        await window.electron.ipcRenderer.invoke('data-overwrite-sample-profile', sampleName, sampleProfile);
      }
      await refreshProfiles();
      showSnackbar(`Sample profile "${sampleName}" saved`);
    } catch (error) {
      showSnackbar('Failed to save sample profile', 'error');
    }
  };

  const handleSaveMotionProfile = async () => {
    if (!motionProfile.name) {
      showSnackbar('Please enter a profile name before saving', 'error');
      return;
    }
    // Sync sets into motionProfile before saving
    const profileToSave = { ...motionProfile, sets };
    try {
      const result = await window.electron.ipcRenderer.invoke('data-save-motion-profile', profileToSave) as { exists?: boolean; name?: string; entry?: MotionProfileEntry };
      if (result.exists) {
        // eslint-disable-next-line no-restricted-globals
        const overwrite = confirm(`A motion profile named "${result.name}" already exists. Replace it?`);
        if (!overwrite) return;
        await window.electron.ipcRenderer.invoke('data-overwrite-motion-profile', profileToSave);
      }
      await refreshProfiles();
      showSnackbar(`Motion profile "${motionProfile.name}" saved`);
    } catch (error) {
      showSnackbar('Failed to save motion profile', 'error');
    }
  };

  // ── Load from database via dropdown ─────────────────────────────
  const handleLoadSampleProfile = (profileId: string) => {
    setSelectedSampleProfileId(profileId);
    const entry = savedSampleProfiles.find((p) => p.id === profileId);
    if (entry) {
      setSampleProfile(entry.profile);
      setSampleName(entry.name);
      showSnackbar(`Loaded sample profile "${entry.name}"`, 'info');
    }
  };

  const handleLoadMotionProfile = (profileId: string) => {
    setSelectedMotionProfileId(profileId);
    const entry = savedMotionProfiles.find((p) => p.id === profileId);
    if (entry) {
      setMotionProfile(entry.profile);
      setSets(entry.profile.sets.length > 0 ? entry.profile.sets : [initialSet]);
      showSnackbar(`Loaded motion profile "${entry.name}"`, 'info');
    }
  };

  // ── Delete from database ────────────────────────────────────────
  const handleDeleteSampleProfile = async (profileId: string) => {
    try {
      await window.electron.ipcRenderer.invoke('data-delete-sample-profile', profileId);
      if (selectedSampleProfileId === profileId) setSelectedSampleProfileId('');
      await refreshProfiles();
      showSnackbar('Sample profile deleted', 'info');
    } catch (error) {
      showSnackbar('Failed to delete sample profile', 'error');
    }
  };

  const handleDeleteMotionProfile = async (profileId: string) => {
    try {
      await window.electron.ipcRenderer.invoke('data-delete-motion-profile', profileId);
      if (selectedMotionProfileId === profileId) setSelectedMotionProfileId('');
      await refreshProfiles();
      showSnackbar('Motion profile deleted', 'info');
    } catch (error) {
      showSnackbar('Failed to delete motion profile', 'error');
    }
  };

  // ── Import from file (secondary option) ─────────────────────────
  const handleImportSampleProfileFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const loadedProfile = JSON.parse(content) as SampleProfile;
      setSampleProfile(loadedProfile);
      const importName = file.name.replace(/\.sp$/i, '') || 'profile';
      setSampleName(importName);
      await window.electron.ipcRenderer.invoke('data-overwrite-sample-profile', importName, loadedProfile);
      await refreshProfiles();
      showSnackbar(`Imported and saved "${importName}"`, 'success');
    } catch (error) {
      showSnackbar('Failed to import sample profile', 'error');
    }
    // eslint-disable-next-line no-param-reassign
    event.target.value = '';
  };

  const handleImportMotionProfileFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const loadedProfile = JSON.parse(content) as MotionProfile;
      setMotionProfile(loadedProfile);
      setSets(loadedProfile.sets.length > 0 ? loadedProfile.sets : [initialSet]);
      await window.electron.ipcRenderer.invoke('data-overwrite-motion-profile', loadedProfile);
      await refreshProfiles();
      showSnackbar(`Imported and saved "${loadedProfile.name || 'profile'}"`, 'success');
    } catch (error) {
      showSnackbar('Failed to import motion profile', 'error');
    }
    // eslint-disable-next-line no-param-reassign
    event.target.value = '';
  };

  const handleOpenDialog = () => {
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
  };

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const reorderedSets = Array.from(sets);
    const [movedSet] = reorderedSets.splice(result.source.index, 1);
    reorderedSets.splice(result.destination.index, 0, movedSet);
    setSets(reorderedSets);
    setMotionProfile({
      ...motionProfile,
      sets: reorderedSets,
    });
  };

  const handleMotionProfileChange =
    (field: keyof MotionProfile) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target;
      setMotionProfile((prev) => ({
        ...prev,
        [field]: value,
      }));
    };

  const handleSampleProfileChange =
    (field: keyof SampleProfile) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target;
      setSampleProfile((prev) => ({
        ...prev,
        [field]: Number(value),
      }));
    };

  const handleSetChange =
    (index: number, field: string) =>
    (event: React.ChangeEvent<HTMLInputElement | { value: unknown }>) => {
      const newSets = [...sets];
      newSets[index] = {
        ...newSets[index],
        [field]: event.target.value,
      };
      setSets(newSets);
      setMotionProfile({
        ...motionProfile,
        sets: newSets,
      });
    };

  const handleMoveDragEnd = (setIndex: number, result: DropResult) => {
    if (!result.destination) return;
    const newSets = [...sets];
    const reorderedMoves = Array.from(newSets[setIndex].moves);
    const [movedMove] = reorderedMoves.splice(result.source.index, 1);
    reorderedMoves.splice(result.destination.index, 0, movedMove);
    newSets[setIndex] = {
      ...newSets[setIndex],
      moves: reorderedMoves,
    };
    setSets(newSets);
    setMotionProfile({
      ...motionProfile,
      sets: newSets,
    });
  };

  const handleMoveChange =
    (setIndex: number, moveIndex: number, field: keyof Move) =>
    (event: SelectChangeEvent<string>) => {
      const newSets = [...sets];
      newSets[setIndex] = {
        ...newSets[setIndex],
        moves: newSets[setIndex].moves.map((move, i) => {
          if (i === moveIndex) {
            return {
              ...move,
              [field]: event.target.value,
            };
          }
          return move;
        }),
      };
      setSets(newSets);
      setMotionProfile({
        ...motionProfile,
        sets: newSets,
      });
    };

  const handleAddMove = (setIndex: number) => {
    const newSets = [...sets];
    newSets[setIndex] = {
      ...newSets[setIndex],
      moves: [...newSets[setIndex].moves, initialMove],
    };
    setSets(newSets);
    setMotionProfile({
      ...motionProfile,
      sets: newSets,
    });
  };

  const handleDeleteMove = (setIndex: number, moveIndex: number) => {
    const newSets = [...sets];
    newSets[setIndex] = {
      ...newSets[setIndex],
      moves: newSets[setIndex].moves.filter((_, i) => i !== moveIndex),
    };
    setSets(newSets);
    setMotionProfile({
      ...motionProfile,
      sets: newSets,
    });
  };

  const handleMoveParameterChange =
    (setIndex: number, moveIndex: number, field: string) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const newSets = [...sets];
      const inputValue = event.target.value;
      newSets[setIndex] = {
        ...newSets[setIndex],
        moves: newSets[setIndex].moves.map((move, i) => {
          if (i === moveIndex) {
            return {
              ...move,
              moveParameters: {
                ...move.moveParameters,
                [field]: inputValue,
              },
            };
          }
          return move;
        }),
      };
      setSets(newSets);
      setMotionProfile({
        ...motionProfile,
        sets: newSets,
      });
    };

  const handleSaveSet = async (index: number) => {
    const set = sets[index];
    if (!set.name) {
      alert('Please enter a set name before saving.');
      return;
    }
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'data-save-set',
        set,
      );
      if (result.exists) {
        const overwrite = window.confirm(
          `A set named "${result.name}" already exists. Do you want to replace it?`,
        );
        if (!overwrite) return;
        await window.electron.ipcRenderer.invoke('data-overwrite-set', set);
      }
    } catch (error) {
      componentLogger.error('Failed to save set:', error);
    }
  };

  const handleLoadSet = async (index: number) => {
    try {
      const savedSets = await window.electron.ipcRenderer.invoke('data-get-sets');
      if (!savedSets || savedSets.length === 0) {
        alert('No saved sets found.');
        return;
      }
      // Show a simple selection dialog using the set names
      const setNames = savedSets.map((s: { name: string }) => s.name);
      const selectedName = window.prompt(
        `Available sets:\n${setNames.map((n: string, i: number) => `${i + 1}. ${n}`).join('\n')}\n\nEnter the number of the set to load:`,
      );
      if (!selectedName) return;
      const selectedIndex = parseInt(selectedName, 10) - 1;
      if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= savedSets.length) {
        alert('Invalid selection.');
        return;
      }
      const loadedSet = savedSets[selectedIndex];
      const newSets = [...sets];
      newSets[index] = loadedSet;
      setSets(newSets);
      setMotionProfile({
        ...motionProfile,
        sets: newSets,
      });
    } catch (error) {
      componentLogger.error('Failed to load set:', error);
    }
  };

  const handleDeleteSet = (index: number) => {
    const newSets = sets.filter((_, i) => i !== index);
    setSets(newSets);
    setMotionProfile({
      ...motionProfile,
      sets: newSets,
    });
  };

  return (
    <Box
      sx={{
        p: 4,
        pt: 4,
        height: 'calc(100vh - 64px)', // Subtract header height
        overflowY: 'auto',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {/* Sample Profile Section */}
      <Paper elevation={2} sx={{ p: 3 }}>
        <Typography variant="h5" sx={{ mb: 3, fontWeight: 'bold' }}>
          Sample Profile
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={4}>
            <TextField
              label="Max Force (N)"
              type="number"
              value={sampleProfile.maxForce}
              onChange={handleSampleProfileChange('maxForce')}
              fullWidth
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              label="Max Velocity (mm/s)"
              type="number"
              value={sampleProfile.maxVelocity}
              onChange={handleSampleProfileChange('maxVelocity')}
              fullWidth
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              label="Max Displacement (mm)"
              type="number"
              value={sampleProfile.maxDisplacement}
              onChange={handleSampleProfileChange('maxDisplacement')}
              fullWidth
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              label="Sample Width (mm)"
              type="number"
              value={sampleProfile.sampleWidth}
              onChange={handleSampleProfileChange('sampleWidth')}
              fullWidth
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              label="Sample Thickness (mm)"
              type="number"
              value={sampleProfile.sampleThickness}
              onChange={handleSampleProfileChange('sampleThickness')}
              fullWidth
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              label="Sample Name"
              value={sampleName}
              onChange={(e) => setSampleName(e.target.value)}
              fullWidth
            />
          </Grid>
        </Grid>
        <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* Load from saved profiles */}
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <FormControl sx={{ flex: 1 }} size="small">
              <InputLabel>Load Saved Profile</InputLabel>
              <Select
                value={selectedSampleProfileId}
                label="Load Saved Profile"
                onChange={(e) => handleLoadSampleProfile(e.target.value as string)}
              >
                {savedSampleProfiles.map((sp) => (
                  <MenuItem key={sp.id} value={sp.id}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                      <span>{sp.name} — {sp.profile.maxForce}N, {sp.profile.maxDisplacement}mm</span>
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {selectedSampleProfileId && (
              <IconButton
                size="small"
                color="error"
                onClick={() => handleDeleteSampleProfile(selectedSampleProfileId)}
                title="Delete selected profile"
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            )}
            <IconButton
              size="small"
              onClick={() => window.electron.ipcRenderer.invoke('data-open-data-dir')}
              title="Open profiles folder"
            >
              <LoadIcon fontSize="small" />
            </IconButton>
          </Box>
          {/* Action buttons */}
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              variant="contained"
              color="primary"
              startIcon={<SaveIcon />}
              onClick={handleSaveSampleProfile}
            >
              Save Sample Profile
            </Button>
            <Button
              variant="outlined"
              component="label"
              startIcon={<ImportIcon />}
            >
              Import from File
              <input
                type="file"
                accept=".sp"
                hidden
                onChange={handleImportSampleProfileFile}
              />
            </Button>
          </Box>
        </Box>
      </Paper>

      <Divider sx={{ my: 2 }} />

      {/* Motion Profile Section */}
      <Paper elevation={2} sx={{ p: 3 }}>
        <Typography variant="h5" sx={{ mb: 3, fontWeight: 'bold' }}>
          Motion Profile
        </Typography>
        <Grid container spacing={2} sx={{ mb: 4 }}>
          <Grid item xs={12} sm={6}>
            <TextField
              label="Name"
              value={motionProfile.name}
              onChange={handleMotionProfileChange('name')}
              fullWidth
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              label="Description"
              value={motionProfile.description}
              onChange={handleMotionProfileChange('description')}
              fullWidth
            />
          </Grid>
        </Grid>

        {/* Sets Section */}
        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="sets">
            {(provided) => (
              <Grid
                container
                spacing={2}
                sx={{ px: 0 }}
                {...provided.droppableProps}
                ref={provided.innerRef}
              >
                {sets.map((set, setIndex) => (
                  <Draggable
                    key={setIndex}
                    draggableId={`set-${setIndex}`}
                    index={setIndex}
                  >
                    {(provided) => (
                      <Grid
                        item
                        xs={12}
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                      >
                        <Item>
                          <DragHandle {...provided.dragHandleProps}>
                            <DragIndicator />
                          </DragHandle>
                          <Grid container spacing={2}>
                            <Grid item xs={12} sm={6} md={4}>
                              <TextField
                                label="Set Name"
                                value={set.name}
                                onChange={handleSetChange(setIndex, 'name')}
                                fullWidth
                              />
                            </Grid>
                            <Grid item xs={12} sm={6} md={4}>
                              <TextField
                                label="Executions"
                                type="number"
                                value={set.executions}
                                onChange={handleSetChange(
                                  setIndex,
                                  'executions',
                                )}
                                fullWidth
                              />
                            </Grid>
                            <Grid item xs={12}>
                              <DragDropContext
                                onDragEnd={(result) =>
                                  handleMoveDragEnd(setIndex, result)
                                }
                              >
                                <Droppable droppableId={`moves-${setIndex}`}>
                                  {(provided) => (
                                    <Grid
                                      container
                                      spacing={2}
                                      {...provided.droppableProps}
                                      ref={provided.innerRef}
                                    >
                                      {set.moves.map((move, moveIndex) => (
                                        <Draggable
                                          key={moveIndex}
                                          draggableId={`move-${setIndex}-${moveIndex}`}
                                          index={moveIndex}
                                        >
                                          {(provided) => (
                                            <Grid
                                              item
                                              xs={12}
                                              ref={provided.innerRef}
                                              {...provided.draggableProps}
                                            >
                                              <MoveItem>
                                                <FormControlStyled>
                                                  <Select
                                                    value={move.moveType}
                                                    onChange={handleMoveChange(
                                                      setIndex,
                                                      moveIndex,
                                                      'moveType',
                                                    )}
                                                    size="small"
                                                  >
                                                    <MenuItem value="linear">
                                                      Linear
                                                    </MenuItem>
                                                    <MenuItem value="dwell">
                                                      Dwell
                                                    </MenuItem>
                                                    <MenuItem value="arc">
                                                      Arc
                                                    </MenuItem>
                                                    <MenuItem value="math">
                                                      Math
                                                    </MenuItem>
                                                  </Select>
                                                </FormControlStyled>

                                                {move.moveType !== 'dwell' && (
                                                  <FormControlStyled>
                                                    <Select
                                                      value={
                                                        move.absoluteOrRelative
                                                      }
                                                      onChange={handleMoveChange(
                                                        setIndex,
                                                        moveIndex,
                                                        'absoluteOrRelative',
                                                      )}
                                                      size="small"
                                                    >
                                                      <MenuItem value="absolute">
                                                        Absolute
                                                      </MenuItem>
                                                      <MenuItem value="relative">
                                                        Relative
                                                      </MenuItem>
                                                    </Select>
                                                  </FormControlStyled>
                                                )}

                                                {move.moveType === 'linear' &&
                                                  move.absoluteOrRelative ===
                                                    'absolute' && (
                                                    <>
                                                      <TextFieldStyled
                                                        label="Position (mm)"
                                                        type="text"
                                                        value={
                                                          move.moveParameters
                                                            .position
                                                        }
                                                        onChange={handleMoveParameterChange(
                                                          setIndex,
                                                          moveIndex,
                                                          'position',
                                                        )}
                                                        size="small"
                                                      />
                                                      <TextFieldStyled
                                                        label="Velocity (mm/s)"
                                                        type="number"
                                                        value={
                                                          move.moveParameters
                                                            .velocity
                                                        }
                                                        onChange={handleMoveParameterChange(
                                                          setIndex,
                                                          moveIndex,
                                                          'velocity',
                                                        )}
                                                        size="small"
                                                      />
                                                    </>
                                                  )}

                                                {move.moveType === 'linear' &&
                                                  move.absoluteOrRelative ===
                                                    'relative' && (
                                                    <>
                                                      <TextFieldStyled
                                                        label="Distance (mm)"
                                                        type="text"
                                                        value={
                                                          move.moveParameters
                                                            .distance
                                                        }
                                                        onChange={handleMoveParameterChange(
                                                          setIndex,
                                                          moveIndex,
                                                          'distance',
                                                        )}
                                                        size="small"
                                                      />
                                                      <TextFieldStyled
                                                        label="Velocity (mm/s)"
                                                        type="number"
                                                        value={
                                                          move.moveParameters
                                                            .velocity
                                                        }
                                                        onChange={handleMoveParameterChange(
                                                          setIndex,
                                                          moveIndex,
                                                          'velocity',
                                                        )}
                                                        size="small"
                                                      />
                                                    </>
                                                  )}

                                                {move.moveType === 'dwell' && (
                                                  <TextFieldStyled
                                                    label="Time (ms)"
                                                    type="number"
                                                    value={
                                                      move.moveParameters.time
                                                    }
                                                    onChange={handleMoveParameterChange(
                                                      setIndex,
                                                      moveIndex,
                                                      'time',
                                                    )}
                                                    size="small"
                                                  />
                                                )}

                                                {move.moveType === 'arc' &&
                                                  move.absoluteOrRelative ===
                                                    'absolute' && (
                                                    <>
                                                      <TextFieldStyled
                                                        label="Position"
                                                        type="text"
                                                        value={
                                                          move.moveParameters
                                                            .position
                                                        }
                                                        onChange={handleMoveParameterChange(
                                                          setIndex,
                                                          moveIndex,
                                                          'position',
                                                        )}
                                                        size="small"
                                                      />
                                                      <TextFieldStyled
                                                        label="Circular Offset"
                                                        type="number"
                                                        value={
                                                          move.moveParameters
                                                            .circularOffset
                                                        }
                                                        onChange={handleMoveParameterChange(
                                                          setIndex,
                                                          moveIndex,
                                                          'circularOffset',
                                                        )}
                                                        size="small"
                                                      />
                                                    </>
                                                  )}

                                                {move.moveType === 'arc' &&
                                                  move.absoluteOrRelative ===
                                                    'relative' && (
                                                    <>
                                                      <TextFieldStyled
                                                        label="Distance"
                                                        type="text"
                                                        value={
                                                          move.moveParameters
                                                            .distance
                                                        }
                                                        onChange={handleMoveParameterChange(
                                                          setIndex,
                                                          moveIndex,
                                                          'distance',
                                                        )}
                                                        size="small"
                                                      />
                                                      <TextFieldStyled
                                                        label="Circular Offset"
                                                        type="number"
                                                        value={
                                                          move.moveParameters
                                                            .circularOffset
                                                        }
                                                        onChange={handleMoveParameterChange(
                                                          setIndex,
                                                          moveIndex,
                                                          'circularOffset',
                                                        )}
                                                        size="small"
                                                      />
                                                    </>
                                                  )}

                                                <DeleteButton
                                                  variant="contained"
                                                  color="error"
                                                  onClick={() =>
                                                    handleDeleteMove(
                                                      setIndex,
                                                      moveIndex,
                                                    )
                                                  }
                                                  size="small"
                                                >
                                                  ×
                                                </DeleteButton>
                                              </MoveItem>
                                            </Grid>
                                          )}
                                        </Draggable>
                                      ))}
                                      {provided.placeholder}
                                    </Grid>
                                  )}
                                </Droppable>
                              </DragDropContext>
                              <Box
                                sx={{
                                  display: 'flex',
                                  justifyContent: 'center',
                                  my: 2,
                                }}
                              >
                                <Button
                                  variant="outlined"
                                  color="primary"
                                  startIcon={<AddIcon />}
                                  onClick={() => handleAddMove(setIndex)}
                                  size="small"
                                >
                                  Add Move
                                </Button>
                              </Box>
                            </Grid>
                            <Grid item xs={12}>
                              <Box sx={{ display: 'flex', gap: 2 }}>
                                <Button
                                  variant="contained"
                                  color="primary"
                                  startIcon={<SaveIcon />}
                                  onClick={() => handleSaveSet(setIndex)}
                                  sx={{ flex: 1 }}
                                >
                                  Save Set
                                </Button>
                                <Button
                                  variant="contained"
                                  color="secondary"
                                  startIcon={<LoadIcon />}
                                  onClick={() => handleLoadSet(setIndex)}
                                  sx={{ flex: 1 }}
                                >
                                  Load Set
                                </Button>
                                <Button
                                  variant="contained"
                                  color="error"
                                  onClick={() => handleDeleteSet(setIndex)}
                                  sx={{ flex: 1 }}
                                >
                                  Delete Set
                                </Button>
                              </Box>
                            </Grid>
                          </Grid>
                        </Item>
                      </Grid>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </Grid>
            )}
          </Droppable>
        </DragDropContext>

        <Box sx={{ display: 'flex', justifyContent: 'center', my: 3 }}>
          <Button
            variant="outlined"
            color="primary"
            startIcon={<AddIcon />}
            onClick={() => {
              const newSets = [
                ...sets,
                { ...initialSet, name: `Set ${sets.length + 1}` },
              ];
              setSets(newSets);
              setMotionProfile({
                ...motionProfile,
                sets: newSets,
              });
            }}
          >
            Add Set
          </Button>
        </Box>

        <Box sx={{ mt: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* Load from saved profiles */}
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <FormControl sx={{ flex: 1 }} size="small">
              <InputLabel>Load Saved Profile</InputLabel>
              <Select
                value={selectedMotionProfileId}
                label="Load Saved Profile"
                onChange={(e) => handleLoadMotionProfile(e.target.value as string)}
              >
                {savedMotionProfiles.map((mp) => (
                  <MenuItem key={mp.id} value={mp.id}>
                    {mp.name}{mp.description ? ` — ${mp.description}` : ''}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {selectedMotionProfileId && (
              <IconButton
                size="small"
                color="error"
                onClick={() => handleDeleteMotionProfile(selectedMotionProfileId)}
                title="Delete selected profile"
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            )}
            <IconButton
              size="small"
              onClick={() => window.electron.ipcRenderer.invoke('data-open-data-dir')}
              title="Open profiles folder"
            >
              <LoadIcon fontSize="small" />
            </IconButton>
          </Box>
          {/* Action buttons */}
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              variant="contained"
              color="primary"
              startIcon={<SaveIcon />}
              onClick={handleSaveMotionProfile}
            >
              Save Motion Profile
            </Button>
            <Button
              variant="outlined"
              component="label"
              startIcon={<ImportIcon />}
            >
              Import from File
              <input
                type="file"
                accept=".mp"
                hidden
                onChange={handleImportMotionProfileFile}
              />
            </Button>
            <Button
              variant="contained"
              color="primary"
              startIcon={<CodeIcon />}
              onClick={handleOpenDialog}
            >
              Preview G-code
            </Button>
          </Box>
        </Box>
      </Paper>

      <Dialog
        open={openDialog}
        onClose={handleCloseDialog}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Generated G-code and Graph</DialogTitle>
        <DialogContent>
          <GCodeGenerator
            profile={{ ...motionProfile, sampleProfile } as TestProfile}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog} color="primary">
            Close
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
          severity={snackbar.severity}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default TestProfileForm;
