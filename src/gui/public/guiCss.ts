export const guiCss = `
:root {
  color-scheme: light dark;
  --kubus-bg: #eef1f4;
  --kubus-surface: rgba(255, 255, 255, 0.64);
  --kubus-surface-strong: rgba(255, 255, 255, 0.82);
  --kubus-border: rgba(38, 45, 55, 0.13);
  --kubus-text: #111820;
  --kubus-muted: #69727f;
  --kubus-accent: #1f8a70;
  --kubus-danger: #b23b4a;
  --kubus-warning: #b7791f;
  --kubus-radius-lg: 22px;
  --kubus-radius-md: 14px;
  --kubus-spacing: 18px;
  --kubus-blur: 20px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --kubus-bg: #0d1116;
    --kubus-surface: rgba(24, 30, 38, 0.66);
    --kubus-surface-strong: rgba(29, 37, 47, 0.86);
    --kubus-border: rgba(221, 229, 237, 0.12);
    --kubus-text: #edf2f7;
    --kubus-muted: #98a4b3;
    --kubus-accent: #58c5a8;
  }
}

* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at 12% 10%, rgba(31, 138, 112, 0.16), transparent 30%),
    linear-gradient(145deg, var(--kubus-bg), color-mix(in srgb, var(--kubus-bg), #000 8%));
  color: var(--kubus-text);
}
a { color: inherit; }
button, input, select { font: inherit; }

.shell {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 24px;
  min-height: 100vh;
  padding: 24px;
}
.sidebar, .card {
  border: 1px solid var(--kubus-border);
  background: var(--kubus-surface);
  backdrop-filter: blur(var(--kubus-blur));
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.13);
}
.sidebar {
  border-radius: var(--kubus-radius-lg);
  padding: 22px;
  align-self: start;
  position: sticky;
  top: 24px;
}
.brand { font-size: 21px; font-weight: 700; letter-spacing: 0; }
.subtle { color: var(--kubus-muted); }
.local-note { margin-top: 10px; font-size: 12px; line-height: 1.5; color: var(--kubus-muted); }
.nav { display: grid; gap: 8px; margin-top: 24px; }
.nav button {
  border: 1px solid transparent;
  border-radius: 12px;
  padding: 11px 12px;
  background: transparent;
  color: var(--kubus-muted);
  text-align: left;
  cursor: pointer;
}
.nav button.active {
  background: var(--kubus-surface-strong);
  border-color: var(--kubus-border);
  color: var(--kubus-text);
}
.main { display: grid; gap: 18px; }
.topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h1 { margin: 0; font-size: 34px; line-height: 1.08; letter-spacing: 0; }
h2 { margin: 0 0 14px; font-size: 18px; letter-spacing: 0; }
.section { display: none; gap: 18px; }
.section.active { display: grid; }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.card { border-radius: var(--kubus-radius-lg); padding: var(--kubus-spacing); }
.metric { min-height: 114px; display: grid; align-content: space-between; }
.metric-label { color: var(--kubus-muted); font-size: 13px; }
.metric-value { font-size: 28px; font-weight: 720; letter-spacing: 0; overflow-wrap: anywhere; }
.badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--kubus-border);
  border-radius: 999px;
  padding: 5px 10px;
  background: var(--kubus-surface-strong);
  font-size: 12px;
  color: var(--kubus-muted);
}
.badge.good { color: var(--kubus-accent); }
.badge.warn { color: var(--kubus-warning); }
.badge.bad { color: var(--kubus-danger); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
.button {
  border: 1px solid var(--kubus-border);
  border-radius: 12px;
  background: var(--kubus-surface-strong);
  color: var(--kubus-text);
  padding: 10px 13px;
  cursor: pointer;
}
.button.primary { background: color-mix(in srgb, var(--kubus-accent), transparent 78%); color: var(--kubus-text); }
.button:disabled { opacity: 0.55; cursor: wait; }
.list { display: grid; gap: 10px; }
.row {
  display: grid;
  gap: 7px;
  border-top: 1px solid var(--kubus-border);
  padding-top: 12px;
  font-size: 13px;
}
.row:first-child { border-top: 0; padding-top: 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.split { display: flex; justify-content: space-between; gap: 14px; align-items: center; }
.log-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.auth {
  max-width: 420px;
  margin: 12vh auto;
  display: grid;
  gap: 14px;
}
input, select {
  width: 100%;
  border: 1px solid var(--kubus-border);
  border-radius: 12px;
  background: var(--kubus-surface-strong);
  color: var(--kubus-text);
  padding: 11px 12px;
}
.error { color: var(--kubus-danger); }

@media (max-width: 860px) {
  .shell { grid-template-columns: 1fr; padding: 14px; }
  .sidebar { position: static; }
  .grid, .grid.two { grid-template-columns: 1fr; }
  .topbar { display: grid; }
  h1 { font-size: 28px; }
}
`;
