// SDK BOUNDARY: New imports from ./forge.js must be classified in
// shared/types/plugin-sdk.ts. See docs/plugins/architecture.md#sdk-surface.
// eslint-disable-next-line no-restricted-imports -- existing forge imports are classified; the lint guard covers new additions
import type {
  FileDecorationContribution,
  FileDecorationProviderDescriptor,
  FileDecorationProviderImpl,
  ForgeProviderContribution,
  ForgeProviderDescriptor,
  ForgeProviderImpl,
  NormalizedPRState,
  ResourceRef,
} from "./forge.js";
import type { NotificationType } from "./notification.js";
import type {
  ActionDispatchResult,
  ActionId,
  PluginActionManifestEntry,
  PluginCanDispatchResult,
} from "./actions.js";
import type { AgentState, WaitingReason } from "./agent.js";
import type { AgentDetectionConfig } from "../config/agentRegistry.js";
import type { z } from "zod";

export interface PanelContribution {
  id: string;
  name: string;
  iconId: string;
  color: string;
  hasPty: boolean;
  canRestart: boolean;
  canConvert: boolean;
  showInPalette: boolean;
  /**
   * Whether this panel kind can live in the dock. Dockable by default; set
   * `false` to opt out (for a kind with no meaningful compact chip-row form).
   */
  dockable?: boolean;
}

export interface ToolbarButtonContribution {
  id: string;
  label: string;
  iconId: string;
  actionId: ActionId;
  priority?: 1 | 2 | 3 | 4 | 5;
}

/**
 * Semantic color for a {@link PluginPanelBadge}. Plugins pick intent, not a raw
 * hex value, so badges stay theme-consistent. `"warning"` and `"error"` map to
 * the app's status palette; `"default"` is the neutral accent-free tint.
 *
 * `"success"` does NOT render green. A badge stands for as long as the plugin
 * leaves it there, and the host cannot know what a given plugin means by
 * success, so it renders as emphasis on the neutral ramp instead of a health
 * hue (#12002) — still visually distinct from `"default"`, just not green.
 */
export type PluginPanelBadgeColor = "default" | "success" | "warning" | "error";

/**
 * A small live indicator a plugin overlays on a panel's title chrome via
 * {@link PluginHostApi.setPanelBadge}, keyed by panel id. Lets per-worktree /
 * per-agent state (notes present, CI pass/fail, review status) surface without
 * opening the panel. Two shapes: a bare status `dot`, or a short `label`
 * (text capped at 6 characters host-side so it can't overflow the header).
 */
export type PluginPanelBadge =
  | { kind: "dot"; color?: PluginPanelBadgeColor; tooltip?: string }
  | { kind: "label"; text: string; color?: PluginPanelBadgeColor; tooltip?: string };

/** Max length of a {@link PluginPanelBadge} `label` text, enforced host-side. */
export const PLUGIN_PANEL_BADGE_LABEL_MAX = 6;

export type MenuItemLocation = "terminal" | "file" | "view" | "help";
// `"panel"` was removed (#10512): no renderer surface ever mounted
// `usePluginContextMenuItems("panel")`, so a contributed panel context-menu item
// was silently dead. Only `worktree` / `terminal` / `file` have live consumers.
export type ContextMenuLocation = "worktree" | "terminal" | "file";

export const BUILT_IN_PLUGIN_CAPABILITIES = [
  "fs:project-read",
  "fs:project-write",
  "fs:user-data-read",
  "fs:user-data-write",
  "network:fetch",
  "agent:invoke",
  "agent:read",
  "agent:register",
  "agent:input",
  "git:read",
  "git:write",
  "clipboard:read",
  "clipboard:write",
  "shell:exec",
  // Disclosure-only (#11299). A plugin's `main` runs Node-capable, so it can
  // already `net.connect()` a Unix-domain socket or Windows named pipe — the
  // Docker socket being the motivating case — with no host mediation possible.
  // This token doesn't add that power and doesn't gate it; it exists so the
  // Plugin Manager can *tell the user* the plugin claims it, and so the claim
  // can carry an optional `scopes.socket.allowedPaths` intent. Deliberately
  // excluded from CONFIRM_TRIGGERING_CAPABILITIES: elevating on a token the
  // host cannot enforce would buy friction without buying safety.
  "socket:connect",
] as const;

export type BuiltInPluginCapability = (typeof BUILT_IN_PLUGIN_CAPABILITIES)[number];

const BUILT_IN_PLUGIN_CAPABILITY_SET: ReadonlySet<string> = new Set(BUILT_IN_PLUGIN_CAPABILITIES);

/**
 * Runtime narrowing for a capability token arriving from an untrusted source —
 * a manifest field or a `host.registerAction` argument, where the declared TS
 * type is a promise the plugin has not actually kept. Host-internal: the SDK
 * barrel deliberately omits the capability list, so plugins narrow against the
 * schema instead.
 */
export function isBuiltInPluginCapability(value: unknown): value is BuiltInPluginCapability {
  return typeof value === "string" && BUILT_IN_PLUGIN_CAPABILITY_SET.has(value);
}

export type PluginCapability = BuiltInPluginCapability;

export interface MenuItemContribution {
  label: string;
  actionId: ActionId;
  location: MenuItemLocation;
  accelerator?: string;
  when?: string;
}

export interface KeybindingContribution {
  actionId: ActionId;
  combo: string;
  // Mirrors the manifest schema's scope enum (electron/schemas/plugin.ts) so
  // plugin authors can't compile against a scope the manifest gate rejects.
  scope?: import("./keybinding.js").KeyScope;
  description?: string;
  when?: string;
}

export interface PluginKeybindingDescriptor {
  pluginId: string;
  item: KeybindingContribution;
}

export interface ContextMenuContribution {
  actionId: ActionId;
  location: ContextMenuLocation;
  label: string;
  when?: string;
}

/**
 * View contribution location. Only `panel` is supported — it registers a panel
 * kind at plugin load with `showInPalette: true` so the view is spawnable from
 * the panel palette. It is wired today by the inline renderer host (#9229); see
 * `docs/plugins/architecture.md` for the renderer host design. `sidebar` is
 * rejected at the manifest gate (`ViewContributionSchema`) because the sidebar
 * host does not exist yet — accepting it would validate a contribution the
 * runtime cannot honor. The `experimental_` prefix on the contribution point
 * signals that the shape may still change before the feature exits experiment
 * status.
 */
export type ViewLocation = "panel";

export interface ViewContribution {
  id: string;
  componentPath: string;
  location: ViewLocation;
  // Advisory only — the matching `contributes.panels` entry owns the rendered
  // icon/name at runtime. `name`/`description` were removed (#10888) because no
  // runtime path consumed them.
  iconId?: string;
}

/**
 * The project surfaces a project-local plugin can own. See §7.8 and
 * `SurfaceContributionsSchema` in `electron/schemas/plugin.ts` for why
 * `projectHome` and `defaultLayout` are not here yet.
 */
export type ProjectSurfaceSlot = "emptyCanvas";

/** A surface slot claim naming one of the plugin's own `contributes.views`. */
export interface SurfaceViewSlot {
  viewId: string;
}

/** The `contributes.surfaces` block of a project plugin's manifest. */
export interface SurfaceContributions {
  emptyCanvas?: SurfaceViewSlot;
}

/**
 * A resolved surface claim, as the renderer receives it.
 *
 * `panelKindId` is the RUNTIME, project-qualified panel-kind id the view
 * registered under, not the manifest's bare `viewId` — the renderer already
 * knows how to turn one of those into a mounted plugin view (icon, name, the
 * `plugin://` component path, the error boundary), so a surface reuses that
 * path wholesale instead of growing a second way to mount the same module.
 */
export interface ProjectSurfaceClaim {
  /** The owning plugin INSTANCE key, matching `PanelKindConfig.extensionId`. */
  pluginId: string;
  panelKindId: string;
}

/** Every surface claimed in one project, keyed by slot. */
export type ProjectSurfaceSnapshot = Partial<Record<ProjectSurfaceSlot, ProjectSurfaceClaim>>;

/**
 * Props every plugin-contributed panel view receives from the renderer host.
 * Intentionally narrower than the host-internal `PanelComponentProps` so the
 * SDK surface stays stable across a future `plugin://` → trusted-iframe
 * cutover (#9229).
 *
 * - `panelId` is the runtime panel instance id (the same value the host uses
 *   in `addPanelOptions` / IPC). Plugins should treat it as opaque.
 * - `pluginId` is the plugin's manifest `name` — useful for namespacing
 *   plugin-local storage keys and for logging.
 * - `disposeSignal` aborts on unmount AND when the host receives a
 *   `plugin:panel-kinds-changed` push that no longer contains this kind. The
 *   broadcast fires before the main process tears down plugin IPC handlers,
 *   so signal-driven cleanup (fetch aborts, subscription teardown) runs
 *   while the plugin host APIs are still live.
 * - `panelRemovedSignal` aborts ONLY when the panel is permanently gone.
 */
export interface PanelViewProps {
  readonly panelId: string;
  readonly pluginId: string;
  /**
   * Lifetime of THIS mounted view attempt — not of the panel (#11301).
   *
   * Aborts on React unmount, on "Try again", and when a
   * `plugin:panel-kinds-changed` push drops this kind. Crucially, a temporary
   * unmount aborts it too: maximizing a sibling pane, switching away from a
   * dock tab, or caching a background project view all tear the subtree down
   * while the panel itself lives on. Tie only view-scoped work to it — in-flight
   * `fetch`es, DOM observers, `postToPanel` subscriptions.
   *
   * NEVER tie a durable resource (a spawned process, a long-lived session) to
   * this signal: it will be killed the first time the user maximizes another
   * pane. Durable resources belong in the plugin's worker, which observes the
   * panel across every remount via `host.onDidChangePanelLifecycle`.
   */
  readonly disposeSignal: AbortSignal;
  /**
   * Lifetime of the PANEL RECORD (#11301). The same `AbortSignal` object is
   * handed to every mount of a given `panelId`, so it survives remounts,
   * retries, trash-then-restore, and plugin view upgrades.
   *
   * Aborts exactly once, when the panel is permanently removed from the panel
   * store — never for a temporary unmount and never while a trashed panel is
   * still restorable. This is the signal to use for cleanup that must happen
   * once and only when the user is genuinely done with the panel.
   */
  readonly panelRemovedSignal: AbortSignal;
  /**
   * Opaque argument bag handed to the view when the panel is spawned with one
   * — e.g. `{ path }` from a "open file in plugin panel" intent. Sourced from
   * the panel's `extensionState` (the same bag that survives the save/restore
   * round-trip), so a restored panel sees the args it was originally spawned
   * with. Empty (no key) for panels opened without an initial argument. The
   * host never mutates it; plugins should treat the contents as read-only.
   */
  readonly initialArgs?: Record<string, unknown>;
  /**
   * The worktree the panel instance belongs to, as recorded on the panel at
   * spawn time. Lets a view reconstruct its own context without dispatching
   * `worktree.getCurrent` — which resolves the *visible* worktree, not the
   * one that owns the panel, and so returns the wrong answer for a background
   * or restored panel. `undefined` for a panel spawned without a worktree.
   */
  readonly worktreeId?: string;
}

/**
 * What just happened to one plugin panel instance (#11301). The renderer owns
 * the transitions; the worker observes them through
 * `host.onDidChangePanelLifecycle`.
 *
 * `mounted` / `hidden` are the two *view* states — a panel whose React subtree
 * is currently rendered vs. one whose subtree has been torn down while the panel
 * record lives on (sibling maximize, an inactive dock tab, a cached project
 * view). `hidden` explicitly does NOT mean the user closed anything.
 *
 * `backgrounded` / `trashed` / `restored` / `removed` are *panel record* states
 * read off `PanelLocation`: `backgrounded` is `location: "background"`,
 * `trashed` is the recoverable soft close, `restored` is the one-shot edge out
 * of trash (a transition, never a resting state), and `removed` is the terminal
 * event — the panel is gone and will never come back under this id.
 *
 * `render-failed` means the current view attempt reached the host's error
 * boundary. It is cleared by a successful retry. The failure detail stays in the
 * renderer's diagnostics pane; only the fact of failure crosses to the worker.
 */
export type PluginPanelLifecyclePhase =
  "mounted" | "hidden" | "backgrounded" | "trashed" | "restored" | "removed" | "render-failed";

/**
 * One panel lifecycle transition delivered to a plugin worker (#11301).
 * Deliberately minimal and frozen before delivery: it carries identity and
 * phase, never renderer internals, error text, or user paths.
 */
export interface PluginPanelLifecycleEvent {
  /** Runtime panel instance id — matches `PanelViewProps.panelId`. */
  readonly panelId: string;
  /** Namespaced panel kind, i.e. `${pluginId}.${panel.id}`. */
  readonly panelKindId: string;
  /** Owning plugin's manifest `name`. Always this plugin's own id. */
  readonly pluginId: string;
  readonly phase: PluginPanelLifecyclePhase;
}

/**
 * Lazily-spawned MCP server contribution (#9235). The declared `command` is
 * launched as a real subprocess the first time its tools are enumerated (not at
 * load time), inheriting `args` and `env`. `${settings:*}` templates inside
 * `args` are resolved from user-scope settings at spawn and on restart, so a
 * contributed command does run with the plugin author's wiring — treat it as
 * trust-gated, not inert. Shape intentionally mirrors the Claude Desktop /
 * Cursor MCP server config format (stdio only; remote servers via `url` are out
 * of scope and deliberately excluded). The `experimental_` prefix on the
 * contributes field signals the shape may still change.
 */
