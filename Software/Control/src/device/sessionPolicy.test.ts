/**
 * M7 — DeviceSession policy matrix (pure).
 */
import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
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
  behaviour(
    {
      id: 'session.failed-download-retried-then-given-up',
      covers: 'src/device/sessionPolicy.ts#shouldRetryDownloadNack',
      given: 'a download the machine refuses, at the first chunk and again later in the file',
      then: 'a download the machine refuses is retried up to a higher limit on the first chunk and a lower limit on later chunks, then given up',
      why: 'the first chunk waits for the file to appear on the machine; a later chunk that keeps failing is a stuck transfer',
    },
    () => {
      for (const { sampleIndex, expectCap } of [
        { sampleIndex: 0, expectCap: DOWNLOAD_MAX_NOT_READY_RETRIES },
        { sampleIndex: 1, expectCap: DOWNLOAD_MAX_MID_RETRIES },
        { sampleIndex: 100, expectCap: DOWNLOAD_MAX_MID_RETRIES },
      ]) {
        expect(downloadNackRetryCap(sampleIndex)).toBe(expectCap);
      }

      for (const { sampleIndex, retries, ok } of [
        { sampleIndex: 0, retries: 0, ok: true },
        { sampleIndex: 0, retries: DOWNLOAD_MAX_NOT_READY_RETRIES - 1, ok: true },
        { sampleIndex: 0, retries: DOWNLOAD_MAX_NOT_READY_RETRIES, ok: false },
        { sampleIndex: 5, retries: DOWNLOAD_MAX_MID_RETRIES - 1, ok: true },
        { sampleIndex: 5, retries: DOWNLOAD_MAX_MID_RETRIES, ok: false },
      ]) {
        expect(shouldRetryDownloadNack(retries, sampleIndex)).toBe(ok);
      }
    },
  );
});

describe('M7 upload retry matrix', () => {
  behaviour(
    {
      id: 'session.failed-upload-retried-then-given-up',
      covers: 'src/device/sessionPolicy.ts#shouldRetryUpload',
      given: 'a program upload that fails, with a retry limit of three',
      then: 'a failed upload is retried while the attempt count is below the limit, the default limit is three, and the attempt at the limit is given up',
    },
    () => {
      expect(UPLOAD_DEFAULT_MAX_RETRIES).toBe(3);
      for (const { attempt, max, ok } of [
        { attempt: 0, max: 3, ok: true },
        { attempt: 1, max: 3, ok: true },
        { attempt: 2, max: 3, ok: true },
        { attempt: 3, max: 3, ok: false },
        { attempt: 1, max: 1, ok: false },
      ]) {
        expect(shouldRetryUpload(attempt, max)).toBe(ok);
      }
    },
  );
});

describe('M7 partial upload invalidation', () => {
  behaviour(
    {
      id: 'session.failed-run-invalidates-partial-upload',
      covers: 'src/device/sessionPolicy.ts#shouldInvalidatePartialUpload',
      given: 'a test run that wrote only part of its program to the machine',
      then: 'a test run that did not succeed invalidates the half-written program, and a successful run leaves the uploaded program in place',
      why: 'a half-uploaded program that later ran to the end would look complete',
    },
    () => {
      for (const { success, invalidate } of [
        { success: true, invalidate: false },
        { success: false, invalidate: true },
      ]) {
        expect(shouldInvalidatePartialUpload(success)).toBe(invalidate);
      }
    },
  );
});

describe('M7 abort detection', () => {
  behaviour(
    {
      id: 'session.emergency-stop-is-an-abort',
      covers: 'src/device/sessionPolicy.ts#isAbortError',
      given: 'errors from an emergency stop, and ordinary machine refusals and timeouts',
      then: 'an emergency-stop abort is recognised as an abort, including a message that starts with aborted, and a machine refusal or a timeout is treated as an ordinary error',
    },
    () => {
      for (const { msg, abort } of [
        { msg: ABORT_ERROR_MESSAGE, abort: true },
        { msg: 'aborted: emergency stop', abort: true },
        { msg: 'device NACKed command 3', abort: false },
        { msg: 'response timeout', abort: false },
      ]) {
        expect(isAbortError(msg)).toBe(abort);
      }
    },
  );
});

describe('M7 download chunk terminal', () => {
  const WIRE = 16; // STOREDSAMPLE_WIRE_SIZE-like
  behaviour(
    {
      id: 'session.short-download-chunk-ends-the-file',
      covers: 'src/device/sessionPolicy.ts#downloadChunkIsTerminal',
      given: 'download chunks that are empty, full, or shorter than requested',
      then: 'an empty download chunk or a chunk shorter than the request ends the file, and a full-sized chunk continues the download',
    },
    () => {
      for (const { len, perReq, terminal } of [
        { len: 0, perReq: 100, terminal: true },
        { len: 100 * WIRE, perReq: 100, terminal: false },
        { len: 50 * WIRE, perReq: 100, terminal: true },
        { len: WIRE, perReq: 100, terminal: true },
      ]) {
        expect(downloadChunkIsTerminal(len, perReq, WIRE)).toBe(terminal);
      }
    },
  );
});

describe('M7 OpMutex single-in-flight', () => {
  behaviour(
    {
      id: 'session.ops-run-one-at-a-time',
      covers: 'src/device/sessionPolicy.ts#OpMutex',
      given: 'two device operations started together, the first one slow',
      then: 'when two device operations are started together, the second waits until the first has finished before starting',
      why: 'two in-flight commands would interleave on the serial line',
    },
    async () => {
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
    },
  );

  behaviour(
    {
      id: 'session.failed-op-releases-the-queue',
      covers: 'src/device/sessionPolicy.ts#OpMutex',
      given: 'a device operation that fails, then another that succeeds',
      then: 'after a device operation fails, the next operation still runs',
      why: 'a failed command must not block every command that follows',
    },
    async () => {
      const mutex = new OpMutex();
      await expect(
        mutex.run(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await expect(mutex.run(async () => 'ok')).resolves.toBe('ok');
    },
  );
});
