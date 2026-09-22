# CLAUDE.md

## Repository role

**THIS REPOSITORY IS THE RUNTIME. IT IS NOT node.kubus.site.**

| | Repository | What it is |
| --- | --- | --- |
| Runtime | `kubus-project/kubus-node` (this repo) | the software an operator installs and runs: package `@kubus/kubus-node`, binary `kubus-node`, Docker runtime, local GUI |
| Public website | `kubus-project/node.kubus.site` | the website that explains and distributes the runtime |

Public prose brand: **kubus node** (lowercase, always). Technical package,
binary and repository name: **`kubus-node`**. Do not "correct" either into the
other.

kubus node is a local runtime and public archive node for art.kubus: it stores
and serves canonical public cultural records, runs spatial (Gaussian)
reconstruction on compatible NVIDIA/CUDA hardware or requests it from a
selected provider, and connects owned nodes to art.kubus over WebRTC/TURN.
Licence: `AGPL-3.0-only`; branding is reserved (`TRADEMARKS.md`).

## Source-of-truth precedence

For spatial delivery or cross-repository product work, read the current
`art.kubus/docs/PRODUCT_UX_SEO_PROGRAM.md` master roadmap, its Wave 12
`docs/AGENT_EXECUTION_PLAN.md` package and
`art.kubus/docs/SPATIAL_DELIVERY_ROADMAP.md` before editing. This runtime
already supports capture/reconstruction/manifests; preview generation,
streamed/paged runtime LOD and capacity-aware replication are future work
gated by Ljubljana field evidence. Do not confuse the archive PLY with normal
viewer delivery or this runtime with `node.kubus.site`.

1. The explicit, current user instruction.
2. This `CLAUDE.md`.
3. Repository docs under **Required reading**.
4. Current tested source behaviour (`src/`, `tests/`).
5. Historical PR descriptions, release notes and changelogs.

## Agent start checklist

Before editing:

1. Read this file fully and the Required reading relevant to the task.
2. `git status`; preserve uncommitted work (never `reset --hard` / `clean -fd`).
3. Confirm branch and `HEAD`; inspect `git log --oneline -15`. Feature
   branches often live in separate worktrees (`git worktree list`).
4. Classify the task: CLI/installer, GUI, local API, participation/archive,
   spatial processing, transport, release, or docs.
5. Check whether the change alters a released contract (CLI flags, local API,
   env vars, Compose, release assets). Those need release notes.
6. Never treat a public-website task as a runtime task, or the reverse.

## Non-negotiable rules

- **Local runtime analytics stay local.** `src/analytics/analyticsStore.ts`
  keeps bounded, hourly-bucketed counters on the operator's own disk; nothing
  in it is ever sent anywhere. Do not send it to central website analytics,
  admin, or any collector without an explicit architecture decision.
- **Website analytics are a different system.** node.kubus.site visitor
  analytics describe people reading the website; they are not runtime
  telemetry and never include node identity. Do not add runtime data to them.
- **Participation traffic is not analytics.** Registration and heartbeats to
  the backend availability API carry aggregate byte/count and health
  information only (`docs/PRIVACY.md`); admin shows registered nodes under
  PLATFORM / Nodes. Keep them free of raw frames, poses, filenames, local
  paths, payload keys and decrypted provider content.
- **PROCESS ≠ PUBLISH. SYNC ≠ PUBLISH.** Only explicit authorized publication
  creates canonical public state.
- **The GUI is local/private by default.** Beyond loopback it requires
  `NODE_GUI_TOKEN`; never create public DNS for `my.node.kubus.site`; never
  expose Kubo RPC (5001).
- **Secrets** (`NODE_GUI_TOKEN`, `KUBUS_OPERATOR_TOKEN`, identity files) are
  never logged, committed or echoed into docs.
- **No merge** of any PR without explicit user authorization.

## Naming and branding

- Prose: `kubus node`, `kubus`, `art.kubus`, always lowercase, including at
  the start of a sentence and in headings.
- Identifiers exactly: `kubus-node`, `@kubus/kubus-node`, `NODE_GUI_TOKEN`,
  `KUBUS_OPERATOR_TOKEN`, `KubusNodeSetup.ps1`, class names in code.
- Natural acronyms stay uppercase: API, GPU, IPFS, CID.

## Design / architecture

Responsibilities as implemented:

