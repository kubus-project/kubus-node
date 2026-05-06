export function guiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kubus Node</title>
  <link rel="stylesheet" href="/gui/assets/gui.css">
</head>
<body>
  <main class="auth card">
    <div class="brand">Kubus Node</div>
    <p class="subtle">Loading local node health...</p>
  </main>
  <script type="module" src="/gui/assets/gui.js"></script>
</body>
</html>`;
}
