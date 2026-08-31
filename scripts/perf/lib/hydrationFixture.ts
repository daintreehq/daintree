import { performance } from "node:perf_hooks";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPerfTempRoot } from "./tempRoots";

/**
 * The real renderer hydration path (`src/utils/stateHydration/`), driven
 * headless.
 *
 * WHAT IS REAL. Every per-panel decision hydration makes about a saved
 * snapshot: `inferKind` (including the legacy `agent`/`markdown` migrations),
 * `resolveRespawnAgentId`, and the five argument builders in
 * `statePatcher.ts` — `buildArgsForBackendTerminal`,
 * `buildArgsForReconnectedFallback`, `buildArgsForRespawn`,
 * `buildArgsForNonPtyRecreation` and `buildArgsForOrphanedTerminal`. Those
 * builders reach the real agent registry (`getAgentConfig`), the real preset
 * resolution (`resolveAgentRuntimeSettings`, the CCR preset store), the real
 * launch-command builders (`generateAgentCommand`, `buildResumeCommand`,
 * `buildResumeLatestCommand`, `buildLaunchCommandFromFlags`), the real bypass
 * and inline-mode flag reconciliation, and the real per-kind deserializers in
 * `src/config/panelKindSerialisers.ts` with all of their untrusted-input
 * sanitizers.
 *
 * WHAT IS NOT, and cannot be here. `hydrateAppState` and `restorePanelsPhase`
 * are the callers of everything above, and neither runs in a plain Node
 * process: `restorePanelsPhase` awaits a real `terminalInstanceService` attach
 * per panel (an xterm instance in a DOM), batches through
 * `getRestoreBatchParams` with real UI yields, and drives `reconnectWithTimeout`
 * against a live PTY host. So this prices the CPU hydration spends deciding what
 * to restore, NOT wall-clock restore: the attach, the reconnect round trip, the
 * batch yields and first paint are all outside the bracket, and a regression in
 * any of them is invisible here. PERF-196 has the same shape for the parser and
 * says so for the same reason.
 *
 * REACHABILITY. `statePatcher.ts` bundles with esbuild against the `@`/`@shared`
 * aliases with exactly one stub: `@/config/agentIcons`, which uses Vite's
 * `import.meta.glob` to eager-load React brand components. Icons are never read
 * by an argument builder. Nothing else in the graph is stubbed — 168 modules,
 * all production.
 */

export interface SavedPanel {
  id: string;
  kind?: string;
  type?: string;
  agentId?: string;
  launchAgentId?: string;
  title?: string;
  titleMode?: string;
  cwd?: string;
  worktreeId?: string;
  location?: string;
  command?: string;
  browserUrl?: string;
  browserHistory?: { entries: string[]; index: number };
  browserZoom?: number;
  devCommand?: string;
  viewportPreset?: string;
  filePath?: string;
  fileViewMode?: string;
  fileStatus?: string;
  diffSource?: string;
  baseBranch?: string;
  browserRootPath?: unknown;
  browserExpandedPaths?: unknown;
  browserSelectedPath?: unknown;
  browserSortKey?: unknown;
  browserSortDirection?: unknown;
  browserSidebarWidth?: unknown;
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  agentPresetId?: string;
  extensionState?: Record<string, unknown>;
  createdAt?: number;
  lastActiveAt?: number;
}

interface BackendRecord {
  id: string;
  kind?: string;
  launchAgentId?: string;
  title?: string;
  cwd: string;
  agentState?: string;
  waitingReason?: string;
  lastStateChange?: number;
  agentSessionId?: string;
}

interface BuiltArgs {
  kind?: string;
  launchAgentId?: string;
  title?: string;
  cwd?: string;
  worktreeId?: string;
  location?: string;
  existingId?: string;
  requestedId?: string;
  command?: string;
  devCommand?: string;
  agentState?: string;
  waitingReason?: string;
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  sessionLostOnRestore?: boolean;
  browserUrl?: string;
  filePath?: string;
  fileViewMode?: string;
  fileStatus?: string;
  diffSource?: string;
  browserRootPath?: string;
  browserExpandedPaths?: string[];
  browserSelectedPath?: string;
  browserSortKey?: string;
  restore?: boolean;
}

