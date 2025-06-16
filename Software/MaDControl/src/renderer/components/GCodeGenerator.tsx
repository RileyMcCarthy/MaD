import React, { useState, useEffect } from 'react';
import { Box, Button, Typography, Grid } from '@mui/material';
import { LineChart } from '@mui/x-charts/LineChart';
import { TestProfile, MoveType } from '@shared/SharedInterface';
import { axisClasses } from '@mui/x-charts/ChartsAxis';

interface GCodeGeneratorProps {
  profile: TestProfile;
  onGcodeGenerated?: (gcode: string[]) => void;
}

const GCodeGenerator: React.FC<GCodeGeneratorProps> = ({ profile, onGcodeGenerated }) => {
  const [gcode, setGcode] = useState<string[]>([]);
  const [distanceData, setDistanceData] = useState<number[]>([]);
  const [timeData, setTimeData] = useState<number[]>([]);

  useEffect(() => {
    generateGcode(profile);
  }, [profile]);

  const generateGcode = (profileData: TestProfile) => {
    const gcodeLines: string[] = [];
    const distancePoints: number[] = [0];
    const timePoints: number[] = [0];
    let currentTime = 0;
    let currentPosition = 0;
    let currentMode: 'absolute' | 'relative' | undefined = undefined;

    // Add header comments
    gcodeLines.push(`; Test Profile: ${profileData.name}`);
    gcodeLines.push(`; Description: ${profileData.description}`);
    gcodeLines.push('');

    // Set initial mode to absolute
    gcodeLines.push('G90 ; Set absolute positioning');
    currentMode = 'absolute';

    profileData.sets.forEach((set, setIndex) => {
      // Add set header comment
      gcodeLines.push(`; Set ${setIndex + 1}: ${set.name} (${set.executions} executions)`);
      gcodeLines.push('');

      for (let i = 0; i < set.executions; i++) {
        // Add execution header comment
        gcodeLines.push(`; Execution ${i + 1}/${set.executions}`);

        set.moves.forEach((move) => {
          // Convert string values to numbers
          const position = Number(move.moveParameters.position) || 0;
          const velocity = Number(move.moveParameters.velocity) || 0;
          const moveDistance = Number(move.moveParameters.distance) || 0;
          const dwellTime = Number(move.moveParameters.time) || 0;
          const circularOffset = Number(move.moveParameters.circularOffset) || 0;

          const startPosition = currentPosition;
          const startTime = currentTime;

          // Set positioning mode if different from current
          if (move.absoluteOrRelative === 'absolute' && currentMode !== 'absolute') {
            gcodeLines.push('G90 ; Set absolute positioning');
            currentMode = 'absolute';
          } else if (move.absoluteOrRelative === 'relative' && currentMode !== 'relative') {
            gcodeLines.push('G91 ; Set relative positioning');
            currentMode = 'relative';
          }

          switch (move.moveType) {
            case 'linear':
              if (move.absoluteOrRelative === 'absolute') {
                gcodeLines.push(`G1 X${position} F${velocity}`);
                currentPosition = position;
                const distanceDelta = Math.abs(currentPosition - startPosition);
                currentTime += distanceDelta / (velocity || 1); // Prevent division by zero

                // Add points for straight line
                distancePoints.push(startPosition);
                timePoints.push(startTime);
                distancePoints.push(currentPosition);
                timePoints.push(currentTime);
              } else {
                gcodeLines.push(`G1 X${moveDistance} F${velocity}`);
                currentPosition += moveDistance;
                currentTime += Math.abs(moveDistance) / (velocity || 1); // Prevent division by zero

                // Add points for straight line
                distancePoints.push(startPosition);
                timePoints.push(startTime);
                distancePoints.push(currentPosition);
                timePoints.push(currentTime);
              }
              break;
            case 'dwell':
              gcodeLines.push(`G4 P${dwellTime}`);
              currentTime += dwellTime / 1000;

              // Add points for dwell (horizontal line)
              distancePoints.push(startPosition);
              timePoints.push(startTime);
              distancePoints.push(startPosition);
              timePoints.push(currentTime);
              break;
            case 'arc':
              if (move.absoluteOrRelative === 'absolute') {
                gcodeLines.push(`G2 X${position} I${circularOffset}`);
                currentPosition = position;
                // Approximate arc time based on distance and velocity
                const arcDistance = Math.abs(currentPosition - startPosition);
                currentTime += arcDistance / 100; // Assuming 100mm/s for arcs

                // Add points for curved line (approximated with multiple points)
                const numPoints = 20; // Number of points to approximate the curve
                for (let j = 0; j <= numPoints; j++) {
                  const t = j / numPoints;
                  // Use quadratic interpolation for arc approximation
                  const interpolatedPosition = startPosition + (currentPosition - startPosition) * t +
                    Math.sin(t * Math.PI) * circularOffset;
                  const interpolatedTime = startTime + (currentTime - startTime) * t;
                  distancePoints.push(interpolatedPosition);
                  timePoints.push(interpolatedTime);
                }
              } else {
                gcodeLines.push(`G2 X${moveDistance} I${circularOffset}`);
                currentPosition += moveDistance;
                // Approximate arc time based on distance and velocity
                currentTime += Math.abs(moveDistance) / 100; // Assuming 100mm/s for arcs

                // Add points for curved line (approximated with multiple points)
                const numPoints = 20; // Number of points to approximate the curve
                for (let j = 0; j <= numPoints; j++) {
                  const t = j / numPoints;
                  // Use quadratic interpolation for arc approximation
                  const interpolatedPosition = startPosition + (currentPosition - startPosition) * t +
                    Math.sin(t * Math.PI) * circularOffset;
                  const interpolatedTime = startTime + (currentTime - startTime) * t;
                  distancePoints.push(interpolatedPosition);
                  timePoints.push(interpolatedTime);
                }
              }
              break;
            case 'math':
              // Add math move handling if needed
              break;
            default:
              break;
          }
        });
      }
    });

    setGcode(gcodeLines);
    setDistanceData(distancePoints);
    setTimeData(timePoints);
    onGcodeGenerated?.(gcodeLines);
  };

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h4" gutterBottom>
        G-code Generator
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <Typography variant="h6">Generated G-code:</Typography>
          <Box
            component="pre"
            sx={{
              backgroundColor: '#f5f5f5',
              padding: 2,
              borderRadius: 1,
              maxHeight: '400px',
              overflow: 'auto',
              color: '#000000',
            }}
          >
            {gcode.join('\n')}
          </Box>
        </Grid>
        <Grid item xs={12}>
          <Typography variant="h6">Distance vs. Time Graph:</Typography>
          <LineChart
            xAxis={[{ data: timeData, label: 'Time (s)' }]}
            grid={{ horizontal: true }}
            yAxis={[
              {
                id: 'distance',
                scaleType: 'linear',
                label: 'Distance (mm)',
                min: Math.min(...distanceData),
                max: Math.max(...distanceData),
              },
            ]}
            series={[
              {
                yAxisKey: 'distance',
                data: distanceData,
                type: 'line',
                showMark: false,
                label: 'Distance',
                curve: 'linear',
              },
            ]}
            height={400}
            margin={{ top: 50, right: 80, bottom: 50, left: 50 }}
            sx={{
              [`.${axisClasses.left} .${axisClasses.label}`]: {
                transform: 'translate(-10px, 0)',
              },
              [`.${axisClasses.right} .${axisClasses.label}`]: {
                transform: 'translate(20px, 0)',
              },
            }}
          />
        </Grid>
      </Grid>
    </Box>
  );
};

export default GCodeGenerator;