export interface McpServerContribution {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * One `contributes.skills` entry (#10892). A skill is a markdown file the plugin
 * ships — instructions/knowledge (not executable code) that Daintree's built-in
 * MCP server surfaces to agents through the `skills.search` / `skills.load`
 * tools. `id` is namespaced at runtime as `{pluginId}.{id}`. `path` is a
 * plugin-relative markdown file, validated with the same traversal guard as a
 * view's `componentPath` and realpath-contained to the plugin dir when read.
 * Skills carry no capability requirement — they are inert declarative content.
 */
export interface SkillContribution {
  id: string;
  name: string;
  /** Plugin-relative path to the skill's markdown file (e.g. `./skills/tdd.md`). */
  path: string;
  /** Optional phrase fragments that help agents discover the skill via `skills.search`. */
  triggers?: string[];
}

/**
 * One terminal in a `contributes.recipes` entry (#11860). The authorable subset
 * of {@link RecipeTerminal}: the transient per-launch fields (`agentModelId`,
 * `agentLaunchFlags`, `location`) are session state the recipe editor already
 * strips on persist, so a manifest may not declare them. `type` accepts the
 * built-in terminal kinds plus an agent id the SAME plugin contributes — a
 * foreign plugin's agent id is dropped by the sanitizer at registration.
 */
export interface RecipeContributionTerminal {
  type: string;
  title?: string;
  command?: string;
  env?: Record<string, string>;
  initialPrompt?: string;
  args?: string;
  devCommand?: string;
  exitBehavior?: "keep" | "trash" | "remove";
}

/**
 * One `contributes.recipes` entry (#11860). A recipe is a named multi-terminal
 * launch layout the plugin ships; the host registers it under the qualified id
 * `{pluginId}.{id}` and merges it into the recipe list as a plugin-owned tier
 * available in every project.
 *
 * Terminals are declared inline rather than pointing at a shipped JSON file so
 * the install-time confirmation can show what a recipe actually runs:
 * `readArchiveManifest` reads only the manifest, never extracting the archive.
 *
 * Contributed content is immutable — the user customises by duplicating into a
 * user-owned tier. `showInEmptyState` and `autoAssign` are DEFAULTS: a user
 * override for either lives in the sidecar
 * ({@link PluginRecipeMetadata}) and wins. Recipes carry no capability
 * requirement, matching {@link SkillContribution} — the terminals they declare
 * still pass the same content sanitizer every other recipe tier does, and a
 * capability in an unsandboxed runtime would be a label rather than a gate.
 */
export interface RecipeContribution {
  id: string;
  name: string;
  terminals: RecipeContributionTerminal[];
  /** Default for the empty-state pin; a user pin/unpin overrides it. */
  showInEmptyState?: boolean;
  /**
   * Default issue auto-assign behaviour; a user choice overrides it.
   *
   * Spelled out rather than importing `RecipeAutoAssign` from `./project.js`.
   * This module is an entry point of the plugin SDK's bundled declarations, and
   * a type-only import still widens that rollup's graph: pulling in `project.ts`
   * drags `panel.ts` → `panelKindRegistry.ts` → `theme/terminal.ts` behind it,
   * and the DTS build then fails on an `@xterm/xterm` type that module imports.
   * The two stay in step because the registry assigns this straight onto
   * `TerminalRecipe.autoAssign`, so any drift is a compile error there.
   */
  autoAssign?: "always" | "never" | "prompt";
}

/**
 * Per-capability scope binding that attenuates the compound-capability lattice
 * elevation in `PluginService.validateAndBuildActionDescriptor`. The lattice
 * elevates `effectiveDanger` to `"confirm"` when a plugin pairs a sensitive
 * source (sensitive reads, or `network:fetch` as a remote control channel)
 * with a sink (`network:fetch`, local writes, `shell:exec`). Tightly-bound
 * sinks skip elevation — a plugin that proves its `network:fetch` only talks
 * to one explicit HTTPS API is not a generic exfiltration channel.
 *
 * Wildcards (`*`, `**`) are rejected at schema parse time so a tightly-bound
 * declaration cannot smuggle a permissive value past the manifest gate.
 * SSRF targets (loopback, link-local, RFC1918) and embedded credentials are
 * also rejected at parse time. See `electron/schemas/plugin.ts` for the
 * canonical validation rules.
 */
export interface PluginNetworkScope {
  /**
   * Allowlist of HTTPS URLs the plugin's `network:fetch` capability may talk
   * to. Each entry must parse as a `https:` URL with a multi-segment hostname,
   * no embedded credentials, no wildcards, and no private/loopback target.
   */
  allowedUrls: string[];
}

export interface PluginFsScope {
  /**
   * Allowlist of absolute filesystem paths the plugin's `fs:*` capabilities may
   * touch. Each entry is schema-validated at parse time (must be an absolute
   * path containing no `..` segment and no `*`/`**` glob — literal-path
   * allowlist only).
   *
   * Enforced at runtime by the host-mediated {@link PluginFsApi} ({@link
   * PluginHostApi.fs}): every path argument is realpath-resolved and contained
   * to one of these roots (traversal and symlink-escape rejected), mirroring the
   * `plugin://` protocol handler's containment discipline. It does NOT gate the
   * compound-capability lattice — `scopes.network` is the only bucket the lattice
   * consults today.
   *
   * Honest scope note: this gates `host.fs`/`host.git` only. A plugin's `main`
   * still runs in-process and can call raw `node:fs` directly, which the host
   * cannot intercept until the sandbox/trust model changes (D3). `host.fs` gives
   * a sanctioned, contained, audited path; it does not seal the in-process one.
   */
  allowedPaths: string[];
}

/**
 * Optional path intent for the `socket:connect` capability (#11299). Purely
 * declarative: unlike {@link PluginFsScope}, nothing enforces it, because a
 * plugin's `main` reaches `node:net` directly and the host has no interception
 * point. Its job is disclosure — the Permissions tab renders these entries so
 * "connects to local sockets" reads as "connects to `/var/run/docker.sock`".
 *
 * Entries are validated for shape only (a Unix-domain path or a Windows
 * `\\.\pipe\…` name, no globs), and validated identically on every platform so
 * a cross-platform manifest parses on all of them.
 */
export interface PluginLocalSocketScope {
  /**
   * Declared local endpoints the plugin intends to connect to — Unix-domain
   * socket paths and/or Windows named pipes. Advisory, not enforced.
   */
  allowedPaths: string[];
}

export interface PluginManifestScopes {
  network?: PluginNetworkScope;
  fs?: PluginFsScope;
  socket?: PluginLocalSocketScope;
}

/**
 * A plugin-contributed agent entry (#9560). Lets a plugin teach Daintree about
 * a launchable agent CLI it doesn't ship, so the CLI shows up as a named,
 * selectable agent rather than a generic shell. Requires the `agent:register`
 * capability (enforced at the manifest gate). Plugin agent IDs are additive for
 * new IDs only — a contribution whose `id` collides with a built-in is rejected
 * at parse time, and built-in entries always shadow plugin entries in
 * `getEffectiveRegistry`. Cross-plugin ID conflicts resolve first-registered-wins.
 *
 * Plugin agents launch as named, untracked terminals: the schema surfaces
 * `id`, `name`, `command`, `args`, `color`, `iconId`,
 * `supportsContextInjection`, and an optional `detection` block. The
 * `detection` field (#10587) lets a contributed agent describe its
 * working/waiting/completed output patterns so it participates in the
 * agent-state UI like a built-in — output-volume state already works from the
 * launch hint, and declared patterns add the richer prompt/completion cues.
 * Threaded onto the resolved {@link AgentConfig} by `contributionToAgentConfig`
 * and consumed by the pty-host activity monitor.
 */
export interface PluginAgentContribution {
  id: string;
  name: string;
  command: string;
  args?: string[];
  color: string;
  iconId: string;
  supportsContextInjection?: boolean;
  /**
   * Optional output-pattern detection config (#10587). Passive observation
   * only — patterns are matched against terminal output to drive the
   * working/waiting/completed state machine, consistent with the agent-config
   * boundary (Daintree never modifies the agent's own config).
   */
  detection?: AgentDetectionConfig;
}

/**
 * A plugin-contributed terminal process detection (#11613). Maps one command
 * name to the icon a terminal tab shows while that command runs, so a plugin
 * that ships or wraps a CLI can make it identifiable in a pane instead of
 * falling back to the generic terminal glyph.
 *
 * `command` is the bare executable name the detector matches — the same key
 * space as the built-in `PROCESS_TOOL_REGISTRY` commands (`vite`, `pytest`,
 * `redis-cli`). Lowercase only: `ProcessDetector` lower-cases every candidate
 * before lookup, so a mixed-case key could never match. A tool with aliases
 * declares one entry per alias.
 *
 * `iconId` uses the generic plugin icon namespace ({@link PLUGIN_ICON_IDS} in
 * `shared/config/pluginIconIds.ts`), the same one `contributes.panels[].iconId`
 * and `contributes.toolbarButtons[].iconId` use — plugins cannot ship bundled
 * brand marks. Advisory, like those siblings: an unrecognized id renders a
 * fallback glyph rather than failing the load.
 *
 * Inert declarative data, so no capability is required. A command that collides
 * with a built-in tool or agent is rejected at parse time; a cross-plugin
 * collision resolves first-registered-wins with a warning.
 *
 * Deliberately no `label`: the renderer resolves a detected process's display
 * label from its icon id (`deriveTerminalChrome`), and generic plugin icon ids
 * are shared across plugins, so a plugin-supplied label could not be resolved
 * unambiguously. A plugin-detected process labels itself with its icon id until
 * the identity model carries a distinct process label through panel state.
 *
 * Registered into `shared/config/pluginProcessToolRegistry.ts` at load time and
 * mirrored into the pty-host, where detection runs.
 */
export interface PluginProcessToolContribution {
  command: string;
  iconId: string;
}

/**
 * Closed set of catalog categories a plugin can declare via
 * `manifest.category`. The plugin manager groups its list by these (#9554
 * successor) — a closed enum rather than free-form tags so the catalog can't
 * fragment into orphan one-off groups. Display labels, ordering, and the
 * contributes-based fallback derivation live in
 * `shared/config/pluginCategoryRegistry.ts`.
 */
export const PLUGIN_CATEGORY_IDS = ["forge", "ai", "workspace", "other"] as const;

export type PluginCategoryId = (typeof PLUGIN_CATEGORY_IDS)[number];

/**
 * A single attribution entry in {@link PluginManifest.authors}. `name` is
 * required; the rest are optional. `url` (when present) is validated to the
 * same https-only, no-credentials, no-private-host discipline as network
 * scopes — see `PluginAuthorUrlSchema` in `electron/schemas/plugin.ts` — since
 * it surfaces as a user-clickable link in the detail pane.
 */
export interface PluginAuthor {
  name: string;
  url?: string;
  email?: string;
  role?: string;
}

/**
 * Which root a plugin was discovered under. Replaces the `isBuiltin` boolean at
 * the manifest gate, which could only say "first-party or not" and had no way
 * to express a third root:
 *
 * - `"builtin"` — shipped inside the app bundle (`plugins/builtin/`), plus the
 *   E2E sideload root, which is loaded on the same trust footing.
 * - `"user"` — installed by the user into the per-user plugins directory.
 * - `"project"` — lives in a project's own `.daintree/plugins/`, is only ever
 *   loaded while that project is open, and must declare `scope: "project"`.
 *
 * Host-internal: a plugin never learns its own origin, so this is deliberately
 * not re-exported from the SDK barrel.
 */
export type PluginOrigin = "builtin" | "user" | "project";

export interface PluginManifest {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  /**
   * One-line value proposition shown in catalog rows and cards. `description`
   * stays the long-form copy for the detail pane.
   */
  tagline?: string;
  /**
   * Optional attribution credits shown in the detail pane's "Contributors"
   * block. Each entry credits a person who worked on the plugin.
   */
  authors?: PluginAuthor[];
  /**
   * Declared catalog category. Optional — when absent the manager derives one
   * from `contributes` (see `resolvePluginCategory`).
   */
  category?: PluginCategoryId;
  main?: string;
  engines?: {
    daintree?: string;
  };
  /**
   * Declares the plugin is only ever loaded project-locally. REQUIRED when the
   * manifest is discovered under a project's own plugins directory, REJECTED
   * under the user or builtin roots. The manifest gate enforces both directions,
   * so a project plugin cannot be dropped into the user directory (or a user
   * plugin into a project) and quietly keep working under assumptions its author
   * never made.
   *
   * A guardrail against accidental promotion, not a security control: the trust
   * decision is the project folder, not this field.
   */
  scope?: "project";
  capabilities?: PluginCapability[];
  /**
   * Per-capability scope bindings that attenuate the compound-capability
   * lattice. See {@link PluginManifestScopes}. Absent on most plugins —
   * the lattice still elevates compound pairs without scopes, so this field
   * is opt-in only for plugins that need to skip elevation.
   */
  scopes?: PluginManifestScopes;
  activationEvents?: "onStartupFinished"[];
  contributes: {
    panels: PanelContribution[];
    toolbarButtons: ToolbarButtonContribution[];
    menuItems: MenuItemContribution[];
    keybindings: KeybindingContribution[];
    contextMenus: ContextMenuContribution[];
    /**
     * Manifest-declared commands. Each entry registers a {@link PluginActionDescriptor}
     * at load time (so the command appears in the palette before the plugin
     * activates) and is lazily bound to `src/{id}.{ts,tsx,js,mjs}` on first
     * dispatch. `id` is the bare command id — the host namespaces it as
     * `{pluginId}.{id}` to match the {@link PluginActionDescriptor.id} convention.
     */
    commands: PluginActionContribution[];
    views: ViewContribution[];
    mcpServers: McpServerContribution[];
    /**
     * Plugin-contributed skills (#10892) — markdown knowledge/instruction files
     * surfaced to agents via the built-in MCP server's `skills.search` /
     * `skills.load` tools. Inert declarative content; no capability required.
     * Empty unless the plugin ships skills.
     */
    skills: SkillContribution[];
    forgeProviders: ForgeProviderContribution[];
    fileDecorationProviders: FileDecorationContribution[];
    /**
     * Plugin-contributed launchable agents (#9560). Each entry registers an
     * {@link PluginAgentContribution} into the effective agent registry at load
     * time so the CLI is selectable as a named agent. Requires the
     * `agent:register` capability. Empty unless the plugin opts in.
     */
    agents: PluginAgentContribution[];
    /**
     * Plugin-contributed terminal process detections (#11613). Each entry maps
     * a command name to the icon a terminal tab shows while that command runs.
     * Inert declarative data; no capability required. Empty unless the plugin
     * ships or wraps a CLI it wants recognized.
     */
    processTools: PluginProcessToolContribution[];
    /**
     * Declared plugin settings. When absent or empty, `host.settings.set()`
     * accepts any key (permissive for plugins that declare none). When non-empty,
     * `set()` (and the settings-UI write/reset paths) reject keys not declared
     * here and enforce each setting's declared scope — see `assertSettingDeclared`
     * in `electron/services/plugin/PluginSettingsManager.ts`.
     */
    settings?: SettingDefinition[];
    /**
     * Plugin-contributed recipes (#11860) — named multi-terminal launch layouts
     * merged into the recipe list as a plugin-owned, globally-available tier.
     * Inert declarative content; no capability required. Content is immutable;
     * user-owned frecency and preferences live in a sidecar keyed by the
     * qualified id. Empty unless the plugin ships recipes.
     */
    recipes: RecipeContribution[];
    /**
     * Project surfaces this plugin claims (§7.8). Optional in the type but
     * always materialized by the manifest schema's `.default({})`, so a
     * consumer reading it off a parsed manifest never sees `undefined` — the
     * optionality is for the hand-built manifest literals in tests and tooling
     * that predate the field.
     *
     * Only meaningful for a `scope: "project"` plugin; the manifest schema
     * rejects the key outright for any other origin.
     */
    surfaces?: SurfaceContributions;
  };
}

/**
 * Field control kind for a {@link SettingDefinition}. Drives which input the
 * generated settings form renders (#9301):
 * - `string` → single-line text input (default when `type` is omitted)
 * - `number` → numeric input, optionally range-bounded by `min`/`max`
 * - `boolean` → toggle switch
 * - `enum` → select, choices from `options`
 * - `json` → multi-line textarea, validated as JSON on blur
 * - `secret` → password input, never rendered with its stored value until the
 *   user explicitly reveals it
 * - `path` / `directory` / `file` → read-only text input + a "Browse" button
 *   that opens the native chooser via `window.electron.plugin.pickPath`. The
 *   stored value is an absolute filesystem path. `path` and `directory` choose a
 *   folder; `file` chooses a single file (narrowable by `extensions`). When
 *   `mustExist` is set the form flags a stored path that no longer resolves.
 */
export type SettingFieldType =
  "string" | "number" | "boolean" | "enum" | "json" | "secret" | "path" | "directory" | "file";

/**
 * Declaration for a single plugin setting under `contributes.settings` (#9301).
 * Rendered as a generated form field in Preferences → Plugins and persisted via
 * {@link SettingsApi}. `id` is the storage key; `type` selects the control. The
 * manifest schema coerces the legacy `secret: true` flag to `type: "secret"`, so
 * consumers only need to switch on `type`.
 */
export interface SettingDefinition {
  id: string;
  type?: SettingFieldType;
  label?: string;
  description?: string;
  default?: unknown;
  /** Where the value is stored. Defaults to `"user"`. */
  scope?: PluginSettingsScope;
  /** Allowed values for `type: "enum"`. Ignored for other types. */
  options?: string[];
  /** Inclusive lower bound for `type: "number"`. */
  min?: number;
  /** Inclusive upper bound for `type: "number"`. */
  max?: number;
  /**
   * For `type: "path" | "directory" | "file"` — when `true`, the settings form
   * flags a stored path that no longer resolves on disk. Advisory: it does not
   * block saving (the chooser only returns existing paths), but a path that was
   * valid at pick time can later be moved or deleted. Ignored for other types.
   */
  mustExist?: boolean;
  /**
   * For `type: "file"` — restrict the native chooser to these file extensions
   * (without the leading dot, e.g. `["json", "md"]`). Maps to an Electron
   * dialog filter. Ignored for `path` / `directory` (folders are unfiltered)
   * and all other types.
   */
  extensions?: string[];
  /**
   * Legacy secret hint (F19). The manifest schema normalizes `secret: true` to
   * `type: "secret"`; new manifests should use the type. Once normalized, the
   * value follows the same at-rest tier as any `type: "secret"` setting —
   * keychain-backed via Electron `safeStorage` when available, plaintext JSON
   * only as a fallback (see {@link PluginSecretStorageTier}, #9167).
   */
  secret?: boolean;
}

/**
 * Request for the plugin-reachable native folder/file chooser
 * (`window.electron.plugin.pickPath`). Driven by the generated settings form's
 * "Browse" button for `path` / `directory` / `file` fields, so it is
 * user-initiated and not capability-gated — but it is scoped to a valid
 * `pluginId` at the IPC boundary. `kind: "directory"` chooses a single folder;
 * `kind: "file"` chooses a single file, optionally narrowed by `filters`.
 */
export interface PluginPickPathRequest {
  kind: "directory" | "file";
  /** Pre-select this absolute path in the chooser. Ignored when not absolute. */
  defaultPath?: string;
  /** File-type filters for `kind: "file"` (extensions without the dot). Ignored for directories. */
  filters?: PluginPickPathFilter[];
}

/** One named extension group for the `kind: "file"` chooser. */
export interface PluginPickPathFilter {
  name: string;
  /** Extensions without the leading dot, e.g. `["json", "md"]`. `["*"]` allows all. */
  extensions: string[];
}

export type PluginSettingsScope = "user" | "project";

/**
 * Scope for the private {@link StorageApi} key/value store. Unlike
 * {@link PluginSettingsScope} this adds a `"worktree"` scope that auto-resolves
 * the currently-active worktree at call time (parallel to how `"project"`
 * resolves the active project), so a plugin can keep per-worktree machine state
 * without hand-rolling its own per-worktree keying inside a project blob. Kept a
 * distinct type from `PluginSettingsScope` so the settings UI / manifest schema
 * never has to reason about `"worktree"`.
 */
export type PluginStorageScope = "user" | "project" | "worktree";

/**
 * Snapshot of one plugin's stored setting values for a single scope, returned to
 * the settings UI (#9301). Secret values are deliberately never included —
 * `secretsSet` only reports *which* secret keys have a stored value so the form
 * can show a "saved" affordance without exposing the secret. Revealing a secret
 * requires a separate, explicit `revealSecretSetting` call.
 */
export interface PluginSettingsUiValues {
  /** Stored non-secret values keyed by setting id. A missing key means unset. */
  values: Record<string, unknown>;
  /** Ids of secret-typed settings that currently have a stored value. */
  secretsSet: string[];
  /**
   * At-rest tier new secret writes will use right now (#9167). `"keychain"` when
   * the OS keychain (Electron `safeStorage`) is available, `"plaintext"` when it
   * is not (e.g. a headless Linux box) and secrets fall back to `chmod 0o600`
   * JSON. The settings UI discloses this honestly per secret field.
   */
  secretTier: PluginSecretStorageTier;
  /**
   * Ids of secret settings whose *currently stored* value is still plaintext —
   * either written before a keychain was available, or not yet migrated. A value
   * here that's absent from a `"keychain"` tier means the UI should nudge the
   * user to re-save it. Migration happens automatically on the next write.
   */
  secretsPlaintext: string[];
}

/** At-rest storage tier for a secret setting value (#9167). */
export type PluginSecretStorageTier = "keychain" | "plaintext";

/**
 * Persistent, plugin-scoped key/value settings exposed on
 * {@link PluginHostApi.settings}. Values are stored as JSON at
 * `~/.daintree/plugin-settings/{pluginId}.json` (user scope) or
 * `<projectRoot>/.daintree/plugin-settings/{pluginId}.json` (project scope),
 * with `chmod 0o600` applied on POSIX. Settings declared `type: "secret"` are
 * encrypted at rest through the OS keychain (Electron `safeStorage`) when one is
 * available, falling back to the same plaintext-0600 path when it is not (#9167);
 * the `get`/`set` API shape is identical either way. Non-secret values are always
 * plaintext JSON — do not store credentials in non-secret keys.
 *
 * `scope` defaults to `"user"`. Project scope resolves the active project at
 * call time, so it tracks project switches: `get` returns `undefined` and `set`
 * throws when no project is active.
 */
/**
 * Options accepted by long-running host calls (filesystem reads/writes, git
 * reads and mutations, the on-demand worktree-status accessor). Carries an
 * optional {@link AbortSignal} so a plugin can cancel a call it no longer needs
 * — e.g. when a panel the read was feeding has unmounted. An already-aborted
 * signal rejects the call before any I/O; aborting mid-flight rejects with the
 * signal's reason. Always the trailing argument so it never collides with a
 * method's positional parameters.
 */
export interface PluginHostCallOptions {
  signal?: AbortSignal;
}

/**
 * Options accepted by high-frequency event subscriptions (today
 * {@link PluginActivationApi.onDidChangeWorktrees}). `debounceMs` coalesces a
 * burst of change events into a single trailing callback fired `debounceMs`
 * after the last event — the host re-emits the worktree set on every git-status
 * poll, so a UI-updating plugin can opt into far fewer callbacks. Values below a
 * small floor (~50ms) are clamped up; `0` / omitted means no debounce (fire on
 * every change). The coalesced callback receives the most recent snapshot list.
 */
export interface PluginHostSubscriptionOptions {
  debounceMs?: number;
}

export interface SettingsApi {
  /**
   * Read a setting. Resolves to `undefined` when the key is unset, or (for
   * `"project"` scope) when no project is active.
   *
   * When the key is declared in `contributes.settings`, its declared `scope`
   * (default `"user"`) is authoritative: omitting `scope` reads from the declared
   * scope, and passing a `scope` that conflicts with the declaration throws — the
   * read counterpart to the `set`/`onDidChange` scope guards. Undeclared keys (or
   * manifests with no declarations) fall back to the supplied `scope` or `"user"`.
   */
  get<T = unknown>(key: string, scope?: PluginSettingsScope): Promise<T | undefined>;
  /**
   * Persist a setting. Rejects `undefined` and non-JSON-serializable values.
   * For `"project"` scope with no active project, throws. When the manifest
   * declares `contributes.settings`, an undeclared key is rejected.
   */
  set<T = unknown>(key: string, value: T, scope?: PluginSettingsScope): Promise<void>;
  /**
   * Subscribe to in-process writes of `key` in `scope` (default `"user"`). The
   * callback fires with the new value after each `set` that changes it. Edits
   * made to the JSON file by other processes do NOT fire until the plugin
   * reloads. Must be called during `activate()` — subscribing is revoke-guarded.
   * Resolves to a disposer; calling it more than once is a no-op. All
   * subscriptions are automatically disposed when the plugin is unloaded.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected (the promise rejects).
   */
  onDidChange<T = unknown>(
    key: string,
    callback: (value: T | undefined) => void,
    scope?: PluginSettingsScope
  ): Promise<() => void>;
}

/**
 * Private, plugin-scoped key/value storage exposed on
 * {@link PluginHostApi.storage}. This is the machine-owned counterpart to
 * {@link SettingsApi}: values never surface in the plugin settings UI and are
 * NOT gated by `contributes.settings` declarations, so a plugin can persist its
 * own working state freely without declaring every key. Values are stored as
 * plaintext JSON (no secret encryption — never store credentials here) at
 * `~/.daintree/plugin-storage/{pluginId}.json` (user scope),
 * `<projectRoot>/.daintree/plugin-storage/{pluginId}.json` (project scope), or
 * `<worktreePath>/.daintree/plugin-storage/{pluginId}.json` (worktree scope),
 * with `chmod 0o600` applied on POSIX.
 *
 * `scope` defaults to `"user"`. The `"project"` and `"worktree"` scopes resolve
 * the active project / active worktree at call time, so they track switches:
 * `get` and `delete` resolve to a no-op (returning `undefined` / void) and
 * `set` throws when no project / worktree is active.
 */
export interface StorageApi {
  /**
   * Read a stored value. Resolves to `undefined` when the key is unset, or when
   * the requested `"project"` / `"worktree"` scope has no active target.
   */
  get<T = unknown>(key: string, scope?: PluginStorageScope): Promise<T | undefined>;
  /**
   * Persist a value. Rejects `undefined` and non-JSON-serializable values. For
   * `"project"` / `"worktree"` scope with no active target, throws.
   */
  set<T = unknown>(key: string, value: T, scope?: PluginStorageScope): Promise<void>;
  /**
   * Remove a stored value. A missing key (or a `"project"` / `"worktree"` scope
   * with no active target) resolves to a no-op rather than throwing.
   */
  delete(key: string, scope?: PluginStorageScope): Promise<void>;
  /**
   * Subscribe to in-process writes of `key` in `scope` (default `"user"`). The
   * callback fires with the new value after each `set`/`delete` that changes it.
   * Edits made to the JSON file by other processes do NOT fire until the plugin
   * reloads. Must be called during `activate()` — subscribing is revoke-guarded.
   * Resolves to a disposer; calling it more than once is a no-op. All
   * subscriptions are automatically disposed when the plugin is unloaded.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected (the promise rejects).
   */
  onDidChange<T = unknown>(
    key: string,
    callback: (value: T | undefined) => void,
    scope?: PluginStorageScope
  ): Promise<() => void>;
}

export type PluginInstallSource = "builtin" | "sideload" | "url" | "catalog";

/**
 * Parsed intent of a `daintree://` deep link (#9559). The OS hands the raw URI
 * to the main process via `open-url` (macOS) or `second-instance` / `process.argv`
 * (Windows/Linux); `parseDaintreeUrl` validates and narrows it to one of these
 * shapes before it crosses to the renderer.
 *
 * - `install` — `daintree://plugin/install?url=<https-or-http-archive-url>`: opens
 *   the Plugin Manager with the URL pre-filled in the install dialog. The user
 *   still presses install, so the existing HTTP-warning and security gates fire;
 *   a deep link never installs silently.
 * - `open` — `daintree://plugin/open?id=<publisher.name>`: opens the Plugin
 *   Manager scrolled to the named plugin.
 */
export type PluginDeepLinkIntent =
  { action: "install"; url: string } | { action: "open"; pluginId: string };

/**
 * Manifest identity shown in the sideload confirmation dialog (#11280). A
 * narrow projection of {@link PluginManifest} read by `readArchiveManifest`
 * without extracting the archive — `contributes` and the rest of the manifest
 * tree never cross IPC. Arrays are normalized to `[]` so the dialog renders
 * explicit empty states rather than omitting rows.
 */
export interface PluginArchiveManifestPreview {
  name: string;
  displayName?: string;
  version: string;
  /**
   * Resolved on main from the full validated manifest (`resolvePluginCategory`
   * needs `contributes`, which never crosses IPC) so the dialog can render the
   * same category icon tile the catalog uses.
   */
  category: PluginCategoryId;
  authors: PluginAuthor[];
  capabilities: PluginCapability[];
  /**
   * Contributed recipes, disclosed by name because a recipe is executable
   * content that ships with no capability to advertise it (#11860). `names` is
   * the complete (clamped, sanitized) list — bounded by the manifest schema at
   * 50 recipes and 200 characters each, so it can't flood the surface, and the
   * dialog bounds its own viewport rather than the data (#12001). `count` is
   * the same total, kept as the cross-process invariant the dialog's prose
   * reads.
   */
  recipes: { count: number; names: string[] };
}

/**
 * One `.dntr` archive awaiting the user's install decision (#11280). Raised
 * when the OS hands the app a double-clicked archive — macOS `open-file`, or a
 * Windows/Linux argv entry — and delivered to the primary window once it has
 * painted. Carrying the parsed manifest (not just the path) is what makes the
 * confirmation a D2 preview of actual content rather than a filename prompt.
 *
 * `archivePath` is the approval token: the renderer hands it back to
 * `plugin.installFromPath`, which re-runs every trust gate in main.
 */
export interface PluginArchiveInstallIntent {
  intentId: string;
  archivePath: string;
  archiveFileName: string;
  manifest: PluginArchiveManifestPreview;
}

/**
 * Discriminant for {@link PluginCheckUpdateResult}. A manual update check
 * (`plugin:check-for-update`) re-fetches the plugin's `originalUrl`, hashes the
 * archive, and compares it against the installed `archiveHash` — the check is
 * purely informational and never installs. Manual reinstall (preserving
 * settings, never auto) is the user's follow-up action.
 *
 * - `up-to-date` — the re-fetched archive hashes identically to the installed one
 * - `available` — the hashes differ; the result carries the new manifest preview
 * - `invalid-id` — no installed record, or the record has no `originalUrl`
 *   (sideload/builtin); the UI gate makes the no-URL case unreachable in practice
 * - `fetch-failed` — network error, non-2xx response, bad content-type, or an
 *   archive that exceeds the size cap / fails to parse; carries a `message`
 */
export type PluginUpdateCheckStatus = "available" | "up-to-date" | "invalid-id" | "fetch-failed";

/**
 * Outcome of a manual update check. Returned as plain data (never thrown) so the
 * structured result survives Electron's structured-clone IPC boundary (#3769) —
 * domain failures (`fetch-failed`) come back as data, not as a rejected promise.
 */
export type PluginCheckUpdateResult =
  | { status: "up-to-date" }
  | {
      status: "available";
      name: string;
      version: string;
      displayName?: string;
      capabilities: PluginCapability[];
    }
  | { status: "invalid-id" }
  | { status: "fetch-failed"; message: string };

/**
 * One URL-installed plugin found to have an update available by the opt-in
 * background check (#10893). A trimmed projection of the `available` variant of
 * {@link PluginCheckUpdateResult} — enough for the inbox notification copy and
 * the manager's "Update all" queue without re-querying.
 */
export interface PluginBackgroundUpdateEntry {
  pluginId: string;
  displayName: string;
  version: string;
  capabilities: PluginCapability[];
}

/**
 * Result of a background update-check pass across all URL-installed plugins
 * (#10893). Broadcast to renderers (and cached in main for late-subscriber
 * hydration) only when `updates` is non-empty. `signature` is a deterministic
 * digest of the update set so the renderer can dedupe repeated passes that
 * surface the same set into a single inbox row.
 */
export interface PluginBackgroundUpdateCheckResult {
  checkedAt: number;
  updates: PluginBackgroundUpdateEntry[];
  signature: string;
}

/** Opt-in state for the background update check (#10893). OFF by default. */
export interface PluginBackgroundUpdateCheckSettings {
  enabled: boolean;
}

export interface PluginLoadError {
  message: string;
  stack?: string;
  at: number;
}

/**
 * Outcome of an implicit panel-view activation (`plugin:activate-for-view`).
 * Returned as a plain discriminated object — never a thrown `Error` — so the
 * discriminant and message survive the contextBridge crossing intact (#6116:
 * custom `Error` properties are stripped a second time on deserialize). The
 * renderer throws renderer-side from `{ ok: false }` so the real activation
 * cause reaches the view's ErrorBoundary instead of a generic import timeout.
 */
export type PluginActivationResult =
  | {
      ok: true;
      /**
       * A main-minted `plugin://` URL on a fresh view generation, returned only
       * when the caller asked to recover from an import-stage failure (#11728).
       * The renderer imports this instead of the poisoned specifier — a rejected
       * dynamic import is permanent for its URL, so only a specifier V8 has
       * never seen re-evaluates. Absent for PTY/view-less kinds and whenever no
       * recovery was requested.
       */
      recoveryComponentPath?: string;
    }
  | { ok: false; error: string; stack?: string };

/**
 * Wire envelope for every push over the `plugin:{pluginId}:{channel}` transport
 * (`host.broadcastToRenderer`, `host.postToPanel`, and the managed-process
 * stream). `panelId` carries the per-instance target: `null` is a broadcast to
 * every subscriber of `(pluginId, channel)`, a non-empty string targets only
 * the panel instance with that id. The preload `plugin.on` / `plugin.onPanel`
 * dispatcher unwraps `payload` before handing it to the subscriber.
 */
export interface PluginPanelEventEnvelope {
  panelId: string | null;
  payload: unknown;
}

export interface PluginUpdateAvailable {
  version: string;
  channel: "manual";
}

/**
 * Persisted provenance record for a non-builtin plugin. Keyed by
 * `manifest.name` in `plugins.installed`. Runtime fields (`manifest`, `dir`,
 * `loadedAt`, `isBuiltin`) are reconstructed at load time and not stored here.
 */
export interface InstalledPluginRecord {
  source: PluginInstallSource;
  installedAt: number;
  /**
   * When the plugin was last reinstalled over an existing install (the #9292
   * swap path). Absent on first install — `installedAt` alone marks an untouched
   * install. Preserved separately from `installedAt` so a manual update keeps
   * the original install date while recording the upgrade.
   */
  updatedAt?: number;
  archiveHash: string | null;
  originalUrl: string | null;
  disabled: boolean;
  updateAvailable: PluginUpdateAvailable | null;
  devMode: boolean;
  loadError: PluginLoadError | null;
}

/**
 * Discriminated failure code for {@link PluginInstallResult}. Each value maps
 * to a distinct failure branch in `PluginService.installPlugin` so the install
 * dialog (F22a/b/F23/F24) can render a tailored message instead of a raw
 * stringified error.
 *
 * - `lock_failed` — couldn't acquire the cross-process `install.lock`
 * - `archive_invalid` — `.dntr` extraction failed (bad zip, path traversal, oversize)
 * - `manifest_invalid` — `plugin.json` failed the strict Zod schema
 * - `engine_incompatible` — `engines.daintree` range doesn't satisfy the running version
 * - `namespace_unauthorized` — reserved `daintree.*` name or publisher/name disagreement
 * - `name_collision` — the id matches a built-in or a launch-reserved plugin name; rejected before the swap so no broken dir is left
 * - `hash_failed` — couldn't compute the archive SHA-256
 * - `unload_failed` — the existing plugin's disposer cascade threw
 * - `swap_failed` — atomic rename failed but the prior state was restored
 * - `swap_unrecoverable` — rename failed AND rollback failed; on-disk state is inconsistent
 * - `load_failed` — swap committed but the new plugin failed to load
 *
 * Install-from-URL bounded-fetch failures (F24), produced before the archive
 * reaches `PluginService.installPlugin`:
 * - `fetch_failed` — non-2xx HTTP status or a network/transport error
 * - `fetch_timeout` — the download exceeded the shared `PLUGIN_DOWNLOAD_TIMEOUT_MS` deadline (30s)
 * - `size_exceeded` — declared `Content-Length` or the streamed bytes exceeded 30 MB
 * - `content_type_rejected` — response wasn't a plugin archive (bad MIME and the URL doesn't end in `.dntr`)
 * - `extraction_timeout` — extraction ran past `PLUGIN_ARCHIVE_TOTAL_DEADLINE_MS` (#11302), distinct
 *   from `archive_invalid`: the archive may be fine and the source merely too slow, so the
 *   actionable advice is "try again", not "check the file"
 */
export type PluginInstallErrorCode =
  | "lock_failed"
  | "archive_invalid"
  | "extraction_timeout"
  | "manifest_invalid"
  | "engine_incompatible"
  | "namespace_unauthorized"
  | "name_collision"
  | "hash_failed"
  | "unload_failed"
  | "swap_failed"
  | "swap_unrecoverable"
  | "load_failed"
  | "fetch_failed"
  | "fetch_timeout"
  | "size_exceeded"
  | "content_type_rejected";

/**
 * Structured install validation error. `path` is the JSON pointer segments
 * into `plugin.json` for `manifest_invalid` failures (empty for non-manifest
 * errors) so the dialog can highlight the offending field.
 */
export interface PluginInstallError {
  code: PluginInstallErrorCode;
  path?: string[];
  message: string;
}

/**
 * Result of a plugin install attempt. Returned as plain data (never thrown) so
 * structured validation errors survive Electron's structured-clone IPC boundary
 * intact (#3769). The discriminant is `status` rather than `ok` because
 * `ok`/`success` keys collide with the IPC success envelope and are rejected by
 * `ForbidIpcEnvelopeKeys` at the handler boundary.
 *
 * `installed`/`failed` are the terminal outcomes of {@link
 * PluginService.installPlugin}, reached by both the install-from-path
 * (drag-and-drop, #9295) and install-from-URL (F24) entry points, which run the
 * full atomic flow. The remaining statuses are produced by the thin install
 * entry points before that flow runs: `cancelled` is a user-dismissed file
 * picker (no message to show), `invalid-url` is a malformed or rejected URL, and
 * `not-implemented` is returned only by the native-file-picker path
 * (install-from-file, F21/F23) — the picker is wired but does not yet route the
 * chosen path into the installer.
 */
export type PluginInstallResult =
  | { status: "installed"; pluginId: string }
  | { status: "failed"; errors: PluginInstallError[] }
  | { status: "cancelled" }
  | { status: "invalid-url" }
  | { status: "not-implemented" };

/**
 * The `status` discriminant of {@link PluginInstallResult}. Exported so the
 * `daintree-plugin` CLI can type its install-response branches against the host
 * contract instead of a bare `string`, keeping the two sides from drifting.
 */
export type PluginInstallStatus = PluginInstallResult["status"];

/** Optional provenance hints recorded on a successful install. */
export interface PluginInstallOptions {
  /** How the install was initiated. Defaults to `"sideload"` when omitted. */
  source?: PluginInstallSource;
  /** Original download URL for catalog/url installs. Never logged. */
  originalUrl?: string | null;
  /**
   * Correlation id for progress reporting and cancellation (#11302). Minted by
   * the caller that wants feedback; omitting it installs exactly as before, just
   * without progress events or a cancel target. Not persisted.
   */
  jobId?: string;
}

/**
 * Coarse stage of an in-flight install (#11302). Deliberately a small fixed
 * sequence rather than the agent installer's raw stdout chunks — a plugin
 * install is a known series of steps, not a subprocess emitting text.
 *
 * `downloading` only occurs for install-from-URL. Everything through
 * `validating` is staged in a scratch directory and freely cancellable;
 * `activating` marks the commit point, past which cancellation is refused
 * because the swap and load are already underway.
 */
export type PluginInstallPhase = "downloading" | "extracting" | "validating" | "activating";

/** Progress push for an install started with a {@link PluginInstallOptions.jobId}. */
export interface PluginInstallProgressEvent {
  /** The `jobId` the caller supplied; events for other jobs must be ignored. */
  jobId: string;
  phase: PluginInstallPhase;
  /**
   * The archive entry currently being written, during `extracting` only.
   * Throttled — this is a liveness detail, not a complete log of every entry.
   */
  entry?: string;
  /** False once the install has passed the commit point and can no longer be cancelled. */
  cancellable: boolean;
}

export interface LoadedPluginInfo {
  manifest: PluginManifest;
  dir: string;
  loadedAt: number;
  /**
   * True for plugins loaded from the app-bundled `plugins/builtin/` directory.
   * Built-ins skip the install-time capability disclosure dialog and cannot be
   * uninstalled — they can only be disabled (effect on next startup).
   * Determined by load path, never declared in the manifest.
   */
  isBuiltin: boolean;
  /** How the plugin was installed. Built-ins always return `"builtin"`. */
  source: PluginInstallSource;
  /** When the plugin was first installed (record created). `0` for builtins. */
  installedAt: number;
  /**
   * When the plugin was last reinstalled over an existing install. `undefined`
   * for builtins and for plugins that have never been upgraded.
   */
  updatedAt?: number;
  /** SHA-256 of the `.dntr` archive at install time. `null` for builtins and dev-mode dir loads. */
  archiveHash: string | null;
  /** Original install URL. `null` for builtins and sideloads. Never logged to console. */
  originalUrl: string | null;
  /** Most recent activation error, or `null` if the last load succeeded. */
  loadError: PluginLoadError | null;
  /** Per-plugin disable state for non-builtins. Builtins use `disabledBuiltins` instead. */
  disabled: boolean;
  /** Set by the update-check job (F25). Reserved slot — `null` until F25 lands. */
  updateAvailable: PluginUpdateAvailable | null;
  /** Loaded from a directory outside the managed plugins dir (e.g. via `daintree-plugin` CLI dev command). */
  devMode: boolean;
  /**
   * True when the desired state (`disabled`) diverges from what's actually
   * running this session — i.e. the user toggled the plugin but the change
   * (load or unload) only takes effect on next launch. Drives the
   * "Restart required" cue. Recomputed on every `listPlugins()` call, so it
   * survives a Preferences-tab remount.
   */
  pendingRestart?: boolean;
  /**
   * Aggregate danger verdict for the plugin's declared capabilities, computed
   * once in the main process by `PluginService.listPlugins` from the flat
   * `CONFIRM_TRIGGERING_CAPABILITIES` set plus the compound-capability lattice
   * (`manifestTriggersCompoundElevation`). `"confirm"` means the plugin holds at
   * least one individually high-risk capability, or a compound pair the lattice
   * elevates (e.g. a sensitive read + an unconstrained network sink). The
   * renderer reads this for the manager's effective-danger summary instead of
   * re-deriving the lattice — the security logic stays single-source on main.
   * The flat high-risk set lives in `shared/config/pluginCapabilities.ts`
   * (`CONFIRM_TRIGGERING_CAPABILITIES`), shared with the MCP tier cap in
   * `PluginMcpTierAuth`; do not re-declare it anywhere else.
   */
  pluginDanger: "safe" | "confirm";
  /**
   * True when the plugin was refused at load time by the remote blocklist /
   * kill-switch (#10891) — its `manifest.name` matched a blocklist entry whose
   * version range covers `manifest.version`. Distinct from `disabled` (a
   * user-togglable Preferences state) and `loadError` (a technical activation
   * failure): this is a host-decided policy refusal the user cannot toggle off.
   * A blocklisted plugin is never registered in the running set — no `activate`
   * runs and it contributes no panels/actions — but it is still surfaced in the
   * Plugin Manager so the block is visible.
   */
  blocklisted: boolean;
  /**
   * Human-readable explanation for the block (from the matched entry's
   * `message`, falling back to its machine `reason`). `undefined` unless
   * `blocklisted` is true.
   */
  blocklistReason?: string;
}

export interface PluginIpcContext {
  projectId: string | null;
  worktreeId: string | null;
  webContentsId: number;
  pluginId: string;
}

export type PluginIpcHandler = (
  ctx: PluginIpcContext,
  ...args: unknown[]
) => unknown | Promise<unknown>;

/**
 * Typed channel handler bound by the second overload of
 * {@link PluginHostApi.registerHandler}. Receives the IPC context and the
 * single parsed args payload (post-Zod-validation). The variadic
 * {@link PluginIpcHandler} stays the canonical legacy shape; typed handlers
 * are adapted to it at registration time so the dispatch path is unchanged.
 */
export type PluginTypedIpcHandler<TArgs, TResult> = (
  ctx: PluginIpcContext,
  args: TArgs
) => TResult | Promise<TResult>;

/**
 * Per-channel schema bundle for typed `registerHandler` registrations. `args`
 * validates the single-payload dispatch input (`window.electron.plugin.invoke(
 * pluginId, channel, args)` — only the first argument is parsed). `result`
 * validates the handler's return value before it crosses back to the renderer
 * so a plugin's contract drift surfaces at the boundary instead of as a
 * mysterious downstream TypeError. `requires` lists the
 * {@link BuiltInPluginCapability} values the channel needs; the host rejects
 * registration if any are missing from the plugin's declared
 * `manifest.capabilities`, and re-checks at dispatch as defense-in-depth.
 */
export interface PluginChannelSchema<TArgs, TResult> {
  args: z.ZodType<TArgs>;
  result: z.ZodType<TResult>;
  requires?: readonly BuiltInPluginCapability[];
}

/**
 * Provider-agnostic projection of a worktree's linked forge resources (issue
 * and/or PR), exposed on {@link PluginWorktreeSnapshot.linked}. Replaces the
 * GitHub-shaped flat fields that previously leaked onto the snapshot —
 * plugins consuming linkage now route through a provider id and the shared
 * {@link ResourceRef} shape.
 */
export interface PluginWorktreeLinkedIssue {
  readonly ref: ResourceRef;
  readonly title?: string;
}

export interface PluginWorktreeLinkedPR {
  readonly ref: ResourceRef;
  readonly title?: string;
  readonly url: string;
  readonly state: NormalizedPRState;
  readonly ciStatus?: import("./forge.js").CIStatus;
  /** Branch this PR merges into (e.g. "develop"). Drives base-branch divergence display. */
  readonly baseRef?: string;
}

export interface PluginWorktreeLinked {
  readonly providerId: string;
  readonly issue?: PluginWorktreeLinkedIssue;
  readonly pr?: PluginWorktreeLinkedPR;
}

/**
 * Normalized change state for a single file in a worktree's git status,
 * exposed to plugins. Collapses the internal {@link import("./git.js").GitStatus}
 * vocabulary down to the five states a decoration/lint plugin acts on:
 * `copied` → `added`, `conflicted` → `modified`, and `ignored` files are
 * dropped from the projection entirely (a plugin scanning "what changed" never
 * wants ignored noise).
 */
export type PluginWorktreeFileState = "added" | "modified" | "deleted" | "untracked" | "renamed";

/** A single changed file in {@link PluginWorktreeStatus.files}. */
export interface PluginWorktreeStatusFile {
  /** Path relative to the worktree root, as git reports it. */
  readonly path: string;
  readonly state: PluginWorktreeFileState;
}

/**
 * Read-only projection of a worktree's polled git status — the *which files
 * changed* companion to {@link PluginWorktreeSnapshot}, sourced from the same
 * status the host already polls (no extra shell-out). Lets a plugin scan only
 * what changed instead of hand-rolling `git status`. `files` is sorted by path
 * for stable diffing; `counts` is the per-state tally over `files`.
 */
export interface PluginWorktreeStatus {
  readonly files: readonly PluginWorktreeStatusFile[];
  /** Total entries in `files` (post-`ignored` filtering). */
  readonly changedFileCount: number;
  readonly counts: Readonly<Record<PluginWorktreeFileState, number>>;
}

/**
 * Read-only, deep-frozen projection of a worktree exposed to plugins.
 * This is an explicit allowlist of fields from the internal WorktreeSnapshot;
 * do not add fields by spreading — every field must be intentionally exposed
 * so internal shape changes don't leak to third-party plugins.
 */
export interface PluginWorktreeSnapshot {
  readonly id: string;
  readonly worktreeId: string;
  readonly path: string;
  readonly name: string;
  readonly isCurrent: boolean;
  readonly branch?: string;
  readonly isMainWorktree?: boolean;
  readonly aheadCount?: number;
  readonly behindCount?: number;
  /**
   * Provider-agnostic projection of the worktree's linked forge resources
   * (issue and/or PR), or `null` when no resource is linked. Replaces the
   * removed GitHub-shaped `issueNumber` / `issueTitle` / `prNumber` / `prUrl`
   * / `prState` / `prTitle` fields.
   */
  readonly linked: PluginWorktreeLinked | null;
  readonly mood?: "stable" | "active" | "stale" | "error";
  /** Most recent valid dirty-file modification time or HEAD committer time (milliseconds since epoch) */
  readonly lastActivityTimestamp?: number | null;
  readonly createdAt?: number;
  /**
   * Projection of the worktree's polled git status — which files changed and a
   * per-state tally. Sourced from the host's existing status poll, so a plugin
   * can scan only the changed set without shelling out to `git status`.
   * `null` when the host hasn't computed a status for this worktree yet.
   */
  readonly status: PluginWorktreeStatus | null;
}

/**
 * Why {@link PluginWorktreesResult} could not name a worktree set (#12174).
 *
 * The argument-less {@link PluginHostApi.getWorktrees} collapses every one of
 * these to `[]`, which a plugin cannot tell apart from a project that genuinely
 * has no worktrees. The reasons are deliberately semantic rather than one
 * literal per internal branch: a plugin can act on "retry later" versus "this
 * project is gone", but nothing it can do differs between a workspace client
 * that is not wired yet and a workspace host that missed its readiness gate.
 * The finer diagnosis stays in Daintree's logs.
 *
 * - `plugin-unloaded` — the plugin unloaded (or was replaced by a same-id
 *   reload) before or during the read; a stale timer sees this
 * - `workspace-unavailable` — the workspace subsystem cannot answer yet: no
 *   client wired, no host serving the resolved window (a project still opening),
 *   or a host that never finished populating
 * - `scope-unresolved` — an unbound host found no focused project view to read
 *   on behalf of (common mid-project-switch)
 * - `project-unavailable` — a bound host's project cannot be resolved: the
 *   binding carries no root, or the project has closed and its workspace-host
 *   entry is gone
 * - `fetch-failed` — a read was attempted against a live host and threw
 */
export type PluginWorktreesUnavailableReason =
  | "plugin-unloaded"
  | "workspace-unavailable"
  | "scope-unresolved"
  | "project-unavailable"
  | "fetch-failed";

/**
 * Availability- and scope-aware outcome of a worktree read (#12174). Returned
 * as plain data (never thrown), like {@link PluginCheckUpdateResult} and
 * {@link PluginActivationResult}, so the structured result survives Electron's
 * structured-clone IPC boundary.
 *
 * This exists because `[]` is overloaded. {@link PluginHostApi.getWorktrees}
 * answers `[]` for an unloaded plugin, an unwired workspace client, an
 * unresolved window scope, a rootless or closed project, a failed read, *and*
 * for a project that really has no worktrees — seven states behind one value.
 * A plugin that treats "no match in the list" as proof its stored worktree is
 * gone will therefore false-positive during a project switch or after a wake.
 *
 * `status: "ok"` is the only authoritative answer, and it names `projectId` so
 * a plugin can also tell *which* project the list describes. That matters on
 * the unbound path: mid-switch the focused view can still be the outgoing
 * project, so a populated list that omits the worktree you are looking for may
 * simply belong to another project rather than confirm a mismatch. Compare
 * `projectId` before concluding anything from the contents.
 *
 * The `unavailable` variant deliberately carries no `projectId`: there is no
 * authoritative answer in that branch, so there is no project the absent
 * worktrees can be said to be absent *from*.
 */
export type PluginWorktreesResult =
  | {
      readonly status: "ok";
      /**
       * The project whose workspace host produced `worktrees`, as the host
       * itself knows it — captured from the entry that served this read, not
       * re-resolved from focus afterwards, so a switch that lands while the
       * read is in flight cannot relabel it.
       */
      readonly projectId: string;
      /** Authoritative for `projectId`. Empty means the project has no worktrees. */
      readonly worktrees: PluginWorktreeSnapshot[];
    }
  | {
      readonly status: "unavailable";
      readonly reason: PluginWorktreesUnavailableReason;
    };

/**
 * Read-only, frozen projection of an agent session's coarse state, exposed to
 * plugins behind the `agent:read` capability. This is an explicit allowlist of
 * fields from the internal `agent:state-changed` event payload; do NOT add
 * fields by spreading — every field must be intentionally exposed so internal
 * shape changes (and internal routing identifiers) don't leak to third-party
 * plugins. Observation only: nothing on this surface can drive, pause, resume,
 * or inject into an agent session.
 *
 * Deliberately omits the internal routing ids (`terminalId`, `worktreeId`,
 * `cwd`) and the activity-detector internals (`trigger`, `confidence`,
 * `temperature`, …): a plugin holding only `agent:read` has no declared
 * capability to access PTY/worktree internals, so exposing them here would let
 * it cross-reference state it can't otherwise reach.
 */
export interface PluginAgentSnapshot {
  /**
   * Stable id of the agent session, when the host could attribute the
   * transition to one. Absent for runtime-detected-only flows that route by
   * terminal rather than a resolved agent id.
   */
  readonly agentId?: string;
  /** Coarse lifecycle state: idle | working | waiting | directing | completed | exited. */
  readonly state: AgentState;
  /** The state the session transitioned away from. */
  readonly previousState: AgentState;
  /**
   * Convenience flag — `true` while the session is doing in-flight work
   * (`working` | `waiting` | `directing`), `false` otherwise. Derived from the
   * same `ACTIVE_AGENT_STATES` set the host uses, so a plugin doesn't have to
   * re-maintain the membership list.
   */
  readonly running: boolean;
  /** Why the session is waiting; present only when `state === "waiting"`. */
  readonly waitingReason?: WaitingReason;
  /** Cumulative session cost in USD; present only on `completed`/`exited` transitions. */
  readonly sessionCost?: number;
  /** Cumulative session token count; present only on `completed`/`exited` transitions. */
  readonly sessionTokens?: number;
  /** Unix timestamp in milliseconds when the transition was committed. */
  readonly timestamp: number;
}

/**
 * Options for {@link PluginHostApi.showToast}. Intentionally narrower than the
 * app's internal `notify()` surface: plugins cannot set `priority` (a
 * `priority:"low"` + `type:"error"` toast silently drops — see the lint rule at
 * `eslint.config.js`), pass a `ReactNode` message, or attach an action button
 * (plugins have no IPC channel to wire one to). `message` is namespaced with the
 * plugin's id (`{pluginId}: {message}`) by the host for provenance.
 */
export interface PluginToastOptions {
  /** Toast body. String only across the IPC boundary — no `ReactNode`. */
  message: string;
  /** Maps directly to the app's `NotificationType`. Defaults to `"info"`. */
  type?: NotificationType;
  /** Auto-dismiss delay in milliseconds. Defaults to the app's per-type default. */
  durationMs?: number;
}

/**
 * One selectable row in a {@link PluginHostApi.showQuickPick} list. `id` is the
 * stable identity used for selection tracking and search keys; `label` is the
 * primary line. `description` renders inline after the label (dimmed) and
 * `detail` on a second muted line — both are optional and searched when
 * {@link PluginQuickPickOptions.matchOnDescription} is set. All fields are plain
 * strings so the item survives the structured-clone IPC boundary.
 */
export interface PluginQuickPickItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
}

/** Options for {@link PluginHostApi.showQuickPick}. */
export interface PluginQuickPickOptions {
  /** Dialog title line. Defaults to a generic "Select an option". */
  title?: string;
  /** Search-input placeholder. */
  placeholder?: string;
  /** Allow selecting multiple items. Changes the resolved value to an array. */
  canSelectMany?: boolean;
  /** Also fuzzy-match against each item's `description`/`detail`, not just `label`. */
  matchOnDescription?: boolean;
}

/** Options for {@link PluginHostApi.showInputBox}. */
export interface PluginInputBoxOptions {
  /** Dialog title line. Defaults to a generic "Enter a value". */
  title?: string;
  /** Prompt text shown above the input describing what to enter. */
  prompt?: string;
  /** Placeholder shown in the empty input. */
  placeholder?: string;
  /** Pre-filled initial value. */
  value?: string;
  /** Render the input as a password field (masked). */
  password?: boolean;
  /**
   * Regular-expression source string the entered value must match before the
   * input can be submitted. Validated client-side at submit time (no per-keystroke
   * IPC round-trip); an invalid pattern is ignored rather than blocking the user.
   */
  validationPattern?: string;
  /** Message shown when {@link validationPattern} fails. Defaults to a generic hint. */
  validationMessage?: string;
}

/** Options for {@link PluginHostApi.showConfirm}. */
export interface PluginConfirmOptions {
  /** Dialog title — a sentence-case question naming the entity (e.g. `Delete 'foo'?`). */
  title: string;
  /** Body text stating the specific consequence of confirming. */
  message?: string;
  /**
   * Primary-button label. For a {@link destructive} confirm use a verb-noun
   * label (e.g. `Delete file`), never a bare `OK`/`Confirm`. Defaults to `Confirm`.
   */
  confirmLabel?: string;
  /** Secondary-button label. Defaults to `Cancel`. */
  cancelLabel?: string;
  /** Style the primary button as destructive (red) to signal an irreversible action. */
  destructive?: boolean;
}

/**
 * Runtime handler bound to a plugin-registered action via
 * {@link PluginHostApi.registerAction}. Receives the dispatch args payload
 * (the renderer-side synthetic action forwards a single args object) and
 * returns the action's result. Unlike {@link PluginIpcHandler} it does NOT
 * receive an IPC context — action handlers are addressed by action id, not by
 * a per-invocation channel context. The closure lives only in main and never
 * crosses the IPC boundary.
 */
export type ActionHandler = (args: unknown) => unknown | Promise<unknown>;

/**
 * Execution backend for a managed process (#11300, #11871).
 *
 * - `pipe` (the default): a plain child process with stdin closed and
 *   stdout/stderr piped. Output arrives split by stream.
 * - `duplex`: as `pipe`, but stdin is piped too, so the child can be driven via
 *   {@link PluginDuplexProcessHandle.write}. stdout and stderr stay separate.
 *   This is the mode for a child speaking a protocol over stdio — MCP, LSP and
 *   ACP servers all carry JSON-RPC on stdout while using stderr for
 *   diagnostics, so they need a writable input AND an output stream the
 *   diagnostics are not mixed into. The host stays framing-agnostic: MCP and
 *   ACP delimit messages with newlines, LSP with `Content-Length` headers, and
 *   the plugin implements whichever its child speaks.
 * - `pty`: the command runs under a real pseudo-terminal, so it sees a TTY,
 *   accepts input via {@link PluginPtyProcessHandle.write}, and can be resized.
 *   A PTY merges stdout and stderr into one stream by construction.
 */
export type PluginProcessMode = "pipe" | "duplex" | "pty";

/**
 * One chunk of output from a managed process, delivered to
 * {@link PluginProcessHandle.onData}.
 */
export interface PluginProcessDataChunk {
  /**
   * `stdout` / `stderr` in pipe and duplex mode — both keep the child's two
   * output streams apart. `data` in PTY mode only: a pseudo-terminal has a
   * single combined stream, so there is no split to report.
   */
  readonly stream: "stdout" | "stderr" | "data";
  /** The decoded UTF-8 chunk. */
  readonly chunk: string;
}

/**
 * Options for {@link PluginProcessApi.spawn} in the default pipe mode. All
 * fields are optional; `command` is the positional first argument. The host
 * anchors a relative spawn against `cwd` (defaulting to the active worktree
 * path, then the process cwd).
 *
 * The child does NOT inherit the host environment. It is built from a fixed
 * allowlist of essentials (PATH, HOME, locale, temp dir, and the Windows keys a
 * child cannot run without) plus whatever this call passes in {@link env} — so
 * a plugin never receives the main process's tokens, and anything else the
 * command needs must be handed to it explicitly.
 */
export interface PluginProcessSpawnOptions {
  /** Argument vector. Each entry is passed verbatim — no shell interpolation. */
  args?: string[];
  /** Working directory for the child. Defaults to the active worktree, then the host cwd. */
  cwd?: string;
  /**
   * Environment entries applied over the host's safe-key allowlist. These are
   * additions to a minimal base, NOT overrides on the full host environment —
   * a key the plugin does not pass and the allowlist does not cover is absent.
   */
  env?: Record<string, string>;
  /**
   * Execution backend. Omit (or pass `"pipe"`) for the default piped child.
   * Pass `"duplex"` ({@link PluginDuplexProcessSpawnOptions}) to also get a
   * writable stdin, or `"pty"` ({@link PluginPtyProcessSpawnOptions}) for a
   * pseudo-terminal.
   */
  mode?: "pipe";
  /**
   * Route this process's stream events to a single panel instead of every panel
   * the plugin owns. `undefined` / `null` broadcast, matching `postToPanel`.
   */
  panelId?: string | null;
}

/**
 * Options for a stdio-driven {@link PluginProcessApi.spawn}. Same anchoring and
 * environment rules as {@link PluginProcessSpawnOptions} — the only difference
 * is that stdin is piped rather than closed. Selecting `mode: "duplex"` narrows
 * the returned handle to {@link PluginDuplexProcessHandle}.
 */
export interface PluginDuplexProcessSpawnOptions extends Omit<PluginProcessSpawnOptions, "mode"> {
  mode: "duplex";
}

/**
 * Options for an interactive {@link PluginProcessApi.spawn}. Same anchoring and
 * environment rules as {@link PluginProcessSpawnOptions}, plus the initial
 * terminal size. Selecting `mode: "pty"` narrows the returned handle to
 * {@link PluginPtyProcessHandle}.
 */
export interface PluginPtyProcessSpawnOptions extends Omit<PluginProcessSpawnOptions, "mode"> {
  mode: "pty";
  /** Initial column count. Defaults to 80. Must be a positive integer. */
  cols?: number;
  /** Initial row count. Defaults to 24. Must be a positive integer. */
  rows?: number;
}

/**
 * Live handle to a process spawned via {@link PluginProcessApi.spawn}. The
 * handle's `id` keys the stream events fanned out to the plugin's panels over
 * `postToPanel("process", …)` (see {@link import("./ipc/pluginProcess.js").PluginProcessStreamEvent}).
 *
 * `kill()` SIGTERMs the child and escalates to SIGKILL after a grace period;
 * `restart()` kills the current child and respawns it with the same
 * command/args/cwd/env, reusing the same handle id and bumping its restart
 * counter. Both are safe to call after the process has already exited (no-op).
 * `onExit`/`onCrash` register lifecycle callbacks carrying the real exit
 * code/signal — `onCrash` fires only on a non-zero / signalled exit the plugin
 * did not request, `onExit` fires on every termination. Callbacks registered
 * after the process has already terminated are invoked on the next microtask
 * with the recorded outcome, so a late subscriber never misses the event.
 */
export interface PluginProcessHandle {
  /** Host-assigned opaque id, stable across `restart()`. */
  readonly id: string;
  /**
   * Terminate the process: clean `SIGTERM`, then `SIGKILL` after the host grace
   * period if it hasn't exited. No-op if already terminated.
   */
  kill(): void;
  /**
   * Kill the current child (if any) and respawn with the same
   * command/args/cwd/env. Resolves once the new child is spawned. Reuses this
   * handle id and increments its restart counter.
   */
  restart(): Promise<void>;
  /** Register a callback fired on any termination. Returns a disposer. */
  onExit(callback: (info: { exitCode: number | null; signal: string | null }) => void): () => void;
  /**
   * Register a callback fired only on an unexpected termination (non-zero exit
   * code or a signal the plugin did not request via `kill()`). Returns a disposer.
   */
  onCrash(callback: (info: { exitCode: number | null; signal: string | null }) => void): () => void;
  /**
   * Receive the process's output in the plugin's own code (#11300) — the
   * counterpart to the panel stream, for a plugin that needs to parse what it
   * spawned (a `--machine`-mode daemon's line-delimited JSON, say) rather than
   * just display it. Returns a disposer.
   *
   * Output produced before the first subscriber attaches is buffered (bounded)
   * and replayed on subscription, so a daemon that greets immediately is not
   * missed by a callback registered on the next tick. Once any subscriber has
   * attached, delivery is live-only. Panel streaming is unaffected either way.
   */
  onData(callback: (chunk: PluginProcessDataChunk) => void): () => void;
}

/**
 * A {@link PluginProcessHandle} for a process whose input the plugin can drive
 * — spawned with `mode: "duplex"` (stdin piped, stdout/stderr still separate)
 * or `mode: "pty"` (a pseudo-terminal, which also brings `resize`).
 *
 * `write()` is fire-and-forget and never throws: it is a no-op once the process
 * has exited or its input has closed, mirroring `kill()`. It is safe to call
 * immediately after `spawn()` resolves.
 */
export interface PluginDuplexProcessHandle extends PluginProcessHandle {
  /**
   * Write to the child's input. Passed through verbatim — the host adds no
   * framing, so the caller emits whatever its protocol expects: a newline
   * terminator for NDJSON (`JSON.stringify(msg) + "\n"`), or a
   * `Content-Length` header block for LSP.
   *
   * Framing is the caller's job in both directions: {@link PluginProcessHandle.onData}
   * delivers raw chunks that may split or coalesce protocol frames, so the
   * plugin does its own buffering and message splitting.
   *
   * Fire-and-forget: the write is queued on the child's stdin and the
   * backpressure signal is not surfaced. That suits the low-volume
   * control-plane traffic this is built for; a plugin that streams bulk data
   * faster than the child reads it will grow that buffer unboundedly.
   */
  write(data: string): void;
}

/**
 * A {@link PluginDuplexProcessHandle} for a process spawned with `mode: "pty"`.
 * Adds the one operation only a pseudo-terminal makes possible on top of
 * `write()`: telling the child the window changed size.
 *
 * Like `write()`, `resize()` is a no-op once the process has exited and is safe
 * to call immediately after `spawn()` resolves. A `resize()` issued while a
 * `restart()` is still allocating the replacement PTY is retained (last write
 * wins) and folded into that PTY's initial size rather than replayed as a late
 * SIGWINCH.
 */
export interface PluginPtyProcessHandle extends PluginDuplexProcessHandle {
  /** Report a new terminal size to the child. Both values must be positive integers. */
  resize(cols: number, rows: number): void;
}

/**
 * Managed-process surface on {@link PluginHostApi.process}. Gated on the
 * declared `shell:exec` capability — `spawn` from a plugin that did not declare
 * it rejects with a `PERMISSION_REQUIRED:` error (the first runtime enforcement
 * of a scope capability). Spawns are surfaced in the plugin audit trail.
 *
 * NOT revoke-guarded: a process orchestrator spawns and respawns from timers
 * and subscription callbacks long after `activate()`. Liveness is plugin
 * membership — once the plugin unloads every outstanding process is torn down
 * and a further `spawn` rejects.
 */
export interface PluginProcessApi {
  /**
   * Spawn the command under a real pseudo-terminal. The returned handle adds
   * `write()` and `resize()`; output arrives as a single combined stream on
   * `onData()` and as `{ kind: "data" }` panel events. The PTY is allocated in
   * the crash-isolated pty-host utility process, so a native failure cannot
   * take the app down with it.
   */
  spawn(command: string, options: PluginPtyProcessSpawnOptions): Promise<PluginPtyProcessHandle>;
  /**
   * Spawn a child with its stdin piped as well as its stdout/stderr, and return
   * a handle that adds `write()`. Use this to drive a command that speaks a
   * protocol over stdio — an MCP, LSP or ACP server, or anything else carrying
   * JSON-RPC — where the reply stream must stay free of the diagnostics the
   * child writes to stderr. Output arrives split by stream on
   * {@link PluginProcessHandle.onData}, exactly as in pipe mode; the host does
   * no framing, so the plugin owns buffering and message splitting.
   *
   * Rejects on the same conditions as the pipe-mode overload.
   */
  spawn(
    command: string,
    options: PluginDuplexProcessSpawnOptions
  ): Promise<PluginDuplexProcessHandle>;
  /**
   * Spawn a child process on the plugin's behalf and return a live handle. The
   * child's stdout/stderr stream to the plugin's panels over
   * `postToPanel("process", …)` keyed by the handle id (targeted at
   * `options.panelId` when given, broadcast otherwise), and to the plugin's own
   * code via {@link PluginProcessHandle.onData}. Rejects when the plugin lacks
   * `shell:exec`, when the per-plugin concurrency cap is reached, or when the
   * plugin has been unloaded.
   */
  spawn(command: string, options?: PluginProcessSpawnOptions): Promise<PluginProcessHandle>;
}

/** One directory entry returned by {@link PluginFsApi.readdir}. */
export interface PluginFsDirEntry {
  /** Entry name (basename only — never a path). */
  name: string;
  /** True when the entry is a directory. */
  isDirectory: boolean;
  /** True when the entry is a regular file. */
  isFile: boolean;
  /** True when the entry is a symbolic link (resolved containment still applies on read). */
  isSymbolicLink: boolean;
}

/** File metadata returned by {@link PluginFsApi.stat}. */
export interface PluginFsStat {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  /** Size in bytes. */
  size: number;
  /** Last-modified time, epoch milliseconds. */
  mtimeMs: number;
}

/**
 * Host-mediated, scope-contained filesystem surface on {@link PluginHostApi.fs}.
 *
 * Every path argument is resolved against the plugin's declared
 * `scopes.fs.allowedPaths` and realpath-contained to one of those roots before
 * any I/O — a traversal (`..`) or a symlink that escapes a root is rejected,
 * mirroring the `plugin://` protocol handler's discipline. This is the runtime
 * enforcement of `scopes.fs.allowedPaths` (previously advisory-only).
 *
 * Reads are gated on `fs:project-read` / `fs:user-data-read`; writes on
 * `fs:project-write` / `fs:user-data-write`. A plugin missing the relevant
 * capability is rejected with a `PERMISSION_REQUIRED:` prefix (the same prefix
 * `useHostChannel` discriminates on); a path outside every allowed root is
 * rejected with a `PATH_NOT_ALLOWED:` prefix. Writes are recorded in the plugin
 * audit trail.
 *
 * Unlike the global `files.read` IPC, {@link readFile} carries NO 500KB / binary
 * cap — it is a deliberate plugin API, not the size-limited preview path.
 *
 * NOT revoke-guarded: a plugin reads/writes from timers and subscription
 * callbacks long after `activate()`. Liveness is plugin membership — once the
 * plugin unloads every method rejects and any active {@link watch} is torn down.
 */
export interface PluginFsApi {
  /**
   * Read a file as UTF-8 text. Resolves the contained absolute path; rejects on
   * a missing read capability, an out-of-scope path, or a non-file target. Pass
   * `options.signal` to cancel a read that is no longer needed.
   */
  readFile(filePath: string, options?: PluginHostCallOptions): Promise<string>;
  /**
   * Write UTF-8 text to a file, creating it if absent (parent directories must
   * already exist within scope). Rejects on a missing write capability or an
   * out-of-scope path. Recorded in the audit trail. No cancellation signal —
   * partial-write semantics are deliberately out of scope.
   */
  writeFile(filePath: string, contents: string): Promise<void>;
  /** List a directory's immediate children. Rejects on a missing read capability or an out-of-scope path. */
  readdir(dirPath: string, options?: PluginHostCallOptions): Promise<PluginFsDirEntry[]>;
  /** Stat a path. Rejects on a missing read capability or an out-of-scope path. */
  stat(targetPath: string, options?: PluginHostCallOptions): Promise<PluginFsStat>;
  /**
   * Watch one or more contained paths for changes, invoking `callback` with the
   * changed absolute path. `paths` are each resolved and contained at
   * subscription time; an out-of-scope or missing-capability path rejects.
   * Resolves to a disposer that tears the watcher down; all watchers are
   * automatically torn down on unload. Rejects on a missing read capability so
   * authoring mistakes surface loudly. Pass `options.signal` to abort the
   * subscription attempt before it is wired.
   */
  watch(
    paths: string[],
    callback: (changedPath: string) => void,
    options?: PluginHostCallOptions
  ): Promise<() => void>;
}

/** A single changed file in {@link PluginGitApi.status}. Mirrors {@link PluginWorktreeStatusFile}. */
export type PluginGitStatusFile = PluginWorktreeStatusFile;

/** Result of {@link PluginGitApi.status}. */
export interface PluginGitStatus {
  /** Absolute worktree path the status was read for. */
  worktreePath: string;
  files: PluginGitStatusFile[];
  changedFileCount: number;
}

/**
 * Options for {@link PluginGitApi.commit}. The host enforces the #7880 / D2
 * change-preview safeguard at the host layer: `commit` refuses without an
 * explicit, non-empty `message` — there is no silent fallback to a derived
 * commit message — and the host computes the real staged diff as the preview
 * (returned in {@link PluginGitCommitResult}) before mutating.
 */
export interface PluginGitCommitOptions {
  /**
   * Commit message. MUST be a non-empty string the plugin explicitly authored —
   * the host rejects an empty/whitespace message rather than substituting a
   * derived one (the #7880 root-cause guard).
   */
  message: string;
}

/** Result of {@link PluginGitApi.commit}. */
export interface PluginGitCommitResult {
  /** Short SHA of the new commit. */
  commit: string;
  /** The committed message (echoed back for confirmation). */
  message: string;
  /**
   * The host-computed staged diff that was committed — the real change preview
   * the D2 safeguard requires. A plugin UI can surface this to the user.
   */
  preview: string;
}

/**
 * Host-mediated git surface on {@link PluginHostApi.git}, scoped to a worktree
 * the plugin may access (the `worktreePath` must resolve inside the plugin's
 * `scopes.fs.allowedPaths`). Implemented over the existing hardened simple-git
 * service — not a reinvented git layer.
 *
 * Reads ({@link status}, {@link diff}) are gated on `git:read`; mutations
 * ({@link add}, {@link commit}) on `git:write`. A missing capability rejects
 * with a `PERMISSION_REQUIRED:` prefix; an out-of-scope `worktreePath` with a
 * `PATH_NOT_ALLOWED:` prefix. {@link commit} additionally enforces the host-side
 * change-preview safeguard (see {@link PluginGitCommitOptions}). Mutations are
 * recorded in the plugin audit trail.
 *
 * NOT revoke-guarded — same lifetime/membership semantics as {@link PluginFsApi}.
 */
export interface PluginGitApi {
  /** Changed-file status for the worktree. Gated on `git:read`. Pass `options.signal` to cancel. */
  status(worktreePath: string, options?: PluginHostCallOptions): Promise<PluginGitStatus>;
  /**
   * Unified diff for the worktree (or one `filePath` relative to it). Returns
   * the raw diff text. Gated on `git:read`. Pass `options.signal` to cancel.
   */
  diff(worktreePath: string, filePath?: string, options?: PluginHostCallOptions): Promise<string>;
  /**
   * Stage paths (relative to `worktreePath`, or all changes when omitted).
   * Gated on `git:write`. Recorded in the audit trail. Pass `options.signal` to cancel.
   */
  add(worktreePath: string, paths?: string[], options?: PluginHostCallOptions): Promise<void>;
  /**
   * Commit staged changes. Gated on `git:write`. Refuses without an explicit
   * non-empty {@link PluginGitCommitOptions.message} — no silent fallback (the
   * #7880 guard) — and returns the real staged diff as a change preview.
   * Recorded in the audit trail. Pass `callOptions.signal` to cancel before the
   * commit is created.
   */
  commit(
    worktreePath: string,
    options: PluginGitCommitOptions,
    callOptions?: PluginHostCallOptions
  ): Promise<PluginGitCommitResult>;
}

/**
 * Host-mediated access to the OS clipboard, backing the `clipboard:read` /
 * `clipboard:write` capability tokens. The *read* surface is deliberately
 * text-only — omitting image/HTML/file-list reads is what stops a plugin
 * smuggling out richer payloads than it declared. Writes carry no such risk
 * (the plugin already has the bytes), so a bounded {@link writeImage} is
 * offered alongside {@link writeText}; there is still no HTML or file-list
 * write. Every method runs in the main process (Electron's `clipboard` module
 * is unavailable in the plugin utility worker), so they remain callable from a
 * headless plugin with no mounted panel.
 *
 * Like {@link PluginFsApi} and {@link PluginGitApi} this is NOT revoke-guarded:
 * plugins read/write from post-activation timers and callbacks. Once the plugin
 * is unloaded every method rejects.
 */
export interface PluginClipboardApi {
  /**
   * Replace the clipboard's contents with `text`. Gated on `clipboard:write`.
   * Rejects with a `PAYLOAD_TOO_LARGE:` prefix when `text` exceeds 8 MiB by
   * UTF-8 byte count (mirroring the renderer IPC clipboard guard).
   */
  writeText(text: string): Promise<void>;
  /**
   * Replace the clipboard's contents with a PNG image. Gated on the same
   * `clipboard:write` token as {@link writeText} — putting an image on the
   * clipboard is no less reversible than putting text there, so it earns no
   * separate capability and does not elevate action danger.
   *
   * `pngData` must be the raw PNG bytes. Rejects with a `PAYLOAD_TOO_LARGE:`
   * prefix above 20 MiB (matching the renderer IPC clipboard guard) and with a
   * `VALIDATION:` prefix when the bytes don't decode to a non-empty image —
   * Electron's `nativeImage.createFromBuffer` reports malformed input by
   * returning an empty image rather than throwing, so the emptiness check is
   * the only signal available. Successful writes append an audit record
   * carrying the byte count only, never the image bytes.
   *
   * Decoding happens in the main process by necessity: the renderer's
   * `navigator.clipboard.write()` path crashes on Linux with binary PNG
   * payloads (#4900), so this is the only safe route for image writes.
   */
  writeImage(pngData: Uint8Array): Promise<void>;
  /**
   * Read the clipboard's text contents. Gated on `clipboard:read`. Resolves to
   * `""` when the clipboard is empty or holds non-text content (image, file
   * list) — it never rejects on content type.
   */
  readText(): Promise<string>;
}

/**
 * Host-mediated OS "reveal / open with the default app" surface (#11299).
 *
 * Exists because the renderer's built-in `system.openPath` action validates
 * against the *user's* roots — open projects, tracked worktrees, Electron's
 * `userData` — and carries no caller identity, so a plugin dispatching it
 * cannot reach the one directory that is unambiguously its own:
 * `~/.daintree/plugin-data/<plugin-id>/`. A plugin that just wrote a
 * screenshot there had no sanctioned way to reveal it, and shelled out to
 * `/usr/bin/open` instead — trading a contained call for arbitrary execution.
 *
 * Both methods resolve paths against the calling plugin's *declared* filesystem
 * scope (`scopes.fs.allowedPaths` plus its implicit plugin-data namespace), and
 * the plugin id is bound at host construction rather than travelling as an
 * argument, so one plugin can never name another's namespace. Containment is
 * realpath-based, so a symlink cannot walk out of scope. Gated on the `fs:*`
 * capability matching the resolved root's class: revealing something under the
 * plugin-data namespace needs `fs:user-data-read` or `fs:user-data-write`,
 * under a project root `fs:project-read` or `fs:project-write` — a plugin that
 * could legitimately create the file can always reveal it.
 *
 * Like {@link PluginFsApi} this is NOT revoke-guarded, and every method rejects
 * once the plugin is unloaded.
 */
export interface PluginSystemApi {
  /**
   * Open `targetPath` with the OS default application. Rejects paths outside
   * the plugin's declared scope (`OUTSIDE_ROOT:`), non-absolute or unresolvable
   * paths (`INVALID_PATH:`), and executable file types (`.app`, `.exe`, `.sh`,
   * … — checked on both the raw path and its realpath target, so a benignly
   * named symlink cannot smuggle a launch primitive past the deny-list).
   */
  openPath(targetPath: string): Promise<void>;
  /**
   * Reveal `targetPath` in the OS file manager, selecting it. Same containment
   * and capability rules as {@link openPath}, but without the executable
   * deny-list: revealing a file in Finder/Explorer shows it, it does not run
   * it. The path must exist.
   */
  showItemInFolder(targetPath: string): Promise<void>;
}

/**
 * The revoke-guarded slice of {@link PluginHostApi}: the registration methods
 * that are only valid during `activate()`. The host revokes this surface once
 * activation resolves or times out — every method here throws if called
 * afterward (e.g. from a subscription callback or timer). The split is
 * extracted into its own interface so the activation-window contract is visible
 * at the type level, not only in JSDoc and prose docs.
 *
 * {@link PluginHostApi} extends this, so the `host` handed to `activate()`
 * exposes both these registration methods and the post-activation-safe methods.
 * Type a helper that should only ever register-during-activation as
 * `PluginActivationApi` to make the narrower contract explicit at its call
 * sites. The post-activation-safe methods ({@link PluginHostApi.showToast},
 * {@link PluginHostApi.dispatch}, {@link PluginHostApi.invalidateFileDecorations},
 * {@link PluginHostApi.logger}, and the worktree accessors `getActiveWorktree`
 * /`getWorktrees`) live on {@link PluginHostApi} directly and remain callable
 * for the plugin's whole lifetime. Note the worktree *subscriptions*
 * (`onDidChangeActiveWorktree`/`onDidChangeWorktrees`) and `settings.onDidChange`
 * are revoke-guarded — subscribing is an activation-window operation even though
 * the callbacks fire later.
 */
export interface PluginActivationApi {
  /**
   * Imperatively register an action with a main-side handler. The
   * `descriptor.id` must NOT include the plugin prefix — the host namespaces
   * it as `{pluginId}.{descriptor.id}` at runtime. `descriptor.danger` accepts
   * `"safe"` or `"confirm"`; `"restricted"` is rejected. The host raises the
   * effective danger to `"confirm"` when the plugin holds a high-risk
   * capability, mirroring {@link PluginActionDescriptor.effectiveDanger}.
   * Calling with a previously-registered id replaces the prior descriptor and
   * handler. Must be called during `activate()` — the host is revoked once
   * activation resolves or times out. Unregistered automatically on unload.
   *
   * Resolves once the registration is accepted. The revoke / validation guard
   * still throws synchronously, so a rejected registration surfaces both as a
   * synchronous throw at the call site and is reflected by the promise.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerAction(descriptor: PluginActionContribution, handler: ActionHandler): Promise<void>;
  /**
   * Bind a typed IPC handler whose args and result are validated against the
   * provided Zod schemas, gated on the listed plugin capabilities. The host
   * rejects registration if any `schema.requires` capability is missing from
   * `manifest.capabilities` (fail-closed at the registration boundary). At
   * dispatch the args are `safeParse`d, the handler is invoked with the
   * parsed payload, and the result is `safeParse`d before returning to the
   * renderer. Schema failures throw with a `SCHEMA_ERROR:` prefix; missing
   * capabilities throw with a `PERMISSION_REQUIRED:` prefix — the
   * renderer-side `useHostChannel` hook discriminates on these prefixes.
   *
   * Must be called during `activate()`.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerHandler<TArgs, TResult>(
    channel: string,
    schema: PluginChannelSchema<TArgs, TResult>,
    handler: PluginTypedIpcHandler<TArgs, TResult>
  ): Promise<void>;
  /**
   * Legacy untyped overload: a variadic handler with no host-side validation.
   * Retained for plugins that haven't migrated to per-channel schemas. The
   * typed overload above is preferred for new code. Also revoke-guarded — must
   * be called during `activate()`.
   */
  registerHandler(channel: string, handler: PluginIpcHandler): Promise<void>;
  /**
   * Push a fire-and-forget payload to all renderers listening on `channel`.
   * Intended for the activation window — wiring up the renderer-side view of a
   * plugin's state before `activate()` returns.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the broadcast is rejected.
   */
  broadcastToRenderer(channel: string, payload: unknown): Promise<void>;
  /**
   * Bind a runtime {@link ForgeProviderImpl} to the descriptor declared in
   * `contributes.forgeProviders`. The descriptor's `id` is namespaced to the
   * plugin at runtime as `{pluginId}.{descriptor.id}`. Returns a disposer that
   * unbinds the single implementation; all bindings are automatically removed
   * when the plugin is unloaded. Must be called during `activate()` — the
   * host is revoked once activation resolves or times out.
   *
   * The `descriptor.id` must match an entry declared in
   * `contributes.forgeProviders`; an undeclared id is rejected so the impl
   * cannot drift away from the manifest-driven routing table. Calling this
   * method twice with the same `descriptor.id` overwrites the prior binding;
   * the older disposer becomes inert and will not remove the newer impl when
   * later invoked.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerForgeProvider(
    descriptor: ForgeProviderDescriptor,
    impl: ForgeProviderImpl
  ): Promise<() => void>;
  /**
   * Bind a runtime {@link FileDecorationProviderImpl} to a descriptor declared
   * in `contributes.fileDecorationProviders`. The descriptor's `id` is
   * namespaced at runtime as `{pluginId}.{descriptor.id}` and must match an
   * entry in the manifest — an undeclared id is rejected so the impl cannot
   * drift away from the manifest-driven scope-routing table. Returns a
   * disposer that unbinds the single implementation; all bindings are
   * automatically removed when the plugin is unloaded. Must be called during
   * `activate()` — the host is revoked once activation resolves or times out.
   * Calling this twice with the same `descriptor.id` overwrites the prior
   * binding; the older disposer becomes inert.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and registration is rejected.
   */
  registerFileDecorationProvider(
    descriptor: FileDecorationProviderDescriptor,
    impl: FileDecorationProviderImpl
  ): Promise<() => void>;
  /**
   * Subscribe to active-worktree changes. The callback fires with the new
   * active snapshot (or `null` when none is active). Returns a disposer;
   * calling it more than once is a no-op. All subscriptions are automatically
   * disposed when the plugin is unloaded.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected.
   */
  onDidChangeActiveWorktree(
    callback: (snapshot: PluginWorktreeSnapshot | null) => void
  ): Promise<() => void>;
  /**
   * Subscribe to the worktree set changing. The callback fires with the full
   * current list on any worktree add/update/remove. Resolves to a disposer;
   * calling it more than once is a no-op. All subscriptions are automatically
   * disposed when the plugin is unloaded.
   *
   * Pass `options.debounceMs` to coalesce bursts (the host re-emits on every
   * git-status poll) into a single trailing callback — see
   * {@link PluginHostSubscriptionOptions}. Omitted means fire on every change.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected.
   */
  onDidChangeWorktrees(
    callback: (snapshots: PluginWorktreeSnapshot[]) => void,
    options?: PluginHostSubscriptionOptions
  ): Promise<() => void>;
  /**
   * Subscribe to agent-session state changes, gated on the `agent:read`
   * capability. The callback fires with a frozen {@link PluginAgentSnapshot}
   * on every accepted agent state transition across all sessions (unscoped,
   * like {@link onDidChangeWorktrees} — a plugin filters by `snapshot.agentId`
   * if it cares about one session). Resolves to a disposer; calling it more
   * than once is a no-op. All subscriptions are automatically disposed when the
   * plugin is unloaded.
   *
   * Observation only — there is no companion method to drive, pause, resume, or
   * inject into a session.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare the
   *   `agent:read` capability, or if called after activation resolves or times
   *   out (the host is revoked).
   */
  onDidChangeAgentState(callback: (snapshot: PluginAgentSnapshot) => void): Promise<() => void>;
  /**
   * Subscribe to panel lifecycle transitions for this plugin's own contributed
   * panels (#11301). No capability is required — a plugin only ever sees events
   * for panel instances of kinds it contributed itself.
   *
   * This is how a worker learns the difference a view's `disposeSignal` cannot
   * express: that signal aborts for a temporary unmount (sibling maximize,
   * inactive dock tab, cached project view) exactly as it does for a permanent
   * close, so a worker that treats it as deletion tears down durable resources
   * the user still wants. Keep those resources in the worker and release them on
   * `"removed"` — the terminal phase — rather than guessing from the view.
   *
   * On subscribe the host replays the current phase of every live panel of this
   * plugin, so a plugin that activated lazily *because* a view opened still sees
   * that panel's state. One-shot transitions (`"restored"`) are not replayed.
   *
   * Callbacks receive a frozen {@link PluginPanelLifecycleEvent}. Resolves to a
   * disposer; calling it more than once is a no-op, and all subscriptions are
   * disposed automatically when the plugin is unloaded.
   *
   * Subscribing is revoke-guarded — call it during `activate()`. The callback
   * itself fires for the plugin's whole lifetime; only the act of subscribing
   * is restricted to the activation window.
   *
   * @throws {Error} If called after activation resolves or times out — the host
   *   is revoked and the subscription is rejected.
   */
  onDidChangePanelLifecycle(
    callback: (event: PluginPanelLifecycleEvent) => void
  ): Promise<() => void>;
}

/**
 * The full host surface handed to a plugin's `activate()`. Extends
 * {@link PluginActivationApi} (the revoke-guarded registration methods, valid
 * only during activation) with the post-activation-safe methods below, which
 * remain callable from subscription callbacks and timers for the plugin's whole
 * lifetime and degrade to a no-op once the plugin is unloaded.
 */
/**
 * Built-in action catalog surface on {@link PluginHostApi.actions} (#10561).
 * Projects the app's `ActionService` manifest to plugins so an orchestration
 * plugin can discover what `host.dispatch()` accepts — the ids, arg schemas, and
 * danger classification — without reading Daintree's source.
 *
 * Like {@link PluginHostApi.dispatch} this is NOT revoke-guarded: plugins
 * introspect from post-activation command handlers and timers. Once the plugin
 * is unloaded `list()` resolves `[]` and `get()` / `canDispatch()` resolve as if
 * the action were absent (`null` / `"restricted"`) — these never throw.
 */
export interface PluginHostActionsApi {
  /**
   * List every plugin-dispatchable action as a slim
   * {@link PluginActionManifestEntry}. Mirrors `ActionService.list()`:
   * `danger:"restricted"` actions are filtered out, so listed entries are always
   * `"safe"` or `"confirm"`. Resolves `[]` when no renderer is available or the
   * plugin has been unloaded.
   */
  list(): Promise<PluginActionManifestEntry[]>;
  /**
   * Look up a single action by id, or `null` when it doesn't exist or is
   * `danger:"restricted"` (restricted actions are invisible to plugins, matching
   * {@link list}). Prefer this over {@link list} for a single lookup — it avoids
   * projecting the whole catalog.
   */
  get(actionId: ActionId): Promise<PluginActionManifestEntry | null>;
  /**
   * Pre-flight a dispatch without triggering it: `"ok"` for a safe action,
   * `"confirm"` for a confirm-gated one (which {@link PluginHostApi.dispatch}
   * would reject with `CONFIRMATION_REQUIRED`), and `"restricted"` for an
   * unknown or `danger:"restricted"` action. Lets a plugin warn the user before
   * triggering a confirm prompt. See {@link PluginCanDispatchResult}.
   */
  canDispatch(actionId: ActionId): Promise<PluginCanDispatchResult>;
}

export interface PluginHostApi extends PluginActivationApi {
  readonly pluginId: string;
  /**
   * Push a fire-and-forget payload to every renderer subscribed to
   * `(pluginId, channel)` via `window.electron.plugin.on(...)`. This is the
   * post-activation-safe sibling of {@link broadcastToRenderer}: it fans out
   * over the exact same `plugin:{pluginId}:{channel}` transport, but unlike the
   * revoke-guarded activation broadcast it remains callable from the plugin's
   * own timers, polls, and subscription callbacks long after `activate()`
   * resolves — so a plugin can stream live data into its panels without the
   * renderer degrading to `invoke()` polling.
   *
   * Like {@link invalidateFileDecorations}, {@link showToast}, and
   * {@link dispatch} this is NOT revoke-guarded: liveness is plugin membership,
   * so it becomes a silent no-op once the plugin is unloaded. `channel` must be
   * a non-empty string without colons (the namespace separator); an invalid
   * channel throws so authoring mistakes surface loudly.
   *
   * Pass `panelId` to target a single panel instance — only the renderer
   * subscribed via `window.electron.plugin.onPanel(pluginId, channel, panelId,
   * …)` (or the SDK's `usePluginPanelEvent`) receives it, so multiple open
   * instances of the same panel kind no longer all receive every push. Omit it
   * (or pass `null`) to broadcast to every `plugin.on` / `usePluginEvent`
   * subscriber as before. An empty-string `panelId` throws.
   */
  postToPanel(channel: string, payload: unknown, panelId?: string | null): Promise<void>;
  /**
   * Returns the currently-active worktree (`isCurrent === true`) of the project
   * this host reads for, as a frozen snapshot, or `null` if none is active.
   *
   * `null` is overloaded exactly as `[]` is on {@link getWorktrees} — it means
   * "no active worktree" *or* "no answer available". Use
   * {@link getWorktreesResult} and pick out `isCurrent` yourself when the
   * difference matters.
   */
  getActiveWorktree(): Promise<PluginWorktreeSnapshot | null>;
  /**
   * Returns the worktrees of the project this host reads for, as frozen
   * snapshots — the project named by a project-bound host's binding, or the
   * focused window's project for an app-global one.
   *
   * Resolves `[]` both when the project has no worktrees and when no answer is
   * available at all; {@link getWorktreesResult} separates the two.
   */
  getWorktrees(): Promise<PluginWorktreeSnapshot[]>;
  /**
   * The same read as {@link getWorktrees}, but able to say when it has no
   * answer and which project the answer it does have describes (#12174).
   *
   * `getWorktrees()` collapses an unloaded plugin, an unwired workspace client,
   * an unresolved window scope, a rootless or closed project and a failed read
   * all to the same `[]` a genuinely empty project returns. Prefer this method
   * wherever the absence of a worktree drives a decision — a stored binding
   * that looks broken, a panel that looks orphaned — and only treat a
   * `status: "ok"` result whose `projectId` matches your expectation as
   * evidence. See {@link PluginWorktreesResult}.
   *
   * Like {@link getWorktrees} this is not revoke-guarded and never throws: once
   * the plugin unloads it degrades to `{ status: "unavailable", reason:
   * "plugin-unloaded" }`.
   */
  getWorktreesResult(): Promise<PluginWorktreesResult>;
  /**
   * Returns the changed-file / git-status projection for the worktree at the
   * given absolute `path` (the same {@link PluginWorktreeStatus} carried on
   * {@link PluginWorktreeSnapshot.status}), or `null` when no worktree matches
   * or the host hasn't polled a status yet. Reads the host's already-polled
   * status — it does NOT trigger a fresh `git status`.
   *
   * Like {@link postToPanel} this is NOT revoke-guarded: it stays callable from
   * the plugin's timers and subscription callbacks and degrades to `null` once
   * the plugin is unloaded. Pass `options.signal` to cancel.
   */
  getWorktreeStatus(
    path: string,
    options?: PluginHostCallOptions
  ): Promise<PluginWorktreeStatus | null>;
  /**
   * Returns the most recent agent-session state observed since the plugin
   * subscribed via {@link onDidChangeAgentState}, as a frozen
   * {@link PluginAgentSnapshot}, or `null` when no transition has been observed
   * yet (the host keeps no pre-subscription history). Gated on the `agent:read`
   * capability.
   *
   * Like {@link postToPanel} this is NOT revoke-guarded: it stays callable from
   * the plugin's timers and subscription callbacks and degrades to `null` once
   * the plugin is unloaded. Observation only.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare the
   *   `agent:read` capability.
   */
  getAgentState(): Promise<PluginAgentSnapshot | null>;
  /**
   * Send `text` to the currently-active agent terminal, gated on the
   * `agent:input` capability. The host resolves the target itself (focused /
   * visible agent terminal first, then a `waiting` agent, then the most recently
   * active agent terminal in the active project) so plugins stop reinventing
   * `terminal.list`-based selection heuristics that drift (#10558). The raw
   * `terminal.sendCommand` action is closed to plugin dispatch — this is the
   * sanctioned injection path.
   *
   * `options.submit` controls whether the text is executed. It defaults to
   * `false` — the **stage-only** default-safe mode: the text is pasted into the
   * agent's input for the user to review and submit, with no Enter appended.
   * Pass `{ submit: true }` to append Enter and run it immediately.
   *
   * First use raises a just-in-time consent prompt (like `shell:exec`); a
   * granted consent covers later calls. Like {@link dispatch} this is NOT
   * revoke-guarded: liveness is plugin membership, so it becomes a no-op once the
   * plugin is unloaded.
   *
   * @throws {Error} `PERMISSION_REQUIRED:` if the plugin did not declare the
   *   `agent:input` capability, or if the user denies the consent prompt.
   * @throws {Error} `NO_ACTIVE_AGENT:` if no agent terminal is available to
   *   receive the input.
   */
  sendToActiveAgent(text: string, options?: { submit?: boolean }): Promise<void>;
  /**
   * Signal that decorations for `scope` (optionally narrowed to `paths`) have
   * changed and any renderer showing them should re-pull. Unlike the
   * `register*` methods this is NOT revoke-guarded: it is called from the
   * plugin's own subscription callbacks (worktree changes, polling timers)
   * which fire long after `activate()` resolves, and must remain callable for
   * the plugin's whole lifetime. It becomes a silent no-op once the plugin is
   * unloaded.
   */
  invalidateFileDecorations(scope: string, paths?: string[]): Promise<void>;
  /**
   * Set (or clear) a small live badge on the title chrome of the panel with the
   * given `panelId` — a status `dot` or a short `label` — so per-worktree /
   * per-agent state surfaces without opening the panel. Pass `null` to clear
   * this plugin's badge on that panel. Badges are keyed by `(pluginId, panelId)`,
   * so plugins never clobber each other's badge on the same panel.
   *
   * Like {@link invalidateFileDecorations} this is NOT revoke-guarded: plugins
   * call it from post-activation subscription callbacks and timers, and it
   * becomes a silent no-op once the plugin is unloaded (all of the plugin's
   * badges are cleared on unload). An invalid `panelId` or badge shape (e.g. a
   * `label` longer than {@link PLUGIN_PANEL_BADGE_LABEL_MAX} characters) rejects
   * so authoring mistakes surface loudly. (For a dev-mode plugin running in the
   * hot-reload worker this is fire-and-forget like
   * {@link invalidateFileDecorations}: a malformed badge shape is logged in the
   * host rather than rejected back to the `await`, though an empty `panelId` is
   * still rejected synchronously worker-side.)
   */
  setPanelBadge(panelId: string, badge: PluginPanelBadge | null): Promise<void>;
  /**
   * Surface a toast notification. The host namespaces the message as
   * `{pluginId}: {message}` for provenance — a plugin cannot spoof another
   * plugin's id since `pluginId` is bound to the host at activation. Routes
   * through the app's `notify()` path so rate-limit, quiet-hours, and
   * inbox-history semantics apply identically to plugin toasts.
   *
   * Like {@link invalidateFileDecorations} this is NOT revoke-guarded: plugins
   * call it from post-activation subscription callbacks and timers. It becomes
   * a silent no-op once the plugin is unloaded. Invalid options (empty message,
   * unknown `type`) reject so authoring mistakes surface loudly.
   */
  showToast(options: PluginToastOptions): Promise<void>;
  /**
   * Dispatch an action by id through the app's `ActionService` with a `"plugin"`
   * source. Plugins use this to invoke their own registered actions, actions
   * contributed by other plugins, or any built-in action — always through the
   * audited, validated dispatch path rather than bypassing it.
   *
   * Args are validated against the action's `argsSchema` by `ActionService`;
   * the host does not re-validate. Actions classified `danger: "restricted"`
   * are rejected with `RESTRICTED`, and `danger: "confirm"` actions return
   * `CONFIRMATION_REQUIRED` (plugins cannot bypass confirm-gating — there is no
   * `confirmed` flag).
   *
   * Like {@link invalidateFileDecorations} and {@link showToast} this is NOT
   * revoke-guarded: plugins call it from post-activation subscription callbacks
   * and timers. Once the plugin is unloaded it returns
   * `{ ok: false, error: { code: "PLUGIN_UNLOADED" } }` without attempting a
   * dispatch.
   */
  dispatch(actionId: ActionId, args?: unknown): Promise<ActionDispatchResult>;
  /**
   * Built-in action catalog: discover what `dispatch()` accepts (ids, arg
   * schemas, danger) and pre-flight a dispatch. Projects the app's
   * `ActionService` manifest to plugins (#10561). See {@link PluginHostActionsApi}.
   *
   * Like {@link dispatch} this is NOT revoke-guarded — it stays callable from
   * post-activation callbacks and degrades to empty/absent results once the
   * plugin is unloaded.
   */
  readonly actions: PluginHostActionsApi;
  /**
   * Imperatively prompt the user to pick from a list, rendered through the app's
   * searchable command-palette surface. Resolves with the chosen item (or an
   * array when `options.canSelectMany` is set), or `undefined` if the user
   * dismisses the palette (Escape / click-away).
   *
   * Like {@link showToast} this is async and NOT revoke-guarded: plugins call it
   * from command handlers that run long after `activate()` resolves. If the
   * plugin is unloaded while the palette is open the pending call resolves
   * `undefined` (it never throws). Invalid items reject so authoring mistakes
   * surface loudly.
   */
  showQuickPick(
    items: PluginQuickPickItem[],
    options: PluginQuickPickOptions & { canSelectMany: true }
  ): Promise<PluginQuickPickItem[] | undefined>;
  showQuickPick(
    items: PluginQuickPickItem[],
    options?: PluginQuickPickOptions
  ): Promise<PluginQuickPickItem | undefined>;
  /**
   * Imperatively prompt the user for a line of text, rendered through the app's
   * dialog surface. Resolves with the entered string, or `undefined` if the user
   * cancels (Escape / Cancel). A non-empty {@link PluginInputBoxOptions.validationPattern}
   * is enforced client-side at submit time.
   *
   * Async and NOT revoke-guarded for the same reason as {@link showQuickPick};
   * resolves `undefined` if the plugin is unloaded while the dialog is open.
   */
  showInputBox(options?: PluginInputBoxOptions): Promise<string | undefined>;
  /**
   * Imperatively ask the user to confirm an action, rendered through the app's
   * `ConfirmDialog`. Resolves `true` if confirmed, `false` if cancelled,
   * dismissed, or the plugin is unloaded while the dialog is open.
   *
   * Async and NOT revoke-guarded for the same reason as {@link showQuickPick}.
   * For an irreversible action set {@link PluginConfirmOptions.destructive} and
   * use a verb-noun `confirmLabel`.
   */
  showConfirm(options: PluginConfirmOptions): Promise<boolean>;
  /**
   * Persistent, plugin-scoped key/value settings. Plaintext JSON storage with
   * `chmod 0o600` on POSIX — no OS keychain (#9167). See {@link SettingsApi}.
   */
  readonly settings: SettingsApi;
  /**
   * Private, plugin-scoped key/value storage — the machine-owned counterpart to
   * {@link settings}. Values never surface in the settings UI and are not gated
   * by `contributes.settings` declarations. Plaintext JSON, three scopes
   * (`"user"`, `"project"`, `"worktree"`). See {@link StorageApi}.
   *
   * Like {@link settings} this is NOT revoke-guarded: plugins read/write storage
   * throughout their lifetime. The store is the source of truth, so a late call
   * is harmless. `onDidChange` is the one revoke-guarded member (subscribe only
   * during `activate()`).
   */
  readonly storage: StorageApi;
  /**
   * Structured diagnostic logger backed by a bounded per-plugin ring buffer in
   * the main process. Lines are forwarded to the host console (prefixed
   * `[plugin:{pluginId}]`) and retained for the most recent ~500 entries so
   * they can be folded into an error report on demand. See {@link PluginLogger}.
   *
   * Like {@link invalidateFileDecorations}, {@link showToast}, and
   * {@link dispatch} this is NOT revoke-guarded: plugins log from
   * post-activation callbacks and timers. Writes become a silent no-op once the
   * plugin is unloaded.
   */
  readonly logger: PluginLogger;
  /**
   * Managed child-process lifecycle, gated on the declared `shell:exec`
   * capability. Spawns processes tied to the plugin's lifetime: every
   * outstanding process is killed (clean SIGTERM, then SIGKILL after a grace
   * period) on unload/disable/revoke, and a per-plugin concurrency cap bounds
   * how many can run at once. See {@link PluginProcessApi}.
   *
   * Like {@link postToPanel} this is NOT revoke-guarded: a process orchestrator
   * spawns from post-activation timers and callbacks. Once the plugin is
   * unloaded `spawn` rejects.
   */
  readonly process: PluginProcessApi;
  /**
   * Host-mediated filesystem surface contained to the plugin's declared
   * `scopes.fs.allowedPaths` — the runtime enforcement of those paths (formerly
   * advisory-only). Reads gated on `fs:*-read`, writes on `fs:*-write`. See
   * {@link PluginFsApi}.
   *
   * NOT revoke-guarded: plugins read/write from post-activation timers and
   * callbacks. Once the plugin unloads every method rejects and active watchers
   * are torn down.
   */
  readonly fs: PluginFsApi;
  /**
   * Host-mediated git surface scoped to a worktree inside the plugin's
   * `scopes.fs.allowedPaths`, implemented over the existing hardened git
   * service. Reads gated on `git:read`, mutations on `git:write`; `commit`
   * enforces the host-side change-preview safeguard. See {@link PluginGitApi}.
   *
   * NOT revoke-guarded — same membership lifetime as {@link fs}.
   */
  readonly git: PluginGitApi;
  /**
   * Host-mediated OS clipboard surface. Reads gated on `clipboard:read`, writes
   * on `clipboard:write`. Text reads/writes plus bounded PNG writes; runs in the
   * main process so it works from a headless plugin. See
   * {@link PluginClipboardApi}.
   *
   * NOT revoke-guarded — same membership lifetime as {@link fs}.
   */
  readonly clipboard: PluginClipboardApi;
  /**
   * Host-mediated "open with the default app" / "reveal in file manager"
   * surface, scoped to the plugin's own declared filesystem roots — including
   * its implicit `~/.daintree/plugin-data/<plugin-id>/` namespace, which the
   * renderer's built-in `system.openPath` action cannot reach. Gated on the
   * `fs:*` capability matching the resolved root's class. See
   * {@link PluginSystemApi}.
   *
   * NOT revoke-guarded — same membership lifetime as {@link fs}.
   */
  readonly system: PluginSystemApi;
}

/**
 * Synchronous, fire-and-forget diagnostic logger handed to a plugin via
 * {@link PluginHostApi.logger}. Each call appends one line to the plugin's
 * ring buffer and mirrors it to the host console. `fields` is an optional
 * structured payload serialized alongside the message; an unserializable
 * payload is coerced to a string rather than thrown. Calls return `void` — the
 * write is enqueued internally and never rejects.
 *
 * Deliberate carve-out: every other host method is Promise-returning (#10519),
 * but the logger stays synchronous. Logging happens from error handlers and
 * sync callbacks where forcing `await` is ergonomic noise, the write genuinely
 * cannot fail (it is enqueued, never awaited), and the precedent — VS Code's
 * own `OutputChannel.appendLine` — is synchronous. Do not "complete" the async
 * conversion by making these return `Promise<void>`.
 */
export interface PluginLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type PluginActivate = (
  host: PluginHostApi
) => void | (() => void) | Promise<void | (() => void)>;

/**
 * Serializable shape a plugin uses to register an action at runtime via the
 * host API. The renderer converts this into a synthetic ActionDefinition
 * whose run() dispatches back into main via plugin:invoke. Action handlers
 * themselves live in main and cannot cross the IPC boundary, so only
 * metadata travels here. `danger: "restricted"` is rejected server-side
 * — plugins cannot register restricted-danger actions.
 */
export interface PluginActionContribution {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: "command" | "query";
  danger: "safe" | "confirm";
  keywords?: string[];
  inputSchema?: Record<string, unknown>;
  /**
   * Per-action capability intent: the subset of the plugin's declared
   * `manifest.capabilities` this specific action actually exercises. Mirrors
   * {@link PluginChannelSchema.requires} in both spelling and enforcement — the
   * host rejects registration if any entry is missing from the manifest, so an
   * action can never claim authority the plugin never asked the user for.
   *
   * This narrows which capabilities the danger computation consults, so a
   * no-authority action in a high-authority plugin stays one click:
   *
   * - **omitted** — every manifest capability is consulted (today's behavior,
   *   preserved verbatim so existing plugins need no migration and a plugin
   *   that never opts in cannot accidentally de-escalate).
   * - **`[]`** — the action declares no capability intent and may stay `"safe"`
   *   even when the plugin holds `shell:exec` elsewhere.
   * - **non-empty** — only the listed capabilities are consulted, both for the
   *   flat high-risk set and the compound-capability lattice.
   *
   * It is a *classification* input only: it never grants access. Host APIs
   * still gate on `manifest.capabilities` at call time, so listing a capability
   * here neither adds nor removes runtime authority. Declaring
   * `danger: "confirm"` still pins the action to confirm regardless.
   */
  requires?: readonly BuiltInPluginCapability[];
}

export interface PluginActionDescriptor extends PluginActionContribution {
  pluginId: string;
  /**
   * Host-authoritative danger classification, computed in the main process by
   * {@link PluginService.registerPluginAction} from the plugin's declared
   * manifest capabilities. The plugin's self-reported `danger` is advisory
   * only — the host raises it (never lowers it) when the plugin holds a
   * high-risk capability, so a plugin cannot self-declare `"safe"` on a
   * destructive action to bypass MRU exclusion, repeatLast eligibility, and
   * the user-source confirm dialog. The renderer must read this field — not
   * `danger` — for any classification decision, and fail safe to `"confirm"`
   * if it is absent (e.g. a stale descriptor from a pre-migration cache).
   *
   * When the contribution declares {@link PluginActionContribution.requires},
   * the capabilities consulted here narrow to that subset — the host still
   * derives the verdict itself, it just asks a more precise question. Omitting
   * `requires` keeps the whole-manifest derivation.
   */
  effectiveDanger: "safe" | "confirm";
}

/**
 * Durable scope a plugin's persisted per-plugin state belongs to. `"global"`
 * covers installed and builtin plugins, which are app-wide by design; a
 * project-scoped plugin uses its app-minted `projectId` (see `mintProjectId`),
 * which is derived from the normalized folder path and stored outside the
 * repository — so a repository cannot forge or address another project's key.
 */
export type PluginScopeKey = "global" | (string & {});

/**
 * Hostname segment of a `plugin://` URL. Minted per loaded plugin instance and
 * invalidated on unload, so a URL captured before an unload resolves to
 * nothing rather than into whatever now occupies that plugin id.
 *
 * Not a secret. It is a namespace, not a capability — never build
 * authorization on possession of one.
 */
export type PluginProtocolAuthority = string & {
  readonly __brand: "PluginProtocolAuthority";
};

/**
 * Binds a plugin's host API to one project. Built once per plugin instance and
 * captured by every closure in the host object, so "which project?" is
 * answerable from the binding instead of from whichever window happens to be
 * focused when the plugin calls.
 *
 * `projectId: null` marks an unbound plugin — installed and builtin plugins,
 * which stay app-global. Unbound host surfaces still resolve their target from
 * focus; each such site says so explicitly at the call site. A bound plugin
 * never consults focus, because a plugin acting on a project it does not
 * belong to is never right.
 */
export interface PluginHostBinding {
  /** Owning project, or null for an app-global (installed/builtin) plugin. */
  readonly projectId: string | null;
  /** Absolute, realpath-resolved project root. Null iff `projectId` is null. */
  readonly projectRoot: string | null;
}

/** An unbound binding — the app-global default for installed and builtin plugins. */
export const UNBOUND_PLUGIN_HOST_BINDING: PluginHostBinding = {
  projectId: null,
  projectRoot: null,
};

/**
 * Prefix marking a plugin instance key as project-owned.
 *
 * A project plugin is keyed `project__{projectId}__{manifestId}` everywhere the
 * host indexes a plugin instance — `PluginService.plugins`, the contribution
 * registries' `pluginId`/`extensionId`, the `plugin://` authority map, the
 * capability-consent subject, the per-plugin settings/storage filename. That is
 * what keeps two projects shipping the same manifest id genuinely separate:
 * separate contributions, separate authority, separate grants, separate
 * teardown. Keying them by bare manifest id would give one project's revoke the
 * power to sweep the other's registrations, and one project's grant the power
 * to answer for both.
 *
 * The separator is `__` rather than `/` or `:` on purpose: an instance key is
 * joined onto a filesystem path for the user-scope settings and storage files,
 * and both of those characters are either a path separator or illegal on
 * Windows. A project id is 64 lowercase hex (`mintProjectId`) and a manifest id
 * is `publisher.name` in `[a-z0-9-]`, so neither half can contain `__` and the
 * parse below is unambiguous.
 */
export const PROJECT_PLUGIN_INSTANCE_PREFIX = "project__";

const PROJECT_PLUGIN_INSTANCE_SEPARATOR = "__";

/** Build the instance key a project-owned plugin loads under. */
export function makeProjectPluginInstanceKey(projectId: string, manifestId: string): string {
  return `${PROJECT_PLUGIN_INSTANCE_PREFIX}${projectId}${PROJECT_PLUGIN_INSTANCE_SEPARATOR}${manifestId}`;
}

/**
 * Split an instance key back into its project and manifest halves, or `null`
 * when the key is not a project instance key (an installed or builtin plugin
 * id, which is its own manifest id).
 */
export function parseProjectPluginInstanceKey(
  instanceKey: string
): { projectId: string; manifestId: string } | null {
  if (!instanceKey.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX)) return null;
  const rest = instanceKey.slice(PROJECT_PLUGIN_INSTANCE_PREFIX.length);
  const cut = rest.indexOf(PROJECT_PLUGIN_INSTANCE_SEPARATOR);
  if (cut <= 0) return null;
  const projectId = rest.slice(0, cut);
  const manifestId = rest.slice(cut + PROJECT_PLUGIN_INSTANCE_SEPARATOR.length);
  if (projectId.length === 0 || manifestId.length === 0) return null;
  return { projectId, manifestId };
}

