import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

/**
 * The REAL action dispatch layer for PERF-200..205, in a plain Node process.
 *
 * `ActionService` is described in CLAUDE.md as "the typed dispatch layer behind
 * menus, keybindings, context menus, and agent automation — and the same
 * manifest is the tool surface of the local MCP server". Every keystroke and
 * every MCP tool call crosses it, and nothing measured it. These fixtures load
 * that layer unmodified and drive it through its public entry points.
 *
 * WHAT IS REAL
 *   - `src/services/ActionService.ts` — the registry, the dispatch gate chain
 *     (args validation, `isEnabled`, danger/confirmation, result validation),
 *     `toManifestEntry`, the lazy JSON-schema cache. Unmodified product code.
 *   - The whole built-in action catalog: `createActionDefinitions()` builds the
 *     real ~495 definition factories from `src/services/actions/definitions/`,
 *     each one instantiated and registered. Their `isEnabled`, `disabledReason`
 *     and `palette.isReady` predicates are the shipped ones and really run.
 *   - `src/services/KeybindingService.ts` with the real `DEFAULT_KEYBINDINGS`
 *     table, including the real `when`-clause parser and evaluator.
 *   - The main-process MCP projection: `shouldExposeTool`,
 *     `buildToolInputSchema`, `buildToolOutputSchema`, `buildAnnotations` and
 *     `buildSurfaceManifest`, against the real tier allowlists. This is the
 *     exact pipeline `sessionServer`'s `tools/list` handler runs.
 *   - The per-view worktree store (`createWorktreeStore`), seeded, so the
 *     worktree-scoped predicates evaluate instead of throwing.
 *
 * WHAT IS NOT, AND CANNOT BE
 *   - **No action ever reaches `run()` on the real catalog.** Every real-action
 *     dispatch in these scenarios is one the gate chain rejects before `run()`
 *     (unknown id, invalid args, disabled, confirmation required). `run()`
 *     bodies call `window.electron`, spawn PTYs and mutate renderer stores;
 *     executing them here would measure a crash, not a dispatch. The successful
 *     dispatch path is measured on probe actions this fixture registers into the
 *     same real service — real schemas, real gate chain, a no-op `run()`.
 *   - **No renderer.** There is no DOM, no React, no `window.electron`. So:
 *     `emitActionDispatchedEvent` returns immediately (`isElectronApiAvailable()`
 *     is false), so the IPC leg of a dispatch is NOT in any number here;
 *     `emitShortcutHint` runs but finds an unhydrated hint store;
 *     `buildKeybindingWhenContext` cannot be used (it reads `document`), so the
 *     `when` context is supplied through the service's own static
 *     `setWhenContext` fallback — clause parsing and evaluation are real, the
 *     context snapshot is not live.
 *   - **No plugins.** Plugin-contributed actions, their raw JSON Schemas and
 *     their keybindings are absent, so catalog size is the built-in floor.
 *   - **`import.meta.env` is `{}`**, which means `DEV` is falsy: the
 *     register-time definition linter and the DEV deep-freeze of cached schemas
 *     are both off, matching a production renderer rather than a dev one.
 *   - **Platform is pinned.** `isMac()` reads `navigator.platform`, which in
 *     Node is `process.platform` ("darwin"), so the real renderer's macOS branch
 *     would never be taken. The fixture installs a fixed `navigator.platform`
 *     so the keybinding table and the Cmd/Ctrl matcher resolve identically on
 *     every runner — these counts are meant to compare across machines.
 *   - `src/config/agentIcons.ts` is stubbed: it is a Vite `import.meta.glob` of
 *     React brand icons, unreachable from any measured path.
 *
 * The module graph is linked by esbuild rather than imported directly, for the
 * same reason `worktreeSidebarFixture.ts` does it: the renderer half is written
 * against Vite (`import.meta.env`, `@/` aliases) and the MCP half transitively
 * imports `electron`. One bundle, built once per process.
 */

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Pinned so the keybinding table and the Cmd/Ctrl branch of the matcher are the
 * same on every runner. Installed before the bundle is imported, because
 * `defaultKeybindings.ts` reads `isWindows()` at module evaluation.
 */
const PINNED_NAVIGATOR = { platform: "MacIntel", userAgent: "daintree-perf-harness" };

function installPinnedNavigator(): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: PINNED_NAVIGATOR,
  });
}

