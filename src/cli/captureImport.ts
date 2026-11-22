import path from 'node:path';
import { createWorkerAgent } from '../spatial/workerClient.js';
import { acquireRuntimeLease } from '../runtime/runtimeLease.js';
import { LocalStore } from '../state/localStore.js';
import { CaptureStore } from '../captures/captureStore.js';
import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';

const USAGE = `Usage:
  kubus-node capture import-video <path> [--artwork <id>] [--marker <id>] [--captured-at <ISO time>] [--process] [--floater-crop]
  kubus-node capture import-photos <directory> [--video <file>] [--artwork <id>] [--marker <id>] [--captured-at <ISO time>] [--captured-by <label>] [--process] [--floater-crop]
  kubus-node capture add-video <captureId> <path> [--captured-at <ISO time>] [--process] [--floater-crop]
  kubus-node capture process <captureId> [--previous <spatialId>] [--floater-crop]

import-video imports one video file as a private capture, without the 128 MiB upload limit.
import-photos imports a directory of still photographs (JPEG or PNG, at least 8; no camera
poses needed, the worker solves them with COLMAP), optionally together with one video as a
mixed capture. add-video builds a NEW mixed capture from an existing photo capture plus a later
video; the photo capture is kept, and processing the new capture produces a new spatial revision
that links to the photo capture's record. process queues a reconstruction for a stored capture.

With a running Node the path must be readable by that Node and sit in an import directory:
<data>/imports (inside the container: /var/lib/kubus-node/data/imports) or a directory listed in
KUBUS_IMPORT_DIRS. With no running Node the path is imported directly from wherever it is.
--process queues a reconstruction job for the new capture (running Node only).
--floater-crop asks the worker to crop stray Gaussians outside the subject at export.`;

export interface ImportVideoArguments {
  file: string;
  artworkId?: string;
  markerId?: string;
  capturedAt?: string;
  process: boolean;
  floaterCrop?: boolean;
}

export interface ImportPhotosArguments {
  directory: string;
  videoFile?: string;
  artworkId?: string;
  markerId?: string;
  capturedAt?: string;
  capturedBy?: string;
  process: boolean;
  floaterCrop?: boolean;
}

export interface AddVideoArguments {
  captureId: string;
  file: string;
  capturedAt?: string;
  process: boolean;
  floaterCrop?: boolean;
}

export interface ProcessArguments {
  captureId: string;
  previousSpatialId?: string;
  floaterCrop?: boolean;
}

/** Splits `args` into options (name -> value, or `true` for flags) and positionals; an unknown option is an error. */
function parseOptions(args: string[], valued: string[], flags: string[]): { options: Record<string, string | true>; positionals: string[] } {
  const options: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valued.includes(arg)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg] = next;
      index += 1;
    } else if (flags.includes(arg)) {
      options[arg] = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { options, positionals };
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
    else if (arg === '--floater-crop') out.floaterCrop = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else if (!out.file) out.file = arg;
    else throw new Error('Only one video can be imported per capture');
  }
  if (!out.file) throw new Error('A video file path is required');
  return out;
}

export function parseImportPhotosArguments(args: string[]): ImportPhotosArguments {
  const { options, positionals } = parseOptions(args, ['--video', '--artwork', '--marker', '--captured-at', '--captured-by'], ['--process', '--floater-crop']);
  if (positionals.length === 0) throw new Error('A photo directory path is required');
  if (positionals.length > 1) throw new Error('Only one photo directory can be imported per capture');
  return {
    directory: positionals[0]!,
    videoFile: options['--video'] as string | undefined,
    artworkId: options['--artwork'] as string | undefined,
    markerId: options['--marker'] as string | undefined,
    capturedAt: options['--captured-at'] as string | undefined,
    capturedBy: options['--captured-by'] as string | undefined,
    process: options['--process'] === true,
    ...(options['--floater-crop'] === true ? { floaterCrop: true } : {}),
  };
}

export function parseAddVideoArguments(args: string[]): AddVideoArguments {
  const { options, positionals } = parseOptions(args, ['--captured-at'], ['--process', '--floater-crop']);
  if (positionals.length < 2) throw new Error('A photo capture id and a video file path are required');
  if (positionals.length > 2) throw new Error('Only one video can be added');
  return {
    captureId: positionals[0]!,
    file: positionals[1]!,
    capturedAt: options['--captured-at'] as string | undefined,
    process: options['--process'] === true,
    ...(options['--floater-crop'] === true ? { floaterCrop: true } : {}),
  };
}

