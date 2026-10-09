import { describe, expect, it } from 'vitest';
import {
  isBundleFileName,
  isBundleVariant,
  ROLE_STORAGE_CLASS,
  validateSpatialManifest,
  variantContentCid,
  type SpatialManifest,
} from '../src/spatial/models.js';

const CID = 'bafybeigdyrztzudirp3ybneu4qwfrmagwo3ye25qmqu4vpvzjqe4prc7lm';
const OTHER = 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

const archive = { role: 'spatial_archive', cid: CID, sizeBytes: 100, mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' };
const preview = { role: 'spatial_preview', cid: OTHER, sizeBytes: 10, mimeType: 'application/octet-stream', format: 'spz', storageClass: 'hot' };
const runtime = { role: 'spatial_mobile', rootCid: OTHER, entrypoint: 'scene.rad', fileCount: 6, sizeBytes: 500, mimeType: 'application/octet-stream', format: 'rad', storageClass: 'warm' };

function manifest(variants: unknown[] = [archive], overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: 'kubus.spatial/1', type: 'gaussianSplat', id: 'scene-1', artworkId: 'artwork-1', captureId: 'capture-1',
    captureProvenance: { source: 'localCapture', captureId: 'capture-1' }, capturedAt: '2026-08-01T00:00:00.000Z',
    variants,
    processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/2', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 15000, outputFormat: 'ply' } },
    createdAt: '2026-08-01T00:05:00.000Z',
    ...overrides,
  };
}

const withVariant = (extra: Record<string, unknown>, base: Record<string, unknown> = archive) => manifest([{ ...base, ...extra }]);

describe('spatial manifest: representation shapes', () => {
  it('accepts a legacy single-file manifest exactly as the previous release wrote it', () => {
    // The shape the 0.8.1 runtime stored: one archive variant, `cid` only, no bundle fields,
    // no derivative provenance. Existing scenes must keep validating unchanged.
    const legacy = manifest([archive]);
    const validated = validateSpatialManifest(legacy);
    expect(validated.variants).toEqual([archive]);
    expect(validated.processing.derivatives).toBeUndefined();
  });

  it('accepts all three representations together: single-file preview, bundle runtime, single-file archive', () => {
    const validated = validateSpatialManifest(manifest([preview, runtime, archive]));
    expect(validated.variants.map((variant) => variant.role)).toEqual(['spatial_preview', 'spatial_mobile', 'spatial_archive']);
    expect(validated.variants.map(isBundleVariant)).toEqual([false, true, false]);
    expect(validated.variants.map(variantContentCid)).toEqual([OTHER, OTHER, CID]);
  });

  it('describes a bundle by root, entrypoint and file count, and does not require the count', () => {
    expect(() => validateSpatialManifest(manifest([runtime]))).not.toThrow();
    const { fileCount: _omitted, ...withoutCount } = runtime;
    expect(() => validateSpatialManifest(manifest([withoutCount]))).not.toThrow();
  });

  it('keeps the two shapes mutually exclusive', () => {
    expect(() => validateSpatialManifest(manifest([{ ...runtime, cid: CID }]))).toThrow('spatial_manifest_variant_invalid');
    expect(() => validateSpatialManifest(manifest([{ ...archive, rootCid: OTHER, entrypoint: 'scene.rad' }]))).toThrow('spatial_manifest_variant_invalid');
    const { cid: _cid, ...neither } = archive;
    expect(() => validateSpatialManifest(manifest([neither]))).toThrow('spatial_manifest_variant_invalid');
    expect(() => validateSpatialManifest(withVariant({ cid: '' }))).toThrow('spatial_manifest_variant_invalid');
  });

  it('refuses bundle-only fields on a single-file variant', () => {
    expect(() => validateSpatialManifest(withVariant({ entrypoint: 'scene.rad' }))).toThrow('spatial_manifest_variant_invalid');
    expect(() => validateSpatialManifest(withVariant({ fileCount: 3 }))).toThrow('spatial_manifest_variant_invalid');
  });

  it('requires a bundle to name a safe entrypoint', () => {
    const { entrypoint: _entrypoint, ...missing } = runtime;
    expect(() => validateSpatialManifest(manifest([missing]))).toThrow('spatial_manifest_bundle_entrypoint_invalid');
    for (const entrypoint of ['', '.', '..', '../scene.rad', 'a/b.rad', 'a\\b.rad', '.hidden', '-lead.rad', 'sp ace.rad', 'nul\u0000.rad', 'ünï.rad', 'a..b.rad', 'x'.repeat(129)]) {
      expect(() => validateSpatialManifest(manifest([{ ...runtime, entrypoint }])), JSON.stringify(entrypoint)).toThrow('spatial_manifest_bundle_entrypoint_invalid');
    }
  });

  it('bounds the file count to a whole, positive, sane number', () => {
    for (const fileCount of [0, -1, 1.5, 20_001, Number.NaN, Number.POSITIVE_INFINITY, '6']) {
      expect(() => validateSpatialManifest(manifest([{ ...runtime, fileCount }])), String(fileCount)).toThrow('spatial_manifest_variant_invalid');
    }
    expect(() => validateSpatialManifest(manifest([{ ...runtime, fileCount: 1 }]))).not.toThrow();
    expect(() => validateSpatialManifest(manifest([{ ...runtime, fileCount: 20_000 }]))).not.toThrow();
  });

  it('requires a whole, non-negative size and a declared type and format', () => {
    for (const sizeBytes of [-1, 1.5, Number.NaN, '100', undefined, 2 ** 60]) {
      expect(() => validateSpatialManifest(withVariant({ sizeBytes })), String(sizeBytes)).toThrow('spatial_manifest_variant_invalid');
    }
    expect(() => validateSpatialManifest(withVariant({ sizeBytes: 0 }))).not.toThrow();
    expect(() => validateSpatialManifest(withVariant({ mimeType: '' }))).toThrow('spatial_manifest_variant_invalid');
    expect(() => validateSpatialManifest(withVariant({ format: '' }))).toThrow('spatial_manifest_variant_invalid');
    expect(() => validateSpatialManifest(manifest([null]))).toThrow('spatial_manifest_variant_invalid');
    expect(() => validateSpatialManifest(manifest(['archive']))).toThrow();
  });
});

