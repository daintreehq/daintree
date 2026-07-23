import type { PanelKind, TerminalInstance } from "../types/panel.js";
import type { TerminalSnapshot } from "../types/project.js";
import type { AddPanelOptions } from "../types/addPanelOptions.js";
import { getAgentConfig } from "./agentRegistry.js";
import { PANEL_KIND_BRAND_COLORS } from "../theme/index.js";

/**
 * Single source of truth for the set of built-in panel kinds. Adding a fourth
 * built-in kind is a one-line change here — every guard and registry helper
 * derives from this array.
 */
export const BUILT_IN_PANEL_KINDS = [
  "terminal",
  "browser",
  "dev-preview",
  "review",
  "file",
  "file-browser",
  "diff",
] as const;

/** Built-in panel kinds — derived from `BUILT_IN_PANEL_KINDS` */
export type BuiltInPanelKind = (typeof BUILT_IN_PANEL_KINDS)[number];

/**
 * Where the focus fallback should look when the focused panel is removed
 * (trashed, moved to dock). `"first-grid"` is today's behavior — pick the
 * first remaining grid panel of the active worktree. `"previous-focused"`
 * restores focus to whatever `previousFocusedId` points at (if still a valid
 * grid panel), falling back to first-grid otherwise.
 *
 * Open union — extensions may register custom fallback strategies; unknown
 * values are treated as `"first-grid"` so a misconfigured plugin can't strand
 * focus.
 */
export type PanelKindDockFallbackTarget = "first-grid" | "previous-focused" | (string & {});

/**
 * Type stub for a future field that will control what happens when a panel is
 * closed (trashed vs. moved to dock). Wired into `PanelKindPolicy` so the
 * shape is forward-compatible; no behavioral wiring exists yet.
 */
export type PanelKindCloseBehavior = "trash" | "dock" | (string & {});

/**
 * Per-kind dock/focus policy. All fields are optional — kinds that omit a
 * field fall back to the matching `DEFAULT_PANEL_KIND_POLICY` value, which
 * encodes today's behavior. Kinds that omit the whole `policy` block are
 * indistinguishable from kinds that set `policy: {}`.
 */
export interface PanelKindPolicy {
  /**
   * Where focus lands when this kind's panel was focused and is then removed
   * from the grid (trashed, moved to dock). Default: `"first-grid"`.
   */
  dockFallbackTarget?: PanelKindDockFallbackTarget;
  /**
   * Whether spawning this kind into the grid should steal keyboard focus to
   * the new panel. Used as the default when no caller-supplied override is
   * provided. Default: `true` (today's behavior — newly added grid panels
   * become focused).
   */
  defaultFocusOnCreate?: boolean;
  /**
   * Whether spawning this kind into the dock with `activateDockOnCreate`
   * should open the dock popover (mount the panel UI and steal focus to it).
   * Mirrors the MCP suppression path. Default: `true`.
   */
  dockPopoverOnSpawn?: boolean;
  /**
   * Stubbed for forward-compatibility. Not wired yet. Default: `"trash"`.
   */
  closeBehavior?: PanelKindCloseBehavior;
}

/**
 * Default policy values applied when a kind omits a `policy` field (or omits
 * the whole `policy` block). Captures today's universal behavior so the
 * additive policy descriptor is a strict superset.
 */
export const DEFAULT_PANEL_KIND_POLICY: Required<PanelKindPolicy> = {
  dockFallbackTarget: "first-grid",
  defaultFocusOnCreate: true,
  dockPopoverOnSpawn: true,
  closeBehavior: "trash",
};

/**
 * Configuration for a panel kind.
 * Extensions can register new panel kinds with custom configurations.
 */