/** Minimal `electron` stand-in. Nothing on the measured MCP paths touches it. */
const ELECTRON_STUB = `
const noop = () => undefined;
export const app = {
  getPath: () => "/tmp/daintree-perf",
  getVersion: () => "0.0.0-perf",
  getName: () => "Daintree",
  isPackaged: false,
  on: noop,
  whenReady: () => Promise.resolve(),
};
export const ipcMain = { on: noop, handle: noop, removeHandler: noop };
export const BrowserWindow = class { static getAllWindows() { return []; } };
export const webContents = { getAllWebContents: () => [] };
export const shell = { openExternal: noop };
export const dialog = {};
export const session = {};
export const net = {};
export const nativeTheme = { on: noop };
export const utilityProcess = { fork: noop };
export default { app, ipcMain, BrowserWindow, webContents, shell };
`;

const AGENT_ICONS_STUB = `
const Icon = () => null;
export const AGENT_ICON_MAP = { claude: Icon };
export function resolveAgentIcon() { return Icon; }
`;

/**
 * Structural views of the product objects this fixture drives. Deliberately
 * narrow — only the members the scenarios call — so the bundle's real types
 * stay the authority and this file never becomes a second, drifting copy.
 */
export interface ActionManifestRow {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: string;
  danger: string;
  enabled: boolean;
  requiresArgs: boolean;
  disabledReason?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  examples?: unknown[];
  mcpVisibility?: string;
  paletteHidden?: true;
  paletteDisabled?: true;
  paletteDisabledReason?: string;
}

