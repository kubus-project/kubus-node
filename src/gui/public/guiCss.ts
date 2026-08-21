/**
 * kubus Node GUI stylesheet.
 *
 * Design intent: the Node is a kubus product surface, not a generic admin
 * panel — it uses the same canonical tokens and liquid-glass language as
 * art.kubus (lib/utils/design_tokens.dart: KubusColors.glassLight/glassDark/
 * glassBorderLight/glassBorderDark), applied at the same points the app
 * applies it: the shell/nav and top-level panels, never nested rows. This is
 * still an information-dense operator tool that has to stay legible for long
 * stretches on a desktop display, so glass is bounded, not blanket - see
 * "Liquid glass" below for exactly which surfaces get it.
 *
 * Constraints: no webfonts, no CDN, no framework. The node must render
 * correctly with no internet connection at all.
 */
export const guiCss = `
:root {
  color-scheme: light dark;

  /* Palette shared with art.kubus (lib/utils/design_tokens.dart). */
  --k-primary: #00838f;
  --k-primary-strong: #0097a7;
  --k-primary-soft: rgba(0, 131, 143, 0.10);

  --k-bg: #f8f9fa;
  --k-surface: #ffffff;
  --k-surface-sunken: #f1f3f5;
  --k-surface-raised: #ffffff;
  --k-border: #e0e0e0;
  --k-border-strong: #cfd4d9;

  --k-text: #1a1a1a;
  --k-text-secondary: #5f6368;
  --k-text-tertiary: #80868b;

  --k-good: #2e7d32;
  --k-good-soft: rgba(46, 125, 50, 0.10);
  --k-attention: #b26a00;
  --k-attention-soft: rgba(178, 106, 0, 0.10);
  --k-critical: #c62828;
  --k-critical-soft: rgba(198, 40, 40, 0.10);
  --k-neutral: #5f6368;
  --k-neutral-soft: rgba(95, 99, 104, 0.10);

  /* Spacing scale mirrors KubusSpacing: 2 / 4 / 8 / 16 / 24 / 32 / 48. */
  --k-space-xxs: 2px;
  --k-space-xs: 4px;
  --k-space-sm: 8px;
  --k-space-md: 16px;
  --k-space-lg: 24px;
  --k-space-xl: 32px;
  --k-space-xxl: 48px;

  /* Radii mirror KubusRadius: 4 / 8 / 12 / 16 / 24. */
  --k-radius-xs: 4px;
  --k-radius-sm: 8px;
  --k-radius-md: 12px;
  --k-radius-lg: 16px;

  --k-shadow-sm: 0 1px 2px rgba(15, 23, 32, 0.06);
  --k-shadow-md: 0 2px 8px rgba(15, 23, 32, 0.08);

  /* Liquid glass: mirrors KubusColors.glassLight/glassBorderLight exactly
     (0x99FFFFFF = 60% white, 0x40FFFFFF border). Blur amounts are this
     surface's own tuning - the Flutter tokens don't define blur radii. */
  --k-glass: rgba(255, 255, 255, 0.6);
  --k-glass-border: rgba(255, 255, 255, 0.4);
  --k-glass-hover: rgba(255, 255, 255, 0.72);
  --k-blur-md: 20px;
  --k-blur-lg: 32px;

  --k-control-height: 36px;
  --k-motion-fast: 120ms;
  --k-motion: 180ms;
  --k-ease: cubic-bezier(0.2, 0, 0, 1);

  --k-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --k-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

  font-family: var(--k-font);
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

@media (prefers-color-scheme: dark) {
  :root {
    --k-bg: #0f1215;
    --k-surface: #171b1f;
    --k-surface-sunken: #121619;
    --k-surface-raised: #1d2227;
    --k-border: #2a3037;
    --k-border-strong: #39424a;

    --k-text: #e8eaed;
    --k-text-secondary: #9aa0a6;
    --k-text-tertiary: #7c848b;

    --k-primary: #26c6da;
    --k-primary-strong: #4dd0e1;
    --k-primary-soft: rgba(38, 198, 218, 0.12);

    --k-good: #66bb6a;
    --k-good-soft: rgba(102, 187, 106, 0.14);
    --k-attention: #ffb300;
    --k-attention-soft: rgba(255, 179, 0, 0.14);
    --k-critical: #ef5350;
    --k-critical-soft: rgba(239, 83, 80, 0.14);
    --k-neutral: #9aa0a6;
    --k-neutral-soft: rgba(154, 160, 166, 0.12);

    --k-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
    --k-shadow-md: 0 2px 10px rgba(0, 0, 0, 0.45);

    /* Mirrors KubusColors.glassDark/glassBorderDark (0xCC1A1A1A = 80%
       #1A1A1A, 0x40000000 border). */
    --k-glass: rgba(26, 26, 26, 0.8);
    --k-glass-border: rgba(0, 0, 0, 0.4);
    --k-glass-hover: rgba(36, 36, 36, 0.85);
  }
}

*, *::before, *::after { box-sizing: border-box; }

html, body { height: 100%; }

body {
  margin: 0;
  /* The page backdrop itself: two fixed, cheap radial tints under the flat
     background colour, so glass surfaces (.sidebar, .panel) have something
     with actual variation to reveal - a blur over a perfectly flat colour
     is indistinguishable from a plain tint and would make the blur pure
     cost with no visual payoff. Fixed (not scroll-linked) and static (no
     animation): this is texture, not decoration to keep re-computing. */
  background:
    radial-gradient(720px 480px at 8% -8%, var(--k-primary-soft), transparent 60%),
    radial-gradient(640px 480px at 100% 0%, var(--k-primary-soft), transparent 55%),
    var(--k-bg);
  background-attachment: fixed;
  color: var(--k-text);
}

h1, h2, h3, p, figure { margin: 0; }
button, input, select, textarea { font: inherit; color: inherit; }

/* --- Typographic scale ------------------------------------------------- */
/* Display is rare. Page > section > card > body > metadata, and technical
   identifiers are always visually subordinate. */
.t-page { font-size: 26px; font-weight: 640; letter-spacing: -0.015em; line-height: 1.2; }
.t-section { font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--k-text-secondary); }
.t-card { font-size: 15px; font-weight: 600; letter-spacing: -0.005em; }
.t-metric { font-size: 24px; font-weight: 640; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.t-body { font-size: 14px; color: var(--k-text-secondary); }
.t-meta { font-size: 12.5px; color: var(--k-text-tertiary); }
.t-mono { font-family: var(--k-font-mono); font-size: 12.5px; color: var(--k-text-secondary); overflow-wrap: anywhere; }

/* --- Skip link and focus ------------------------------------------------ */
.skip-link {
  position: absolute;
  left: var(--k-space-md);
  top: -60px;
  z-index: 60;
  padding: var(--k-space-sm) var(--k-space-md);
  border-radius: var(--k-radius-sm);
  background: var(--k-surface);
  border: 1px solid var(--k-border);
  transition: top var(--k-motion-fast) var(--k-ease);
}
.skip-link:focus { top: var(--k-space-md); }

:focus-visible {
  outline: 2px solid var(--k-primary);
  outline-offset: 2px;
  border-radius: var(--k-radius-xs);
}

/* --- Liquid glass --------------------------------------------------------
   Bounded to genuinely elevated surfaces: the shell/nav and top-level
   panels/menus/modals. Nested rows, list items and table cells stay flat -
   a blurred surface inside a blurred surface reads as noise, not depth, and
   costs real compositing time for no visual benefit.

   .sidebar and .panel (below) carry the glass treatment directly in their
   own rules, since they're the two surfaces that already exist everywhere
   in this file (25+ call sites) - a second class name at every call site
   would be one more thing to remember and one more way to regress. The
   .kubus-glass-* classes exist as the reusable primitive for surfaces that
   don't have their own base rule yet: modals, dropdown/context menus, and
   standalone controls a future Part D screen (job detail, Spatial preview,
   pairing) introduces.

   Every primitive falls back to an opaque surface when backdrop-filter
   isn't supported, so the Node never renders a see-through, illegible
   panel. */
.kubus-glass,
.kubus-glass-panel,
.kubus-glass-modal,
.kubus-glass-menu {
  background: var(--k-glass);
  backdrop-filter: blur(var(--k-blur-md));
  -webkit-backdrop-filter: blur(var(--k-blur-md));
  border: 1px solid var(--k-glass-border);
}
.kubus-glass-nav {
  background: var(--k-glass);
  backdrop-filter: blur(var(--k-blur-lg));
  -webkit-backdrop-filter: blur(var(--k-blur-lg));
}
.kubus-glass-control,
.kubus-glass-input,
.kubus-glass-chip {
  background: var(--k-glass);
  border: 1px solid var(--k-glass-border);
  /* Controls typically live inside an already-glass panel; blurring them
     too would stack blur-in-blur, so they take the glass tint without a
     second backdrop-filter pass. */
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .kubus-glass,
  .kubus-glass-panel,
  .kubus-glass-modal,
  .kubus-glass-menu,
  .kubus-glass-nav,
  .sidebar,
  .panel {
    background: var(--k-surface);
  }
}

/* --- App shell ---------------------------------------------------------- */
.shell {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  background: var(--k-glass);
  backdrop-filter: blur(var(--k-blur-lg));
  -webkit-backdrop-filter: blur(var(--k-blur-lg));
  border-right: 1px solid var(--k-glass-border);
  padding: var(--k-space-lg) var(--k-space-md);
  display: flex;
  flex-direction: column;
  gap: var(--k-space-lg);
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}

.brand { display: grid; gap: var(--k-space-xxs); }
.brand-name { font-size: 16px; font-weight: 640; letter-spacing: -0.01em; }
.brand-descriptor { font-size: 12px; color: var(--k-text-tertiary); }

.nav { display: grid; gap: var(--k-space-xxs); }
.nav-button {
  display: flex;
  align-items: center;
  gap: var(--k-space-sm);
  width: 100%;
  min-height: var(--k-control-height);
  padding: var(--k-space-sm) var(--k-space-sm);
  border: 0;
  border-radius: var(--k-radius-sm);
  background: transparent;
  color: var(--k-text-secondary);
  text-align: left;
  font-size: 14px;
  cursor: pointer;
  transition: background var(--k-motion-fast) var(--k-ease), color var(--k-motion-fast) var(--k-ease);
}
.nav-button:hover { background: var(--k-surface-sunken); color: var(--k-text); }
.nav-button[aria-current="page"] {
  background: var(--k-primary-soft);
  color: var(--k-primary);
  font-weight: 600;
}
/* Attention is carried by a marker as well as colour, so the nav stays
   readable without colour perception. */
.nav-flag {
  margin-left: auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.nav-flag.attention { background: var(--k-attention); }
.nav-flag.critical { background: var(--k-critical); }

.sidebar-footer { margin-top: auto; display: grid; gap: var(--k-space-xs); }

.main {
  min-width: 0;
  padding: var(--k-space-lg) var(--k-space-xl);
  display: grid;
  align-content: start;
  gap: var(--k-space-lg);
  /* Long-form operator reading tops out well before ultrawide. */
  max-width: 1280px;
}

.page-header { display: grid; gap: var(--k-space-xs); }
.page-header-row { display: flex; align-items: center; gap: var(--k-space-md); flex-wrap: wrap; }
.page-lede { font-size: 15px; color: var(--k-text-secondary); max-width: 68ch; }

/* --- Status ------------------------------------------------------------- */
/* Status is never colour alone: a dot shape plus an always-present text label. */
.status {
  display: inline-flex;
  align-items: center;
  gap: var(--k-space-sm);
  font-size: 14px;
  font-weight: 560;
}
.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
  background: var(--k-neutral);
}
.status.good .status-dot { background: var(--k-good); }
.status.attention .status-dot { background: var(--k-attention); }
.status.critical .status-dot { background: var(--k-critical); }
.status.good { color: var(--k-good); }
.status.attention { color: var(--k-attention); }
.status.critical { color: var(--k-critical); }

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--k-space-xs);
  padding: 3px var(--k-space-sm);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 560;
  background: var(--k-neutral-soft);
  color: var(--k-text-secondary);
  white-space: nowrap;
}
.chip.good { background: var(--k-good-soft); color: var(--k-good); }
.chip.attention { background: var(--k-attention-soft); color: var(--k-attention); }
.chip.critical { background: var(--k-critical-soft); color: var(--k-critical); }

/* --- Surfaces ----------------------------------------------------------- */
.panel {
  background: var(--k-glass);
  backdrop-filter: blur(var(--k-blur-md));
  -webkit-backdrop-filter: blur(var(--k-blur-md));
  border: 1px solid var(--k-glass-border);
  border-radius: var(--k-radius-md);
  padding: var(--k-space-md);
  display: grid;
  gap: var(--k-space-md);
  align-content: start;
}
.panel-header { display: flex; align-items: baseline; justify-content: space-between; gap: var(--k-space-md); }
/* Deliberately flat: no card-inside-card-inside-card. */
.panel .panel { border: 0; padding: 0; background: none; }

.stack { display: grid; gap: var(--k-space-md); }
.stack-sm { display: grid; gap: var(--k-space-sm); }
.row { display: flex; align-items: center; gap: var(--k-space-sm); flex-wrap: wrap; }
.row-between { display: flex; align-items: center; justify-content: space-between; gap: var(--k-space-md); }
.spacer { flex: 1 1 auto; }

/* Overview grid: the four conceptual areas, not four identical dashboard tiles. */
.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--k-space-md);
}
.overview-grid > .panel--lead { grid-column: 1 / -1; }
/* Column layout so each card's trailing action can sit on the same baseline
   even though the cards carry different numbers of metrics. */
.overview-grid > .panel { display: flex; flex-direction: column; }
.overview-grid > .panel > .button { margin-top: auto; align-self: flex-start; }

.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--k-space-md);
}
.metric { display: grid; gap: var(--k-space-xxs); align-content: start; }
.metric-label { font-size: 12.5px; color: var(--k-text-secondary); }
.metric-detail { font-size: 12.5px; color: var(--k-text-tertiary); }
/* Named values (a GPU model, "None yet") sit a step below the figure style so
   quantities keep the emphasis on a card that mixes both. */
.metric-text { font-size: 15px; font-weight: 560; letter-spacing: -0.005em; }

/* --- Capacity bar ------------------------------------------------------- */
/* Three numbers do not need a pie chart. */
.capacity { display: grid; gap: var(--k-space-sm); }
.capacity-track {
  display: flex;
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--k-surface-sunken);
  border: 1px solid var(--k-border);
}
.capacity-fill { height: 100%; min-width: 2px; }
.capacity-fill.public { background: var(--k-primary); }
.capacity-fill.private { background: var(--k-primary-strong); opacity: 0.5; }
.capacity-fill.other { background: var(--k-border-strong); }
.capacity-legend { display: flex; flex-wrap: wrap; gap: var(--k-space-md); }
.capacity-key { display: inline-flex; align-items: center; gap: var(--k-space-sm); font-size: 13px; }
.capacity-swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.capacity-swatch.public { background: var(--k-primary); }
.capacity-swatch.private { background: var(--k-primary-strong); opacity: 0.5; }
.capacity-swatch.other { background: var(--k-border-strong); }
.capacity-swatch.available { background: var(--k-surface-sunken); border: 1px solid var(--k-border-strong); }
.capacity-value { color: var(--k-text-secondary); font-variant-numeric: tabular-nums; }

/* --- Controls ----------------------------------------------------------- */
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--k-space-sm);
  min-height: var(--k-control-height);
  padding: 0 var(--k-space-md);
  border: 1px solid var(--k-border-strong);
  border-radius: var(--k-radius-sm);
  background: var(--k-surface);
  color: var(--k-text);
  font-size: 14px;
  font-weight: 560;
  cursor: pointer;
  transition: background var(--k-motion-fast) var(--k-ease), border-color var(--k-motion-fast) var(--k-ease);
}
.button:hover:not(:disabled) { background: var(--k-surface-sunken); }
.button:disabled { opacity: 0.5; cursor: not-allowed; }
.button.primary {
  background: var(--k-primary);
  border-color: var(--k-primary);
  color: #ffffff;
}
.button.primary:hover:not(:disabled) { background: var(--k-primary-strong); border-color: var(--k-primary-strong); }
.button.subtle { border-color: transparent; background: transparent; color: var(--k-primary); }
.button.subtle:hover:not(:disabled) { background: var(--k-primary-soft); }
.button.danger { border-color: var(--k-critical); color: var(--k-critical); background: transparent; }
.button.danger:hover:not(:disabled) { background: var(--k-critical-soft); }
.button.small { min-height: 30px; padding: 0 var(--k-space-sm); font-size: 13px; }

input[type="text"], input[type="password"], input[type="number"], select {
  width: 100%;
  min-height: var(--k-control-height);
  padding: 0 var(--k-space-sm);
  border: 1px solid var(--k-border-strong);
  border-radius: var(--k-radius-sm);
  background: var(--k-surface);
}
input[type="range"] { width: 100%; accent-color: var(--k-primary); }
label { display: grid; gap: var(--k-space-xs); font-size: 13px; color: var(--k-text-secondary); }

/* Switch: a real checkbox underneath, so keyboard and screen readers work. */
.switch { display: flex; align-items: center; gap: var(--k-space-md); cursor: pointer; }
.switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.switch-track {
  width: 40px;
  height: 24px;
  border-radius: 999px;
  background: var(--k-border-strong);
  padding: 3px;
  flex: none;
  transition: background var(--k-motion) var(--k-ease);
}
.switch-thumb {
  /* The track is not a flex container, so the thumb needs its own box or it
     stays inline and collapses to nothing. */
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: var(--k-shadow-sm);
  transition: transform var(--k-motion) var(--k-ease);
}
.switch input:checked + .switch-track { background: var(--k-primary); }
.switch input:checked + .switch-track .switch-thumb { transform: translateX(16px); }
.switch input:focus-visible + .switch-track { outline: 2px solid var(--k-primary); outline-offset: 2px; }
.switch-text { display: grid; gap: var(--k-space-xxs); }
.switch-title { font-size: 14px; font-weight: 560; color: var(--k-text); }

/* --- Records (tables become stacked records on narrow screens) ---------- */
.records { display: grid; }
.record {
  display: grid;
  gap: var(--k-space-xs);
  padding: var(--k-space-md) 0;
  border-top: 1px solid var(--k-border);
}
.record:first-child { border-top: 0; padding-top: 0; }
.record-title { display: flex; align-items: center; gap: var(--k-space-sm); flex-wrap: wrap; font-weight: 560; }

/* --- Progressive disclosure --------------------------------------------- */
details.disclosure { border-top: 1px solid var(--k-border); padding-top: var(--k-space-md); }
details.disclosure > summary {
  cursor: pointer;
  font-size: 13.5px;
  font-weight: 560;
  color: var(--k-primary);
  list-style: none;
  display: flex;
  align-items: center;
  gap: var(--k-space-sm);
  min-height: 28px;
}
details.disclosure > summary::-webkit-details-marker { display: none; }
details.disclosure > summary::before {
  content: "";
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform var(--k-motion-fast) var(--k-ease);
}
details.disclosure[open] > summary::before { transform: rotate(45deg); }
details.disclosure > .stack, details.disclosure > .stack-sm { margin-top: var(--k-space-md); }

/* Dangerous controls are set apart rather than sprinkled among normal ones. */
.danger-zone {
  border: 1px solid var(--k-critical);
  border-radius: var(--k-radius-md);
  padding: var(--k-space-md);
  display: grid;
  gap: var(--k-space-sm);
  background: var(--k-critical-soft);
}

/* --- Banner ------------------------------------------------------------- */
/* Participation problems keep the GUI usable; they never replace it. */
.banner {
  display: flex;
  align-items: flex-start;
  gap: var(--k-space-md);
  padding: var(--k-space-md);
  border-radius: var(--k-radius-md);
  border: 1px solid var(--k-attention);
  background: var(--k-attention-soft);
}
.banner.critical { border-color: var(--k-critical); background: var(--k-critical-soft); }
.banner-body { display: grid; gap: var(--k-space-xxs); flex: 1 1 auto; }
.banner-title { font-weight: 600; }

/* --- Empty and loading states ------------------------------------------- */
.empty {
  display: grid;
  gap: var(--k-space-xs);
  padding: var(--k-space-xl) var(--k-space-md);
  text-align: center;
  justify-items: center;
}
.empty-title { font-weight: 560; }
.empty-body { font-size: 14px; color: var(--k-text-secondary); max-width: 44ch; }

/* Skeletons preserve layout so the shell never jumps when data lands. */
.skeleton {
  border-radius: var(--k-radius-xs);
  background: linear-gradient(90deg, var(--k-surface-sunken) 25%, var(--k-border) 37%, var(--k-surface-sunken) 63%);
  background-size: 400% 100%;
  animation: k-shimmer 1.4s ease-in-out infinite;
  min-height: 12px;
}
.skeleton.metric-line { height: 24px; width: 60%; }
.skeleton.text-line { height: 12px; width: 80%; }
@keyframes k-shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}

/* Refreshing keeps the last known values on screen instead of blinking to
   "offline" on every poll. */
.is-refreshing { opacity: 0.72; transition: opacity var(--k-motion) var(--k-ease); }

/* --- Pairing ------------------------------------------------------------ */
.pairing { display: grid; gap: var(--k-space-lg); justify-items: center; text-align: center; }
.qr-frame {
  padding: var(--k-space-md);
  background: #ffffff;
  border: 1px solid var(--k-border);
  border-radius: var(--k-radius-md);
  line-height: 0;
}
.qr-frame svg { display: block; width: min(360px, 78vw); height: auto; image-rendering: pixelated; }
.pairing-code {
  font-family: var(--k-font-mono);
  font-size: 18px;
  letter-spacing: 0.08em;
  padding: var(--k-space-sm) var(--k-space-md);
  border-radius: var(--k-radius-sm);
  background: var(--k-surface-sunken);
  border: 1px solid var(--k-border);
  overflow-wrap: anywhere;
}
.countdown { font-variant-numeric: tabular-nums; }

/* --- Onboarding --------------------------------------------------------- */
.onboarding {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--k-space-lg);
}
.onboarding-card {
  width: min(620px, 100%);
  background: var(--k-surface);
  border: 1px solid var(--k-border);
  border-radius: var(--k-radius-lg);
  padding: var(--k-space-xl);
  display: grid;
  gap: var(--k-space-lg);
  box-shadow: var(--k-shadow-md);
}
.steps { display: flex; gap: var(--k-space-xs); }
.step-pip { height: 3px; flex: 1; border-radius: 999px; background: var(--k-border); }
.step-pip.done { background: var(--k-primary); }
.step-pip.current { background: var(--k-primary); opacity: 0.55; }
.feature-list { display: grid; gap: var(--k-space-md); }
.feature { display: grid; gap: var(--k-space-xxs); }
.feature-title { font-weight: 600; font-size: 14.5px; }

/* --- Logs --------------------------------------------------------------- */
.log-viewport {
  max-height: 60vh;
  overflow: auto;
  border: 1px solid var(--k-border);
  border-radius: var(--k-radius-sm);
  background: var(--k-surface-sunken);
}
.log-line {
  display: grid;
  grid-template-columns: 64px 132px minmax(0, 1fr);
  gap: var(--k-space-sm);
  padding: var(--k-space-sm) var(--k-space-md);
  border-bottom: 1px solid var(--k-border);
  font-family: var(--k-font-mono);
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.log-line:last-child { border-bottom: 0; }
.log-level { font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
.log-level.warn { color: var(--k-attention); }
.log-level.error { color: var(--k-critical); }
.log-level.info { color: var(--k-text-tertiary); }
.log-subsystem { font-weight: 600; color: var(--k-text-secondary); margin-right: var(--k-space-xs); }
.log-detail { display: block; color: var(--k-text-tertiary); font-size: 11.5px; }

/* --- Auth screen -------------------------------------------------------- */
.auth {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--k-space-lg);
}
.auth-card {
  width: min(400px, 100%);
  background: var(--k-surface);
  border: 1px solid var(--k-border);
  border-radius: var(--k-radius-lg);
  padding: var(--k-space-xl);
  display: grid;
  gap: var(--k-space-md);
  box-shadow: var(--k-shadow-md);
}

.visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* --- Responsive --------------------------------------------------------- */
/* Tablet and small laptop: the sidebar becomes a horizontal section bar. */
@media (max-width: 1024px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar {
    position: sticky;
    top: 0;
    z-index: 20;
    height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--k-border);
    padding: var(--k-space-md);
    gap: var(--k-space-md);
  }
  .nav {
    grid-auto-flow: column;
    grid-auto-columns: max-content;
    overflow-x: auto;
    gap: var(--k-space-xs);
    scrollbar-width: thin;
    /* Keep focus rings from being clipped by the scroll container. */
    padding: 2px;
  }
  .nav-button { white-space: nowrap; }
  .sidebar-footer { display: none; }
  .main { padding: var(--k-space-md); }
}

@media (max-width: 640px) {
  :root { font-size: 14.5px; }
  .main { padding: var(--k-space-md) var(--k-space-md) var(--k-space-xl); gap: var(--k-space-md); }
  .t-page { font-size: 22px; }
  .metrics { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
  .overview-grid { grid-template-columns: 1fr; }
  .row-between { flex-direction: column; align-items: flex-start; gap: var(--k-space-sm); }
  /* Log columns stack rather than overflow horizontally. */
  .log-line { grid-template-columns: 1fr; gap: var(--k-space-xxs); }
  .onboarding-card { padding: var(--k-space-lg); }
  /* A banner action squeezed into a narrow column wraps to three lines. */
  .banner { flex-direction: column; align-items: stretch; }
  .banner .button { width: 100%; }
  /* Comfortable touch targets on a phone browser. */
  .button { min-height: 44px; }
  .nav-button { min-height: 40px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .skeleton { animation: none; background: var(--k-surface-sunken); }
}

@media (prefers-contrast: more) {
  :root { --k-border: #7a828a; --k-border-strong: #4a5158; }
}
`;