export interface PanelKindConfig {
  /** Unique identifier for this panel kind */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Icon identifier (for TerminalIcon/PanelIcon component) */
  iconId: string;
  /** Brand/accent color */
  color: string;
  /** Whether this panel kind uses a PTY process */
  hasPty: boolean;
  /** Whether this panel kind can be restarted */
  canRestart: boolean;
  /** Whether this panel kind can convert to/from other types */
  canConvert: boolean;
  /**
   * Whether a non-PTY kind can live in the dock. PTY kinds are always
   * dockable; setting this opts a non-PTY kind into dock membership. The
   * dock render path must have a chip for the kind (see `ContentDock`) —
   * `DockPanelData` in shared/types/panel.ts is the type-level twin of this
   * flag and the two must stay in sync.
   */
  dockable?: boolean;
  /**
   * Whether the dialog presentation uses a fixed near-full height instead of
   * sizing to content. For browsing surfaces whose content height varies with
   * every interaction (expanding a folder, opening a file), a content-sized
   * dialog visibly grows and shrinks under the user; pinning the surface keeps
   * it still even when the tree doesn't fill it.
   */
  dialogFullHeight?: boolean;
  /** Whether this panel kind uses the standard terminal UI */
  usesTerminalUi?: boolean;
  /** Whether this panel kind should keep its runtime alive across project switches */
  keepAliveOnProjectSwitch?: boolean;
  /**
   * Whether this panel kind's lazy chunk loads on the first-render path — i.e.
   * a persisted panel of this kind restores synchronously from session state,
   * pulling its `React.lazy()` chunk into the first-paint download. Drives the
   * first-render chunk budget seed list (see `getFirstRenderSeeds`).
   */
  firstRenderRestore?: boolean;
  /**
   * Root-relative source path of this kind's lazy boundary, in the exact form
   * Vite/Rolldown emits as a manifest key (e.g. `"src/panels/review/ReviewPane.tsx"`).
   * Required when `firstRenderRestore` is true so the budget script can resolve
   * the chunk in `dist/.vite/manifest.json`. Must match the manifest key — a
   * file-relative path like `"./review/ReviewPane"` will silently miss.
   */
  lazyImportPath?: string;
  /** Whether this panel kind should appear in the panel palette (⌘⇧P). Set to false for panels with dedicated spawn actions (terminal, agent). Defaults to true for extension panels if not specified. */
  showInPalette?: boolean;
  /** Extension ID if this is an extension-provided panel kind */
  extensionId?: string;
  /**
   * Fully-resolved `plugin://{pluginId}/{path}` URL of the React module that
   * renders this kind. Set during `loadPlugin` when a `views`
   * entry matches a panel by bare id. Travels through the existing
   * `plugin:panel-kinds-changed` broadcast so the renderer can lazy-import the
   * module without a separate IPC call. Absent for PTY-backed plugin panels
   * (rendered through `TerminalPane`) and for plugin panels without a matching
   * view contribution (rendered through `PluginMissingPanel`).
   */
  componentPath?: string;
  /** Keyboard shortcut (optional) */
  shortcut?: string;
  /** Search aliases for fuzzy matching in the panel palette */
  searchAliases?: string[];
  /** Serialize kind-specific fields from a panel instance into a snapshot fragment */
  serialize?: (panel: TerminalInstance) => Partial<TerminalSnapshot>;
  /**
   * Factory that returns kind-specific fields for a new panel instance.
   * Common fields (id, title, location, worktreeId, isVisible, runtimeStatus, extensionState)
   * are injected by addTerminal — this only returns the kind-specific diff.
   * Optional: unregistered/extension kinds fall back to getExtensionFallbackDefaults.
   */
  createDefaults?: (options: AddPanelOptions) => Partial<TerminalInstance>;
  /**
   * Per-kind dock/focus policy. See `PanelKindPolicy` for fields. Omitting
   * this (or setting it to `{}`) preserves the universal default behavior
   * encoded in `DEFAULT_PANEL_KIND_POLICY`.
   */
  policy?: PanelKindPolicy;
}

