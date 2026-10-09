import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { spatialViewerBootstrapJs, spatialViewerHtml } from '../src/gui/templates/spatialViewer.js';
import { spatialViewerBundle, spatialViewerBundleSource } from '../src/gui/public/vendor/spatialViewerBundle.js';

/**
 * The page that hosts the Spatial viewer asks for capabilities and hands the
 * renderer same-origin URLs. These tests run the real bootstrap script against
 * stand-ins for the browser APIs it uses and record exactly what it asks for;
 * tests/spatialViewerBrowser.test.ts (skipped without a browser) runs the whole
 * path in Chromium.
 */

interface Call { url: string; method: string; headers: Record<string, string>; body?: string; keepalive?: boolean }

function representation(role: string, entry: string, bundle = false) {
  return { role, format: bundle ? 'rad' : 'spz', bundle, sizeBytes: 10, url: `/gui/content/${'T'.repeat(43)}/${entry}`, expiresAt: '2030-01-01T00:00:00.000Z', idleTtlMs: 600000 };
}

async function runBootstrap(options: {
  search: string;
  token?: string;
  ticket?: unknown;
  ticketStatus?: number;
}) {
  const calls: Call[] = [];
  const loads: Array<{ api: string; argument: unknown }> = [];
  const status = { hidden: false, textContent: '' };
  const listeners: Record<string, () => void> = {};
  const errors: unknown[] = [];
  const sandbox = {
    document: { querySelector: () => status },
    location: { search: options.search, origin: 'http://127.0.0.1:4321' },
    localStorage: { getItem: (key: string) => (key === 'kubus_node_gui_token' ? options.token ?? '' : null) },
    URLSearchParams,
    console: { error: (error: unknown) => errors.push(error) },
    JSON, Object, encodeURIComponent, Error, Promise,
    fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; keepalive?: boolean } = {}) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, keepalive: init.keepalive });
      const ok = (options.ticketStatus ?? 201) < 400;
      return { ok, status: options.ticketStatus ?? 201, json: async () => ({ success: ok, data: options.ticket }), blob: async () => { throw new Error('the bootstrap must not read a Blob'); } };
    },
    window: {
      addEventListener: (name: string, handler: () => void) => { listeners[name] = handler; },
      loadSpatial: (argument: unknown) => { loads.push({ api: 'loadSpatial', argument }); return Promise.resolve(); },
      loadSpatialProgressive: (argument: unknown) => { loads.push({ api: 'loadSpatialProgressive', argument }); return Promise.resolve({ ok: true }); },
      unloadSpatial: () => loads.push({ api: 'unloadSpatial', argument: undefined }),
    },
  } as Record<string, unknown>;
  (sandbox.location as { search: string }).search = options.search;
  vm.runInNewContext(spatialViewerBootstrapJs, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { calls, loads, status, listeners, errors, sandbox };
}