describe('spatial manifest: roles and storage class', () => {
  it('fixes the storage class by role', () => {
    expect(ROLE_STORAGE_CLASS).toEqual({ spatial_preview: 'hot', spatial_mobile: 'warm', spatial_archive: 'cold' });
  });

  it.each([
    ['spatial_preview', 'hot'], ['spatial_mobile', 'warm'], ['spatial_archive', 'cold'],
  ])('%s must be %s and nothing else', (role, expected) => {
    const base = role === 'spatial_mobile' ? runtime : { ...archive, role };
    expect(() => validateSpatialManifest(manifest([{ ...base, storageClass: expected }]))).not.toThrow();
    for (const wrong of ['hot', 'warm', 'cold', 'archive', '', undefined].filter((candidate) => candidate !== expected)) {
      expect(() => validateSpatialManifest(manifest([{ ...base, storageClass: wrong }])), `${role} as ${String(wrong)}`).toThrow('spatial_manifest_storage_class_invalid');
    }
  });

  it('refuses a role this Node does not store, so it cannot claim a class of its own', () => {
    for (const role of ['spatial_other', 'archive', '', 'SPATIAL_ARCHIVE', undefined, 7]) {
      expect(() => validateSpatialManifest(manifest([{ ...archive, role, storageClass: 'hot' }])), String(role)).toThrow('spatial_manifest_variant_role_invalid');
    }
  });

  it('refuses two representations for one role, so "the preview" is unambiguous', () => {
    expect(() => validateSpatialManifest(manifest([archive, { ...archive, cid: OTHER }]))).toThrow('spatial_manifest_variant_duplicate_role');
    expect(() => validateSpatialManifest(manifest([preview, runtime, preview]))).toThrow('spatial_manifest_variant_duplicate_role');
  });
});

describe('spatial manifest: envelope', () => {
  it('rejects a document that is not a supported kubus.spatial/1 manifest', () => {
    expect(() => validateSpatialManifest(null)).toThrow('spatial_manifest_invalid');
    expect(() => validateSpatialManifest('x')).toThrow('spatial_manifest_invalid');
    expect(() => validateSpatialManifest(manifest([archive], { schema: 'kubus.spatial/2' }))).toThrow('spatial_manifest_schema_unsupported');
    expect(() => validateSpatialManifest(manifest([archive], { type: 'pointCloud' }))).toThrow('spatial_manifest_type_invalid');
    for (const field of ['id', 'artworkId', 'captureId', 'capturedAt']) {
      expect(() => validateSpatialManifest(manifest([archive], { [field]: '' })), field).toThrow('spatial_manifest_required_field_missing');
    }
    expect(() => validateSpatialManifest(manifest([archive], { processing: undefined }))).toThrow('spatial_manifest_processing_invalid');
    expect(() => validateSpatialManifest(manifest([archive], { variants: [] }))).toThrow('spatial_manifest_variants_required');
    expect(() => validateSpatialManifest(manifest([archive], { variants: undefined }))).toThrow('spatial_manifest_variants_required');
  });

  it('requires the reconstruction record the engine and iteration count', () => {
    const processing = (reconstruction: Record<string, unknown>) => ({ protocol: 'kubus.spatial-job/1', workerVersion: 'w/2', reconstruction });
    const good = { engine: 'nerfstudio', method: 'splatfacto', iterations: 15000, outputFormat: 'ply' };
    expect(() => validateSpatialManifest(manifest([archive], { processing: processing(good) }))).not.toThrow();
    for (const bad of [{ ...good, engine: 'colmap' }, { ...good, method: 'nerfacto' }, { ...good, iterations: 0 }, { ...good, iterations: 1.5 }, { ...good, outputFormat: '' }]) {
      expect(() => validateSpatialManifest(manifest([archive], { processing: processing(bad) })), JSON.stringify(bad)).toThrow('spatial_manifest_reconstruction_invalid');
    }
  });

  it('returns a copy, so mutating the result cannot change the manifest that was validated', () => {
    const input = manifest([archive]) as SpatialManifest;
    const output = validateSpatialManifest(input);
    output.variants[0]!.sizeBytes = 1;
    output.id = 'changed';
    expect(input.variants[0]!.sizeBytes).toBe(100);
    expect(input.id).toBe('scene-1');
  });
});

describe('bundle file names', () => {
  it('accepts the names a paged runtime actually uses', () => {
    for (const name of ['scene.rad', 'scene-lod.rad', 'scene-lod-0.radc', 'scene-lod-12345.radc', 'a', 'A_b-c.d', 'x'.repeat(128)]) {
      expect(isBundleFileName(name), name).toBe(true);
    }
  });

  it('accepts only one plain path segment', () => {
    for (const name of ['', '.', '..', '...', '.x', '-x', '_x', 'a/b', '/a', 'a/', 'a\\b', 'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a%2fb', 'a..b', 'ünï', 'x'.repeat(129), null, undefined, 7, {}, ['a']]) {
      expect(isBundleFileName(name), JSON.stringify(name)).toBe(false);
    }
  });
});
