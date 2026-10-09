import { describe, expect, it } from 'vitest';
import {
  SPATIAL_WORKER_STATES,
  SPATIAL_WORKER_URL,
  describeSpatialWorkerState,
  dockerHasNvidiaRuntime,
  envUpdatesFor,
  parseNvidiaSmi,
  parseSpatialWorkerMode,
  planSpatialWorker,
  type SpatialWorkerProbe,
} from '../src/installer/spatialWorker.js';
import { mergeEnvText, readEnvValue } from '../src/installer/runtimeEnv.js';

const RTX = { name: 'NVIDIA GeForce RTX 3080 Ti', vramMb: 12288, driver: '566.36' };
const probe = (overrides: Partial<SpatialWorkerProbe> = {}): SpatialWorkerProbe => ({ platformSupported: true, gpus: [RTX], dockerNvidiaRuntime: true, ...overrides });

describe('KUBUS_SPATIAL_WORKER', () => {
  it('defaults to auto and accepts auto, on and off in any case', () => {
    expect(parseSpatialWorkerMode(undefined)).toBe('auto');
    expect(parseSpatialWorkerMode('')).toBe('auto');
    expect(parseSpatialWorkerMode('  ')).toBe('auto');
    for (const [input, expected] of [['auto', 'auto'], ['ON', 'on'], [' Off ', 'off']] as const) expect(parseSpatialWorkerMode(input)).toBe(expected);
  });

  it('refuses anything else instead of guessing', () => {
    for (const value of ['true', 'false', '1', '0', 'yes', 'gpu', 'enabled']) expect(() => parseSpatialWorkerMode(value), value).toThrow('KUBUS_SPATIAL_WORKER must be auto, on or off');
  });
});

describe('reading nvidia-smi', () => {
  it('reads one line per GPU: name, memory in MiB, driver', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3080 Ti, 12288, 566.36\n')).toEqual([RTX]);
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3080 Ti, 12288, 566.36\nNVIDIA GeForce RTX 3070 Ti, 8192, 566.36\r\n')).toEqual([
      RTX, { name: 'NVIDIA GeForce RTX 3070 Ti', vramMb: 8192, driver: '566.36' },
    ]);
  });

  it('keeps a name that itself contains a comma whole', () => {
    expect(parseNvidiaSmi('NVIDIA RTX A4000, Laptop GPU, 8192, 550.54.14')).toEqual([{ name: 'NVIDIA RTX A4000, Laptop GPU', vramMb: 8192, driver: '550.54.14' }]);
  });

  it('finds no GPU in the tool\'s complaints or in garbage, rather than inventing one', () => {
    for (const output of ['', '\n', 'No devices were found', 'NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver.', 'a, b', 'name, notanumber, 1.0', 'name, 0, 1.0', 'name, -5, 1.0', ', 12288, 566.36', 'name, 12288, ']) {
      expect(parseNvidiaSmi(output), JSON.stringify(output)).toEqual([]);
    }
  });
});

describe('reading Docker\'s runtimes', () => {
  it('is true only when a runtime named exactly nvidia is registered', () => {
    expect(dockerHasNvidiaRuntime('{"io.containerd.runc.v2":{"path":"runc"},"nvidia":{"path":"nvidia-container-runtime"},"runc":{"path":"runc"}}\n')).toBe(true);
    expect(dockerHasNvidiaRuntime('{"io.containerd.runc.v2":{"path":"runc"},"runc":{"path":"runc"}}')).toBe(false);
    expect(dockerHasNvidiaRuntime('{"nvidia-experimental":{"path":"x"}}')).toBe(false);
    expect(dockerHasNvidiaRuntime('{}')).toBe(false);
  });

  it('is "could not tell" - not "no" - for output it cannot read', () => {
    for (const output of ['', 'not json', 'null', '[]', '"nvidia"', '42']) expect(dockerHasNvidiaRuntime(output), output).toBeNull();
  });
});

