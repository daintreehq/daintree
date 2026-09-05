import type { PanelKind, PanelLocation, TerminalInstance } from "../types/panel.js";
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
   * Whether a panel kind can live in the dock. Every registered kind is
   * dockable by default (built-in and plugin alike); set `dockable: false` to
   * opt a kind out — the explicit escape hatch for kinds with no meaningful
   * compact chip-row form. The dock render path is generic (`ContentDock`
   * renders any non-PTY dockable kind through `DockedNonPtyPanelItem`), so
   * membership follows this flag via `panelKindIsDockable` / `isDockPanel`
   * rather than a hard-coded kind list.
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
   * Version of this kind's `extensionState` schema, from
   * `contributes.panels[].stateVersion` (#12280). Absent for built-ins and for
   * plugins that never declare one, which is read as "no opinion" — the bag is
   * handed over unjudged, exactly as before versioning existed.
   *
   * The host stamps this onto the panel record whenever the plugin writes state
   * and refuses, on restore, to hand a view a bag stamped above what the
   * installed build declares. That is the whole migration contract: a plugin
   * bumping the number is telling the host that older bags need migrating, and
   * `PanelViewProps.stateVersion` tells the view which version it is reading so
   * it can do so.
   */
  stateVersion?: number;
  /**
   * Owning project, or `null`/absent for global plugin and built-in kinds. Set
   * only for kinds contributed by a project-local plugin, whose `id` is the
   * project-qualified runtime form (`project:{projectId}/{manifestId}/{kindId}`).
   */
  projectId?: string | null;
  /**
   * Manifest id of the owning plugin, split out from the qualified runtime id
   * so persistence never has to re-derive it from the `id` string. Equals
   * `extensionId` for global kinds; for project kinds it is the bare manifest
   * id, while `extensionId` may carry the scoped registration key.
   */
  pluginManifestId?: string;
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
  /**
   * Action a bare launch of this kind dispatches through, so every launcher
   * surface activates it the same way instead of each one deciding for itself
   * (#11668). The action owns target resolution, defaults and dedup; the
   * launcher only says where it wants the panel. Kinds that need nothing
   * beyond a plain panel omit this and are created through `addPanel`.
   *
   * Read via {@link resolvePanelKindLaunchActionId}, never directly — plugin
   * configs arrive over IPC, and a plugin naming an arbitrary action here
   * would turn its own launcher row into a dispatch of that action.
   */
  launchActionId?: string;
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
    launchActionId: "agent.launch",
  },
  browser: {
    id: "browser",
    name: "Browser",
    iconId: "globe",
    color: PANEL_KIND_BRAND_COLORS.browser,
    hasPty: false,
    canRestart: false,
    canConvert: false,
    // Dockable by default (no explicit flag) — a reading surface with a
    // meaningful compact chip form.
    keepAliveOnProjectSwitch: true,
    showInPalette: true,
    searchAliases: ["web", "chrome", "internet", "www"],
    firstRenderRestore: true,
    lazyImportPath: "src/components/Browser/BrowserPane.tsx",
    // Reading surface like file/review: focus returns to what the user was
    // last viewing when the panel leaves the grid, not the first grid terminal.
    policy: { dockFallbackTarget: "previous-focused" },
    launchActionId: "agent.launch",
  },
  "dev-preview": {
    id: "dev-preview",
    name: "Dev Preview",
    iconId: "monitor-play",
    color: PANEL_KIND_BRAND_COLORS["dev-preview"],
    hasPty: false,
    canRestart: false,
    canConvert: false,
    // Explicit opt-out: a live dev-server preview has no meaningful compact
    // chip-row form (like diff and review).
    dockable: false,
    usesTerminalUi: false,
    keepAliveOnProjectSwitch: true,
    showInPalette: true,
    searchAliases: ["localhost", "server", "preview", "port"],
    firstRenderRestore: true,
    lazyImportPath: "src/components/DevPreview/DevPreviewPane.tsx",
    // Not `agent.launch`: that path creates a bare preview with no command, so
    // only this one honours the project's configured dev-server command.
    launchActionId: "devServer.start",
  },
  review: {
    id: "review",
    name: "Review",
    iconId: "git-pull-request",
    color: PANEL_KIND_BRAND_COLORS.review,
    hasPty: false,
    canRestart: false,
    canConvert: false,
    // Explicit opt-out: a review surface has no meaningful compact chip-row
    // form (like diff and dev-preview).
    dockable: false,
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
    // Dockable by default (no explicit flag) — a reading surface with a
    // meaningful compact chip form.
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
    // Dockable by default (no explicit flag). The chip row is only a label, and
    // the panel itself is moved — not remounted — into the dock popover, so the
    // two-pane browser has the same room there as the file viewer (#11917).
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
    // Resolves its own browse root, composes the title, and focuses an existing
    // browser for the same folder instead of opening a second one.
    launchActionId: "worktree.openFileBrowserPanel",
  },
  diff: {
    id: "diff",
    name: "Diff Viewer",
    iconId: "file-diff",
    color: PANEL_KIND_BRAND_COLORS.diff,
    hasPty: false,
    canRestart: false,
    canConvert: false,
    // Explicit opt-out: the dock's chip row has no meaningful compact form for
    // a diff (review and dev-preview opt out for the same reason).
    dockable: false,
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
 * Reactive snapshot of the metadata registry for `useSyncExternalStore`.
 * Replaced (not mutated) on every registry change so React's `Object.is`
 * identity check schedules a rerender — `ContentDock` /
 * `DockPanelOffscreenContainer` observe it so a `dockable`-only flip or a
 * plugin unregister re-evaluates their `isDockPanel` membership without waiting
 * for an unrelated panel-store mutation (#11375). Mirrors the
 * `definitionsSnapshot` pattern in `src/panels/registry.tsx`.
 *
 * IMPORTANT: `getPanelKindRegistrySnapshot` must return this stable reference,
 * never a fresh `{ ...PANEL_KIND_REGISTRY }` per call — a new object every call
 * makes React 19's `Object.is` guard see a perpetual change and loop.
 */
let panelKindRegistrySnapshot: Readonly<Record<string, PanelKindConfig>> = {
  ...PANEL_KIND_REGISTRY,
};
const panelKindRegistryListeners = new Set<() => void>();

/**
 * Replace the snapshot with a fresh copy of the live registry and notify
 * subscribers. Called once per public mutation (a batch removal emits one
 * notification, not one per removed kind).
 */
function notifyPanelKindRegistry(): void {
  panelKindRegistrySnapshot = { ...PANEL_KIND_REGISTRY };
  for (const listener of panelKindRegistryListeners) {
    try {
      listener();
    } catch (err) {
      console.error("[panelKindRegistry] registry listener threw:", err);
    }
  }
}

/**
 * Subscribe to any metadata-registry change (register, unregister, flip).
 * Stable module-scope function so `useSyncExternalStore` never re-subscribes
 * per render.
 *
 * @returns Unsubscribe function. Safe to call multiple times.
 */
export function subscribeToPanelKindRegistry(listener: () => void): () => void {
  panelKindRegistryListeners.add(listener);
  return () => {
    panelKindRegistryListeners.delete(listener);
  };
}

/**
 * Snapshot for `useSyncExternalStore`. Returns the same reference until a
 * registration changes the registry; React uses identity comparison to detect
 * changes. Also serves as the SSR/getServerSnapshot value (identical set).
 */
export function getPanelKindRegistrySnapshot(): Readonly<Record<string, PanelKindConfig>> {
  return panelKindRegistrySnapshot;
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
  notifyPanelKindRegistry();
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
  if (removed.length > 0) {
    notifyPanelKindRegistry();
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
  notifyPanelKindRegistry();
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
 * Where a panel kind came from, as three tiers a launcher can speak about.
 * Ordered by how much the distinction costs the user: a `project-plugin` kind
 * exists only inside the project that ships it and is gone in the next one,
 * which is the surprise this classification exists to prevent (#12272).
 */
export type PanelKindOrigin = "builtin" | "plugin" | "project-plugin";

/**
 * Classify a kind's origin from the ownership fields the registry already
 * carries. Project ownership wins: a project-local kind always has an
 * `extensionId` too, so testing `projectId` second would collapse tier 3 into
 * tier 2.
 *
 * Takes the config rather than the id on purpose. The id is enough to derive
 * this (see {@link toPersistedPanelKindRef}), but every caller that needs the
 * tier is already projecting a `PanelKindConfig` into a row model, and parsing
 * it back out of the id at each render site is how the surfaces drift apart.
 */
export function getPanelKindOrigin(
  config: Pick<PanelKindConfig, "extensionId" | "projectId">
): PanelKindOrigin {
  if (config.projectId != null) return "project-plugin";
  return config.extensionId !== undefined ? "plugin" : "builtin";
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
 * Resolve the action a bare launch of this kind should dispatch through, or
 * `undefined` when the kind is created through a plain `addPanel`.
 *
 * Plugin-contributed kinds always resolve to `undefined`, whatever their config
 * declares: their `PanelKindConfig` arrives over IPC from a plugin manifest, so
 * honouring the field would let a plugin turn its own launcher row into a
 * dispatch of any action it names. Plugin panels are spawned generically
 * instead — `panel.openPluginPanel` remains the explicit, capability-gated way
 * to reach one.
 *
 * Takes the same `PanelKindConfig | PanelKind | undefined` source as
 * {@link resolvePanelKindPolicy}; sync and side-effect free.
 */
export function resolvePanelKindLaunchActionId(
  source: PanelKindConfig | PanelKind | undefined
): string | undefined {
  const config = typeof source === "string" ? getPanelKindConfig(source) : (source ?? undefined);
  if (!config || config.extensionId !== undefined) return undefined;
  return config.launchActionId;
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
 * Check if a panel kind can live in the dock. Every registered kind is
 * dockable by default (built-in and plugin alike); a kind opts out with
 * `dockable: false` (the dock chip row and offscreen host render dockable
 * kinds through `isDockPanel`). An unregistered kind is never dockable — a
 * dock request for an unknown kind would strand the panel with no chip to
 * render it (#11054).
 *
 * @param kind - The panel kind to check
 * @returns True if panels of this kind can be moved to the dock
 */
export function panelKindIsDockable(kind: PanelKind): boolean {
  const config = getPanelKindConfig(kind);
  if (!config) return false;
  return config.dockable !== false;
}

/**
 * Normalize a requested/restored panel location for a single panel of `kind`.
 * A non-dockable kind can't live in the dock — `ContentDock` filters it out via
 * `isDockPanel` while its stored `location:"dock"` keeps the grid from showing
 * it, so it would strand invisibly (#11054, #11375). Redirect the dock landing
 * to the grid; every other location passes through unchanged. This is the
 * single guard the store mutators (move, reorder, undo, trash/background
 * restore) call so a dockability flip can never leave a panel stranded.
 *
 * `kind ?? "terminal"` mirrors the legacy-PTY convention used across the
 * dockability guards — a panel with no `kind` is a legacy terminal, always
 * dockable. Sync and side-effect free: safe inside Zustand `set()` updaters.
 *
 * @returns The original location, or `"grid"` when a non-dockable kind
 *   requested the dock.
 */
export function normalizeDockLocation<TLocation extends PanelLocation>(
  kind: PanelKind | undefined,
  location: TLocation
): TLocation | "grid" {
  return location === "dock" && !panelKindIsDockable(kind ?? "terminal") ? "grid" : location;
}

/**
 * Normalize a group's target location. A tab group is atomic — every member
 * shares one location — so a dock move is all-or-nothing: if ANY live member's
 * kind is non-dockable, the whole group lands in the grid rather than splitting
 * (a mixed-location group is invisible to `getPanelGroup` and corrupts
 * persistence). Grid targets pass through unchanged.
 *
 * @param memberKinds The kinds of the group's live members (`undefined` → legacy terminal)
 * @param location The requested group location
 * @returns `"dock"` only when every member is dockable; otherwise `"grid"`
 */
export function normalizeGroupDockLocation(
  memberKinds: ReadonlyArray<PanelKind | undefined>,
  location: "grid" | "dock"
): "grid" | "dock" {
  if (location !== "dock") return location;
  return memberKinds.every((kind) => panelKindIsDockable(kind ?? "terminal")) ? "dock" : "grid";
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
  if (removed.length > 0) {
    notifyPanelKindRegistry();
  }
}

/**
 * Prefix that marks a runtime panel kind id as project-qualified. Chosen
 * because a colon cannot appear in a plugin manifest id or a
 * `contributes.panels[].id` (both are validated against
 * `[a-zA-Z0-9._-]` / the scoped-name pattern in
 * `electron/schemas/pluginIdentifiers.ts`), so no global kind can ever collide
 * with the qualified namespace.
 */
const PROJECT_PANEL_KIND_PREFIX = "project:";

/**
 * Local mirror of `SCOPED_PLUGIN_NAME_PATTERN`
 * (`electron/schemas/pluginIdentifiers.ts`), which validates every plugin
 * manifest `name`: exactly two lowercase segments joined by a single dot
 * (`acme.dashboard`, `daintree.github`). `shared/` cannot import from
 * `electron/`, so the shape is duplicated here — keep the two in sync.
 *
 * This is what makes the global runtime form parseable: a manifest id holds
 * exactly one dot, so `acme.dashboard.overview` splits deterministically into
 * `acme.dashboard` + `overview` even though BOTH halves may contain dots in
 * principle (`contributes.panels[].id` allows them).
 */
const SCOPED_MANIFEST_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The layout-schema shape for a plugin-contributed panel kind.
 *
 * Deliberately excludes `projectId`: layouts are already project-associated,
 * and embedding the project's identity would orphan every panel when a repo is
 * re-cloned to a different path.
 *
 * Not what layouts store today. `PanelSnapshot.kind` is persisted verbatim, so
 * a saved project-local panel carries the qualified runtime id
 * (`project:{projectId}/…`). That is tolerable because a project id is stable
 * for the life of an install, and a re-clone starts from a fresh layout
 * anyway — a qualified id that no longer resolves degrades to
 * `PluginMissingPanel`, which is the same outcome as an uninstalled plugin.
 * This ref and {@link toPersistedPanelKindRef} exist for the layout-schema
 * change that takes the project id off disk.
 */
export interface PersistedPanelKindRef {
  /** `"project"` for a `.daintree/plugins` contribution, `"global"` otherwise. */
  origin: "global" | "project";
  /** Plugin manifest id, e.g. `"acme.dashboard"`. */
  pluginId: string;
  /** Bare id from `contributes.panels`, e.g. `"overview"`. */
  kindId: string;
}

/**
 * Qualify a persisted ref into the runtime panel kind id used as the registry
 * key and as `TerminalInstance.kind`.
 *
 * - `origin: "global"` → `{pluginId}.{kindId}`, byte-identical to the id
 *   `PluginService` registers today. Global kinds ignore `projectId`.
 * - `origin: "project"` → `project:{projectId}/{pluginId}/{kindId}`, so two
 *   projects can each contribute `acme.dashboard/overview` without colliding.
 *
 * Returns `null` for a project ref with no owning project: that ref cannot be
 * resolved in this context, and inventing an unqualified id for it would alias
 * a project kind onto a global one. Callers treat `null` the same way they
 * treat an unregistered kind — the panel renders `PluginMissingPanel` and is
 * retained, never dropped.
 */
export function toRuntimePanelKindId(
  ref: PersistedPanelKindRef,
  projectId: string | null
): string | null {
  if (ref.pluginId.length === 0 || ref.kindId.length === 0) return null;
  // A slash is the project form's delimiter and cannot appear in a validated
  // manifest id or panel id. Qualifying a ref that contains one would emit an
  // id that parses back into a different ref (the extra slash steals a
  // segment), so refuse it rather than mint a corrupt id.
  if (ref.pluginId.includes("/") || ref.kindId.includes("/")) return null;
  if (ref.origin !== "project") return `${ref.pluginId}.${ref.kindId}`;
  if (projectId === null || projectId.length === 0) return null;
  return `${PROJECT_PANEL_KIND_PREFIX}${projectId}/${ref.pluginId}/${ref.kindId}`;
}

/**
 * The project a runtime panel kind id belongs to, or `null` for a global kind.
 *
 * Manifest ids and panel ids cannot contain `/`, so the last two slashes
 * delimit `{pluginId}/{kindId}` and everything between the prefix and them is
 * the project id — which may itself contain slashes, since a project id is a
 * UUID or a path hash.
 *
 * Main uses this to check that a renderer asking to activate a kind actually
 * belongs to the project that owns it.
 */
export function projectIdFromRuntimePanelKindId(kind: PanelKind): string | null {
  if (!isProjectQualifiedPanelKindId(kind)) return null;
  const rest = (kind as string).slice(PROJECT_PANEL_KIND_PREFIX.length);
  const lastSlash = rest.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const secondLastSlash = rest.lastIndexOf("/", lastSlash - 1);
  if (secondLastSlash <= 0) return null;
  const projectId = rest.slice(0, secondLastSlash);
  return projectId.length > 0 ? projectId : null;
}

/**
 * Whether a runtime panel kind id carries a project qualification.
 *
 * Used by the plugin IPC guard to tell a malformed `project:` id from a global
 * one, so an id that fails to parse cannot skip the owning-project check.
 * Persistence does not consult it yet — see {@link PersistedPanelKindRef}.
 */
export function isProjectQualifiedPanelKindId(kind: PanelKind): boolean {
  return typeof kind === "string" && kind.startsWith(PROJECT_PANEL_KIND_PREFIX);
}

/**
 * Unqualify a runtime panel kind id back into the form a layout persists.
 * Returns `null` for anything that is not a plugin-contributed kind (a
 * built-in like `"terminal"`, or a malformed id).
 *
 * Pass `pluginManifestId` whenever the caller already knows it —
 * `PanelKindConfig.extensionId` at registration, `PanelSnapshot.pluginId` at
 * save/restore. It is authoritative and makes the split exact for any manifest
 * id, including shapes that predate the scoped-name rule.
 *
 * Without the hint the parse is still deterministic:
 * - Project form: manifest ids and panel ids cannot contain `/`, so the last
 *   two slashes delimit `{pluginId}/{kindId}` and everything before them is the
 *   project id (which may itself contain slashes — a project id is "UUID or
 *   path hash").
 * - Global form: a validated manifest id holds exactly one dot, so the first
 *   two dot-segments are the plugin id when they match
 *   {@link SCOPED_MANIFEST_ID_PATTERN}. Splitting on the FIRST dot
 *   (`daintree` + `github.prs`) or the LAST (`acme.dashboard.sales` +
 *   `report` for kind id `sales.report`) both silently corrupt the id.
 *
 * The string round-trip is lossless in both directions for the global form
 * regardless of where the split lands, because re-qualifying rejoins on the
 * same dot. The ref round-trip (`ref → id → ref`) needs the hint only for a
 * kind id that itself contains a dot under a non-scoped manifest id.
 */
export function toPersistedPanelKindRef(
  runtimeId: string,
  pluginManifestId?: string
): PersistedPanelKindRef | null {
  if (typeof runtimeId !== "string" || runtimeId.length === 0) return null;

  if (runtimeId.startsWith(PROJECT_PANEL_KIND_PREFIX)) {
    const rest = runtimeId.slice(PROJECT_PANEL_KIND_PREFIX.length);
    const lastSlash = rest.lastIndexOf("/");
    if (lastSlash <= 0) return null;
    const pluginSlash = rest.lastIndexOf("/", lastSlash - 1);
    if (pluginSlash <= 0) return null;
    const pluginId = rest.slice(pluginSlash + 1, lastSlash);
    const kindId = rest.slice(lastSlash + 1);
    if (pluginId.length === 0 || kindId.length === 0) return null;
    return { origin: "project", pluginId, kindId };
  }

  if (
    pluginManifestId !== undefined &&
    pluginManifestId.length > 0 &&
    runtimeId.startsWith(`${pluginManifestId}.`)
  ) {
    const kindId = runtimeId.slice(pluginManifestId.length + 1);
    if (kindId.length > 0) {
      return { origin: "global", pluginId: pluginManifestId, kindId };
    }
  }

  const segments = runtimeId.split(".");
  const [scopeSegment, nameSegment] = segments;
  if (scopeSegment === undefined || nameSegment === undefined) return null;
  if (segments.length > 2 && SCOPED_MANIFEST_ID_PATTERN.test(`${scopeSegment}.${nameSegment}`)) {
    return {
      origin: "global",
      pluginId: `${scopeSegment}.${nameSegment}`,
      kindId: segments.slice(2).join("."),
    };
  }
  // `SAFE_ID_PATTERN` permits leading, trailing and repeated dots in a panel
  // id, so an empty segment after the plugin id is legal and must survive the
  // round-trip (`acme.dashboard..overview`). Only an empty plugin id or an
  // empty kind id is unparseable.
  const kindId = segments.slice(1).join(".");
  if (scopeSegment.length === 0 || kindId.length === 0) return null;
  return { origin: "global", pluginId: scopeSegment, kindId };
}
