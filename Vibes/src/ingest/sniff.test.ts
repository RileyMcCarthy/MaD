import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sniff } from './sniff.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('sniff', () => {
  it('recognises every artifact this repo can actually produce', () => {
    expect(sniff(fixture('vitest-2.1.9.json'))).toBe('vitest-json');
    expect(sniff(fixture('vitest-2.1.9-junit.xml'))).toBe('junit-xml');
    expect(sniff(fixture('pio-junit.xml'))).toBe('junit-xml');
    expect(sniff(fixture('pio-test-report.json'))).toBe('pio-json');
    expect(sniff(fixture('lcov-geninfo.info'))).toBe('lcov');
  });

  it('tells the two JSON dialects apart by structure, not by filename', () => {
    expect(sniff('{"test_suites": []}')).toBe('pio-json');
    expect(sniff('{"testResults": []}')).toBe('vitest-json');
  });

  it('sees through an XML prologue and a comment', () => {
    expect(sniff('<?xml version="1.0"?>\n<!-- generated -->\n<testsuites/>')).toBe('junit-xml');
  });

  it('recognises a tracefile that starts at SF, with no TN', () => {
    expect(sniff('SF:src/a.ts\nDA:1,1\nend_of_record\n')).toBe('lcov');
  });

  it('tolerates a UTF-8 BOM', () => {
    expect(sniff('﻿TN:\nSF:a.ts\nend_of_record\n')).toBe('lcov');
  });

  it('says unknown rather than guessing', () => {
    expect(sniff('hello world')).toBe('unknown');
    expect(sniff('{"coverageMap": {}}')).toBe('unknown');
    expect(sniff('<coverage lines="4"/>')).toBe('unknown');
  });
});