describe('deciding', () => {
  it('off never runs the worker, whatever the machine has', () => {
    expect(planSpatialWorker('off', probe())).toMatchObject({ start: false, state: 'operator_off' });
    expect(planSpatialWorker('off', probe({ gpus: [], dockerNvidiaRuntime: null }))).toMatchObject({ start: false, state: 'operator_off' });
  });

  it('auto runs it only when there is a GPU AND Docker can give a container one', () => {
    expect(planSpatialWorker('auto', probe())).toMatchObject({ start: true, state: 'enabled' });
    expect(planSpatialWorker('auto', probe({ gpus: [] }))).toMatchObject({ start: false, state: 'no_nvidia_gpu' });
    expect(planSpatialWorker('auto', probe({ gpus: [], dockerNvidiaRuntime: null }))).toMatchObject({ start: false, state: 'no_nvidia_gpu' });
  });

  it('auto does not start a worker for a GPU the container could not use', () => {
    // The host has a GPU; that does not make it available inside a container.
    expect(planSpatialWorker('auto', probe({ dockerNvidiaRuntime: false }))).toMatchObject({ start: false, state: 'docker_gpu_unconfirmed' });
    expect(planSpatialWorker('auto', probe({ dockerNvidiaRuntime: null }))).toMatchObject({ start: false, state: 'docker_gpu_unconfirmed' });
  });

  it('on lets the operator insist where detection found nothing, but not where the platform cannot run it', () => {
    expect(planSpatialWorker('on', probe({ gpus: [], dockerNvidiaRuntime: null }))).toMatchObject({ start: true, state: 'enabled' });
    expect(planSpatialWorker('on', probe({ platformSupported: false }))).toMatchObject({ start: false, state: 'unsupported_platform' });
    expect(planSpatialWorker('auto', probe({ platformSupported: false }))).toMatchObject({ start: false, state: 'unsupported_platform' });
  });

  it('reports what it found, so the Node can show it', () => {
    expect(planSpatialWorker('auto', probe({ dockerNvidiaRuntime: false }))).toMatchObject({ mode: 'auto', gpus: [RTX], dockerNvidiaRuntime: false });
  });
});

describe('what is recorded in runtime.env', () => {
  it('turns the profile and the URL on together, and off together', () => {
    const on = envUpdatesFor({ mode: 'auto', start: true, state: 'enabled' }, '');
    expect(on).toEqual({ KUBUS_SPATIAL_WORKER: 'auto', KUBUS_SPATIAL_WORKER_STATE: 'enabled', SPATIAL_WORKER_URL: SPATIAL_WORKER_URL, COMPOSE_PROFILES: 'spatial' });
    const off = envUpdatesFor({ mode: 'auto', start: false, state: 'no_nvidia_gpu' }, 'COMPOSE_PROFILES=spatial\n');
    expect(off).toEqual({ KUBUS_SPATIAL_WORKER: 'auto', KUBUS_SPATIAL_WORKER_STATE: 'no_nvidia_gpu', SPATIAL_WORKER_URL: '', COMPOSE_PROFILES: null });
  });

  it('leaves profiles the operator enabled alone', () => {
    const existing = 'NODE_BIND_ADDRESS=127.0.0.1\nCOMPOSE_PROFILES=monitoring\n';
    const enabled = mergeEnvText(existing, envUpdatesFor({ mode: 'on', start: true, state: 'enabled' }, existing));
    expect(readEnvValue(enabled, 'COMPOSE_PROFILES')).toBe('monitoring,spatial');
    const disabled = mergeEnvText(enabled, envUpdatesFor({ mode: 'off', start: false, state: 'operator_off' }, enabled));
    expect(readEnvValue(disabled, 'COMPOSE_PROFILES')).toBe('monitoring');
    expect(readEnvValue(disabled, 'SPATIAL_WORKER_URL')).toBe('');
  });

  it('produces values the env-file merger accepts for every state', () => {
    for (const state of SPATIAL_WORKER_STATES) {
      for (const start of [true, false]) expect(() => mergeEnvText('', envUpdatesFor({ mode: 'auto', start, state }, '')), `${state}/${start}`).not.toThrow();
    }
  });
});

describe('what the Node says about it', () => {
  it('explains every reason the worker is not running, and says nothing for "enabled"', () => {
    for (const state of SPATIAL_WORKER_STATES.filter((entry) => entry !== 'enabled')) expect(describeSpatialWorkerState(state)?.length, state).toBeGreaterThan(40);
    expect(describeSpatialWorkerState('enabled')).toBeUndefined();
    expect(describeSpatialWorkerState('something_else')).toBeUndefined();
    expect(describeSpatialWorkerState(undefined)).toBeUndefined();
  });

  it('does not make the Node sound broken when it simply has no GPU', () => {
    expect(describeSpatialWorkerState('no_nvidia_gpu')).toContain('still stores and shares the archive');
  });

  it('tells the operator what to do when the GPU is there but Docker cannot use it', () => {
    const text = describeSpatialWorkerState('docker_gpu_unconfirmed')!;
    expect(text).toContain('NVIDIA Container Toolkit');
    expect(text).toContain('KUBUS_SPATIAL_WORKER=on');
  });
});