/**
 * The manifest id behind a plugin instance key. Identity for an installed or
 * builtin plugin; the bare `publisher.name` for a project instance.
 *
 * This is what belongs in anything the *repository* sees — the project-scope
 * settings and storage filenames under `<projectRoot>/.daintree/` are
 * git-tracked, so writing a machine-local project id into them would commit one
 * developer's identity into everyone's checkout.
 */
export function pluginManifestIdFromInstanceKey(instanceKey: string): string {
  return parseProjectPluginInstanceKey(instanceKey)?.manifestId ?? instanceKey;
}

/** The owning project of a plugin instance key, or null for an app-global one. */
export function projectIdFromPluginInstanceKey(instanceKey: string): string | null {
  return parseProjectPluginInstanceKey(instanceKey)?.projectId ?? null;
}

/**
 * What the user decided about a project's `.daintree/plugins/` folder.
 *
 * `"session"` is deliberately absent from the persisted record — an
 * enable-for-this-session choice lives in memory only and is gone on relaunch,
 * which is the whole point of offering it.
 */
export type ProjectPluginTrustDecision = "enabled" | "disabled" | "session";

/** The persisted half of a project's plugin trust state. */
export interface ProjectPluginTrustRecord {
  /** Persisted decisions only. A `"session"` enable never reaches this record. */
  decision: "enabled" | "disabled";
  /** Epoch ms of the decision, for the plugin manager's audit line. */
  decidedAt: number;
  /**
   * Manifest ids this project has already surfaced to the user — activated,
   * declined, or merely staged. A plugin id absent from here is NEW, and new is
   * the one content change worth a notification. A plugin that disappears and
   * comes back is still in this list, so it is treated as known, not new.
   */
  knownPluginIds: string[];
  /**
   * Manifest ids staged and not activated. Staged plugins are parsed but never
   * executed. A declined stage stays here so it does not re-notify on every
   * subsequent edit.
   */
  stagedPluginIds: string[];
}

