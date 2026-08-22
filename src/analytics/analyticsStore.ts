import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Local Node analytics: bounded, on-disk, hourly-bucketed counters.
 *
 * This is NOT a telemetry pipeline. Nothing here is ever sent anywhere -
 * `AnalyticsStore` only reads and writes one file on this Node's own disk,
 * and every field is a plain count/duration/byte-sum the runtime already
 * measured for its own purposes. No raw content, no private filenames, no
 * capture/job ids, no credentials: a bucket that recorded a failed job knows
 * "one job failed, after N ms, with this many input bytes" and nothing about
 * which job, whose capture, or what error string.
 *
 * Resolution is a deliberate simplification: one bucket per UTC hour, for
 * every requested range (24h/7d/30d alike). A finer sub-hour resolution for
 * the 24h view would need a second aggregation tier (raw samples rolled up
 * into hourly buckets); hourly-only is simpler, still bounded, and still
 * honest - it just means the 24h chart has ~24 points instead of ~288.
 * Documented here rather than silently coarser than what an operator might
 * expect.
 */

export const SCHEMA_VERSION = 1;
const RETENTION_HOURS = 30 * 24; // 30 days of hourly buckets, bounded.

export interface ProcessingBucketCounters {
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Sum of (completedAt - startedAt) in ms, across jobs that finished in this bucket. Divide by a terminal count for an average. */
  totalDurationMs: number;
  totalInputBytes: number;
  totalOutputBytes: number;
}

function emptyProcessingCounters(): ProcessingBucketCounters {
  return { started: 0, completed: 0, failed: 0, cancelled: 0, totalDurationMs: 0, totalInputBytes: 0, totalOutputBytes: 0 };
}

export interface AnalyticsBucket {
  /** ISO start of this UTC hour, e.g. "2026-08-01T14:00:00.000Z". */
  bucketStart: string;
  processing: ProcessingBucketCounters;
}

interface AnalyticsFile {
  schemaVersion: number;
  buckets: AnalyticsBucket[];
}

export type AnalyticsRange = '24h' | '7d' | '30d';

const RANGE_HOURS: Record<AnalyticsRange, number> = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24 };

function hourBucketStart(at: number): string {
  const date = new Date(at);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function emptyFile(): AnalyticsFile {
  return { schemaVersion: SCHEMA_VERSION, buckets: [] };
}

/**
 * Records processing outcomes into bounded hourly buckets and serves ranged
 * queries. Every mutation is queued behind the previous write (same pattern
 * as `LocalStore`) so concurrent job completions cannot interleave a
 * read-modify-write of the bucket array, and every write lands via a
 * temp-file-then-rename so a crash mid-write can never corrupt the file a
 * later read sees.
 */
export class AnalyticsStore {
  private file: AnalyticsFile | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as AnalyticsFile;
      if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.buckets)) {
        throw new Error('unsupported analytics schema version');
      }
      this.file = parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Corrupt or unreadable: start fresh rather than block the Node on a
        // file that only ever holds derived counters, never anything a
        // rebuild would need to recover exactly. Preserve the bad file for
        // inspection instead of silently overwriting it.
        try {
          await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        } catch {
          // Best effort.
        }
      }
      this.file = emptyFile();
    }
  }

  private ensureLoaded(): AnalyticsFile {
    if (!this.file) throw new Error('AnalyticsStore.load() must be called before use');
    return this.file;
  }

  private bucketFor(file: AnalyticsFile, at: number): AnalyticsBucket {
    const bucketStart = hourBucketStart(at);
    let bucket = file.buckets.find((candidate) => candidate.bucketStart === bucketStart);
    if (!bucket) {
      bucket = { bucketStart, processing: emptyProcessingCounters() };
      file.buckets.push(bucket);
      file.buckets.sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
    }
    return bucket;
  }

  private prune(file: AnalyticsFile, now: number): void {
    const cutoff = now - RETENTION_HOURS * 60 * 60 * 1000;
    file.buckets = file.buckets.filter((bucket) => Date.parse(bucket.bucketStart) >= cutoff);
  }

  /** Records one processing-job transition. `at` is injectable for deterministic tests. */
  async recordProcessingEvent(
    kind: 'started' | 'completed' | 'failed' | 'cancelled',
    extra: { durationMs?: number; inputBytes?: number; outputBytes?: number } = {},
    at: number = Date.now(),
  ): Promise<void> {
    const file = this.ensureLoaded();
    const bucket = this.bucketFor(file, at);
    bucket.processing[kind] += 1;
    if (extra.durationMs !== undefined) bucket.processing.totalDurationMs += extra.durationMs;
    if (extra.inputBytes !== undefined) bucket.processing.totalInputBytes += extra.inputBytes;
    if (extra.outputBytes !== undefined) bucket.processing.totalOutputBytes += extra.outputBytes;
    this.prune(file, at);
    await this.persist(file);
  }

  /** Buckets within the requested range, oldest first. Always hourly resolution - see the module doc. */
  query(range: AnalyticsRange, now: number = Date.now()): AnalyticsBucket[] {
    const file = this.ensureLoaded();
    const cutoff = now - RANGE_HOURS[range] * 60 * 60 * 1000;
    return file.buckets.filter((bucket) => Date.parse(bucket.bucketStart) >= cutoff);
  }

  private async persist(file: AnalyticsFile): Promise<void> {
    const next: AnalyticsFile = { schemaVersion: file.schemaVersion, buckets: file.buckets };
    this.writeChain = this.writeChain.then(() => this.atomicWrite(next));
    await this.writeChain;
  }

  private async atomicWrite(next: AnalyticsFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }
}
