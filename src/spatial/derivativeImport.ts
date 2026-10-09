import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { isBundleFileName, ROLE_STORAGE_CLASS, type SpatialDerivativeProvenance, type SpatialVariant } from './models.js';

/**
 * What a worker returns for one variant. A file variant names a path under the
 * job's output directory; a bundle variant names a directory there, its
 * entrypoint and the files it holds. Everything the worker says is checked
 * here before any byte reaches Kubo: the worker is a separate container and
 * its output is input to this process.
 */
export interface WorkerVariant {
  role: SpatialVariant['role'];
  path?: string;
  bundle?: { directory: string; entrypoint: string; files: string[] };
  mimeType: string;
  format: string;
  storageClass?: string;
}

export interface WorkerDerivative {
  tool: string;
  toolVersion: string;
  sourceSplats?: number;
  splats?: number | null;
  sourceBytes?: number;
  bytes: number;
  durationMs?: number;
  settings?: Record<string, number | string | boolean>;
}

const SAFE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/i;
const SAFE_FORMAT = /^[a-z0-9]{1,16}$/;

export class ImportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Resolves `candidate` under `root` through symlinks and refuses anything that lands outside it. */
async function resolveInside(root: string, candidate: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  let real: string;
  try {
    real = await fs.realpath(path.resolve(root, candidate));
  } catch {
    throw new ImportError('worker_output_missing', 'The worker reported a file that does not exist.');
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) throw new ImportError('worker_output_path_invalid', 'The worker reported a path outside its job directory.');
  return real;
}

function checkIdentity(variant: WorkerVariant, expectedRole: SpatialVariant['role']): void {
  if (variant.role !== expectedRole) throw new ImportError('worker_output_invalid', 'The worker returned a different representation than was requested.');
  if (!SAFE_MIME.test(variant.mimeType) || !SAFE_FORMAT.test(variant.format)) throw new ImportError('worker_output_invalid', 'The worker described its output unsafely.');
}

/**
 * Imports one worker variant into Kubo and returns the manifest variant for it.
 *
 * The storage class is taken from the role, never from the worker: a worker
 * must not be able to decide how widely the network replicates its output.
 */
export async function importWorkerVariant(
  kubo: Pick<KuboClient, 'addFileStreamed' | 'addDirectoryStreamed' | 'listBundle'>,
  outputDirectory: string,
  variant: WorkerVariant,
  expectedRole: SpatialVariant['role'],
): Promise<SpatialVariant> {
  checkIdentity(variant, expectedRole);
  const storageClass = ROLE_STORAGE_CLASS[expectedRole as keyof typeof ROLE_STORAGE_CLASS];
  if (!storageClass) throw new ImportError('worker_output_invalid', 'The worker returned a role this Node does not store.');

  if (variant.bundle) {
    const { directory, entrypoint, files } = variant.bundle;
    if (!Array.isArray(files) || files.length === 0 || files.length > 20_000) throw new ImportError('worker_output_invalid', 'The worker returned an empty or oversized bundle.');
    if (!isBundleFileName(entrypoint) || !files.every(isBundleFileName) || !files.includes(entrypoint)) {
      throw new ImportError('worker_output_invalid', 'The worker returned an unsafe bundle listing.');
    }
    if (new Set(files).size !== files.length) throw new ImportError('worker_output_invalid', 'The worker listed a bundle file twice.');
    const bundleDirectory = await resolveInside(outputDirectory, directory);
    // The directory must hold exactly what the worker says. A listing that
    // omitted a file would silently drop a chunk the entry needs; an extra file
    // would publish something nobody described.
    const present = (await fs.readdir(bundleDirectory, { withFileTypes: true }));
    if (present.some((entry) => !entry.isFile())) throw new ImportError('worker_output_invalid', 'The bundle directory contains something that is not a plain file.');
    const presentNames = present.map((entry) => entry.name).sort();
    if (JSON.stringify(presentNames) !== JSON.stringify([...files].sort())) throw new ImportError('worker_output_invalid', 'The bundle listing does not match the files that were written.');
    const added = await kubo.addDirectoryStreamed(bundleDirectory, [...files].sort());
    const imported = (await kubo.listBundle(added.rootCid)).sort();
    if (JSON.stringify(imported) !== JSON.stringify([...files].sort())) throw new ImportError('bundle_import_incomplete', 'Kubo did not store every file in the bundle.');
    return {
      role: expectedRole,
      rootCid: added.rootCid,
      entrypoint,
      fileCount: files.length,
      sizeBytes: added.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      mimeType: variant.mimeType,
      format: variant.format,
      storageClass,
    };
  }

  if (typeof variant.path !== 'string' || !variant.path) throw new ImportError('worker_output_invalid', 'The worker returned a variant without a file.');
  const target = await resolveInside(outputDirectory, variant.path);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new ImportError('worker_output_invalid', 'The worker reported something that is not a file.');
  // Streamed from disk: a Gaussian splat PLY can be hundreds of megabytes and
  // must never be held whole in memory just to re-emit it as multipart data.
  const added = await kubo.addFileStreamed(target, path.basename(target));
  if (!added.Hash) throw new ImportError('kubo_add_missing_cid', 'Kubo did not return a CID for the file.');
  return { role: expectedRole, cid: added.Hash, sizeBytes: stat.size, mimeType: variant.mimeType, format: variant.format, storageClass };
}

/** Provenance as recorded in the manifest: measured by the worker, bounded here. */
export function provenanceFrom(derivative: WorkerDerivative, importedBytes: number): SpatialDerivativeProvenance {
  const count = (value: unknown): number | undefined => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined);
  const settings: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(derivative.settings ?? {}).slice(0, 16)) {
    if (/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key) && ['number', 'string', 'boolean'].includes(typeof value)) {
      settings[key] = typeof value === 'string' ? value.slice(0, 64) : value;
    }
  }
  return {
    tool: String(derivative.tool || 'unknown').slice(0, 64),
    toolVersion: String(derivative.toolVersion || 'unknown').slice(0, 64),
    sourceSplats: count(derivative.sourceSplats),
    splats: count(derivative.splats),
    sourceBytes: count(derivative.sourceBytes),
    bytes: importedBytes,
    durationMs: count(derivative.durationMs),
    settings,
  };
}
