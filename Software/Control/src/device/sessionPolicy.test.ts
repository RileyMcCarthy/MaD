/**
 * M7 — DeviceSession policy matrix (pure).
 */
import { describe, it, expect } from 'vitest';
import {
  downloadNackRetryCap,
  shouldRetryDownloadNack,
  shouldRetryUpload,
  shouldInvalidatePartialUpload,
  isAbortError,
  ABORT_ERROR_MESSAGE,
  OpMutex,
  downloadChunkIsTerminal,
  DOWNLOAD_MAX_NOT_READY_RETRIES,
  DOWNLOAD_MAX_MID_RETRIES,
  UPLOAD_DEFAULT_MAX_RETRIES,
} from './sessionPolicy';

describe('M7 download NACK retry matrix', () => {
  it.each([
    { sampleIndex: 0, expectCap: DOWNLOAD_MAX_NOT_READY_RETRIES },
    { sampleIndex: 1, expectCap: DOWNLOAD_MAX_MID_RETRIES },
    { sampleIndex: 100, expectCap: DOWNLOAD_MAX_MID_RETRIES },
  ])('cap at sampleIndex=$sampleIndex is $expectCap', ({ sampleIndex, expectCap }) => {
    expect(downloadNackRetryCap(sampleIndex)).toBe(expectCap);
  });

  it.each([
    { sampleIndex: 0, retries: 0, ok: true },
    { sampleIndex: 0, retries: DOWNLOAD_MAX_NOT_READY_RETRIES - 1, ok: true },
    { sampleIndex: 0, retries: DOWNLOAD_MAX_NOT_READY_RETRIES, ok: false },
    { sampleIndex: 5, retries: DOWNLOAD_MAX_MID_RETRIES - 1, ok: true },
    { sampleIndex: 5, retries: DOWNLOAD_MAX_MID_RETRIES, ok: false },
  ])(
    'sampleIndex=$sampleIndex after $retries NACKs → retry=$ok',
    ({ sampleIndex, retries, ok }) => {
      expect(shouldRetryDownloadNack(retries, sampleIndex)).toBe(ok);
    },
  );
});

describe('M7 upload retry matrix', () => {
  it.each([
    { attempt: 0, max: 3, ok: true },
    { attempt: 1, max: 3, ok: true },
    { attempt: 2, max: 3, ok: true },
    { attempt: 3, max: 3, ok: false },
    { attempt: 1, max: 1, ok: false },
  ])('attempt=$attempt max=$max → retry=$ok', ({ attempt, max, ok }) => {
    expect(shouldRetryUpload(attempt, max)).toBe(ok);
  });

  it('default max retries is 3', () => {
    expect(UPLOAD_DEFAULT_MAX_RETRIES).toBe(3);
  });
});

describe('M7 partial upload invalidation', () => {
  it.each([
    { success: true, invalidate: false },
    { success: false, invalidate: true },
  ])('runSucceeded=$success → invalidate=$invalidate', ({ success, invalidate }) => {
    expect(shouldInvalidatePartialUpload(success)).toBe(invalidate);
  });
});

describe('M7 abort detection', () => {
  it.each([
    { msg: ABORT_ERROR_MESSAGE, abort: true },
    { msg: 'aborted: emergency stop', abort: true },
    { msg: 'device NACKed command 3', abort: false },
    { msg: 'response timeout', abort: false },
  ])('$msg → abort=$abort', ({ msg, abort }) => {
    expect(isAbortError(msg)).toBe(abort);
  });
});

describe('M7 download chunk terminal', () => {
  const WIRE = 16; // STOREDSAMPLE_WIRE_SIZE-like
  it.each([
    { len: 0, perReq: 100, terminal: true },
    { len: 100 * WIRE, perReq: 100, terminal: false },
    { len: 50 * WIRE, perReq: 100, terminal: true },
    { len: WIRE, perReq: 100, terminal: true },
  ])('len=$len perReq=$perReq → terminal=$terminal', ({ len, perReq, terminal }) => {
    expect(downloadChunkIsTerminal(len, perReq, WIRE)).toBe(terminal);
  });
});

describe('M7 OpMutex single-in-flight', () => {
  it('serializes concurrent ops (second waits for first)', async () => {
    const mutex = new OpMutex();
    const order: number[] = [];
    const slow = mutex.run(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
      return 'a';
    });
    const fast = mutex.run(async () => {
      order.push(3);
      return 'b';
    });
    const [a, b] = await Promise.all([slow, fast]);
    expect(a).toBe('a');
    expect(b).toBe('b');
    // 1 then 2 complete before 3 starts
    expect(order).toEqual([1, 2, 3]);
  });

  it('a rejected op does not stall the chain', async () => {
    const mutex = new OpMutex();
    await expect(
      mutex.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(mutex.run(async () => 'ok')).resolves.toBe('ok');
  });
});
