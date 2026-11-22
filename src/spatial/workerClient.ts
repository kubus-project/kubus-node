import { Agent } from 'undici';

/**
 * The Node-to-worker request that runs a reconstruction.
 *
 * The worker answers `POST /v1/process` only when training and export are
 * finished, which takes tens of minutes and may take hours (the worker allows
 * 24 h of training). Node's built-in `fetch` is undici with a five-minute
 * headers timeout, so without a dedicated dispatcher every real run is marked
 * `worker_failed` after five minutes while the worker carries on training.
 *
 * `headersTimeout: 0` removes that limit for this request only. A hard ceiling
 * is applied as an abort signal instead, so a worker that has hung still ends
 * the request, and the body (a small JSON document sent immediately after the
 * headers) keeps a bounded inactivity timeout.
 */
export const WORKER_BODY_TIMEOUT_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/**
 * The worker's own per-tool timeouts for one job, worst case: ffmpeg frame
 * extraction 1 h and `ns-process-data` 3 h (video jobs only), training 24 h,
 * export 2 h, and the optional floater-crop export another 2 h. The request ceiling must sit above their sum, otherwise the Node
 * aborts with a non-cancel timeout while the worker is still legitimately
 * running. Keep these in step with `spatial-worker/server.py` and
 * `spatial-worker/video_pipeline.py`.
 */
export const WORKER_TOOL_TIMEOUTS_MS = { extraction: 1 * HOUR_MS, poseSolving: 3 * HOUR_MS, training: 24 * HOUR_MS, export: 2 * HOUR_MS, cropExport: 2 * HOUR_MS } as const;
/** Sum of the worker's tool timeouts plus one hour of slack (33 h). */
export const WORKER_REQUEST_CEILING_MS = Object.values(WORKER_TOOL_TIMEOUTS_MS).reduce((sum, ms) => sum + ms, 0) + HOUR_MS;

export interface WorkerAgentOptions {
  /** 0 disables the headers timeout. */
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
}

export function createWorkerAgent(options: WorkerAgentOptions = {}): Agent {
  return new Agent({
    headersTimeout: options.headersTimeoutMs ?? 0,
    bodyTimeout: options.bodyTimeoutMs ?? WORKER_BODY_TIMEOUT_MS,
    // A multi-hour wait on an idle connection must not be reaped by a NAT or
    // bridge in between; probe it periodically.
    connect: { timeout: 30_000, keepAlive: true, keepAliveInitialDelay: 30_000 },
  });
}

let sharedAgent: Agent | undefined;

/** The dispatcher used for long worker calls. Created lazily, shared by every job. */
export function workerAgent(): Agent {
  sharedAgent ??= createWorkerAgent();
  return sharedAgent;
}

/**
 * `fetch` for a request that may legitimately wait hours for its response.
 *
 * Goes through `globalThis.fetch` so tests that stub it keep working; the
 * `dispatcher` option is what lifts the headers timeout.
 */
export function longWorkerFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  options: { agent?: Agent; ceilingMs?: number } = {},
): Promise<Response> {
  const ceiling = AbortSignal.timeout(options.ceilingMs ?? WORKER_REQUEST_CEILING_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, ceiling]) : ceiling;
  return globalThis.fetch(url, { ...init, signal, dispatcher: options.agent ?? workerAgent() } as RequestInit);
}

export interface WorkerFailure {
  code: string;
  message: string;
}

/** Typed video- and photo-intake codes the worker may return; anything else is `worker_failed`. */
export const WORKER_TYPED_ERROR_CODES = new Set([
  'video_unreadable',
  'video_too_short',
  'frames_too_blurry',
  'photos_unreadable',
  'sfm_failed',
  'face_masking_failed',
]);

/**
 * Reads the failure out of a worker error response.
 *
 * FastAPI puts the reason in `detail`, never in `error`. `detail` is a string
 * for the older worker failures and an object `{code, message, details}` for
 * typed ones; `error` is kept as a fallback for any other worker.
 */
export function workerFailure(body: unknown, status: number): WorkerFailure {
  const fallbackCode = status === 503 ? 'worker_unsupported' : 'worker_failed';
  const record = (body && typeof body === 'object' ? body : {}) as { detail?: unknown; error?: unknown };
  const detail = record.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const typed = detail as { code?: unknown; message?: unknown; details?: unknown };
    const code = typeof typed.code === 'string' && WORKER_TYPED_ERROR_CODES.has(typed.code) ? typed.code : fallbackCode;
    const message = typeof typed.message === 'string' && typed.message ? typed.message : String(typed.code ?? `worker_http_${status}`);
    return { code, message: withCounts(message, typed.details) };
  }
  if (typeof detail === 'string' && detail) return { code: fallbackCode, message: detail };
  if (typeof record.error === 'string' && record.error) return { code: fallbackCode, message: record.error };
  return { code: fallbackCode, message: `worker_http_${status}` };
}

/** Appends the machine-readable counts that explain a rejection, without tool output. */
function withCounts(message: string, details: unknown): string {
  if (!details || typeof details !== 'object') return message;
  const picked: string[] = [];
  for (const key of ['durationSeconds', 'extracted', 'selected', 'blurDropped', 'duplicateDropped', 'submittedViews', 'registeredViews', 'registrationRatio', 'submittedPhotos', 'usablePhotos']) {
    const value = (details as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) picked.push(`${key}=${value}`);
  }
  return picked.length ? `${message} (${picked.join(', ')})` : message;
}