/** Runtime state of one plugin directory found under a project's `.daintree/plugins/`. */
export type ProjectPluginState =
  /** Loaded and running. */
  | "active"
  /** Manifest valid, trust granted, but the id is new — parsed, never executed. */
  | "staged"
  /** Manifest valid; no trust decision, or trust is disabled. Never executed. */
  | "blocked"
  /** The directory does not hold a loadable manifest. Never executed. */
  | "invalid";

/** One row of the project's plugin list, as the plugin manager and the trust gate render it. */
export interface ProjectPluginInfo {
  /** Owning project. */
  projectId: string;
  /** Manifest id (`publisher.name`), or the directory name when the manifest is unreadable. */
  id: string;
  /** The key this plugin loads under. Absent for an invalid manifest. */
  instanceId?: string;
  displayName: string;
  version: string;
  description?: string;
  /** Declared capabilities, disclosed in the manager. Never a consent gate. */
  capabilities: PluginCapability[];
  /** Directory name under `.daintree/plugins/`. Not required to equal `id`. */
  dirName: string;
  state: ProjectPluginState;
  /** Why the directory was rejected. Set iff `state === "invalid"`. */
  error?: string;
  /**
   * An installed or builtin plugin already claims this manifest id. Both load —
   * the instance key keeps them apart — and the collision is surfaced here
   * rather than resolved silently.
   */
  collidesWithGlobal: boolean;
}

