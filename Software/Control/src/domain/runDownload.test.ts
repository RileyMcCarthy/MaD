import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { classifyDownload } from './runDownload';

const HEADER = 'time_us,force_mN,position_nm,setpoint_nm';

describe('run data download', () => {
  behaviour(
    {
      id: 'run-download.empty-file',
      covers: 'src/domain/runDownload.ts#classifyDownload',
      given: 'a download that succeeds but brings back no samples',
      expect: {
        'is-empty': 'the run is reported as having no recorded data',
        'gives-reason': 'the reason says the machine recorded nothing for the run',
      },
      why: { 'is-empty': 'the machine answers a run that recorded nothing with an empty file' },
    },
    () => {
      const out = classifyDownload({ success: true, csv: `${HEADER}\n`, sampleBytes: 0 });
      expect(out.kind).toBe('empty');
      if (out.kind === 'empty') expect(out.message).toContain('recorded no data');
    },
  );

  behaviour(
    {
      id: 'run-download.with-samples',
      covers: 'src/domain/runDownload.ts#classifyDownload',
      given: 'a download that brings back recorded samples',
      expect: { 'kept': 'the data is kept to be saved with the run' },
    },
    () => {
      const csv = `${HEADER}\n0,1,2,3\n`;
      expect(classifyDownload({ success: true, csv, sampleBytes: 20 })).toEqual({ kind: 'data', csv });
    },
  );

  behaviour(
    {
      id: 'run-download.failed',
      covers: 'src/domain/runDownload.ts#classifyDownload',
      given: 'a download the machine refuses',
      expect: { 'failed': 'it is a failed download carrying the machine\'s error' },
    },
    () => {
      expect(classifyDownload({ success: false, error: 'Test data not ready' })).toEqual({
        kind: 'failed',
        message: 'Test data not ready',
      });
    },
  );
});