export interface ActionDispatchOutcome {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ActionServiceLike {
  register(definition: unknown): void;
  has(id: string): boolean;
  list(context?: unknown, options?: { includeSchemas?: boolean }): ActionManifestRow[];
  dispatch(
    actionId: string,
    args?: unknown,
    options?: Record<string, unknown>
  ): Promise<ActionDispatchOutcome>;
  setContextProvider(provider: (() => unknown) | null): void;
}

export interface KeybindingRow {
  actionId: string;
  combo: string;
  scope: string;
  priority: number;
  when?: string;
  pluginId?: string;
  description?: string;
  category?: string;
}

export interface KeybindingResolution {
  match?: KeybindingRow;
  chordPrefix: boolean;
  shouldConsume: boolean;
}

export interface KeybindingServiceLike {
  getAllBindings(): KeybindingRow[];
  registerBinding(config: KeybindingRow): void;
  resolveKeybinding(event: KeyboardEvent): KeybindingResolution;
  setWhenContext(context: Record<string, unknown>): void;
  clearPendingChord(): void;
  getPendingChord(): string | null;
  getLastInvalidKey(): string | null;
  clearLastInvalidKey(): void;
}

interface WorktreeViewStoreLike {
  getState: () => {
    applySnapshot: (states: unknown[], version: { epoch: string; seq: number }) => void;
  };
}

export interface ActionModules {
  ActionService: new () => ActionServiceLike;
  createActionDefinitions: (callbacks: unknown) => Map<string, () => unknown>;
  KeybindingService: new () => KeybindingServiceLike;
  DEFAULT_KEYBINDINGS: KeybindingRow[];
  BUILT_IN_ACTION_IDS: readonly string[];
  createWorktreeStore: () => WorktreeViewStoreLike;
  setCurrentViewStore: (store: WorktreeViewStoreLike) => void;
  shouldExposeTool: (entry: ActionManifestRow, tier: string, session: unknown) => boolean;
  buildToolInputSchema: (entry: ActionManifestRow) => Record<string, unknown>;
  buildToolOutputSchema: (entry: ActionManifestRow) => Record<string, unknown> | undefined;
  buildAnnotations: (entry: ActionManifestRow) => Record<string, unknown>;
  buildSurfaceManifest: (
    manifest: readonly ActionManifestRow[],
    tier: string,
    appVersion: string,
    session?: unknown
  ) => { hash: string; tools: unknown[] };
  getTierPermittedActionIds: (tier: string) => ReadonlySet<string>;
  UNBOUND_SESSION_SURFACE: unknown;
}

const ENTRY_SOURCE = `
export { ActionService } from "@/services/ActionService";
export { createActionDefinitions } from "@/services/actions/actionDefinitions";
export { KeybindingService } from "@/services/KeybindingService";
export { DEFAULT_KEYBINDINGS } from "@/services/defaultKeybindings";
export { BUILT_IN_ACTION_IDS } from "@shared/config/actionIds";
export { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
export {
  shouldExposeTool,
  buildToolInputSchema,
  buildToolOutputSchema,
  buildAnnotations,
  getTierPermittedActionIds,
  UNBOUND_SESSION_SURFACE,
} from "MCP_TIER_AUTH";
export { buildSurfaceManifest } from "MCP_SURFACE_MANIFEST";
`;

let modulesPromise: Promise<ActionModules> | null = null;

export function loadActionModules(): Promise<ActionModules> {
  modulesPromise ??= buildActionBundle();
  return modulesPromise;
}

async function buildActionBundle(): Promise<ActionModules> {
  installPinnedNavigator();
  const esbuild = await import("esbuild");
  const outDir = mkdtempSync(join(tmpdir(), "daintree-perf-actions-"));
  const entryFile = join(outDir, "entry.ts");
  const outfile = join(outDir, "actionLayer.mjs");

  const posix = (p: string) => p.replace(/\\/g, "/");
  writeFileSync(
    entryFile,
    ENTRY_SOURCE.replace(
      "MCP_TIER_AUTH",
      posix(join(REPO_ROOT, "electron/services/mcp-server/tierAuth.ts"))
    ).replace(
      "MCP_SURFACE_MANIFEST",
      posix(join(REPO_ROOT, "electron/services/mcp-server/surfaceManifest.ts"))
    )
  );

  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
    alias: { "@": join(REPO_ROOT, "src"), "@shared": join(REPO_ROOT, "shared") },
    define: { "import.meta.env": "{}" },
    loader: { ".css": "empty", ".svg": "empty", ".png": "empty" },
    plugins: [
      {
        name: "daintree-perf-action-stubs",
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({
            path: "electron",
            namespace: "daintree-perf-stub",
            pluginData: ELECTRON_STUB,
          }));
          build.onResolve({ filter: /(^|[\\/])agentIcons$/ }, (args) => ({
            path: args.path,
            namespace: "daintree-perf-stub",
            pluginData: AGENT_ICONS_STUB,
          }));
          build.onLoad({ filter: /.*/, namespace: "daintree-perf-stub" }, (args) => ({
            contents: args.pluginData as string,
            loader: "js",
          }));
        },
      },
    ],
  });

  process.on("exit", () => {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  });

  const mod = (await import(pathToFileURL(outfile).href)) as ActionModules;
  if (typeof mod.createActionDefinitions !== "function") {
    throw new Error("action bundle did not export createActionDefinitions");
  }
  if (typeof mod.shouldExposeTool !== "function") {
    throw new Error("action bundle did not export the MCP tool-surface gate");
  }
  return mod;
}

/**
 * `ActionCallbacks` is 30 renderer callbacks the definitions close over. None of
 * them is invoked on any measured path — they only fire inside `run()` — so a
 * proxy that answers every property with a harmless getter is enough, and it
 * cannot drift when the interface gains a member. The four getters that ARE
 * read by `isEnabled` predicates return seeded values.
 */
function makeCallbacks(worktrees: unknown[]): unknown {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        switch (property) {
          case "getWorktrees":
            return () => worktrees;
          case "getActiveWorktreeId":
            return () => SEEDED_WORKTREE_ID;
          case "getFocusedId":
            return () => "perf-terminal-1";
          case "getIsSettingsOpen":
            return () => false;
          case "getDefaultCwd":
            return () => "/tmp/daintree-perf/project";
          case "getGridNavigation":
            return () => ({
              findNearest: () => null,
              findByIndex: () => null,
              findDockByIndex: () => null,
              getCurrentLocation: () => null,
            });
          default:
            return () => undefined;
        }
      },
    }
  );
}

const SEEDED_WORKTREE_ID = "/tmp/daintree-perf/project/wt-1";
const SEEDED_WORKTREE_COUNT = 6;