/**
 * Registry of panel kind configurations.
 * Built-in kinds are registered at startup with metadata only.
 * Serialize and createDefaults hooks are injected by the renderer
 * via initBuiltInPanelKinds() in src/panels/registry.tsx.
 * Extensions can register additional kinds at runtime.
 */
const PANEL_KIND_REGISTRY: Record<string, PanelKindConfig> = {
  terminal: {
    id: "terminal",
    name: "Terminal",
    iconId: "terminal",
    color: PANEL_KIND_BRAND_COLORS.terminal,
    hasPty: true,
    canRestart: true,
    canConvert: true,
    keepAliveOnProjectSwitch: true,
    showInPalette: false,
  },
  browser: {
    id: "browser",
    name: "Browser",
    iconId: "globe",
    color: PANEL_KIND_BRAND_COLORS.browser,
    hasPty: false,
    canRestart: false,
    canConvert: false,
    dockable: true,
    keepAliveOnProjectSwitch: true,
    showInPalette: true,
    searchAliases: ["web", "chrome", "internet", "www"],
    firstRenderRestore: true,
    lazyImportPath: "src/components/Browser/BrowserPane.tsx",
    // Reading surface like file/review: focus returns to what the user was
    // last viewing when the panel leaves the grid, not the first grid terminal.
    policy: { dockFallbackTarget: "previous-focused" },
  },
  "dev-preview": {
    id: "dev-preview",
    name: "Dev Preview",
    iconId: "monitor-play",
    color: PANEL_KIND_BRAND_COLORS["dev-preview"],
    hasPty: false,
    canRestart: false,
    canConvert: false,
    usesTerminalUi: false,
    keepAliveOnProjectSwitch: true,
    showInPalette: true,
    searchAliases: ["localhost", "server", "preview", "port"],
    firstRenderRestore: true,
    lazyImportPath: "src/components/DevPreview/DevPreviewPane.tsx",
  },
  review: {
    id: "review",
    name: "Review",
    iconId: "git-pull-request",
    color: PANEL_KIND_BRAND_COLORS.review,
    hasPty: false,
    canRestart: false,
    canConvert: false,
    usesTerminalUi: false,
    keepAliveOnProjectSwitch: true,
    showInPalette: true,
    searchAliases: ["diff", "commit", "stage", "git"],
    firstRenderRestore: true,
    lazyImportPath: "src/panels/review/ReviewPane.tsx",
    // Review is a reading surface: when the user moves it to the dock or
    // trashes it, send focus back to whatever they were last reading rather
    // than handing focus to the first grid terminal in the worktree.
    policy: { dockFallbackTarget: "previous-focused" },
  },
  file: {
    id: "file",
    name: "File Viewer",
    iconId: "file-text",
    color: PANEL_KIND_BRAND_COLORS.file,
    hasPty: false,
    canRestart: false,
    canConvert: false,
    dockable: true,
    usesTerminalUi: false,
    keepAliveOnProjectSwitch: true,
    showInPalette: true,
    searchAliases: ["file", "md", "markdown", "readme", "docs", "spec", "document", "viewer"],
    firstRenderRestore: true,
    lazyImportPath: "src/panels/file/FilePane.tsx",
    // Reading surface like review: focus returns to what the user was last
    // reading when the panel leaves the grid.
    policy: { dockFallbackTarget: "previous-focused" },
  },
  "file-browser": {
    id: "file-browser",
    name: "File Browser",
    iconId: "folder-tree",
    color: PANEL_KIND_BRAND_COLORS["file-browser"],
    hasPty: false,
    canRestart: false,
    canConvert: false,
    // Not dockable: the dock chip row shows one compact title per panel, and a
    // two-pane browser has no meaningful compact form (review, diff and
    // dev-preview are non-dockable reading surfaces for the same reason).
    dialogFullHeight: true,
    usesTerminalUi: false,
    keepAliveOnProjectSwitch: true,
    // Spawnable from a bare palette entry: unlike diff and file, the browser
    // needs no target beyond the worktree it opens against.
    showInPalette: true,
    searchAliases: ["files", "browse", "explorer", "tree", "folder", "finder", "assets"],
    firstRenderRestore: true,
    lazyImportPath: "src/panels/file-browser/FileBrowserPane.tsx",
    // Reading surface like review, file and diff: focus returns to what the
    // user was last reading when the panel leaves the grid.
    policy: { dockFallbackTarget: "previous-focused" },
  },
  diff: {
    id: "diff",
    name: "Diff Viewer",
    iconId: "file-diff",
    color: PANEL_KIND_BRAND_COLORS.diff,
    hasPty: false,
    canRestart: false,
    canConvert: false,
    // Not dockable: the dock's chip row has no meaningful compact form for a
    // diff (review and dev-preview are non-dockable reading surfaces too).
    // Pin the dialog at the max height rather than sizing to content, so
    // stepping between files doesn't resize and re-center the whole frame
    // under the cursor (#11364) — same treatment as the file browser.
    dialogFullHeight: true,
    usesTerminalUi: false,
    keepAliveOnProjectSwitch: true,
    // Opened against a specific file, so there is nothing sensible to spawn
    // from a bare palette entry — the entry points all carry a file with them.
    showInPalette: false,
    searchAliases: ["diff", "changes", "compare", "review"],
    firstRenderRestore: true,
    lazyImportPath: "src/panels/diff/DiffPane.tsx",
    // Reading surface like review and file: focus returns to what the user was
    // last reading when the panel leaves the grid.
    policy: { dockFallbackTarget: "previous-focused" },
  },
};

