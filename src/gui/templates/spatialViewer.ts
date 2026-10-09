/**
 * Standalone interactive Spatial preview page.
 *
 * Deliberately isolated in its own document (served at
 * `/gui/assets/spatial-viewer.html`, embedded via `<iframe>` from the main
 * Spatial detail view) rather than mounted inside the main GUI's single-page
 * app: a WebGL context and its GPU resources are tied to this document's
 * lifetime, so leaving the Spatial detail screen and letting the browser
 * discard the iframe is real, automatic cleanup - no manual Three.js/WebGL
 * disposal bookkeeping, and no risk of the renderer surviving into an
 * unrelated part of the GUI or getting recreated on every unrelated poll
 * refresh (the outer page's 10s refresh loop never touches this iframe).
 *
 * The bootstrap script lives in its own file
 * (`spatial-viewer-bootstrap.js`, see below) rather than inline: this
 * page's CSP has no `'unsafe-inline'` for scripts, so an inline `<script>`
 * here would simply be blocked by the browser rather than degrade
 * gracefully - verified against a real browser console, not assumed.
 */
export function spatialViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <meta name="referrer" content="no-referrer">
  <!-- 'wasm-unsafe-eval' (not the much broader 'unsafe-eval') is required for
       Spark's WASM module to compile at all - verified against a real
       browser console, which rejected WebAssembly.instantiateStreaming()
       without it. It permits WASM compilation only, not arbitrary
       eval()/new Function() of JS. -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self' blob: data:; worker-src blob:">
  <title>Spatial preview</title>
  <style>
    html,body,canvas{width:100%;height:100%;margin:0;overflow:hidden;background:#101415}
    canvas{display:block;touch-action:none}
    #status{position:fixed;inset:auto 20px 24px;padding:10px 14px;border-radius:12px;background:#182022cc;color:#fff;font:14px system-ui;text-align:center;max-width:calc(100% - 40px)}
    #status[hidden]{display:none}
  </style>
</head>
<body>
  <canvas aria-label="Interactive spatial archive"></canvas>
  <div id="status">Loading spatial archive…</div>
  <script src="/gui/assets/spatial-viewer.bundle.js"></script>
  <script src="/gui/assets/spatial-viewer-bootstrap.js"></script>
</body>
</html>`;
}

/**
 * Opens a scene through a viewer ticket.
 *
 * The page asks the authenticated GUI API for short-lived capabilities (one per
 * representation) and hands the renderer same-origin content URLs. The GUI
 * credential is used for that one request and for revoking the capability on the
 * way out; it never travels with the content requests, and nothing is fetched
 * whole into a Blob first, so a paged runtime tree can be read page by page with
 * byte ranges.
 *
 * With no `role` the viewer shows what is meant to be viewed: the preview
 * first, then the runtime tree. The original reconstruction is opened only when
 * `role=spatial_archive` is requested by name.
 */
export const spatialViewerBootstrapJs = `
(function () {
  const status = document.querySelector('#status');
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const role = params.get('role') || '';
  const token = localStorage.getItem('kubus_node_gui_token') || '';
  const ticketUrl = '/gui/api/spatial/' + encodeURIComponent(id || '') + '/viewer-ticket';
  let ticketed = false;

  function fail(message) {
    status.hidden = false;
    status.textContent = message;
  }

  function authHeaders(extra) {
    const headers = Object.assign({ Accept: 'application/json' }, extra || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  // Capabilities expire on their own; closing the viewer ends them sooner.
  function revoke() {
    if (!ticketed) return;
    ticketed = false;
    try { fetch(ticketUrl, { method: 'DELETE', headers: authHeaders(), keepalive: true }); } catch (error) { /* best effort */ }
  }
  window.addEventListener('pagehide', function () {
    revoke();
    if (window.unloadSpatial) window.unloadSpatial();
  });

  if (!id) { fail('No Spatial record specified.'); return; }

  fetch(ticketUrl, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(role ? { role: role } : {}),
  })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (body) {
      const ticket = body.data;
      ticketed = true;
      const absolute = function (representation) { return representation ? location.origin + representation.url : undefined; };
      const byRole = function (name) { return ticket.representations.find(function (item) { return item.role === name; }); };
      if (!role && ticket.archiveOnly) {
        fail('This scene has no preview yet. Create one from the scene page, or open the original reconstruction there.');
        return undefined;
      }
      if (role === 'spatial_archive') return window.loadSpatial(absolute(byRole('spatial_archive')));
      return window.loadSpatialProgressive({
        preview: absolute(byRole('spatial_preview')),
        runtime: absolute(byRole('spatial_mobile')),
      });
    })
    .catch(function (error) {
      fail('This spatial archive could not be loaded.');
      console.error(error);
    });
})();
`;
