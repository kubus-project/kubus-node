import { withComposeProfile, readEnvValue, type EnvUpdates } from './runtimeEnv.js';

/**
 * Whether this machine runs the GPU Spatial worker, and why.
 *
 * The worker is optional. A Node is a complete archive and storage participant
 * without it, and a CPU-only machine must stay exactly that: nothing here is
 * allowed to make the Node's own start-up depend on a GPU. So the decision is
 * made once, recorded as a handful of keys in `runtime.env`, and every failure
 * after it is non-fatal and named.
 *
 * `KUBUS_SPATIAL_WORKER`:
 * - `auto` (default): run it only when an NVIDIA GPU is present on the host *and*
 *   Docker has the NVIDIA runtime a GPU container needs. Anything less is
 *   reported, not guessed at.
 * - `on`: the operator insists. Detection that came back empty is not allowed to
 *   veto them (it can be wrong), but the start is still non-fatal.
 * - `off`: never.
 *
 * A GPU on the host is not a GPU in the container. The two probes answer
 * different questions, and the real answer is the worker's own `/health`, which
 * the Node reads and shows.
 */

export type SpatialWorkerMode = 'auto' | 'on' | 'off';

export const SPATIAL_WORKER_STATES = [
  'enabled',
  'operator_off',
  'no_nvidia_gpu',
  'docker_gpu_unconfirmed',
  'unsupported_platform',
  'worker_start_failed',
] as const;
export type SpatialWorkerState = (typeof SPATIAL_WORKER_STATES)[number];

export const SPATIAL_WORKER_URL = 'http://kubus-spatial-worker:8790';
export const SPATIAL_PROFILE = 'spatial';

export interface HostGpu { name: string; vramMb: number; driver: string }

export interface SpatialWorkerProbe {
  platformSupported: boolean;
  /** GPUs `nvidia-smi` listed on the host; empty when it is absent or found none. */
  gpus: HostGpu[];
  /** Whether `docker info` lists an `nvidia` runtime; null when Docker could not be asked. */
  dockerNvidiaRuntime: boolean | null;
}

export interface SpatialWorkerPlan {
  mode: SpatialWorkerMode;
  start: boolean;
  state: SpatialWorkerState;
  gpus: HostGpu[];
  dockerNvidiaRuntime: boolean | null;
}

export function parseSpatialWorkerMode(value: string | undefined): SpatialWorkerMode {
  const text = (value ?? '').trim().toLowerCase();
  if (text === '') return 'auto';
  if (text === 'auto' || text === 'on' || text === 'off') return text;
  throw new Error('KUBUS_SPATIAL_WORKER must be auto, on or off');
}

/** `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits` */
export function parseNvidiaSmi(output: string): HostGpu[] {
  const gpus: HostGpu[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 3) continue;
    const driver = parts[parts.length - 1]!;
    const vramMb = Number(parts[parts.length - 2]);
    const name = parts.slice(0, -2).join(', ');
    if (!name || !Number.isFinite(vramMb) || vramMb <= 0 || !driver) continue;
    gpus.push({ name, vramMb: Math.round(vramMb), driver });
  }
  return gpus;
}

/** `docker info --format '{{json .Runtimes}}'` */
export function dockerHasNvidiaRuntime(output: string): boolean | null {
  try {
    const runtimes: unknown = JSON.parse(output.trim());
    if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) return null;
    return Object.prototype.hasOwnProperty.call(runtimes, 'nvidia');
  } catch {
    return null;
  }
}

export function planSpatialWorker(mode: SpatialWorkerMode, probe: SpatialWorkerProbe): SpatialWorkerPlan {
  const base = { mode, gpus: probe.gpus, dockerNvidiaRuntime: probe.dockerNvidiaRuntime };
  if (mode === 'off') return { ...base, start: false, state: 'operator_off' };
  if (!probe.platformSupported) return { ...base, start: false, state: 'unsupported_platform' };
  if (mode === 'on') return { ...base, start: true, state: 'enabled' };
  if (probe.gpus.length === 0) return { ...base, start: false, state: 'no_nvidia_gpu' };
  if (probe.dockerNvidiaRuntime !== true) return { ...base, start: false, state: 'docker_gpu_unconfirmed' };
  return { ...base, start: true, state: 'enabled' };
}

/**
 * The `runtime.env` keys that record a decision. `COMPOSE_PROFILES` is edited as
 * a list: other profiles an operator enabled stay. An empty `SPATIAL_WORKER_URL`
 * is deliberate ("no worker"), which the Compose file keeps empty rather than
 * replacing with its default.
 */
export function envUpdatesFor(plan: Pick<SpatialWorkerPlan, 'mode' | 'start' | 'state'>, currentEnvText: string): EnvUpdates {
  return {
    KUBUS_SPATIAL_WORKER: plan.mode,
    KUBUS_SPATIAL_WORKER_STATE: plan.state,
    SPATIAL_WORKER_URL: plan.start ? SPATIAL_WORKER_URL : '',
    COMPOSE_PROFILES: withComposeProfile(readEnvValue(currentEnvText, 'COMPOSE_PROFILES'), SPATIAL_PROFILE, plan.start),
  };
}

/** What the Node shows an operator for a recorded state. Never a claim about the worker itself - only about why it was or was not started. */
export function describeSpatialWorkerState(state: string | undefined): string | undefined {
  switch (state) {
    case 'operator_off': return 'The Spatial worker is turned off on this machine (KUBUS_SPATIAL_WORKER=off).';
    case 'no_nvidia_gpu': return 'No NVIDIA GPU was detected on this machine, so the Spatial worker was not started. This Node still stores and shares the archive.';
    case 'docker_gpu_unconfirmed': return 'An NVIDIA GPU was found, but Docker\'s NVIDIA runtime was not, so the Spatial worker was not started. Install the NVIDIA Container Toolkit (Linux) or enable GPU support in Docker Desktop (Windows), or set KUBUS_SPATIAL_WORKER=on to try anyway.';
    case 'unsupported_platform': return 'The Spatial worker is supported on Linux x64 and Windows x64 only.';
    case 'worker_start_failed': return 'The Spatial worker could not be started. The Node is running without it; run "docker compose logs kubus-spatial-worker" for the reason.';
    default: return undefined;
  }
}
