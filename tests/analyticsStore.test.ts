import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsStore, SCHEMA_VERSION } from '../src/analytics/analyticsStore.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempFilePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-analytics-'));
  dirs.push(dir);
  return path.join(dir, 'analytics.json');
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE = Date.parse('2026-08-01T12:34:56.000Z');

describe('AnalyticsStore', () => {
  it('starts empty with no earlier data invented', async () => {
    const store = new AnalyticsStore(await tempFilePath());
    await store.load();
    expect(store.query('24h', BASE)).toEqual([]);
    expect(store.query('30d', BASE)).toEqual([]);
  });

  it('buckets events into their UTC hour and accumulates counters', async () => {
    const store = new AnalyticsStore(await tempFilePath());
    await store.load();
    await store.recordProcessingEvent('started', {}, BASE);
    await store.recordProcessingEvent('started', {}, BASE + 5 * 60 * 1000);
    await store.recordProcessingEvent('completed', { durationMs: 60000, inputBytes: 1000, outputBytes: 5000 }, BASE + 10 * 60 * 1000);

    const buckets = store.query('24h', BASE + HOUR);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.processing).toEqual({
      started: 2,
      completed: 1,
      failed: 0,
      cancelled: 0,
      totalDurationMs: 60000,
      totalInputBytes: 1000,
      totalOutputBytes: 5000,
    });
  });

  it('splits events across separate hourly buckets', async () => {
    const store = new AnalyticsStore(await tempFilePath());
    await store.load();
    await store.recordProcessingEvent('started', {}, BASE);
    await store.recordProcessingEvent('started', {}, BASE + 2 * HOUR);

    const buckets = store.query('24h', BASE + 3 * HOUR);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]!.processing.started).toBe(1);
    expect(buckets[1]!.processing.started).toBe(1);
    // Oldest first.
    expect(Date.parse(buckets[0]!.bucketStart)).toBeLessThan(Date.parse(buckets[1]!.bucketStart));
  });

  it('excludes buckets outside the requested range', async () => {
    const store = new AnalyticsStore(await tempFilePath());
    await store.load();
    await store.recordProcessingEvent('completed', {}, BASE);
    const now = BASE + 25 * HOUR; // just past the 24h window
    expect(store.query('24h', now)).toEqual([]);
    expect(store.query('7d', now)).toHaveLength(1);
  });

  it('prunes buckets older than the 30-day retention window', async () => {
    const store = new AnalyticsStore(await tempFilePath());
    await store.load();
    await store.recordProcessingEvent('completed', {}, BASE);
    // An event 31 days later triggers pruning of the now-stale first bucket.
    await store.recordProcessingEvent('completed', {}, BASE + 31 * DAY);
    expect(store.query('30d', BASE + 31 * DAY)).toHaveLength(1);
  });

  it('persists atomically and survives a reload', async () => {
    const filePath = await tempFilePath();
    const store = new AnalyticsStore(filePath);
    await store.load();
    await store.recordProcessingEvent('failed', { durationMs: 1000 }, BASE);

    const reloaded = new AnalyticsStore(filePath);
    await reloaded.load();
    const buckets = reloaded.query('24h', BASE + HOUR);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.processing.failed).toBe(1);

    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    // No job/capture identifiers, error strings, or paths - only counters.
    expect(JSON.stringify(raw)).not.toMatch(/[A-Za-z]:\\|\/tmp\/|error|Error/);
  });

  it('recovers from a corrupt file instead of crashing, and preserves it for inspection', async () => {
    const filePath = await tempFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'not json{{{');

    const store = new AnalyticsStore(filePath);
    await store.load();
    expect(store.query('24h', BASE)).toEqual([]);

    const dirEntries = await fs.readdir(path.dirname(filePath));
    expect(dirEntries.some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('rejects use before load() to fail loudly rather than silently drop data', async () => {
    const store = new AnalyticsStore(await tempFilePath());
    expect(() => store.query('24h')).toThrow(/load\(\)/);
  });
});