describe('spatial viewer bootstrap', () => {
  it('asks for a ticket with the GUI credential and never puts that credential on a content URL', async () => {
    const ticket = { spatialId: 's1', representations: [representation('spatial_preview', 'preview.spz'), representation('spatial_mobile', 'scene-lod.rad', true)], archiveOnly: false };
    const run = await runBootstrap({ search: '?id=s1', token: 'gui-secret', ticket });

    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toMatchObject({ url: '/gui/api/spatial/s1/viewer-ticket', method: 'POST', body: '{}' });
    expect(run.calls[0]!.headers.Authorization).toBe('Bearer gui-secret');
    expect(run.loads).toEqual([{
      api: 'loadSpatialProgressive',
      argument: {
        preview: `http://127.0.0.1:4321/gui/content/${'T'.repeat(43)}/preview.spz`,
        runtime: `http://127.0.0.1:4321/gui/content/${'T'.repeat(43)}/scene-lod.rad`,
      },
    }]);
    expect(JSON.stringify(run.loads)).not.toContain('gui-secret');
  });

  it('opens the preview alone when there is no runtime, and the runtime alone when there is no preview', async () => {
    const previewOnly = await runBootstrap({ search: '?id=s1', ticket: { representations: [representation('spatial_preview', 'preview.spz')], archiveOnly: false } });
    expect(previewOnly.loads[0]!.argument).toEqual({ preview: expect.stringContaining('/preview.spz'), runtime: undefined });
    const runtimeOnly = await runBootstrap({ search: '?id=s1', ticket: { representations: [representation('spatial_mobile', 'scene-lod.rad', true)], archiveOnly: false } });
    expect(runtimeOnly.loads[0]!.argument).toEqual({ preview: undefined, runtime: expect.stringContaining('/scene-lod.rad') });
  });

  it('never opens the original reconstruction unless it is named', async () => {
    const none = await runBootstrap({ search: '?id=s1', ticket: { representations: [], archiveOnly: true, archive: { sizeBytes: 9e8, format: 'ply' } } });
    expect(none.loads).toEqual([]);
    expect(none.status.hidden).toBe(false);
    expect(none.status.textContent).toMatch(/no preview yet/i);
    expect(none.calls).toHaveLength(1);
    expect(none.calls[0]!.body).toBe('{}');
  });

  it('opens the original when asked for by name, through a ticket for that role only', async () => {
    const run = await runBootstrap({ search: '?id=s1&role=spatial_archive', ticket: { representations: [representation('spatial_archive', 'archive.ply')], archiveOnly: false } });
    expect(run.calls[0]!.body).toBe('{"role":"spatial_archive"}');
    expect(run.loads).toEqual([{ api: 'loadSpatial', argument: `http://127.0.0.1:4321/gui/content/${'T'.repeat(43)}/archive.ply` }]);
  });

  it('reports a refused ticket instead of showing a blank viewer', async () => {
    const run = await runBootstrap({ search: '?id=s1', ticket: undefined, ticketStatus: 404 });
    expect(run.loads).toEqual([]);
    expect(run.status.textContent).toMatch(/could not be loaded/i);
  });

  it('says so when no record is named, without asking the server anything', async () => {
    const run = await runBootstrap({ search: '' });
    expect(run.calls).toEqual([]);
    expect(run.status.textContent).toMatch(/No Spatial record/);
  });

  it('revokes its capabilities and releases the scene when the page goes away', async () => {
    const run = await runBootstrap({ search: '?id=s1', token: 'gui-secret', ticket: { representations: [representation('spatial_preview', 'preview.spz')], archiveOnly: false } });
    run.listeners.pagehide!();
    expect(run.calls[1]).toMatchObject({ url: '/gui/api/spatial/s1/viewer-ticket', method: 'DELETE', keepalive: true });
    expect(run.calls[1]!.headers.Authorization).toBe('Bearer gui-secret');
    expect(run.loads.at(-1)).toEqual({ api: 'unloadSpatial', argument: undefined });
    run.listeners.pagehide!();
    expect(run.calls).toHaveLength(2); // revoked once
  });

  it('does not try to revoke a ticket it never got', async () => {
    const run = await runBootstrap({ search: '?id=s1', ticketStatus: 500 });
    run.listeners.pagehide!();
    expect(run.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('does not read content itself: no Blob, no object URLs, no archive default', () => {
    expect(spatialViewerBootstrapJs).not.toMatch(/blob\(|createObjectURL|\.blob\b/);
    expect(spatialViewerBootstrapJs).not.toContain("|| 'spatial_archive'");
    expect(spatialViewerBootstrapJs).not.toContain('/content/');
  });
});

describe('spatial viewer page', () => {
  const html = spatialViewerHtml();
  it('keeps the content it can reach to its own origin and loads its scripts from files', () => {
    expect(html).toContain("connect-src 'self' blob: data:");
    expect(html).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(html).not.toMatch(/<script>[^<]/);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });
});

describe('embedded viewer bundle', () => {
  it('is the build its recorded provenance says it is', () => {
    expect(createHash('sha256').update(spatialViewerBundle).digest('hex')).toBe(spatialViewerBundleSource.bundleSha256);
    expect(spatialViewerBundleSource).toMatchObject({ repository: 'kubus-project/art.kubus', sourcePath: 'assets/spatial_viewer/src/viewer.js', spark: '2.1.0', three: '0.185.1', esbuild: '0.25.9' });
  });

  it('exposes the page API the bootstrap and the app call', () => {
    for (const name of ['loadSpatial', 'loadSpatialProgressive', 'unloadSpatial', 'spatialViewerState', 'resetSpatialView']) {
      expect(spatialViewerBundle, name).toContain(`window.${name}=`);
    }
    expect(spatialViewerBundle).toContain('paged:!0');
  });
});