interface AgentSettingsShape {
  agents?: Record<string, Record<string, unknown>>;
  globalSkipPermissions?: boolean;
  globalUseAltScreen?: boolean;
}

export interface StatePatcherModule {
  inferKind: (saved: SavedPanel) => string;
  resolveRespawnAgentId: (saved: SavedPanel, kind: string) => string | undefined;
  buildArgsForBackendTerminal: (
    backend: BackendRecord,
    saved: SavedPanel,
    projectRoot: string
  ) => BuiltArgs;
  buildArgsForReconnectedFallback: (
    reconnected: BackendRecord,
    saved: SavedPanel,
    projectRoot: string
  ) => BuiltArgs;
  buildArgsForRespawn: (
    saved: SavedPanel,
    kind: string,
    projectRoot: string,
    agentSettings: AgentSettingsShape | undefined,
    mintFreshTerminalId: boolean,
    clipboardDirectory: string | undefined,
    projectPresetsByAgent?: Record<string, unknown[]>,
    options?: {
      resolvedAgentBaseCommand?: string;
      allowResumeLatest?: boolean;
      allowSessionIdResume?: boolean;
    }
  ) => BuiltArgs;
  buildArgsForNonPtyRecreation: (
    saved: SavedPanel,
    kind: string,
    projectRoot: string,
    activeWorktreeId?: string | null
  ) => BuiltArgs;
  buildArgsForOrphanedTerminal: (backend: BackendRecord, projectRoot: string) => BuiltArgs;
}

const AGENT_ICONS_STUB = `
export function resolveAgentIcon() { return null; }
export const AGENT_ICON_MAP = {};
`;

let modulePromise: Promise<StatePatcherModule> | null = null;

/**
 * Bundle the real `statePatcher` for plain Node. Lazy, so importing a scenario
 * module builds nothing (the matrix test enforces that rule for fixtures).
 */
export function loadStatePatcherModule(): Promise<StatePatcherModule> {
  if (!modulePromise) modulePromise = buildStatePatcherBundle();
  return modulePromise;
}

