import type { KuboClient } from '../ipfs/kuboClient.js';
import type { LocalStore } from '../state/localStore.js';
import { localError } from '../localApi/pairingService.js';
import {
  validateSpatialManifest,
  type SpatialDerivativeProvenance,
  type SpatialManifest,
  type SpatialVariant,
} from './models.js';

export type DerivativeKind = 'preview' | 'runtime';

export const DERIVATIVE_ROLE: Record<DerivativeKind, SpatialVariant['role']> = {
  preview: 'spatial_preview',
  runtime: 'spatial_mobile',
};

/** The one attempt that explains why a derivative is not (yet) there. */
export interface DerivativeAttempt {
  state: 'running' | 'failed';
  jobId: string;
  at: string;
  error?: { code: string; message: string };
}

export interface SpatialStoreRecord {
  id: string;
  state: string;
  manifestCid: string;
  manifest: SpatialManifest;
  createdAt: string;
  /** Earlier manifest CIDs of this scene, oldest first. Their blocks stay pinned: a published reference may still name one. */
  manifestHistory?: string[];
  /** Where the preview / runtime derivatives stand when they are not simply present. */
  derivatives?: Partial<Record<DerivativeKind, DerivativeAttempt>>;
  privateSourceCapture?: boolean;
  publication?: unknown;
}

export type DerivativeSummaryState = 'ready' | 'running' | 'failed' | 'missing';
export interface DerivativeSummary {
  state: DerivativeSummaryState;
  error?: { code: string; message: string };
}

/**
 * Whether each derivative exists, is being made, failed, or was never made.
 * "Ready" is read from the manifest itself, so it cannot disagree with what a
 * viewer will actually be offered.
 */
export function summarizeDerivatives(record: Pick<SpatialStoreRecord, 'manifest' | 'derivatives'>): Record<DerivativeKind, DerivativeSummary> {
  const summarize = (kind: DerivativeKind): DerivativeSummary => {
    if (record.manifest.variants.some((variant) => variant.role === DERIVATIVE_ROLE[kind])) return { state: 'ready' };
    const attempt = record.derivatives?.[kind];
    if (attempt?.state === 'running') return { state: 'running' };
    if (attempt?.state === 'failed') return { state: 'failed', error: attempt.error };
    return { state: 'missing' };
  };
  return { preview: summarize('preview'), runtime: summarize('runtime') };
}

const MAX_MANIFEST_HISTORY = 20;

/**
 * Reads and rewrites Spatial records. A scene's manifest is content-addressed
 * and so immutable; adding a derivative therefore writes a new manifest and
 * moves the record to its CID, keeping the scene id stable. Writes for one
 * scene are serialised so two derivatives finishing together cannot each start
 * from the manifest the other has just replaced.
 */
export class SpatialRecords {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: { store: LocalStore; kubo: Pick<KuboClient, 'addBytes'> }) {}

  get(id: string): SpatialStoreRecord {
    const record = this.deps.store.snapshot().spatial?.[id] as SpatialStoreRecord | undefined;
    if (!record || typeof record !== 'object' || !record.manifest) throw localError(404, 'spatial_not_found');
    return structuredClone(record);
  }

  find(id: string): SpatialStoreRecord | undefined {
    try {
      return this.get(id);
    } catch {
      return undefined;
    }
  }

  async create(manifest: SpatialManifest, extras: Partial<SpatialStoreRecord> = {}): Promise<SpatialStoreRecord> {
    validateSpatialManifest(manifest);
    const manifestCid = await this.addManifest(manifest);
    const record: SpatialStoreRecord = {
      id: manifest.id,
      state: 'local',
      manifestCid,
      manifest,
      createdAt: manifest.createdAt,
      privateSourceCapture: true,
      ...extras,
    };
    await this.deps.store.update((state) => { (state.spatial ??= {})[record.id] = record; });
    return structuredClone(record);
  }

  /**
   * Adds or replaces the variant for its role and records how it was made.
   * Safe against a concurrent writer for the same scene.
   */
  attachVariant(id: string, variant: SpatialVariant, kind: DerivativeKind | null, provenance?: SpatialDerivativeProvenance): Promise<SpatialStoreRecord> {
    return this.exclusive(id, async () => {
      const current = this.get(id);
      const manifest = structuredClone(current.manifest);
      manifest.variants = [...manifest.variants.filter((existing) => existing.role !== variant.role), variant]
        .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
      if (kind && provenance) {
        manifest.processing.derivatives = { ...manifest.processing.derivatives, [kind]: provenance };
      }
      validateSpatialManifest(manifest);
      const manifestCid = await this.addManifest(manifest);
      await this.deps.store.update((state) => {
        const stored = state.spatial?.[id] as SpatialStoreRecord | undefined;
        if (!stored) return;
        if (stored.manifestCid !== manifestCid) {
          stored.manifestHistory = [...(stored.manifestHistory ?? []), stored.manifestCid].slice(-MAX_MANIFEST_HISTORY);
        }
        stored.manifest = manifest;
        stored.manifestCid = manifestCid;
        if (kind && stored.derivatives) delete stored.derivatives[kind];
      });
      return this.get(id);
    });
  }

  /** Records that a derivative is being made, or why it could not be, or (null) clears the note. */
  markDerivative(id: string, kind: DerivativeKind, attempt: DerivativeAttempt | null): Promise<void> {
    return this.exclusive(id, async () => {
      await this.deps.store.update((state) => {
        const stored = state.spatial?.[id] as SpatialStoreRecord | undefined;
        if (!stored) return;
        stored.derivatives ??= {};
        if (attempt) stored.derivatives[kind] = attempt;
        else delete stored.derivatives[kind];
      });
    });
  }

  /** On startup, nothing can still be running: a note that says so is a leftover of a crash. */
  async clearStaleRunning(): Promise<void> {
    await this.deps.store.update((state) => {
      for (const value of Object.values(state.spatial ?? {})) {
        const record = value as SpatialStoreRecord;
        for (const kind of ['preview', 'runtime'] as const) {
          if (record.derivatives?.[kind]?.state === 'running') delete record.derivatives[kind];
        }
      }
    });
  }

  private async addManifest(manifest: SpatialManifest): Promise<string> {
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const added = await this.deps.kubo.addBytes(bytes, `${manifest.id}.spatial.json`);
    if (!added.Hash) throw new Error('kubo_add_manifest_missing_cid');
    return added.Hash;
  }

  private exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(() => undefined, () => undefined);
    this.locks.set(id, tail);
    void tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
    return result;
  }
}

const ROLE_ORDER: SpatialVariant['role'][] = ['spatial_preview', 'spatial_mobile', 'spatial_archive', 'model3d'];
