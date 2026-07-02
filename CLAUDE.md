# Daintree

**Overview:** Electron IDE for orchestrating AI coding agents — many agent terminals in parallel across git worktrees: fleet broadcasting, worktree dashboard, context injection, MCP control surface. 15+ agent CLIs supported; roster in `shared/config/agents/` + `shared/config/agentRegistry.ts`. **Stack:** Electron 42 (Chromium 148), React 19, Vite 8, TypeScript, Tailwind CSS v4, Zustand 5, node-pty, simple-git, @xterm/xterm 6.x beta (exact pins in `package.json`). Product, repo, and config dir are all "Daintree" (`daintreehq/daintree`, `.daintree/`).

## Critical Rules

- **Deps & native modules:** `npm install` (dev) / `npm ci` (CI); `postinstall` rebuilds `node-pty` for Electron. Native-module errors → `npm run rebuild`.
- **Code style:** Minimal comments, no decorative headers, high signal-to-noise.
- **Markdown style:** Never hard-wrap prose — every paragraph/list item/table row is ONE physical line (soft wrap is the renderer's job). Applies to all `.md`. Code blocks and ASCII diagrams keep internal breaks.
- **Codex MCP:** `mcp__codex__codex` always takes `model: "gpt-5.5"` — the only valid value (ignore the MCP definition's examples). Include file paths so Codex can read the code.
- **GitHub:** Public repo `daintreehq/daintree`. Use the `gh` CLI for ALL GitHub ops — HTTP fetches fail on auth.
- **Branching:** Gitflow. All PRs target `develop`, NEVER `main` (release merges only).
- **Tracked configs:** `.daintree/recipes/*.json` (recipes = saved parameterized agent-launch configs) are intentionally tracked — never remove or gitignore.
- **Agent config boundary:** Never modify user-owned agent config (`~/.claude/`, `~/.gemini/`, user hooks, CLAUDE.md/AGENTS.md in user projects) — not even additive CLI injection like `--settings`. If a capability needs it, it's out of scope; use passive observation instead (output parsing, OSC titles, process tree, `AgentPatternDetector`-style regex). Precedent #4100.
- **`human-review` label:** marks issues unsolvable autonomously; 10-20x cost, apply sparingly; skip labeled issues when working issues.
- **Research versions:** Always research against our exact versions (Electron 42 / Chromium 148 — `build.target` `chrome148` in `vite.config.ts`; xterm 6.x betas; React 19); never assume older docs apply. Known traps: Electron 42 — unsigned macOS notifications silently emit `failed`, `Session.clearStorageData` drops `quotas`, better-sqlite3 needs a V8 14.8 patch; Electron 33→41 — `console-message` signature, utility-process unhandled-rejection behavior; xterm 6.x — canvas renderer and `windowsMode`/`fastScrollModifier` removed, VS Code viewport/scrollbar, new event system.

### Design & UX Rules

Hard constraints. Linked docs own the full catalogs/audits; rules without a pointer live only here.

- **Accent restraint:** Accent (`--color-accent-primary`, `text-accent-primary`, `outline-daintree-accent`) = at most ONE load-bearing signal (focus anchor or primary CTA) per active focus region (focus trap / arrow-key domain). Never for multi-select, membership, secondary emphasis, or anything on multiple elements at once — use the `bg-overlay-subtle` title-bar lift, focus styling, or neutral surfaces. In doubt → no accent. Checklist: `docs/themes/theme-system.md`.
- **Motion timing:** Shared tiers unless the duration encodes meaning: state changes 150ms `ease-out`; entry/exit 200/120ms; palette/tooltip 150/100ms; panel motion 200/120ms. Use the constants in `src/lib/animationUtils.ts`, never literals. Semantic exceptions (decay/width/sequencing IS the signal — e.g. `ActivityLight`, `FileChangeList` recency) are exempt from tier-fixing. Narrowest transition property set — never widen to bare `transition`/`transition-all`. Keep `transform` out of press snaps (copy `src/styles/components/toolbar.css` or `button.tsx`'s `active:scale-[0.98] active:duration-[1ms]`); box-shadow interpolates in its own named 150ms slot OR snaps with `active:shadow-none`, never both. Focus-ring transitions are wired once globally (`src/index.css` `*:focus-visible`) — no per-element `outline-*` transitions. Patterns: `docs/themes/interaction-state-recipes.md`.
- **High-contrast dual-block:** `@media (prefers-contrast: more)` and `@media (forced-colors: active)` in `src/index.css` are separate on purpose (macOS fires only the former; Windows swaps in system colors) — NEVER consolidate. Rationale inline in the block comments.
- **Loading indicators:** 400ms Doherty gate: <400ms nothing; 400ms–1s skeleton (`animate-pulse-delayed`, gate built in; reduced-motion/performance modes bypass) when the layout shape is predictable, else `Spinner`; >1s skeleton mandatory; >5s add "Still working…". `animate-pulse-immediate` only for waits already known to exceed the gate. `Spinner` has no delay — never for sub-400ms or predictable shapes. Programmatic gate: `useDeferredLoading(isPending, UI_DOHERTY_THRESHOLD)`; canonical: `BrowserPaneSkeleton`. Settings tabs render chrome immediately from safe defaults and populate on resolve — never a full-area `Spinner`.
- **Microcopy:** Sentence case; no period on titles/buttons/labels/single-clause subtitles. Contractions; drop "we". Error toasts = verb-noun title + 1-2 sentence why/fix + ONE contextual recovery action (never "Dismiss"). Destructive buttons verb-noun ("Delete worktree"). Toggle labels never change with state. Confirm dialogs: question naming the entity (`Delete 'foo'?`), body = the specific consequence (never "Are you sure"), verb-noun button. Recovery verbs: `Try again` (error boundaries) / `Retry` (inline banners). Toast titles: past-tense verb for discrete actions ("Token saved" — no "successfully"), noun phrase for ambient state ("Connection lost"); body never restates the title. Action-free error toasts opt out via `// eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok`.
- **Empty states:** Name the next action, not what's absent; when sidebar + grid are both empty, only the canvas gets the primary CTA; completed-work states stay quiet (the `user-cleared` variant of `EmptyState.tsx` nulls its action). Gotcha: gate `RecipeRunner` on `useRecipeStore` `currentProjectId !== null && !isLoading` — NOT `hasEverLaunchedAgent`; `loadRecipes()` sets `currentProjectId` synchronously before IPC resolves, so without the `isLoading` half it flashes empty. Gate teaching content on `hasEverLaunchedAgent`, derived from `usePanelStore` (mirrors `useGettingStartedChecklist`).
- **notify():** Only for events the user couldn't otherwise observe. Gate: timely? helpful next step? not already visible? if ignorable → `console.warn` instead. Surfaces least→most restricted: frame indicator (`panel-state-*`) → grid-bar (`placement: "grid-bar"`) → inbox → toast (the default placement and the MOST restricted) — pick the least-restricted that conveys the signal. `priority: "low"` = inbox only; `{ type: "error", priority: "low" }` is lint-banned. A `ReactNode` message requires `inboxMessage` (compile-enforced, `src/lib/notify.ts`). Grid-bar for signals from outside the visible UI; component-owned `InlineStatusBanner` when the signal and its recovery live in one component. Routing matrix: `docs/architecture/notification-system.md`; canonical code: `useAgentWaitingNudge`, `TerminalCountWarning`, `HostCrashBanner`.
- **Runtime signals:** Lowest tier that stays actionable: T0 silent log → T1 ambient pane chrome (flow pill, toolbar pips) → T2 inline warning banner → T3 inline error banner + recovery → T4 global banner. Demote if ignoring changes nothing; escalate if multi-terminal; auto-recovering states stay T1 until recovery stalls >30s or exhausts retries → T3 with a recovery action. Top-of-app globals contend for ONE slot via `useGlobalBannerPriority` in `GlobalBannerCoordinator.tsx` (mounted in `AppLayout.tsx`) — register there, never as siblings; a suppressible global also routes a `priority: "low"` inbox notify (project-scoped `supersedeKey`). While host-crash is active, suppress duplicate per-pane error banners. Tier table: `docs/architecture/notification-system.md`.
- **Destructive tiers:** Safeguard ∝ reversibility × blast radius (#7880): D0 reversible-local — no confirm but a discoverable inverse; D1 local-irreversible (`terminal.kill`, recipe delete) — `ConfirmDialog` + verb-noun button; D2 shared-state (`git.push`, `worktree.delete`, merge PR) — confirm + preview of ACTUAL content (diff/message/file list; a count is insufficient); D3 catastrophic (delete repo/project) — `typedNameTarget`. Hard rules: (1) no silent fallback defaults — any "if X empty, use Y" on a destructive submit is a review blocker (the #7880 root cause); (2) every wired `ConfirmDialog` carries `danger:"confirm"` (excludes the action from `repeatLast` + palette MRU); (3) direct `window.electron.*` IPC bypasses `ActionService` — wire confirm in the component and log it in the audit; (4) bundled multi-step ops need a preview step or one confirmation naming all operations. Audit + per-tier lists: `docs/architecture/destructive-action-safeguards.md`.

## Development

```bash
npm run dev          # Main + Renderer (Vite)
npm run build        # Production build
npm run check        # typecheck + codegen/channel/confirm-wiring/plugin-manifest guards + lint ratchet + format
npm run fix          # Auto-fix lint/format
npm run package      # Distribute
npm run rebuild      # Rebuild native modules
```

### CI Testing Strategy

- **No tautological assertions:** never assert a value that's a literal copied from the source-of-truth (`expect(DEFAULT_TIMEOUT).toBe(5000)`, `toHaveClass("text-accent-primary")`) — test computed output, invariants, and conditional logic instead. If changing the implementation value forces the same edit in the test, delete the test.
- **PRs/pushes:** typecheck/lint/format/unit/build on Ubuntu only; no E2E. Perf/size budget scripts are intentionally NOT in CI pre-1.0 (dormancy note in `ci.yml`); `ci-ok` is the sole required check.
- **Stabilize (on-demand full surface):** `stabilize.yml` (`workflow_dispatch`; `platform` input, default `linux-windows`) runs check + tests + build + smoke + all E2E suites cross-platform; the `stabilize` skill (`.agents/skills/stabilize/`) drives it (local-first flow, flake triage, re-runs); verdict = the `stabilize-ok` gate. Opens no issues; replaced the cron test-nightly — never re-add cron test runs or issue-creation.
- **Nightly publish:** `nightly-publish.yml` (2 AM UTC) is the only remaining cron — publishes macOS+Linux nightlies to `updates.daintree.org/nightly/`, launch smoke only. Not a validation surface; never drive it "green".
- **Releases:** per-OS workflows (`release-{macos,linux,windows}.yml`) on the same `v*` tag, each a full vertical slice (checks → unit → e2e → build → R2 upload → notify); failures isolate per-OS. E2E core + online + all seven `full-*` buckets gate each publish (buckets auto-shard 4× in `e2e.yml`).
- **E2E tiers:** `e2e/core/` release smoke; `e2e/full/<bucket>/` — seven Playwright projects (`full-terminal`, `full-worktree`, `full-presets`, `full-platform`, `full-panels`, `full-resilience`, `full-plugins`); `e2e/online/` real-API agent tests (gates releases); `e2e/nightly/` memory-leak detection. Boundaries: `docs/e2e-testing.md`. All suites run via `.github/workflows/e2e.yml` (`suite` + optional `test_file`), e.g. `gh workflow run "E2E Tests" --ref develop -f platform=linux -f suite=full-terminal -f test_file=e2e/full/terminal/core-terminal-search.spec.ts`.
- **Local E2E first:** touching a feature with an existing E2E test → run the spec or its bucket locally before pushing (`npx playwright test <spec>` / `npm run test:e2e:full-terminal`).

## Architecture

- **Main (`electron/`):** node-pty, git, OS access. Services in `services/`; IPC handlers by domain in `ipc/handlers/` (channel registry `ipc/channels.ts`); windowing in `window/`. Utility subprocesses with crash recovery: `pty-host/`, `workspace-host/`, `watchdog-host*`, `plugin-dev-worker*` (`docs/architecture/crash-recovery-and-safe-mode.md`).
- **Renderer (`src/`):** React UI; reaches Main only via `window.electron`. Homes: actions → `services/actions/definitions/`; panel modules → `panels/<kind>/`; stores → `store/`; components by domain → `components/`; hooks → `hooks/`; IPC clients → `clients/`.
- **Shared (`shared/`):** cross-process only — types (`types/`, incl. `ipc/`), registries/config (`config/`), theme system (`theme/`).

**State & persistence:** ~100 Zustand stores in two flavors, app-global vs per-project-view (`docs/architecture/state-management.md`); cross-store reads go through `src/store/storeAccessors.ts`, never direct partner-store imports at module eval (TDZ — `docs/architecture/store-init-order.md`). Durable state spans two engines with separate migrations: better-sqlite3 + drizzle-orm (`drizzle.config.ts`, `npm run db:generate`) and electron-store JSON (`electron/store.ts`) — `docs/architecture/persistence-and-migrations.md`.

### Actions

`ActionService` (`src/services/ActionService.ts`) is the typed dispatch layer for menus, keybindings, context menus, and agent automation: `dispatch(actionId, args?, opts?)`, `list()` / `get(id)`. IDs in `BUILT_IN_ACTION_IDS` (`shared/config/actionIds.ts`); types in `shared/types/actions.ts` (`ActionSource` incl. `"plugin"`; `ActionDanger`). The manifest is also the tool surface of the local MCP server (`electron/services/mcp-server/`) — external agents and the in-app assistant drive the IDE through it under tiered auth (`docs/architecture/mcp-server.md`).

### Panels

`PanelInstance = PtyPanelData | BrowserPanelData | DevPreviewPanelData | ReviewPanelData` (`shared/types/panel.ts`); registry + `panelKindHasPty(kind)` in `shared/config/panelKindRegistry.ts`; per-kind modules (serializer, defaults factory, component) in `src/panels/<kind>/`, unified in `src/panels/registry.tsx`.

### Multi-Window & Project Views

Each project gets its own `WebContentsView` + V8 context via `ProjectViewManager` (`electron/window/ProjectViewManager.ts`); LRU eviction under memory pressure. Per-window services live in `WindowContext.services`; global services (PtyClient, WorkspaceClient) are shared.

### IPC Bridge (`window.electron`)

~75 namespaces exposed via `contextBridge` in `electron/preload.cts`; methods return Promises or cleanups. Representative: `worktree`, `terminal`, `files`, `git`, `forge`, `appAgent`, `mcpServer`, `plugin`.

### Plugins

Manifest-driven extensions run in sandboxed utility subprocesses and contribute actions, panels, agents, toolbar buttons, and forge providers, gated by capability + consent. Host runtime `electron/services/plugin/`; registries `shared/config/plugin*.ts`; builtins in `plugins/builtin/` — GitHub ships as a builtin forge plugin, keeping the host forge-neutral (`docs/architecture/forge-provider-abstraction.md`). Author SDK = the npm workspace `packages/*` (`@daintreehq/plugin-sdk` et al.; `npm run packages:build`). Docs: `docs/plugins/`.

### Key Services

- `PtyManager` (Main) and `terminalInstanceService` (Renderer) own PTY processes / xterm instances.
- `WorkspaceService` polls git status; `WorktreeMonitor` tracks each worktree; per-view stores ride dedicated MessagePorts (`WorktreePortBroker`).
- `AgentStateService` (`electron/services/pty/AgentStateService.ts`; FSM in `shared/utils/agentFsm.ts`) tracks idle/working/waiting/directing/completed/exited via passive output heuristics; `running` is a runtime status, not an agent state.
- `CopyTreeService` builds agent context and injects it into terminals; `ResourceProfileService` picks Performance/Balanced/Efficiency from memory, event-loop lag, battery, and worktree count.

## Icons

Lucide only (`lucide-react`) — no bespoke glyphs for app concepts. New concept → closest Lucide icon, added to the alias list in `src/components/icons/index.ts`. Bespoke exceptions: `DaintreeIcon`, `AgentStateCircles`, `McpServerIcon`, `brands/`. See `src/components/icons/README.md`.

## Common Tasks

- **New action:** add the ID to `BUILT_IN_ACTION_IDS` → definition in `src/services/actions/definitions/*.ts` → auto-registers via `useActionRegistry`.
- **New IPC channel:** copy an existing `defineIpcNamespace` handler pair (`electron/ipc/handlers/<domain>.ts` + `<domain>.preload.ts`, e.g. `editorConfig`) → assign the namespace in `electron/preload.cts` → `npm run codegen:ipc && npm run codegen:ipc-renderer` (CI-enforced). Generated types: `shared/types/ipc/generated*.ts`; hand-maintained shapes: `shared/types/ipc/api.ts` / `maps.ts` (`src/types/electron.d.ts` is only the global shim). The `check:ipc-handwritten` ratchet blocks new hand-wired channels.

## Documentation

`docs/README.md` is the full index. Most-used: `docs/development.md` (IPC patterns, debugging, compiler-bailout tooling), `docs/themes/` (theme pipeline, tokens, interaction recipes), `docs/e2e-testing.md`, `docs/architecture/` (actions, MCP server, state, persistence, terminal lifecycle, notifications, destructive safeguards, crash recovery, process/window model), `docs/plugins/`.