function seedWorktrees(): unknown[] {
  return Array.from({ length: SEEDED_WORKTREE_COUNT }, (_, index) => ({
    id: `/tmp/daintree-perf/project/wt-${index}`,
    worktreeId: `/tmp/daintree-perf/project/wt-${index}`,
    path: `/tmp/daintree-perf/project/wt-${index}`,
    name: `wt-${index}`,
    branch: index === 0 ? "main" : `feature/wt-${index}`,
    isCurrent: index === 1,
    isMainWorktree: index === 0,
    mood: "stable",
    modifiedCount: index,
    lastGitStatusCheckedAt: 1_000_000,
    lastActivityTimestamp: null,
  }));
}

let viewStoreInstalled = false;

/**
 * Install the real per-view worktree store once. Several `isEnabled` /
 * `disabledReason` predicates call `getCurrentViewStore()`, which throws when no
 * store is mounted — `ActionService` catches that and fails the action closed,
 * which would quietly turn a context-sensitive predicate into a constant.
 */
function ensureViewStore(mods: ActionModules, worktrees: unknown[]): void {
  if (viewStoreInstalled) return;
  const store = mods.createWorktreeStore();
  mods.setCurrentViewStore(store);
  store.getState().applySnapshot(worktrees, { epoch: "perf", seq: 1 });
  viewStoreInstalled = true;
}

/** The `ActionContext` a fully-loaded window provides. */
export const FULL_CONTEXT: Record<string, unknown> = {
  projectId: "perf-project",
  projectName: "Perf Project",
  projectPath: "/tmp/daintree-perf/project",
  activeWorktreeId: SEEDED_WORKTREE_ID,
  activeWorktreeName: "wt-1",
  activeWorktreePath: SEEDED_WORKTREE_ID,
  activeWorktreeBranch: "feature/wt-1",
  activeWorktreeIsMain: false,
  focusedWorktreeId: SEEDED_WORKTREE_ID,
  focusedTerminalId: "perf-terminal-1",
  focusedTerminalKind: "agent",
  focusedTerminalTitle: "claude",
  isSettingsOpen: false,
};

/** The context a cold window provides before any project is open. */
export const EMPTY_CONTEXT: Record<string, unknown> = {};

// --- Probe actions ----------------------------------------------------------

export const PROBE_ECHO_ID = "perf.probe.echo";
export const PROBE_GATED_ID = "perf.probe.gated";
export const PROBE_PALETTE_ID = "perf.probe.paletteGated";
export const PROBE_CONFIRM_ID = "perf.probe.confirm";
export const PROBE_DISABLED_REASON = "Open a worktree first";
export const PROBE_PALETTE_REASON = "Open a project first";

/**
 * Actions the fixture owns, registered into the same real service as the real
 * catalog. They exist for the two things the real catalog cannot supply here:
 * a dispatch that is allowed to reach `run()`, and predicates whose correct
 * answer for a given `ActionContext` is known independently of the product.
 */
function probeDefinitions(): unknown[] {
  return [
    {
      id: PROBE_ECHO_ID,
      title: "Perf Probe Echo",
      description:
        "Harness-owned probe action used to measure the successful dispatch path end to end.",
      category: "general",
      kind: "query",
      danger: "safe",
      argsSchema: z.object({ n: z.number().int(), label: z.string().optional() }),
      resultSchema: z.object({ n: z.number(), label: z.string() }),
      run: (args: { n: number; label?: string }) => ({ n: args.n, label: args.label ?? "" }),
    },
    {
      id: PROBE_GATED_ID,
      title: "Perf Probe Gated",
      description: "Harness-owned probe action gated on the active worktree in the ActionContext.",
      category: "general",
      kind: "command",
      danger: "safe",
      isEnabled: (ctx: Record<string, unknown>) => ctx.activeWorktreeId !== undefined,
      disabledReason: () => PROBE_DISABLED_REASON,
      run: () => undefined,
    },
    {
      id: PROBE_PALETTE_ID,
      title: "Perf Probe Palette Gated",
      description: "Harness-owned probe action whose palette row requires a project in context.",
      category: "general",
      kind: "command",
      danger: "safe",
      palette: {
        mode: "requireContext",
        isReady: (ctx: Record<string, unknown>) => Boolean(ctx.projectId),
        reason: PROBE_PALETTE_REASON,
      },
      run: () => undefined,
    },
    {
      id: PROBE_CONFIRM_ID,
      title: "Perf Probe Confirm",
      description: "Harness-owned probe action that must refuse an unconfirmed agent dispatch.",
      category: "general",
      kind: "command",
      danger: "confirm",
      dangerRationale: "Probe for the confirmation gate; performs no work.",
      run: () => undefined,
    },
  ];
}

