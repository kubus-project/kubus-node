import type { AppConfig } from '../config/schema.js';
import type { LocalState } from '../state/localStore.js';

export interface ComputeProviderSettings {
  enabled: boolean;
  paused: boolean;
  maxConcurrency: number;
  maxQueueDepth: number;
  maxAcceptedInputBytes: number;
  minimumFreeVramBytes: number;
}

export function effectiveComputeProviderSettings(config: AppConfig, state: LocalState): ComputeProviderSettings {
  const saved = state.computeProviderSettings;
  return {
    enabled: saved?.enabled ?? config.offerRemoteCompute,
    paused: saved?.paused ?? config.remoteComputePaused,
    maxConcurrency: saved?.maxConcurrency ?? config.remoteComputeMaxConcurrency,
    maxQueueDepth: saved?.maxQueueDepth ?? config.remoteComputeMaxQueueDepth,
    maxAcceptedInputBytes: saved?.maxAcceptedInputBytes ?? config.remoteComputeMaxInputBytes,
    minimumFreeVramBytes: saved?.minimumFreeVramBytes ?? config.remoteComputeMinimumFreeVramBytes,
  };
}

export function validateComputeProviderSettings(input: Record<string, unknown>, current: ComputeProviderSettings): ComputeProviderSettings {
  const integer = (key: keyof ComputeProviderSettings, minimum: number, maximum: number): number => {
    if (input[key] === undefined) return current[key] as number;
    const value = Number(input[key]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw Object.assign(new Error(`compute_setting_${key}_invalid`), { statusCode: 400, code: `compute_setting_${key}_invalid` });
    return value;
  };
  return {
    enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
    paused: input.paused === undefined ? current.paused : input.paused === true,
    maxConcurrency: integer('maxConcurrency', 1, 16),
    maxQueueDepth: integer('maxQueueDepth', 0, 100),
    maxAcceptedInputBytes: integer('maxAcceptedInputBytes', 1024 * 1024, 1024 * 1024 * 1024 * 1024),
    minimumFreeVramBytes: integer('minimumFreeVramBytes', 0, 1024 * 1024 * 1024 * 1024),
  };
}