/** The trust state a renderer needs to decide whether to prompt. */
export interface ProjectPluginTrustState {
  projectId: string;
  /** `null` when no decision is on record — the only state that may prompt. */
  decision: ProjectPluginTrustDecision | null;
  /** Whether project plugins are currently permitted to run. */
  enabled: boolean;
  /** True when the decision came from electron-store rather than this session. */
  persisted: boolean;
}

/**
 * `plugin:project-trust-prompt` — the one signal that may open the project
 * plugin trust dialog. The controller emits it only when the folder holds at
 * least one valid manifest and no decision is on record, so the renderer never
 * decides for itself that a prompt is due.
 */
export interface ProjectPluginTrustPromptEvent {
  projectId: string;
  /** Every valid manifest in the folder, named so the dialog can list them. */
  plugins: Array<{ id: string; displayName: string }>;
}

/**
 * `plugin:project-plugins-changed` — a full snapshot, emitted on every project
 * open, trust change and staged activation. It carries everything the plugin
 * manager renders, so the manager can be purely reactive rather than refetching.
 */
export interface ProjectPluginsChangedEvent {
  projectId: string;
  plugins: ProjectPluginInfo[];
  trust: ProjectPluginTrustState;
}

/**
 * `plugin:project-plugin-staged` — a manifest id this project has never had
 * appeared in a trusted folder. Non-blocking, and emitted once per new id: a
 * staged plugin the user ignored or declined never re-announces itself.
 */
export interface ProjectPluginStagedEvent {
  projectId: string;
  pluginId: string;
  displayName: string;
}