// --- Catalog ----------------------------------------------------------------

/**
 * What one definition declares about itself, read off the definition OBJECT
 * before it is handed to `register()`.
 *
 * The oracle for the MCP tool surface has to sit outside both halves of the
 * subject — `ActionService`'s zod-to-JSON-Schema compile and the main-process
 * projection that reads its output. A schema builder that emits tools with no
 * `inputSchema` and empty annotations is strictly cheaper than one that works,
 * and the advertised payload is the headline number, so a smaller payload reads
 * as an improvement. Only a declaration taken from the definitions themselves
 * can tell "we trimmed the surface" from "we stopped emitting it".
 */
export interface SurfaceExpectation {
  title: string;
  /** The definition carries an argument schema, so a JSON Schema is owed. */
  expectsInputSchema: boolean;
  /** Top-level argument names, when the schema resolves to a plain object. */
  argNames: readonly string[];
  /** `mcpOutputSchema` opted in with a result schema behind it. */
  expectsOutputSchema: boolean;
  readOnlyHint: boolean;
  idempotentHint: boolean;
  destructiveHint: boolean;
}

interface ZodShapeCarrier {
  shape?: Record<string, unknown>;
  def?: { innerType?: ZodShapeCarrier; in?: ZodShapeCarrier };
}

/**
 * Top-level argument names by structural reflection on zod's own `shape`,
 * unwrapping the `.optional()` / `.default()` / `.pipe()` layers a third of the
 * catalog wraps around its object schema.
 *
 * Deliberately NOT `z.toJSONSchema` — that is the conversion being graded, and
 * an oracle that re-runs the subject grades nothing. Schemas that resolve to no
 * object shape (an intersection, say) contribute no expectation rather than a
 * false one.
 */
function argNamesOf(schema: unknown): string[] {
  let cursor = schema as ZodShapeCarrier | undefined;
  for (let depth = 0; depth < 8 && cursor; depth += 1) {
    if (cursor.shape && typeof cursor.shape === "object") return Object.keys(cursor.shape);
    cursor = cursor.def?.innerType ?? cursor.def?.in;
  }
  return [];
}

function describeDefinition(definition: unknown): SurfaceExpectation {
  const def = definition as {
    title: string;
    kind?: string;
    danger?: string;
    argsSchema?: unknown;
    rawInputSchema?: unknown;
    mcpOutputSchema?: unknown;
    resultSchema?: unknown;
    rawOutputSchema?: unknown;
    mcpAnnotations?: {
      readOnlyHint?: boolean;
      idempotentHint?: boolean;
      destructiveHint?: boolean;
    };
  };
  const isQuery = def.kind === "query";
  return {
    title: def.title,
    expectsInputSchema: Boolean(def.argsSchema ?? def.rawInputSchema),
    argNames: def.argsSchema ? argNamesOf(def.argsSchema) : [],
    expectsOutputSchema: Boolean(def.mcpOutputSchema && (def.resultSchema ?? def.rawOutputSchema)),
    readOnlyHint: def.mcpAnnotations?.readOnlyHint ?? isQuery,
    idempotentHint: def.mcpAnnotations?.idempotentHint ?? isQuery,
    destructiveHint: def.mcpAnnotations?.destructiveHint ?? def.danger === "confirm",
  };
}

export interface CatalogService {
  /** A real `ActionService` with the real catalog registered into it. */
  service: ActionServiceLike;
  /** Actions registered, probes included. */
  actionCount: number;
  /**
   * Every id handed to `register()`, taken from the definition objects.
   *
   * The projection oracle: `list()` owes back everything that went in, and an
   * expectation derived from `list()` itself makes an empty listing vacuously
   * correct — the fastest sweep and the best slope the harness can record.
   */
  registeredIds: readonly string[];
  /** Per-id declaration, read off the definitions rather than the manifest. */
  expectations: ReadonlyMap<string, SurfaceExpectation>;
  /** Time spent building the definition objects from their factories. */
  factoryMs: number;
  /** Time spent inside `ActionService.register()` for every definition. */
  registerMs: number;
}

export interface CatalogOptions {
  /** Register the harness-owned probe actions alongside the real catalog. */
  withProbes?: boolean;
  /**
   * Register this many extra id-renamed clones of the real definitions, to price
   * how the O(n) manifest projection scales past the shipped catalog size.
   */
  clones?: number;
}