/**
 * Default fields for extension panel kinds that don't provide a createDefaults factory.
 */
export function getExtensionFallbackDefaults(): Partial<TerminalInstance> {
  return {};
}

/**
 * Listener sets for plugin-owned registration events. Built-in kinds (no
 * `extensionId`) are registered at module load before any subscriber exists,
 * so they are deliberately excluded — emitting for them would produce noise
 * with no listeners and force consumers to filter on every dispatch.
 *
 * Kept as plain Sets rather than Node `EventEmitter` so this module stays
 * browser-safe (the renderer imports it with no `events` polyfill).
 */
type RegisterListener = (config: PanelKindConfig) => void;
type UnregisterListener = (kindId: string) => void;

const registerListeners = new Set<RegisterListener>();
const unregisterListeners = new Set<UnregisterListener>();

/**
 * Subscribe to plugin panel kind registrations. Fires once per
 * `registerPanelKind` call where the config has an `extensionId`. Built-in
 * kinds are intentionally not emitted.
 *
 * @returns Unsubscribe function. Safe to call multiple times.
 */
export function onPanelKindRegistered(listener: RegisterListener): () => void {
  registerListeners.add(listener);
  return () => {
    registerListeners.delete(listener);
  };
}

/**
 * Subscribe to plugin panel kind unregistrations. Fires once per kind
 * removed by `unregisterPluginPanelKinds` — N fires for N removed kinds.
 *
 * @returns Unsubscribe function. Safe to call multiple times.
 */
export function onPanelKindUnregistered(listener: UnregisterListener): () => void {
  unregisterListeners.add(listener);
  return () => {
    unregisterListeners.delete(listener);
  };
}

function emitRegistered(config: PanelKindConfig): void {
  for (const listener of registerListeners) {
    try {
      listener(config);
    } catch (err) {
      console.error(`[panelKindRegistry] register listener threw for "${config.id}":`, err);
    }
  }
}

function emitUnregistered(kindId: string): void {
  for (const listener of unregisterListeners) {
    try {
      listener(kindId);
    } catch (err) {
      console.error(`[panelKindRegistry] unregister listener threw for "${kindId}":`, err);
    }
  }
}

/**
 * Register a new panel kind configuration.
 * Used by extensions to add custom panel types.
 *
 * @param config - The panel kind configuration to register
 */