export function parseProcessArguments(args: string[]): ProcessArguments {
  const { options, positionals } = parseOptions(args, ['--previous'], ['--floater-crop']);
  if (positionals.length !== 1) throw new Error('Exactly one capture id is required');
  return {
    captureId: positionals[0]!,
    previousSpatialId: options['--previous'] as string | undefined,
    ...(options['--floater-crop'] === true ? { floaterCrop: true } : {}),
  };
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

/** The job body for `/gui/api/jobs`: the capture plus the options an operator may set. */
function queueInput(captureId: unknown, extra: { floaterCrop?: boolean; previousSpatialId?: string }): Record<string, unknown> {
  return {
    captureId,
    ...(extra.floaterCrop ? { floaterCrop: true } : {}),
    ...(extra.previousSpatialId ? { previousSpatialId: extra.previousSpatialId } : {}),
  };
}

/** Queues a reconstruction on a running Node; returns the job, or undefined when no Node is serving. */
async function queueJob(config: AppConfig, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const queued = await post(config, '/gui/api/jobs', body);
  if (queued === 'unreachable') return undefined;
  if (queued.status !== 201 || !queued.envelope.data) fail(queued.envelope, queued.status);
  return queued.envelope.data;
}

function summary(capture: Record<string, unknown>, job?: Record<string, unknown>): string {
  return JSON.stringify({
    captureId: capture.id,
    kind: capture.kind,
    artworkId: capture.artworkId,
    markerId: capture.markerId,
    capturedAt: capture.capturedAt,
    video: capture.video,
    photos: capture.photos,
    derivedFrom: capture.derivedFrom,
    sizeBytes: capture.sizeBytes,
    ...(capture.skippedFiles ? { skippedFiles: capture.skippedFiles } : {}),
    ...(job ? { jobId: job.id } : {}),
  }, null, 2);
}

function usageError(error: unknown): never {
  throw Object.assign(new Error((error as Error).message), { usage: true });
}

/** Runs `work` with the writer lease and a capture store, for a command with no running Node. */
async function offline<T>(config: AppConfig, work: (captures: CaptureStore) => Promise<T>): Promise<T> {
  const lease = await acquireRuntimeLease(config.localStatePath);
  try {
    const store = new LocalStore(config.localStatePath);
    await store.load();
    return await work(new CaptureStore(config.localDataPath, store));
  } finally {
    await lease.release();
  }
}

/** Shared tail of every import command: use the running Node's answer, or import offline; then queue the job. */
async function finishImport(
  config: AppConfig,
  online: Awaited<ReturnType<typeof post>>,
  importOffline: () => Promise<Record<string, unknown>>,
  parsed: { process: boolean; floaterCrop?: boolean },
): Promise<void> {
  let capture: Record<string, unknown>;
  if (online === 'unreachable') {
    // No Node is serving: take the writer lease and import directly.
    capture = await importOffline();
    if (parsed.process) console.error('--process needs a running Node; start it and process the capture from the GUI');
  } else {
    if (online.status !== 201 || !online.envelope.data) fail(online.envelope, online.status);
    capture = online.envelope.data;
  }
  const job = parsed.process && online !== 'unreachable' ? await queueJob(config, queueInput(capture.id, parsed)) : undefined;
  console.log(summary(capture, job));
}

export async function runCaptureCommand(args: string[], config: AppConfig, logger: Logger): Promise<void> {
  const [subcommand, ...rest] = args;
  try {
    if (subcommand === 'import-video') {
      let parsed: ImportVideoArguments;
      try { parsed = parseImportVideoArguments(rest); } catch (error) { usageError(error); }
      const absolute = path.resolve(parsed.file);
      const online = await post(config, '/gui/api/captures/import-video', {
        path: absolute, artworkId: parsed.artworkId, markerId: parsed.markerId, capturedAt: parsed.capturedAt,
      });
      await finishImport(config, online, async () => {
        const capture = await offline(config, async (captures) => ({ ...(await captures.importVideoFile(absolute, parsed)) }));
        logger.info({ captureId: capture.id }, 'video imported offline');
        return capture;
      }, parsed);
    } else if (subcommand === 'import-photos') {
      let parsed: ImportPhotosArguments;
      try { parsed = parseImportPhotosArguments(rest); } catch (error) { usageError(error); }
      const directory = path.resolve(parsed.directory);
      const videoPath = parsed.videoFile ? path.resolve(parsed.videoFile) : undefined;
      const online = await post(config, '/gui/api/captures/import-photos', {
        path: directory, videoPath, artworkId: parsed.artworkId, markerId: parsed.markerId, capturedAt: parsed.capturedAt, capturedBy: parsed.capturedBy,
      });
      await finishImport(config, online, async () => {
        const capture = await offline(config, async (captures) => ({ ...(await captures.importPhotoDirectory(directory, { ...parsed, videoPath })) }));
        logger.info({ captureId: capture.id }, 'photos imported offline');
        return capture;
      }, parsed);
    } else if (subcommand === 'add-video') {
      let parsed: AddVideoArguments;
      try { parsed = parseAddVideoArguments(rest); } catch (error) { usageError(error); }
      const absolute = path.resolve(parsed.file);
      const online = await post(config, '/gui/api/captures/add-video', { captureId: parsed.captureId, path: absolute, capturedAt: parsed.capturedAt });
      await finishImport(config, online, async () => {
        const capture = await offline(config, async (captures) => ({ ...(await captures.addVideoToCapture(parsed.captureId, absolute, parsed)) }));
        logger.info({ captureId: capture.id }, 'video added offline');
        return capture;
      }, parsed);
    } else if (subcommand === 'process') {
      let parsed: ProcessArguments;
      try { parsed = parseProcessArguments(rest); } catch (error) { usageError(error); }
      const job = await queueJob(config, queueInput(parsed.captureId, parsed));
      if (!job) throw new Error('No running Node answered; start it and try again');
      console.log(JSON.stringify({ jobId: job.id, captureId: parsed.captureId, state: job.state }, null, 2));
    } else {
      console.error(USAGE);
      process.exitCode = 2;
    }
  } catch (error) {
    if ((error as { usage?: boolean }).usage) {
      console.error(`${(error as Error).message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}