async function buildStatePatcherBundle(): Promise<StatePatcherModule> {
  const esbuild = await import("esbuild");
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = pathResolve(here, "../../..");
  const outDir = createPerfTempRoot("daintree-perf-hydration-");
  const outfile = join(outDir, "statePatcher.mjs");

  await esbuild.build({
    entryPoints: [join(repoRoot, "src/utils/stateHydration/statePatcher.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
    alias: {
      "@": join(repoRoot, "src"),
      "@shared": join(repoRoot, "shared"),
    },
    define: { "import.meta.env": "{}" },
    plugins: [
      {
        name: "daintree-hydration-stubs",
        setup(build) {
          // The ONE stub. `agentIcons` resolves React brand components through
          // Vite's `import.meta.glob`, which esbuild leaves as a literal and
          // Node then throws on. No argument builder reads an icon.
          build.onResolve({ filter: /(^|[\\/])agentIcons$/ }, (args) => ({
            path: args.path,
            namespace: "daintree-hydration-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "daintree-hydration-stub" }, () => ({
            contents: AGENT_ICONS_STUB,
            loader: "js",
          }));
        },
      },
    ],
  });

  const mod = (await import(pathToFileURL(outfile).href)) as StatePatcherModule;
  if (typeof mod.buildArgsForRespawn !== "function") {
    throw new Error("statePatcher bundle did not export buildArgsForRespawn");
  }
  return mod;
}

/**
 * How hydration must treat one saved panel. Assigned by the plan builder, so
 * every expectation below is arithmetic over the planted snapshot rather than a
 * second reading from the subject.
 */
export type RestoreRoute =
  "backend" | "reconnected" | "respawnResume" | "respawnWithheld" | "nonPty";

export interface PlannedPanel {
  saved: SavedPanel;
  route: RestoreRoute;
  /** The kind `inferKind` must return for this snapshot. */
  expectedKind: string;
  /** Present for the two PTY-backed routes. */
  backend?: BackendRecord;
  /** Session id planted on the snapshot, for the two respawn routes. */
  plantedSessionId?: string;
  /** Kind-specific field the deserializer must carry through, for `nonPty`. */
  expectedRestoredField?: { name: keyof BuiltArgs; value: string };
  /** Values the sanitizers must drop, and the safe one they must keep. */
  hostile?: { safeExpandedPath: string; droppedExpandedPaths: string[] };
}

export interface HydrationPlan {
  label: string;
  projectRoot: string;
  panels: PlannedPanel[];
  orphans: BackendRecord[];
  agentSettings: AgentSettingsShape;
  clipboardDirectory: string;
  /**
   * Own keys per saved panel that survive a JSON round trip, in plan order.
   *
   * The in-memory snapshots carry keys whose value is `undefined` — a panel
   * with no `titleMode`, no `agentModelId`, no `lastActiveAt` still has those
   * three keys. `JSON.stringify` drops them, which is why a panel read back
   * from disk is a DIFFERENT object shape from the one the plan builder made,
   * and why this count is the arithmetic {@link hydrationRoundTripMisses} uses
   * to tell a real deserialize from a skipped one.
   */
  savedKeyCounts: number[];
}

const AGENT_IDS = ["claude", "codex", "gemini"] as const;
const NON_PTY_KINDS = ["browser", "file", "file-browser", "diff"] as const;

/**
 * Build a saved layout that exercises every restore route hydration has.
 *
 * The route mix is fixed by index arithmetic, not sampled, so the expected
 * per-route counts are derivable without running anything.
 */
export function buildHydrationPlan(
  label: string,
  panelCount: number,
  worktreeCount: number
): HydrationPlan {
  const projectRoot = "/repo";
  const panels: PlannedPanel[] = [];
  const orphans: BackendRecord[] = [];
  // Counted separately from `index`: cycling the kinds on `index` would leave
  // two of the four unreachable, because the non-PTY slots are congruent mod 8.
  let nonPtyIndex = 0;

  for (let index = 0; index < panelCount; index += 1) {
    const worktreeId = `wt-${(index % worktreeCount) + 1}`;
    const cwd = `${projectRoot}/worktrees/${worktreeId}`;
    const slot = index % 8;

    if (slot === 4 || slot === 5) {
      const kind = NON_PTY_KINDS[nonPtyIndex % NON_PTY_KINDS.length];
      nonPtyIndex += 1;
      panels.push(makeNonPtyPanel(index, kind, cwd, worktreeId));
      continue;
    }

    const agentId = AGENT_IDS[index % AGENT_IDS.length];
    const plantedSessionId = `11111111-2222-3333-4444-${String(100000000000 + index).slice(0, 12)}`;
    const saved: SavedPanel = {
      id: `panel-${index}`,
      // Every fourth PTY panel is persisted under the pre-collapse `agent`
      // kind, so the migration branch of `inferKind` is on the hot path.
      kind: index % 4 === 0 ? "agent" : "terminal",
      launchAgentId: agentId,
      title: `${agentId} ${index}`,
      titleMode: index % 5 === 0 ? "user" : undefined,
      cwd,
      worktreeId,
      location: index % 7 === 0 ? "dock" : "grid",
      command: `${agentId} --resume ${plantedSessionId}`,
      agentSessionId: plantedSessionId,
      agentLaunchFlags: index % 3 === 0 ? ["--model", "opus"] : [],
      agentModelId: index % 3 === 0 ? "opus" : undefined,
      createdAt: 1_700_000_000_000 + index * 91,
      lastActiveAt: index % 4 === 0 ? 1_700_000_500_000 + index : undefined,
    };

    const backend: BackendRecord = {
      id: saved.id,
      kind: "terminal",
      launchAgentId: agentId,
      title: saved.title,
      cwd,
      agentState: index % 6 === 0 ? "waiting" : "working",
      waitingReason: index % 6 === 0 ? "approval" : undefined,
      lastStateChange: 1_700_000_600_000 + index,
      agentSessionId: plantedSessionId,
    };

    const route: RestoreRoute =
      slot === 0 || slot === 1
        ? "backend"
        : slot === 2
          ? "reconnected"
          : slot === 3
            ? "respawnResume"
            : "respawnWithheld";

    panels.push({
      saved,
      route,
      expectedKind: "terminal",
      backend: route === "backend" || route === "reconnected" ? backend : undefined,
      plantedSessionId,
    });
  }

  // Backend terminals with no saved snapshot at all — the orphan-adoption pass.
  const orphanCount = Math.max(1, Math.round(panelCount * 0.05));
  for (let i = 0; i < orphanCount; i += 1) {
    orphans.push({
      id: `orphan-${i}`,
      kind: "terminal",
      launchAgentId: AGENT_IDS[i % AGENT_IDS.length],
      title: `${AGENT_IDS[i % AGENT_IDS.length]} orphan ${i}`,
      cwd: `${projectRoot}/worktrees/wt-1`,
      agentState: "working",
    });
  }

  return {
    label,
    projectRoot,
    panels,
    savedKeyCounts: panels.map((planned) => definedKeyCount(planned.saved)),
    orphans,
    agentSettings: {
      agents: {
        claude: { skipPermissions: true },
        codex: {},
        gemini: { useAltScreen: false },
      },
      globalSkipPermissions: false,
      globalUseAltScreen: false,
    },
    clipboardDirectory: "/tmp/daintree-clipboard",
  };
}

/** Own keys with a defined value — exactly what `JSON.stringify` keeps. */
function definedKeyCount(saved: SavedPanel): number {
  let count = 0;
  for (const value of Object.values(saved)) {
    if (value !== undefined) count += 1;
  }
  return count;
}

/**
 * The on-disk round trip a cold start pays before hydration.
 *
 * Both halves exist so the parse can be LOAD-BEARING rather than decorative.
 * PERF-001/002 used to time a `JSON.parse` and throw the result away, hydrating
 * from the in-memory plan instead — so deleting the parse made the benchmark
 * faster and moved no correctness term. `withParsedPanels` below rebuilds the
 * plan around whatever came back, so hydration consumes the parsed snapshots
 * and nothing else.
 */
export function serializeHydrationPanels(plan: HydrationPlan): string {
  return JSON.stringify({ panels: plan.panels.map((planned) => planned.saved) });
}

export function parseHydrationPanels(payload: string): SavedPanel[] {
  return (JSON.parse(payload) as { panels: SavedPanel[] }).panels;
}

/**
 * The plan hydration actually runs against: the same routes and expectations,
 * with every `saved` snapshot replaced by the object the parse produced.
 *
 * Sliced to what came back rather than padded from the original, so a parse
 * that returned fewer panels hydrates fewer panels — visible to the oracle,
 * which is graded against the ORIGINAL plan, instead of being silently papered
 * over with the in-memory copy the round trip was supposed to replace.
 */
export function withParsedPanels(plan: HydrationPlan, parsed: SavedPanel[]): HydrationPlan {
  return {
    ...plan,
    panels: plan.panels
      .slice(0, parsed.length)
      .map((planned, index) => ({ ...planned, saved: parsed[index] })),
  };
}

/**
 * One accumulator for the round trip, over four things a skipped or stubbed
 * parse cannot all satisfy at once.
 *
 * - The panel count came back.
 * - Each panel is the panel the plan planted, by id.
 * - Each panel is a DISTINCT object graph. The in-memory snapshot is the one
 *   thing a deleted parse would hand on, and it is the same reference.
 * - Each panel has the on-disk key shape. `structuredClone` clears the
 *   identity check but keeps `undefined`-valued keys; `JSON.parse` cannot.
 *
 * All four are arithmetic over the plan the fixture built. Nothing here parses
 * the payload a second time to see what the first parse should have said.
 */
export function hydrationRoundTripMisses(plan: HydrationPlan, parsed: SavedPanel[]): number {
  let misses = Math.abs(plan.panels.length - parsed.length);

  const paired = Math.min(plan.panels.length, parsed.length);
  for (let i = 0; i < paired; i += 1) {
    const planted = plan.panels[i].saved;
    const restored = parsed[i];
    if (restored === planted) misses += 1;
    if (restored.id !== planted.id) misses += 1;
    if (Object.keys(restored).length !== plan.savedKeyCounts[i]) misses += 1;
  }

  return misses;
}

function makeNonPtyPanel(
  index: number,
  kind: (typeof NON_PTY_KINDS)[number],
  cwd: string,
  worktreeId: string
): PlannedPanel {
  const base: SavedPanel = {
    id: `panel-${index}`,
    kind,
    title: `${kind} ${index}`,
    cwd,
    worktreeId,
    location: index % 9 === 0 ? "dock" : "grid",
    createdAt: 1_700_000_000_000 + index * 91,
  };

  if (kind === "browser") {
    const url = `http://localhost:${3000 + (index % 20)}/settings`;
    return {
      saved: {
        ...base,
        browserUrl: url,
        browserHistory: { entries: [url, `${url}#tab`], index: 1 },
        browserZoom: 1.1,
      },
      route: "nonPty",
      expectedKind: "browser",
      expectedRestoredField: { name: "browserUrl", value: url },
    };
  }

  if (kind === "file") {
    const filePath = `docs/architecture/state-${index}.md`;
    return {
      saved: {
        ...base,
        filePath,
        // Untrusted on-disk string outside the known set — must be dropped.
        fileViewMode: "hexdump",
      },
      route: "nonPty",
      expectedKind: "file",
      expectedRestoredField: { name: "filePath", value: filePath },
    };
  }

  if (kind === "diff") {
    const filePath = `src/store/panelStore-${index}.ts`;
    return {
      saved: {
        ...base,
        filePath,
        fileStatus: "modified",
        // Not a known diff source — must be dropped rather than passed through.
        diffSource: "cherry-pick",
        baseBranch: "develop",
      },
      route: "nonPty",
      expectedKind: "diff",
      expectedRestoredField: { name: "filePath", value: filePath },
    };
  }

  const safeExpandedPath = `packages/app/src`;
  const droppedExpandedPaths = [
    "/etc/passwd",
    "../../../etc/shadow",
    "C:\\Windows\\System32",
    "packages/app\u0000/src",
  ];
  return {
    saved: {
      ...base,
      browserRootPath: "packages/app",
      browserExpandedPaths: [safeExpandedPath, ...droppedExpandedPaths],
      browserSelectedPath: safeExpandedPath,
      // Not a known sort key — must fall back to absent.
      browserSortKey: "colour",
      browserSortDirection: "desc",
      browserSidebarWidth: 320,
    },
    route: "nonPty",
    expectedKind: "file-browser",
    expectedRestoredField: { name: "browserRootPath", value: "packages/app" },
    hostile: { safeExpandedPath, droppedExpandedPaths },
  };
}

export interface HydrationObservation {
  /** Wall time of the hydration pass alone, oracle excluded. */
  elapsedMs: number;
  /** Builder invocations, tallied at each call site. */
  builtPanelCount: number;
  backendCount: number;
  reconnectedCount: number;
  respawnResumeCount: number;
  respawnWithheldCount: number;
  nonPtyCount: number;
  orphanCount: number;
  /** `inferKind` results, in plan order. */
  inferredKinds: string[];
  /** Built args, in plan order, one per planned panel. */
  built: BuiltArgs[];
  /** Built args for the orphan-adoption pass. */
  orphanBuilt: BuiltArgs[];
}

/**
 * The timed bracket: one hydration sweep over the saved layout, routing each
 * panel exactly as `restorePanelsPhase` routes it.
 */
export function runHydrationPass(
  mod: StatePatcherModule,
  plan: HydrationPlan
): HydrationObservation {
  const inferredKinds: string[] = [];
  const built: BuiltArgs[] = [];
  const orphanBuilt: BuiltArgs[] = [];
  let builtPanelCount = 0;
  let backendCount = 0;
  let reconnectedCount = 0;
  let respawnResumeCount = 0;
  let respawnWithheldCount = 0;
  let nonPtyCount = 0;
  let orphanCount = 0;

  const startedAt = performance.now();

  for (const planned of plan.panels) {
    const kind = mod.inferKind(planned.saved);
    inferredKinds.push(kind);

    switch (planned.route) {
      case "backend":
        built.push(
          mod.buildArgsForBackendTerminal(planned.backend!, planned.saved, plan.projectRoot)
        );
        backendCount += 1;
        break;
      case "reconnected":
        built.push(
          mod.buildArgsForReconnectedFallback(planned.backend!, planned.saved, plan.projectRoot)
        );
        reconnectedCount += 1;
        break;
      case "respawnResume":
        built.push(
          mod.buildArgsForRespawn(
            planned.saved,
            kind,
            plan.projectRoot,
            plan.agentSettings,
            false,
            plan.clipboardDirectory,
            undefined,
            { allowResumeLatest: true, allowSessionIdResume: true }
          )
        );
        respawnResumeCount += 1;
        break;
      case "respawnWithheld":
        built.push(
          mod.buildArgsForRespawn(
            planned.saved,
            kind,
            plan.projectRoot,
            plan.agentSettings,
            true,
            plan.clipboardDirectory,
            undefined,
            // A sibling pane owns this snapshot's session and its agent+cwd
            // resume-latest slot (#11461), so both replays must be withheld.
            { allowResumeLatest: false, allowSessionIdResume: false }
          )
        );
        respawnWithheldCount += 1;
        break;
      case "nonPty":
        built.push(
          mod.buildArgsForNonPtyRecreation(
            planned.saved,
            kind,
            plan.projectRoot,
            planned.saved.worktreeId ?? null
          )
        );
        nonPtyCount += 1;
        break;
    }
    builtPanelCount += 1;
  }

  for (const orphan of plan.orphans) {
    orphanBuilt.push(mod.buildArgsForOrphanedTerminal(orphan, plan.projectRoot));
    orphanCount += 1;
  }

  const elapsedMs = performance.now() - startedAt;

  return {
    elapsedMs,
    builtPanelCount,
    backendCount,
    reconnectedCount,
    respawnResumeCount,
    respawnWithheldCount,
    nonPtyCount,
    orphanCount,
    inferredKinds,
    built,
    orphanBuilt,
  };
}

/**
 * One accumulator per restore route, plus one for the kind dispatch and one for
 * the untrusted-input sanitizers.
 *
 * Not a single total, for the reason the README gives: an aggregate cannot see
 * a deleted term. Delete the orphan-adoption pass and only `orphanMisses` moves;
 * delete the sanitizers and only `sanitizerMisses` does.
 */
export interface HydrationMisses {
  /** `inferKind`, including the `agent` -> `terminal` migration. */
  kindInferenceMisses: number;
  /** `buildArgsForBackendTerminal`: id adoption, cwd, coerced agent state. */
  backendRestoreMisses: number;
  /** `buildArgsForReconnectedFallback`. */
  reconnectRestoreMisses: number;
  /** `buildArgsForRespawn` with resume allowed: the saved session is replayed. */
  respawnResumeMisses: number;
  /** The same builder with resume withheld: the session must NOT be replayed. */
  resumeSuppressionMisses: number;
  /** `buildArgsForNonPtyRecreation` and its per-kind deserializer. */
  nonPtyRestoreMisses: number;
  /** The deserializers' untrusted-input sanitizers, graded both ways. */
  sanitizerMisses: number;
  /** `buildArgsForOrphanedTerminal`. */
  orphanMisses: number;
  /** Every planned panel reached a builder. */
  routeCoverageMisses: number;
}

export function zeroHydrationMisses(): HydrationMisses {
  return {
    kindInferenceMisses: 0,
    backendRestoreMisses: 0,
    reconnectRestoreMisses: 0,
    respawnResumeMisses: 0,
    resumeSuppressionMisses: 0,
    nonPtyRestoreMisses: 0,
    sanitizerMisses: 0,
    orphanMisses: 0,
    routeCoverageMisses: 0,
  };
}

export function addHydrationMisses(left: HydrationMisses, right: HydrationMisses): HydrationMisses {
  return {
    kindInferenceMisses: left.kindInferenceMisses + right.kindInferenceMisses,
    backendRestoreMisses: left.backendRestoreMisses + right.backendRestoreMisses,
    reconnectRestoreMisses: left.reconnectRestoreMisses + right.reconnectRestoreMisses,
    respawnResumeMisses: left.respawnResumeMisses + right.respawnResumeMisses,
    resumeSuppressionMisses: left.resumeSuppressionMisses + right.resumeSuppressionMisses,
    nonPtyRestoreMisses: left.nonPtyRestoreMisses + right.nonPtyRestoreMisses,
    sanitizerMisses: left.sanitizerMisses + right.sanitizerMisses,
    orphanMisses: left.orphanMisses + right.orphanMisses,
    routeCoverageMisses: left.routeCoverageMisses + right.routeCoverageMisses,
  };
}

/**
 * Grade a hydration pass against the planted snapshots.
 *
 * Everything compared here comes from `buildHydrationPlan`. The two respawn
 * routes are the pair worth reading: the same builder, the same snapshot, and
 * opposite requirements — one must reach the saved conversation, the other must
 * not — so a builder that always resumes and a builder that never resumes both
 * score, where a one-sided check would have excused one of them.
 */
export function hydrationPassMisses(
  plan: HydrationPlan,
  observed: HydrationObservation
): HydrationMisses {
  const misses = zeroHydrationMisses();

  misses.routeCoverageMisses =
    Math.abs(plan.panels.length - observed.builtPanelCount) +
    Math.abs(plan.panels.length - observed.built.length) +
    Math.abs(plan.orphans.length - observed.orphanCount) +
    Math.abs(plan.panels.length - observed.inferredKinds.length);

  const paired = Math.min(plan.panels.length, observed.built.length);
  for (let i = 0; i < paired; i += 1) {
    const planned = plan.panels[i];
    const saved = planned.saved;
    const args = observed.built[i];

    if (observed.inferredKinds[i] !== planned.expectedKind) misses.kindInferenceMisses += 1;

    switch (planned.route) {
      case "backend": {
        const backend = planned.backend!;
        if (args.existingId !== backend.id) misses.backendRestoreMisses += 1;
        if (args.kind !== "terminal") misses.backendRestoreMisses += 1;
        if (args.cwd !== backend.cwd) misses.backendRestoreMisses += 1;
        if (args.launchAgentId !== saved.launchAgentId) misses.backendRestoreMisses += 1;
        if (args.agentState !== backend.agentState) misses.backendRestoreMisses += 1;
        // The waiting reason survives only while the state is `waiting` — both
        // directions, so a builder that always forwards it scores too.
        const expectedReason = backend.agentState === "waiting" ? backend.waitingReason : undefined;
        if (args.waitingReason !== expectedReason) misses.backendRestoreMisses += 1;
        if (args.location !== (saved.location === "dock" ? "dock" : "grid")) {
          misses.backendRestoreMisses += 1;
        }
        break;
      }
      case "reconnected": {
        const backend = planned.backend!;
        if (args.existingId !== backend.id) misses.reconnectRestoreMisses += 1;
        if (args.kind !== "terminal") misses.reconnectRestoreMisses += 1;
        if (args.cwd !== backend.cwd) misses.reconnectRestoreMisses += 1;
        if (args.launchAgentId !== saved.launchAgentId) misses.reconnectRestoreMisses += 1;
        if (args.agentSessionId !== planned.plantedSessionId) misses.reconnectRestoreMisses += 1;
        if (args.worktreeId !== saved.worktreeId) misses.reconnectRestoreMisses += 1;
        break;
      }
      case "respawnResume": {
        const sessionId = planned.plantedSessionId!;
        // The whole point of the branch: the rebuilt command must reach the
        // saved conversation, and the id must ride onto the respawned panel.
        if (!args.command || !args.command.includes(sessionId)) misses.respawnResumeMisses += 1;
        if (args.agentSessionId !== sessionId) misses.respawnResumeMisses += 1;
        if (args.sessionLostOnRestore === true) misses.respawnResumeMisses += 1;
        // `mintFreshTerminalId: false`, so the pane keeps its persisted id.
        if (args.requestedId !== saved.id) misses.respawnResumeMisses += 1;
        if (args.launchAgentId !== saved.launchAgentId) misses.respawnResumeMisses += 1;
        if (args.restore !== true) misses.respawnResumeMisses += 1;
        break;
      }
      case "respawnWithheld": {
        const sessionId = planned.plantedSessionId!;
        // The opposite requirement on the same builder: a sibling owns this
        // session, so neither the id nor the resume-latest back door may
        // reach it, and the loss must be surfaced rather than hidden.
        if (args.command && args.command.includes(sessionId)) {
          misses.resumeSuppressionMisses += 1;
        }
        if (args.agentSessionId === sessionId) misses.resumeSuppressionMisses += 1;
        // `saved.command` IS a resume command — an earlier restore built it.
        // Inheriting it rather than rebuilding reinstates the collision the
        // suppression exists to prevent, and is invisible to the id check
        // above only if the id changed shape.
        if (args.command === saved.command) misses.resumeSuppressionMisses += 1;
        // The resume-latest back door does not set this; every branch that
        // genuinely abandons the conversation does.
        if (args.sessionLostOnRestore !== true) misses.resumeSuppressionMisses += 1;
        // `mintFreshTerminalId: true`, so the saved id must NOT be reused.
        if (args.requestedId !== undefined) misses.resumeSuppressionMisses += 1;
        break;
      }
      case "nonPty": {
        if (args.requestedId !== saved.id) misses.nonPtyRestoreMisses += 1;
        if (args.kind !== planned.expectedKind) misses.nonPtyRestoreMisses += 1;
        const field = planned.expectedRestoredField;
        if (field && args[field.name] !== field.value) misses.nonPtyRestoreMisses += 1;
        // A dockable kind keeps its dock placement; a non-dockable one is
        // rescued to the grid (#11375). `diff` is the one non-dockable kind in
        // this mix — `browser`, `file` and `file-browser` all dock.
        const expectedLocation =
          saved.location === "dock" && planned.expectedKind !== "diff" ? "dock" : "grid";
        if (args.location !== expectedLocation) misses.nonPtyRestoreMisses += 1;

        // Sanitizers, graded in both directions.
        if (planned.expectedKind === "file" && args.fileViewMode !== undefined) {
          misses.sanitizerMisses += 1;
        }
        if (planned.expectedKind === "diff") {
          if (args.diffSource !== undefined) misses.sanitizerMisses += 1;
          if (args.fileStatus !== "modified") misses.sanitizerMisses += 1;
        }
        if (planned.hostile) {
          const restored = args.browserExpandedPaths ?? [];
          // The safe entry must survive...
          if (!restored.includes(planned.hostile.safeExpandedPath)) misses.sanitizerMisses += 1;
          // ...and every hostile one must be gone. A sanitizer that dropped
          // everything fails the line above; one that dropped nothing fails
          // these.
          for (const dropped of planned.hostile.droppedExpandedPaths) {
            if (restored.includes(dropped)) misses.sanitizerMisses += 1;
          }
          if (args.browserSortKey !== undefined) misses.sanitizerMisses += 1;
        }
        break;
      }
    }
  }

  const orphanPaired = Math.min(plan.orphans.length, observed.orphanBuilt.length);
  for (let i = 0; i < orphanPaired; i += 1) {
    const orphan = plan.orphans[i];
    const args = observed.orphanBuilt[i];
    if (args.existingId !== orphan.id) misses.orphanMisses += 1;
    if (args.cwd !== orphan.cwd) misses.orphanMisses += 1;
    if (args.location !== "grid") misses.orphanMisses += 1;
    if (args.launchAgentId !== orphan.launchAgentId) misses.orphanMisses += 1;
  }

  return misses;
}
