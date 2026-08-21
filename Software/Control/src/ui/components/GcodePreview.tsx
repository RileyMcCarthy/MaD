import { useMemo } from 'react';
import { TestProfile, generateTestGcode } from '@/domain';
import StaticLineChart from './StaticLineChart';

interface GcodePreviewProps {
  profile: TestProfile;
}

/** Shows the generated G-code text plus a distance-vs-time motion preview. */
export default function GcodePreview({ profile }: GcodePreviewProps) {
  const { gcode, time, distance } = useMemo(
    () => generateTestGcode(profile),
    [profile],
  );

  return (
    <div>
      <h2>Generated G-code</h2>
      <pre className="code-block">{gcode.join('\n')}</pre>
      <h2 style={{ marginTop: 16 }}>Distance vs Time</h2>
      <StaticLineChart
        xLabel="Time (s)"
        yLabel="Distance (mm)"
        x={time}
        series={[{ label: 'Distance', color: '#4ea1ff', data: distance }]}
        height={300}
      />
    </div>
  );
}