/**
 * Build a FRESH `ActionService` and register the whole real catalog into it.
 *
 * Fresh per call on purpose: both the `requiresArgs` cache and the lazy JSON
 * Schema cache are per-service, and a reused service would report a warm
 * manifest as a cold one.
 */
export function buildCatalogService(
  mods: ActionModules,
  options: CatalogOptions = {}
): CatalogService {
  const worktrees = seedWorktrees();
  ensureViewStore(mods, worktrees);

  const factories = mods.createActionDefinitions(makeCallbacks(worktrees));

  const factoryStart = performance.now();
  const definitions: unknown[] = [];
  for (const factory of factories.values()) definitions.push(factory());
  if (options.withProbes) definitions.push(...probeDefinitions());
  const clones = options.clones ?? 0;
  if (clones > 0) {
    // Same definition objects under distinct ids — `register()` recomputes
    // `requiresArgs` and `list()` re-runs every predicate for each one, so this
    // scales exactly the work the real catalog does, without inventing
    // definitions whose predicates are cheaper than the shipped ones.
    const originals = definitions.slice(0, definitions.length);
    for (let i = 0; i < clones; i += 1) {
      const source = originals[i % originals.length] as { id: string };
      definitions.push({ ...source, id: `${source.id}#perfclone${i}` });
    }
  }
  const factoryMs = performance.now() - factoryStart;

  const service = new mods.ActionService();
  const registerStart = performance.now();
  for (const definition of definitions) service.register(definition);
  const registerMs = performance.now() - registerStart;

  // The renderer wires one of these in `useActionRegistry`; without it every
  // dispatch resolves against `{}` and the enablement gate would be measured
  // against a context no window ever has.
  service.setContextProvider(() => FULL_CONTEXT);

  // Read after `registerMs` is taken: this is oracle bookkeeping and must not
  // land inside PERF-200's timed bracket.
  const registeredIds: string[] = [];
  const expectations = new Map<string, SurfaceExpectation>();
  for (const definition of definitions) {
    const id = (definition as { id: string }).id;
    registeredIds.push(id);
    expectations.set(id, describeDefinition(definition));
  }

  return {
    service,
    actionCount: definitions.length,
    registeredIds,
    expectations,
    factoryMs,
    registerMs,
  };
}

let sharedCatalogPromise: Promise<{ mods: ActionModules; catalog: CatalogService }> | null = null;

/**
 * One registered catalog reused across iterations, for scenarios that measure
 * something other than registration. The schema cache is warm after the first
 * manifest read — scenarios that need it cold build their own service.
 */
export function getSharedCatalog(): Promise<{ mods: ActionModules; catalog: CatalogService }> {
  sharedCatalogPromise ??= (async () => {
    const mods = await loadActionModules();
    return { mods, catalog: buildCatalogService(mods, { withProbes: true }) };
  })();
  return sharedCatalogPromise;
}

// --- Keyboard events --------------------------------------------------------

export interface KeyEventInit {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * A stand-in for the seven `KeyboardEvent` fields `resolveKeybinding` and
 * `normalizeKeyForBinding` read. There is no DOM here, and the resolver never
 * touches `target`, `preventDefault` or any other DOM affordance — it reads the
 * four modifier flags, `key`, `code` and `getModifierState("AltGraph")`.
 */
export function makeKeyEvent(init: KeyEventInit): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? "",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    getModifierState: () => false,
  } as unknown as KeyboardEvent;
}

/** Deterministic combo → event, matching what `eventToCombo` would produce. */
export function eventForCombo(combo: string): KeyboardEvent {
  const parts = combo.split("+");
  const key = parts[parts.length - 1]!;
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()));
  return makeKeyEvent({
    key,
    code: /^[a-zA-Z]$/.test(key) ? `Key${key.toUpperCase()}` : key,
    metaKey: modifiers.has("cmd") || modifiers.has("meta"),
    ctrlKey: modifiers.has("ctrl"),
    shiftKey: modifiers.has("shift"),
    altKey: modifiers.has("alt") || modifiers.has("option"),
  });
}

/**
 * `when`-clause context in the shape `buildKeybindingWhenContext` produces.
 * Supplied statically because the real builder reads `document` and three
 * renderer stores; the parser and evaluator that consume it are the real ones.
 */
