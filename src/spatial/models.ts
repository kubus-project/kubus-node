export type SpatialContentType = 'gaussianSplat' | 'model3d';
export type SpatialStorageClass = 'hot' | 'warm' | 'cold';

export interface SpatialVariant {
  role: 'spatial_preview' | 'spatial_mobile' | 'spatial_archive' | 'model3d';
  cid: string;
  sizeBytes: number;
  mimeType: string;
  format: string;
  storageClass: SpatialStorageClass;
}

/**
 * Where a spatial record sits in the history of an artwork's reconstructions.
 *
 * Every record is immutable. A later reconstruction (for example, a video added
 * to a photo capture) is a NEW record with its own `id`; `revision` links it to
 * the one it revises, so a backend can bind a grant to (`id`, `revision.number`)
 * and keep the earlier record published, suspended or withdrawn on its own terms.
 */
export interface SpatialRevision {
  /** 1 for the first record of an artwork, previous number + 1 after that. */
  number: number;
  reason: 'initial' | 'video_added' | 'face_masking' | 'resolve';
  /** Free-text reason an operator gave for the revision (for example the provenance fixes made with it). */
  note?: string;
  previousSpatialId?: string;
  /**
   * The link to the previous record, so a viewer can walk the history. Deliberately absent for `reason:
   * 'face_masking'`: the previous record was reconstructed from unmasked images, and a manifest that anyone may
   * read must not name it (its id, its manifest CID, or the capture that still holds the unmasked photos).
   */
  previousManifestCid?: string;
  previousCaptureId?: string;
  /** What this record was reconstructed from. */
  inputs: { captureKind: string; photos?: number; video?: boolean };
}

export interface SpatialManifest {
  schema: 'kubus.spatial/1';
  type: SpatialContentType;
  id: string;
  artworkId: string;
  markerId?: string;
  captureId: string;
  captureProvenance: {
    source: 'localCapture';
    captureId: string;
    /** How the scene was derived when not from posed frames: video intake, frame selection, SfM and splat counts. */
    derivation?: Record<string, unknown>;
  };
  capturedAt: string;
  capturedBy?: string;
  variants: SpatialVariant[];
  /**
   * Maps splat-file coordinates to viewer coordinates (right-handed, +Y up,
   * subject centred near the origin, radius about 1, front facing +Z):
   * `matrix` is 16 numbers in column-major order (three.js `Matrix4.fromArray`).
   * `up` is the up direction in splat-file coordinates it was derived from.
   */
  transform?: { matrix?: number[]; matrixOrder?: 'column-major'; scale?: number; rotation?: number[]; position?: number[]; up?: number[]; method?: string };
  revision?: SpatialRevision;
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
    /** How the viewer transform was estimated (method, confidence, up vector). */
    orientation?: Record<string, unknown>;
    /** The optional floater crop applied at export: box, method, splat counts before and after. */
    floaterCrop?: Record<string, unknown>;
    /** Whether and how faces in the source images were masked: detector, model checksum and counts, never coordinates. */
    faceMasking?: Record<string, unknown>;
    /** The lightweight preview's method, splat counts, SH degree and byte budget; `null` when the full file is its own preview. */
    lightweight?: Record<string, unknown> | null;
  };
  createdAt: string;
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
  for (const variant of manifest.variants) {
    if (!variant.cid || !Number.isSafeInteger(variant.sizeBytes) || variant.sizeBytes < 0 || !variant.mimeType || !variant.format) {
      throw new Error('spatial_manifest_variant_invalid');
    }
  }
  const matrix = manifest.transform?.matrix;
  if (matrix !== undefined && (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every((entry) => typeof entry === 'number' && Number.isFinite(entry)))) {
    throw new Error('spatial_manifest_transform_invalid');
  }
  const revision = manifest.revision;
  if (revision !== undefined && (!Number.isSafeInteger(revision.number) || revision.number < 1
    || (revision.previousSpatialId !== undefined && typeof revision.previousSpatialId !== 'string')
    || (revision.number > 1 && !revision.previousSpatialId && revision.reason !== 'face_masking'))) {
    throw new Error('spatial_manifest_revision_invalid');
  }
  return structuredClone(manifest as SpatialManifest);
}