export function registerPanelKind(config: PanelKindConfig): void {
  const existing = PANEL_KIND_REGISTRY[config.id];
  if (existing && existing.extensionId === undefined && config.extensionId !== undefined) {
    console.error(
      `[panelKindRegistry] Refusing to overwrite built-in panel kind "${config.id}" with extension "${config.extensionId}"`
    );
    return;
  }
  if (existing) {
    console.warn(`Panel kind "${config.id}" already registered, overwriting`);
  }
  PANEL_KIND_REGISTRY[config.id] = config;
  if (config.extensionId !== undefined) {
    emitRegistered(config);
  }
}

/**
 * Unregister all panel kinds owned by a given plugin.
 * Only removes entries whose `extensionId` matches. Built-in panel kinds
 * have no `extensionId` and will never match a real plugin ID. The input
 * guard rejects empty or non-string pluginIds so a caller that accidentally
 * passes `undefined` (via a type cast or JS-side mistake) cannot match
 * built-in entries whose `extensionId` is also `undefined`.
 *
 * @param pluginId - The plugin whose contributed panel kinds should be removed
 */
export function unregisterPluginPanelKinds(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  const removed: string[] = [];
  for (const [key, config] of Object.entries(PANEL_KIND_REGISTRY)) {
    if (config.extensionId === pluginId) {
      delete PANEL_KIND_REGISTRY[key];
      removed.push(key);
    }
  }
  for (const key of removed) {
    emitUnregistered(key);
  }
}

/**
 * Remove a single plugin-contributed panel kind. Built-in kinds (entries
 * without an `extensionId`) are protected — passing a built-in id is a
 * no-op so a buggy caller cannot strip the registry of its bootstrap state.
 *
 * @param kindId - The panel kind ID to remove
 * @returns true if a plugin entry was removed, false otherwise
 */
export function unregisterPanelKind(kindId: string): boolean {
  if (typeof kindId !== "string" || kindId.length === 0) return false;
  const config = PANEL_KIND_REGISTRY[kindId];
  if (!config || config.extensionId === undefined) return false;
  delete PANEL_KIND_REGISTRY[kindId];
  emitUnregistered(kindId);
  return true;
}

/**
 * Get the configuration for a panel kind.
 *
 * @param kind - The panel kind to look up
 * @returns The panel kind configuration, or undefined if not registered
 */
export function getPanelKindConfig(kind: PanelKind): PanelKindConfig | undefined {
  return PANEL_KIND_REGISTRY[kind];
}

/**
 * Resolve a panel kind's policy, layering its declared `policy` block over
 * `DEFAULT_PANEL_KIND_POLICY`. Returns a fully-populated `Required<PanelKindPolicy>`
 * so callers can read fields without an undefined check.
 *
 * Pass either a `PanelKindConfig` (skip the registry lookup when the caller
 * already has the entry) or a `PanelKind` (does the lookup). An unknown kind
 * resolves to the default policy.
 *
 * Sync, side-effect free, and safe to call from inside Zustand `set()`
 * updaters — the registry is a module-level synchronous map.
 */
export function resolvePanelKindPolicy(
  source: PanelKindConfig | PanelKind | undefined
): Required<PanelKindPolicy> {
  const config = typeof source === "string" ? getPanelKindConfig(source) : (source ?? undefined);
  return { ...DEFAULT_PANEL_KIND_POLICY, ...(config?.policy ?? {}) };
}

/**
 * Get all registered panel kind IDs.
 *
 * @returns Array of registered panel kind IDs
 */
export function getPanelKindIds(): string[] {
  return Object.keys(PANEL_KIND_REGISTRY);
}

/**
 * Get all panel kind configurations contributed by plugins (entries with an
 * `extensionId`). Built-in kinds are excluded. Used by the IPC bridge to
 * snapshot plugin state for renderer pull-on-mount and broadcast pushes.
 */
export function getPluginPanelKinds(): PanelKindConfig[] {
  return Object.values(PANEL_KIND_REGISTRY).filter((config) => config.extensionId !== undefined);
}