| Responsibility | Where |
| --- | --- |
| Launcher / installer | `installer/windows/` (`KubusNodeSetup.ps1`, `KubusNode.iss`, `Start-KubusNodeSetup.cmd`), `src/installer/`, `src/cli/commands.ts` (`kubus-node setup`, `doctor`, `status`, `gui`) |
| Setup and pairing | `src/setup/`, `src/gui/setupServer.ts`: account-authorized setup (sign in to art.kubus, approve), no manual operator token in normal setup |
| Local GUI and its token | `src/gui/` (`guiServer.ts`, `guiAuth.ts`, `guiSession.ts`), port 8787, `NODE_GUI_TOKEN` when not loopback |
| Local API | `src/localApi/` (`/local/v1`), `docs/LOCAL_API.md` |
| Runtime and Docker | `src/runtime/`, `docker-compose.yml`, `docker-compose.release.template.yml`; release installs are digest-pinned |
| Archive participation | `src/participation/`, `src/ipfs/`, `src/scheduler/`: verified replication gates useful compute (`docs/PARTICIPATION.md`) |
| Processing | `src/spatial/`, `src/compute/`, `src/jobs/`, `spatial-worker/` (local NVIDIA/CUDA, or a selected remote provider) |
| Publication | explicit, authorized handoff to the backend (`src/backend/`); unpublished output is non-canonical |
| Transport | `src/webrtc/` (WebRTC/TURN), `docs/REMOTE_TRANSPORT.md` |
| Local analytics | `src/analytics/analyticsStore.ts` (local only) |

The backend decides what is canonical; kubus node stores, processes, retrieves
and serves (`docs/architecture.md`).

## Content and localization

Operator-facing docs are English. The public website's EN/SL copy lives in
`node.kubus.site`, not here.

## Analytics and privacy

See **Non-negotiable rules** and `docs/PRIVACY.md`. Website-side contract:
`node.kubus.site/docs/ANALYTICS-PRIVACY.md`.

## SEO expectations

Not applicable to the runtime. The README is shown on GitHub and npm; keep its
brand casing and claims accurate.

## Generated vs authored files

Generated: `dist/`, release packages (`npm run build:release-package`,
`build:npm-package`), `version.json` via `npm run sync:version`.
Authored: `src/`, `tests/`, `installer/`, `spatial-worker/`, `docs/`.

## Testing

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke            # where the change touches runtime startup
```

CI: `.github/workflows/pr-validation.yml`; releases: `release.yml`,
`node-package.yml` (`docs/RELEASES.md`). The Windows GUI handoff test is known
to be flaky; re-run before concluding a regression.

## Visual QA

GUI changes: render the local GUI (`kubus-node gui`) at desktop and narrow
widths and check setup, status and spatial views.

## Production / deployment cautions

- Releases are tag-driven and immutable; never retag. See `docs/RELEASES.md`.
- The owner's processing node runs from a source checkout with
  `docker compose --profile spatial up -d --build`; back up the state volume
  before upgrading it.
- Do not stop unrelated containers on shared hosts.

## Git rules

- Branch per change; never push to `master` directly.
- Coherent, scoped commits; never "misc".
- Never plain `git push --force`; `--force-with-lease` only when unavoidable.
- No merge without explicit user authorization.

## Forbidden changes / anti-patterns

- Centralizing local runtime analytics to populate admin or website analytics.
- Adding node identity, wallets, peer IDs or paths to anything that leaves the
  machine outside the documented participation/publication contracts.
- Claiming the backend is gone, full decentralization, or network facts that
  are not measured.
- Capitalized brand prose (`Kubus Node`, `kubus Node`, `KUBUS NODE`).

## Agent end checklist

- [ ] `git diff --check` clean
- [ ] lint, typecheck, tests, build green
- [ ] released contracts unchanged, or release notes updated
- [ ] local analytics still local; no new outbound data
- [ ] brand prose lowercase; identifiers exact
- [ ] local `HEAD` equals the remote branch
- [ ] PR body current; nothing merged without authorization

## Required reading

- `README.md`
- `docs/architecture.md`, `docs/node-runtime-guide.md`
- `docs/operator-guide.md`, `docs/LOCAL_API.md`, `docs/api-contract.md`
- `docs/PRIVACY.md`, `docs/security.md`
- `docs/PARTICIPATION.md`, `docs/SPATIAL.md`, `docs/REMOTE_TRANSPORT.md`
- `docs/RELEASES.md`, `docs/licensing.md`, `TRADEMARKS.md`
