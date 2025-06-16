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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Divider,
  Paper,
  SelectChangeEvent,
  CircularProgress,
} from '@mui/material';
import {
  Save as SaveIcon,
  FolderOpen as LoadIcon,
  Add as AddIcon,
  Code as CodeIcon,
  DragIndicator,
  PlayArrow as PlayArrowIcon,
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
import GCodeGenerator from './components/GCodeGenerator';

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

const initialSampleProfile: SampleProfile = {
  maxForce: 0,
  maxVelocity: 0,
  maxDisplacement: 0,
  sampleWidth: 0,
  serialNumber: '',
};

const initialMotionProfile: MotionProfile = {
  name: 'Default',
  description: '',
  sets: [initialSet],
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

const MoveDragHandle = styled('div')(({ theme }) => ({
  position: 'absolute',
  right: theme.spacing(1),
  top: '50%',
  transform: 'translateY(-50%)',
  cursor: 'grab',
  zIndex: 1,
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
    serialNumber: '',
  });

  const [motionProfile, setMotionProfile] = useState<MotionProfile>({
    name: '',
    description: '',
    sets: [],
  });

  const [sets, setSets] = useState([initialSet]);
  const [openDialog, setOpenDialog] = useState(false);

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

  const handleMotionProfileChange = (field: keyof MotionProfile) => (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const value = event.target.value;
    setMotionProfile((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleSampleProfileChange = (field: keyof SampleProfile) => (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const value = event.target.value;
    setSampleProfile((prev) => ({
      ...prev,
      [field]: field === 'serialNumber' ? value : Number(value),
    }));
  };

  const handleSetChange = (index: number, field: string) => (event: React.ChangeEvent<HTMLInputElement | { value: unknown }>) => {
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

  const handleMoveChange = (setIndex: number, moveIndex: number, field: keyof Move) => (event: SelectChangeEvent<string>) => {
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

  const handleMoveParameterChange = (setIndex: number, moveIndex: number, field: string) => (event: React.ChangeEvent<HTMLInputElement>) => {
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

  const handleSaveProfile = () => {
    const jsonProfile = JSON.stringify(motionProfile, null, 2);
    const blob = new Blob([jsonProfile], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${motionProfile.name}.mp`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadProfile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const jsonProfile = e.target?.result as string;
        const loadedProfile = JSON.parse(jsonProfile) as MotionProfile;
        setMotionProfile(loadedProfile);
        setSets(loadedProfile.sets);
      };
      reader.readAsText(file);
    }
  };

  const handleSaveSet = (index: number) => {
    const set = sets[index];
    const jsonSet = JSON.stringify(set, null, 2);
    const blob = new Blob([jsonSet], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${set.name || `set_${index + 1}`}.set`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadSet = (index: number, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const jsonSet = e.target?.result as string;
        const loadedSet = JSON.parse(jsonSet);
        const newSets = [...sets];
        newSets[index] = loadedSet;
        setSets(newSets);
        setMotionProfile({
          ...motionProfile,
          sets: newSets,
        });
      };
      reader.readAsText(file);
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
    <Box sx={{
      p: 4,
      pt: 4,
      height: 'calc(100vh - 64px)', // Subtract header height
      overflowY: 'auto',
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }}>
      {/* Sample Profile Section */}
      <Paper elevation={2} sx={{ p: 3 }}>
        <Typography variant="h5" sx={{ mb: 3, fontWeight: 'bold' }}>Sample Profile</Typography>
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
              label="Serial Number"
              value={sampleProfile.serialNumber}
              onChange={handleSampleProfileChange('serialNumber')}
              fullWidth
            />
          </Grid>
        </Grid>
        <Box sx={{ mt: 2, display: 'flex', gap: 2 }}>
          <Button
            variant="contained"
            color="primary"
            startIcon={<SaveIcon />}
            onClick={() => {
              const jsonProfile = JSON.stringify(sampleProfile, null, 2);
              const blob = new Blob([jsonProfile], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${sampleProfile.serialNumber}.sp`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Save Sample Profile
          </Button>
          <Button
            variant="contained"
            color="secondary"
            startIcon={<LoadIcon />}
            component="label"
          >
            Load Sample Profile
            <input
              type="file"
              accept=".sp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onload = (e) => {
                    const jsonProfile = e.target?.result as string;
                    const loadedProfile = JSON.parse(jsonProfile) as SampleProfile;
                    setSampleProfile(loadedProfile);
                  };
                  reader.readAsText(file);
                }
              }}
            />
          </Button>
        </Box>
      </Paper>

      <Divider sx={{ my: 2 }} />

      {/* Motion Profile Section */}
      <Paper elevation={2} sx={{ p: 3 }}>
        <Typography variant="h5" sx={{ mb: 3, fontWeight: 'bold' }}>Motion Profile</Typography>
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
                  <Draggable key={setIndex} draggableId={`set-${setIndex}`} index={setIndex}>
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
                                onChange={handleSetChange(setIndex, 'executions')}
                                fullWidth
                              />
                            </Grid>
                            <Grid item xs={12}>
                              <DragDropContext onDragEnd={(result) => handleMoveDragEnd(setIndex, result)}>
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
                                                    onChange={handleMoveChange(setIndex, moveIndex, 'moveType')}
                                                    size="small"
                                                  >
                                                    <MenuItem value="linear">Linear</MenuItem>
                                                    <MenuItem value="dwell">Dwell</MenuItem>
                                                    <MenuItem value="arc">Arc</MenuItem>
                                                    <MenuItem value="math">Math</MenuItem>
                                                  </Select>
                                                </FormControlStyled>

                                                {move.moveType !== 'dwell' && (
                                                  <FormControlStyled>
                                                    <Select
                                                      value={move.absoluteOrRelative}
                                                      onChange={handleMoveChange(setIndex, moveIndex, 'absoluteOrRelative')}
                                                      size="small"
                                                    >
                                                      <MenuItem value="absolute">Absolute</MenuItem>
                                                      <MenuItem value="relative">Relative</MenuItem>
                                                    </Select>
                                                  </FormControlStyled>
                                                )}

                                                {move.moveType === 'linear' && move.absoluteOrRelative === 'absolute' && (
                                                  <>
                                                    <TextFieldStyled
                                                      label="Position (mm)"
                                                      type="text"
                                                      value={move.moveParameters.position}
                                                      onChange={handleMoveParameterChange(setIndex, moveIndex, 'position')}
                                                      size="small"
                                                    />
                                                    <TextFieldStyled
                                                      label="Velocity (mm/s)"
                                                      type="number"
                                                      value={move.moveParameters.velocity}
                                                      onChange={handleMoveParameterChange(setIndex, moveIndex, 'velocity')}
                                                      size="small"
                                                    />
                                                  </>
                                                )}

                                                {move.moveType === 'linear' && move.absoluteOrRelative === 'relative' && (
                                                  <>
                                                    <TextFieldStyled
                                                      label="Distance (mm)"
                                                      type="text"
                                                      value={move.moveParameters.distance}
                                                      onChange={handleMoveParameterChange(setIndex, moveIndex, 'distance')}
                                                      size="small"
                                                    />
                                                    <TextFieldStyled
                                                      label="Velocity (mm/s)"
                                                      type="number"
                                                      value={move.moveParameters.velocity}
                                                      onChange={handleMoveParameterChange(setIndex, moveIndex, 'velocity')}
                                                      size="small"
                                                    />
                                                  </>
                                                )}

                                                {move.moveType === 'dwell' && (
                                                  <TextFieldStyled
                                                    label="Time (ms)"
                                                    type="number"
                                                    value={move.moveParameters.time}
                                                    onChange={handleMoveParameterChange(setIndex, moveIndex, 'time')}
                                                    size="small"
                                                  />
                                                )}

                                                {move.moveType === 'arc' && move.absoluteOrRelative === 'absolute' && (
                                                  <>
                                                    <TextFieldStyled
                                                      label="Position"
                                                      type="text"
                                                      value={move.moveParameters.position}
                                                      onChange={handleMoveParameterChange(setIndex, moveIndex, 'position')}
                                                      size="small"
                                                    />
                                                    <TextFieldStyled
                                                      label="Circular Offset"
                                                      type="number"
                                                      value={move.moveParameters.circularOffset}
                                                      onChange={handleMoveParameterChange(setIndex, moveIndex, 'circularOffset')}
                                                      size="small"
                                                    />
                                                  </>
                                                )}

                                                {move.moveType === 'arc' && move.absoluteOrRelative === 'relative' && (
                                                  <>
                                                    <TextFieldStyled
                                                      label="Distance"
                                                      type="text"
                                                      value={move.moveParameters.distance}
                                                      onChange={handleMoveParameterChange(setIndex, moveIndex, 'distance')}
                                                      size="small"
                                                    />
                                                    <TextFieldStyled
                                                      label="Circular Offset"
                                                      type="number"
                                                      value={move.moveParameters.circularOffset}
                                                      onChange={handleMoveParameterChange(setIndex, moveIndex, 'circularOffset')}
                                                      size="small"
                                                    />
                                                  </>
                                                )}

                                                <DeleteButton
                                                  variant="contained"
                                                  color="error"
                                                  onClick={() => handleDeleteMove(setIndex, moveIndex)}
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
                              <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
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
                                  component="label"
                                  sx={{ flex: 1 }}
                                >
                                  Load Set
                                  <input
                                    type="file"
                                    accept=".set"
                                    hidden
                                    onChange={(e) => handleLoadSet(setIndex, e)}
                                  />
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
              const newSets = [...sets, { ...initialSet, name: `Set ${sets.length + 1}` }];
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

        <Box sx={{ mt: 4, display: 'flex', gap: 2 }}>
          <Button
            variant="contained"
            color="primary"
            startIcon={<SaveIcon />}
            onClick={() => {
              const jsonProfile = JSON.stringify(motionProfile, null, 2);
              const blob = new Blob([jsonProfile], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${motionProfile.name}.mp`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Save Motion Profile
          </Button>
          <Button
            variant="contained"
            color="secondary"
            startIcon={<LoadIcon />}
            component="label"
          >
            Load Motion Profile
            <input
              type="file"
              accept=".mp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onload = (e) => {
                    const jsonProfile = e.target?.result as string;
                    const loadedProfile = JSON.parse(jsonProfile) as MotionProfile;
                    setMotionProfile(loadedProfile);
                    setSets(loadedProfile.sets);
                  };
                  reader.readAsText(file);
                }
              }}
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
      </Paper>

      <Dialog
        open={openDialog}
        onClose={handleCloseDialog}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Generated G-code and Graph</DialogTitle>
        <DialogContent>
          <GCodeGenerator profile={{ ...motionProfile, sampleProfile } as TestProfile} />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog} color="primary">
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default TestProfileForm;
