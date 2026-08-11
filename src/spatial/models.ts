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
  return structuredClone(manifest as SpatialManifest);
}
