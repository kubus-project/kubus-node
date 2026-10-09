export type SpatialContentType = 'gaussianSplat' | 'model3d';
export type SpatialStorageClass = 'hot' | 'warm' | 'cold';
export type SpatialVariantRole = 'spatial_preview' | 'spatial_mobile' | 'spatial_archive' | 'model3d';

/**
 * One delivery representation of a Spatial scene.
 *
 * A variant is either a single immutable file or a flat, immutable bundle of
 * files that only make sense together (a paged RAD tree is `scene.rad` plus
 * the `.radc` chunks its header names). The two shapes are mutually exclusive:
 *
 * - single file: `cid` names the file.
 * - bundle: `rootCid` names an immutable directory and `entrypoint` the file
 *   inside it a renderer starts from. The chunk graph belongs to the
 *   representation; chunks are never variants of their own.
 *
 * `sizeBytes` is the total logical size of the representation in both shapes.
 * Pre-bundle manifests carry only `cid` and stay valid unchanged.
 */
export interface SpatialVariant {
  role: SpatialVariantRole;
  cid?: string;
  rootCid?: string;
  entrypoint?: string;
  /** Number of files in a bundle, when known. Factual, never an estimate. */
  fileCount?: number;
  sizeBytes: number;
  mimeType: string;
  format: string;
  storageClass: SpatialStorageClass;
}

/**
 * Storage class is a property of the role, not a free choice: the public
 * pin set and the replication planner key off it, and a manifest that claimed
 * an archive was "hot" would ask every node to replicate it.
 */
export const ROLE_STORAGE_CLASS: Readonly<Record<'spatial_preview' | 'spatial_mobile' | 'spatial_archive', SpatialStorageClass>> = {
  spatial_preview: 'hot',
  spatial_mobile: 'warm',
  spatial_archive: 'cold',
};

/** What a derivative was made from and with, measured at generation time. */
export interface SpatialDerivativeProvenance {
  tool: string;
  toolVersion: string;
  /** Splat count of the master the derivative was made from, when measured. */
  sourceSplats?: number;
  /** Splat count of the derivative itself, when measured. */
  splats?: number;
  sourceBytes?: number;
  bytes: number;
  durationMs?: number;
  settings?: Record<string, number | string | boolean>;
}

export interface SpatialManifest {
  schema: 'kubus.spatial/1';
  type: SpatialContentType;
  id: string;
  artworkId: string;
  markerId?: string;
  captureId: string;
  captureProvenance: { source: 'localCapture'; captureId: string };
  capturedAt: string;
  capturedBy?: string;
  variants: SpatialVariant[];
  transform?: { matrix?: number[]; scale?: number; rotation?: number[]; position?: number[] };
  viewerDefaults?: Record<string, unknown>;
  processing: {
    protocol: 'kubus.spatial-job/1';
    workerVersion: string;
    reconstruction: {
      engine: 'nerfstudio';
      method: 'splatfacto';
      iterations: number;
      outputFormat: string;
    };
    /** Present once a preview or runtime derivative has been generated. */
    derivatives?: {
      preview?: SpatialDerivativeProvenance;
      runtime?: SpatialDerivativeProvenance;
    };
  };
  createdAt: string;
}

const BUNDLE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_BUNDLE_FILES = 20_000;

/**
 * A bundle is flat: one directory, no subdirectories. A file name is a single
 * path segment from a conservative alphabet, so a name can neither climb out of
 * the bundle nor address anything but a direct child. Rejecting at the grammar
 * is stronger than normalising a path and hoping the result stayed inside.
 */
export function isBundleFileName(value: unknown): value is string {
  return typeof value === 'string' && BUNDLE_FILE_NAME.test(value) && !value.includes('..');
}

/** The CID that names this variant's content: the file, or the bundle root. */
export function variantContentCid(variant: Pick<SpatialVariant, 'cid' | 'rootCid'>): string {
  return (variant.rootCid ?? variant.cid) as string;
}

export function isBundleVariant(variant: Pick<SpatialVariant, 'rootCid'>): boolean {
  return typeof variant.rootCid === 'string';
}

function validateVariant(variant: Partial<SpatialVariant>): void {
  if (!variant || typeof variant !== 'object') throw new Error('spatial_manifest_variant_invalid');
  if (!Number.isSafeInteger(variant.sizeBytes) || (variant.sizeBytes as number) < 0 || !variant.mimeType || !variant.format) {
    throw new Error('spatial_manifest_variant_invalid');
  }
  const hasCid = typeof variant.cid === 'string' && variant.cid.length > 0;
  const hasRoot = typeof variant.rootCid === 'string' && variant.rootCid.length > 0;
  // Exactly one: a variant that named both would let two readers disagree about
  // which bytes they were asked to trust.
  if (hasCid === hasRoot) throw new Error('spatial_manifest_variant_invalid');
  if (hasRoot) {
    if (!isBundleFileName(variant.entrypoint)) throw new Error('spatial_manifest_bundle_entrypoint_invalid');
    if (variant.fileCount !== undefined && (!Number.isSafeInteger(variant.fileCount) || variant.fileCount < 1 || variant.fileCount > MAX_BUNDLE_FILES)) {
      throw new Error('spatial_manifest_variant_invalid');
    }
  } else if (variant.entrypoint !== undefined || variant.fileCount !== undefined) {
    throw new Error('spatial_manifest_variant_invalid');
  }
  const policy = ROLE_STORAGE_CLASS[variant.role as keyof typeof ROLE_STORAGE_CLASS];
  if (policy && variant.storageClass !== policy) throw new Error('spatial_manifest_storage_class_invalid');
}

export function validateSpatialManifest(value: unknown): SpatialManifest {
  if (!value || typeof value !== 'object') throw new Error('spatial_manifest_invalid');
  const manifest = value as Partial<SpatialManifest>;
  if (manifest.schema !== 'kubus.spatial/1') throw new Error('spatial_manifest_schema_unsupported');
  if (!['gaussianSplat', 'model3d'].includes(String(manifest.type))) throw new Error('spatial_manifest_type_invalid');
  if (!manifest.id || !manifest.artworkId || !manifest.captureId || !manifest.capturedAt) throw new Error('spatial_manifest_required_field_missing');
  if (manifest.processing?.protocol !== 'kubus.spatial-job/1' || !manifest.processing.workerVersion) throw new Error('spatial_manifest_processing_invalid');
  const reconstruction = manifest.processing.reconstruction;
  if (reconstruction?.engine !== 'nerfstudio' || reconstruction.method !== 'splatfacto' || !Number.isSafeInteger(reconstruction.iterations) || reconstruction.iterations <= 0 || !reconstruction.outputFormat) {
    throw new Error('spatial_manifest_reconstruction_invalid');
  }
  if (!Array.isArray(manifest.variants) || manifest.variants.length === 0) throw new Error('spatial_manifest_variants_required');
  const roles = new Set<string>();
  for (const variant of manifest.variants) {
    validateVariant(variant);
    // One representation per role: "the preview" must be unambiguous.
    if (roles.has(variant.role)) throw new Error('spatial_manifest_variant_duplicate_role');
    roles.add(variant.role);
  }
  return structuredClone(manifest as SpatialManifest);
}