/**
 * Check if a panel kind is registered.
 *
 * @param kind - The panel kind to check
 * @returns True if the panel kind is registered
 */
export function isRegisteredPanelKind(kind: PanelKind): boolean {
  return kind in PANEL_KIND_REGISTRY;
}

/**
 * Get the default title for a panel based on its kind and optional agent ID.
 *
 * @param kind - The panel kind
 * @param agentId - Optional agent ID; when present on a PTY panel, the agent's
 *   display name takes precedence over the kind's default title
 * @returns The default title for the panel
 */
export function getDefaultPanelTitle(kind: PanelKind, agentId?: string): string {
  // Agent identity (via agentId) takes precedence over the generic kind title.
  if (agentId) {
    const agentConfig = getAgentConfig(agentId);
    if (agentConfig) return agentConfig.name;
  }

  // Look up in panel kind registry
  const config = getPanelKindConfig(kind);
  if (config) return config.name;

  // Fallback for unknown kinds: capitalize first letter
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * Get the color for a panel based on its kind and optional agent ID.
 *
 * @param kind - The panel kind
 * @param agentId - Optional agent ID; when present on a PTY panel, the agent's
 *   brand color takes precedence over the kind's default color
 * @returns The hex color for the panel
 */
export function getPanelKindColor(kind: PanelKind, agentId?: string): string {
  // Agent identity (via agentId) takes precedence over the generic kind color.
  if (agentId) {
    const agentConfig = getAgentConfig(agentId);
    if (agentConfig) return agentConfig.color;
  }

  // Look up in panel kind registry
  const config = getPanelKindConfig(kind);
  if (config) return config.color;

  // Neutral fallback for unrecognized kinds — avoids visually impersonating
  // a built-in (terminal teal) for an unknown extension panel.
  return "var(--theme-text-secondary)";
}

/**
 * Check if a panel kind requires a PTY process.
 *
 * @param kind - The panel kind to check
 * @returns True if the panel kind uses PTY
 */
export function panelKindHasPty(kind: PanelKind): boolean {
  const config = getPanelKindConfig(kind);
  return config?.hasPty ?? false;
}

/**
 * Check if a panel kind can live in the dock. PTY kinds always can; non-PTY
 * kinds opt in via `dockable` (the dock chip row and offscreen host render
 * them through `isDockPanel`).
 *
 * @param kind - The panel kind to check
 * @returns True if panels of this kind can be moved to the dock
 */
export function panelKindIsDockable(kind: PanelKind): boolean {
  const config = getPanelKindConfig(kind);
  if (!config) return false;
  return config.hasPty || config.dockable === true;
}

/**
 * Check if a panel kind can be restarted via the UI.
 * Uses the panel kind registry's canRestart property as the source of truth.
 *
 * This indicates the panel kind's restart capability at the architecture level.
 * UI components should still gate restart affordances on both this capability flag
 * AND the availability of an onRestart handler for the specific panel instance.
 *
 * @param kind - The panel kind to check
 * @returns True if the panel kind supports restart, false otherwise (including unregistered kinds)
 *
 * @example
 * // Terminal panels can be restarted (agent terminals are just terminals with agentId set)
 * panelKindCanRestart('terminal') // true
 *
 * // Browser panels cannot be restarted
 * panelKindCanRestart('browser')  // false
 *
 * // Dev-preview panels manage their own restart internally
 * panelKindCanRestart('dev-preview') // false
 *
 * @example
 * // UI usage - gate on both capability and handler
 * const canRestart = panelKindCanRestart(kind);
 * {canRestart && onRestart && <button onClick={onRestart}>Restart</button>}
 */
export function panelKindCanRestart(kind: PanelKind): boolean {
  const config = getPanelKindConfig(kind);
  return config?.canRestart ?? false;
}

/**
 * Check if a panel kind uses the standard terminal UI.
 */
export function panelKindUsesTerminalUi(kind: PanelKind): boolean {
  const config = getPanelKindConfig(kind);
  if (!config) return false;
  return config.usesTerminalUi ?? config.hasPty;
}

/**
 * Check if a panel kind should keep its runtime alive across project switches.
 */
export function panelKindKeepsAliveOnProjectSwitch(kind: PanelKind): boolean {
  const config = getPanelKindConfig(kind);
  if (!config) return false;
  return config.keepAliveOnProjectSwitch ?? config.hasPty;
}

/**
 * Get all built-in panel kinds.
 */
export function getBuiltInPanelKinds(): BuiltInPanelKind[] {
  return [...BUILT_IN_PANEL_KINDS];
}

/**
 * Source paths of every panel kind whose lazy chunk loads on the first-render
 * path (`firstRenderRestore === true`). This is the single source of truth for
 * the first-render chunk budget seed list — a build-time Vite plugin emits the
 * result to `dist/.vite/first-render-seeds.json`, which the budget script reads
 * (it can't import this TS module directly from plain Node ESM).
 *
 * Only built-in kinds are eligible: plugin-registered panels are runtime-async
 * (their chunks are never part of the first-paint download) and are excluded by
 * design. A misconfigured built-in — `firstRenderRestore: true` with a missing
 * or empty `lazyImportPath` — throws rather than silently dropping the seed,
 * since a dropped seed is exactly the budget drift this guard exists to catch.
 *
 * @returns Root-relative source paths matching Vite manifest keys
 */
export function getFirstRenderSeeds(): string[] {
  const seeds: string[] = [];
  for (const config of Object.values(PANEL_KIND_REGISTRY)) {
    if (config.firstRenderRestore !== true) continue;
    if (config.extensionId !== undefined) continue;
    if (typeof config.lazyImportPath !== "string" || config.lazyImportPath.length === 0) {
      throw new Error(
        `[panelKindRegistry] panel kind "${config.id}" sets firstRenderRestore but is missing lazyImportPath`
      );
    }
    seeds.push(config.lazyImportPath);
  }
  return seeds;
}

/**
 * The renderer entry (`src/main.tsx`) is a thin bootstrap shell that immediately
 * `await import("./App")`s the real app root. Because App sits behind that
 * dynamic-import boundary it is NOT part of the entry's static closure, so Vite
 * never auto-preloads it and — until this seed existed — the first-render budget
 * never measured it, even though every cold boot needs App (the build's largest
 * chunk) unconditionally before first interactive.
 */
export const FIRST_RENDER_ROOT_SEED = "src/App.tsx";

/**
 * The full first-render seed set: the app root plus every `firstRenderRestore`
 * panel chunk. BOTH consumers of the first-render closure read this single
 * accessor — the `<link rel="modulepreload">` injection and the build-time seed
 * artifact the budget gate measures — so the preloaded set and the gated set are
 * derived from the same seeds and cannot drift (#9771). Kept separate from
 * {@link getFirstRenderSeeds} so that function stays the registry's own contract.
 *
 * @returns Root-relative source paths matching Vite manifest keys
 */
export function getFirstRenderPreloadSeeds(): string[] {
  return [FIRST_RENDER_ROOT_SEED, ...getFirstRenderSeeds()];
}

/**
 * Remove all extension-contributed panel kinds while preserving built-ins.
 *
 * Built-in entries have no `extensionId` field, so this deletes only entries
 * registered via plugins. Intended for test cleanup — in a singleFork Vitest
 * pool the module-level registry persists across tests, so integration tests
 * must clear extension entries between cases.
 */
export function clearPanelKindRegistry(): void {
  const removed: string[] = [];
  for (const [key, config] of Object.entries(PANEL_KIND_REGISTRY)) {
    if (config.extensionId !== undefined) {
      delete PANEL_KIND_REGISTRY[key];
      removed.push(key);
    }
  }
  for (const key of removed) {
    emitUnregistered(key);
  }
}
