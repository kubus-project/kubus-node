/**
 * The GUI document shell.
 *
 * Deliberately minimal: it ships the layout landmarks, a skip link and a
 * first-paint placeholder that matches the real overview's shape, so the page
 * does not jump when the view model arrives. Everything else is rendered by
 * gui.js from a server-built view model.
 */
export function guiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="no-referrer">
  <title>kubus Node</title>
  <link rel="stylesheet" href="/gui/assets/gui.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div id="app">
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-name">kubus Node</div>
          <div class="brand-descriptor">Local runtime + public archive node</div>
        </div>
      </aside>
      <main class="main" id="main">
        <div class="page-header">
          <div class="skeleton metric-line" style="width:220px"></div>
          <div class="skeleton text-line" style="width:340px"></div>
        </div>
        <div class="overview-grid">
          <div class="panel"><div class="skeleton text-line"></div><div class="skeleton metric-line"></div></div>
          <div class="panel"><div class="skeleton text-line"></div><div class="skeleton metric-line"></div></div>
          <div class="panel"><div class="skeleton text-line"></div><div class="skeleton metric-line"></div></div>
          <div class="panel"><div class="skeleton text-line"></div><div class="skeleton metric-line"></div></div>
        </div>
      </main>
    </div>
  </div>
  <div id="live" class="visually-hidden" role="status" aria-live="polite"></div>
  <script type="module" src="/gui/assets/gui.js"></script>
</body>
</html>`;
}