export const WHEN_CONTEXT_TERMINAL: Record<string, unknown> = {
  terminalFocused: true,
  modalOpen: false,
  paletteOpen: false,
  paletteId: "",
  fleetArmed: true,
  fleetWaiting: false,
  sidebarVisible: true,
};

export const WHEN_CONTEXT_MODAL: Record<string, unknown> = {
  terminalFocused: false,
  modalOpen: true,
  paletteOpen: true,
  paletteId: "action",
  fleetArmed: false,
  fleetWaiting: false,
  sidebarVisible: false,
};

/**
 * Plugin-shaped bindings carrying `when` clauses. `DEFAULT_KEYBINDINGS` has
 * none — every shipped binding is unconditional — so without these the clause
 * parser, its AST cache and the lazy context resolution are dead code in the
 * resolver, which is precisely the branch a plugin-heavy session lives on.
 * Combos are chosen away from the shipped table so `registerBinding` accepts
 * them; `registeredWhenBindings` reports how many it actually took.
 */
export const WHEN_BINDINGS: ReadonlyArray<{
  actionId: string;
  combo: string;
  when: string;
  expectMatchUnder: "terminal" | "modal";
}> = [
  {
    actionId: "perf.when.terminalOnly",
    combo: "Cmd+Alt+Shift+F1",
    when: "terminalFocused && !modalOpen",
    expectMatchUnder: "terminal",
  },
  {
    actionId: "perf.when.modalOnly",
    combo: "Cmd+Alt+Shift+F2",
    when: "modalOpen && paletteId == 'action'",
    expectMatchUnder: "modal",
  },
  {
    actionId: "perf.when.fleetArmed",
    combo: "Cmd+Alt+Shift+F3",
    when: "fleetArmed && !fleetWaiting",
    expectMatchUnder: "terminal",
  },
  {
    actionId: "perf.when.sidebarHidden",
    combo: "Cmd+Alt+Shift+F4",
    when: "!sidebarVisible && paletteOpen",
    expectMatchUnder: "modal",
  },
];

export interface KeybindingHarness {
  service: KeybindingServiceLike;
  /** Bindings the resolver scans on every keydown. */
  bindingCount: number;
  /** What the real table plus the harness's own bindings add up to. */
  expectedBindingCount: number;
  /** Rows of `DEFAULT_KEYBINDINGS` the service did not take. */
  missingDefaultBindings: number;
  /** `when`-carrying bindings `registerBinding` actually accepted. */
  registeredWhenBindings: number;
}

/** Identity of a binding as the resolver scans it: action, combo and scope. */
function bindingKey(binding: KeybindingRow): string {
  return `${binding.actionId} ${binding.combo} ${binding.scope}`;
}

/**
 * A fresh `KeybindingService` with the real defaults plus the `when` bindings.
 *
 * `missingDefaultBindings` is the cardinality oracle. Every keydown is a full
 * scan, so a service that seeded a short table resolves faster on every sample
 * the scenario takes, and the probed combos — twelve of the hundred-plus in the
 * table — would keep matching. `DEFAULT_KEYBINDINGS` is the declaration the
 * service is supposed to have loaded, so reading the registered set back
 * against it is what stops an unprobed row from being free to delete.
 */
export function buildKeybindingHarness(mods: ActionModules): KeybindingHarness {
  const service = new mods.KeybindingService();
  const before = service.getAllBindings().length;
  for (const binding of WHEN_BINDINGS) {
    service.registerBinding({
      actionId: binding.actionId,
      combo: binding.combo,
      when: binding.when,
      scope: "global",
      priority: 20,
      description: "perf harness when-clause binding",
      category: "perf",
      pluginId: "perf-harness",
    });
  }
  const registered = new Set(service.getAllBindings().map(bindingKey));
  let missingDefaultBindings = 0;
  for (const binding of mods.DEFAULT_KEYBINDINGS) {
    if (!registered.has(bindingKey(binding))) missingDefaultBindings += 1;
  }
  const bindingCount = service.getAllBindings().length;
  return {
    service,
    bindingCount,
    expectedBindingCount: mods.DEFAULT_KEYBINDINGS.length + WHEN_BINDINGS.length,
    missingDefaultBindings,
    registeredWhenBindings: bindingCount - before,
  };
}
