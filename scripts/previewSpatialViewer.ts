/**
 * Serves real worker output through the real GUI, so the Spatial viewer can be
 * opened (or driven by a browser test) against the exact delivery path:
 * Kubo bundle -> viewer ticket -> capability content route -> renderer.
 *
 *   KUBUS_TEST_KUBO_BIN=/path/to/ipfs npx tsx scripts/previewSpatialViewer.ts <worker-output-dir>
 *
 * `<worker-output-dir>` is a job output directory holding `master.ply`,
 * `preview/preview.spz` and a `runtime/` bundle (what the spatial worker writes).
 * It starts a throwaway offline Kubo, imports those files through the same
 * importer a job uses, records three scenes (full, preview-only, archive-only),
 * and prints the GUI address and credential. Development tooling: it never
 * touches the node's real state, Kubo or network, and everything is deleted on exit (Ctrl-C or SIGTERM).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGuiServer } from '../src/gui/guiServer.js';
import { KuboClient } from '../src/ipfs/kuboClient.js';
import { ActionLock } from '../src/runtime/actionLock.js';
import { importWorkerVariant } from '../src/spatial/derivativeImport.js';
import { LocalStore } from '../src/state/localStore.js';
import { startDisposableKubo } from '../tests/helpers/disposableKubo.js';

const outputDirectory = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.error('usage: previewSpatialViewer.ts <worker-output-dir>'); process.exit(2); }

const GUI_TOKEN = 'preview-gui-credential';
const kubo = await startDisposableKubo();
const client = new KuboClient(kubo.apiUrl, 60_000);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-viewer-preview-'));

const runtimeFiles = (await fs.readdir(path.join(outputDirectory, 'runtime'))).sort();
const archive = await importWorkerVariant(client, outputDirectory, { role: 'spatial_archive', path: 'master.ply', mimeType: 'application/octet-stream', format: 'ply' }, 'spatial_archive');
const preview = await importWorkerVariant(client, outputDirectory, { role: 'spatial_preview', path: 'preview/preview.spz', mimeType: 'application/octet-stream', format: 'spz' }, 'spatial_preview');
const runtime = await importWorkerVariant(client, outputDirectory, {
  role: 'spatial_mobile', bundle: { directory: 'runtime', entrypoint: 'scene-lod.rad', files: runtimeFiles }, mimeType: 'application/octet-stream', format: 'rad',
}, 'spatial_mobile');

const store = new LocalStore(path.join(workspace, 'state.json'));
await store.load();
const manifest = (id: string, variants: unknown[]) => ({
  schema: 'kubus.spatial/1', type: 'gaussianSplat', id, artworkId: id, captureId: `capture-${id}`,
  captureProvenance: { source: 'localCapture', captureId: `capture-${id}` }, capturedAt: '2026-08-01T00:00:00.000Z', variants,
  processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/2', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 15000, outputFormat: 'ply' } },
  createdAt: '2026-08-01T00:05:00.000Z',
});
await store.update((state) => {
  const spatial = (state.spatial ??= {}) as Record<string, unknown>;
  const add = (id: string, variants: unknown[]) => {
    const m = manifest(id, variants);
    spatial[id] = { id, state: 'local', manifestCid: archive.cid, manifest: m, createdAt: m.createdAt };
  };
  add('scene-full', [archive, preview, runtime]);
  add('scene-preview-only', [archive, preview]);
  add('scene-archive-only', [archive]);
});

const server = await startGuiServer({
  api: { getHealth: async () => ({ ok: true }) } as never,
  kubo: client,
  store,
  config: {
    guiHost: '127.0.0.1', guiAllowRemote: false, guiToken: GUI_TOKEN, guiEnabled: true, guiPort: 0,
    localApiEnabled: false, apiBaseUrl: 'http://api.test', ipfsGatewayUrl: 'http://127.0.0.1:8080', cidClassFilters: [],
  } as never,
  logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
  actionLock: new ActionLock(),
});

console.log(JSON.stringify({ origin: new URL(server.url).origin, guiToken: GUI_TOKEN, scenes: ['scene-full', 'scene-preview-only', 'scene-archive-only'], variants: { archive, preview, runtime } }));

// Keeps the process alive until signalled.
setInterval(() => undefined, 1 << 30);
const stop = async () => { await server.close(); await kubo.stop(); await fs.rm(workspace, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
