import path from 'node:path';
import { createWorkerAgent } from '../spatial/workerClient.js';
import { acquireRuntimeLease } from '../runtime/runtimeLease.js';
import { LocalStore } from '../state/localStore.js';
import { CaptureStore } from '../captures/captureStore.js';
import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';

const USAGE = `Usage: kubus-node capture import-video <path> [--artwork <id>] [--marker <id>] [--captured-at <ISO time>] [--process]

Imports one video file as a private capture, without the 128 MiB upload limit.

With a running Node the file must be readable by that Node and sit in an import
directory: <data>/imports (inside the container: /var/lib/kubus-node/data/imports)
or a directory listed in KUBUS_IMPORT_DIRS. With no running Node the file is
imported directly from wherever it is.
--process queues a reconstruction job for the new capture (running Node only).`;

export interface ImportVideoArguments {
  file: string;
  artworkId?: string;
  markerId?: string;
  capturedAt?: string;
  process: boolean;
}

export function parseImportVideoArguments(args: string[]): ImportVideoArguments {
  const out: ImportVideoArguments = { file: '', process: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === '--artwork') out.artworkId = value();
    else if (arg === '--marker') out.markerId = value();
    else if (arg === '--captured-at') out.capturedAt = value();
    else if (arg === '--process') out.process = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else if (!out.file) out.file = arg;
    else throw new Error('Only one video can be imported per capture');
  }
  if (!out.file) throw new Error('A video file path is required');
  return out;
}

interface Envelope { success?: boolean; data?: Record<string, unknown>; error?: string; code?: string; details?: unknown }

async function post(config: AppConfig, route: string, body: unknown): Promise<{ status: number; envelope: Envelope } | 'unreachable'> {
  const port = config.localApiEnabled ? config.localApiPort : config.guiPort;
  const agent = createWorkerAgent();
  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.guiToken ? { authorization: `Bearer ${config.guiToken}` } : {}) },
      body: JSON.stringify(body),
      dispatcher: agent,
    } as RequestInit);
    return { status: response.status, envelope: (await response.json().catch(() => ({}))) as Envelope };
  } catch (error) {
    const code = ((error as { cause?: { code?: string } }).cause?.code) ?? (error as { code?: string }).code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'unreachable';
    throw error;
  } finally {
    await agent.close().catch(() => undefined);
  }
}

function fail(envelope: Envelope, status: number): never {
  const details = envelope.details ? ` ${JSON.stringify(envelope.details)}` : '';
  throw new Error(`${envelope.code ?? envelope.error ?? `http_${status}`}${details}`);
}

export async function runCaptureCommand(args: string[], config: AppConfig, logger: Logger): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'import-video') {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  let parsed: ImportVideoArguments;
  try {
    parsed = parseImportVideoArguments(rest);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const absolute = path.resolve(parsed.file);
  const online = await post(config, '/gui/api/captures/import-video', {
    path: absolute, artworkId: parsed.artworkId, markerId: parsed.markerId, capturedAt: parsed.capturedAt,
  });
  let capture: Record<string, unknown>;
  if (online === 'unreachable') {
    // No Node is serving: take the writer lease and import directly.
    const lease = await acquireRuntimeLease(config.localStatePath);
    try {
      const store = new LocalStore(config.localStatePath);
      await store.load();
      const captures = new CaptureStore(config.localDataPath, store);
      capture = { ...(await captures.importVideoFile(absolute, parsed)) };
      logger.info({ captureId: capture.id }, 'video imported offline');
    } finally {
      await lease.release();
    }
    if (parsed.process) console.error('--process needs a running Node; start it and process the capture from the GUI');
  } else {
    if (online.status !== 201 || !online.envelope.data) fail(online.envelope, online.status);
    capture = online.envelope.data;
  }
  let job: Record<string, unknown> | undefined;
  if (parsed.process && online !== 'unreachable') {
    const queued = await post(config, '/gui/api/jobs', { captureId: capture.id });
    if (queued === 'unreachable' || queued.status !== 201 || !queued.envelope.data) {
      if (queued !== 'unreachable') fail(queued.envelope, queued.status);
    } else {
      job = queued.envelope.data;
    }
  }
  console.log(JSON.stringify({
    captureId: capture.id,
    kind: capture.kind,
    artworkId: capture.artworkId,
    markerId: capture.markerId,
    video: capture.video,
    sizeBytes: capture.sizeBytes,
    ...(job ? { jobId: job.id } : {}),
  }, null, 2));
}
