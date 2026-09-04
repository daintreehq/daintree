/**
 * In-memory `PluginHostApi` implementation for unit tests. Records every host
 * call into a recording array so a plugin's `activate()` can be exercised
 * without booting Electron, the renderer, or the real contribution registries.
 *
 * Why the intersection return type — `PluginHostApi & MockHostState` makes the
 * recording arrays and `simulate*` helpers visible to callers while still
 * giving TypeScript a compile error the moment `PluginHostApi` gains a new
 * method this mock doesn't implement.
 */

import {
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "../types/plugin.js";
import { toRuntimePanelKindId } from "../config/panelKindRegistry.js";
import type {
  ActionDispatchResult,
  ActionId,
  PluginActionManifestEntry,
  PluginCanDispatchResult,
} from "../types/actions.js";
import type {
  FileDecorationProviderDescriptor,
  FileDecorationProviderImpl,
  ForgeProviderDescriptor,
  ForgeProviderImpl,
} from "../types/forge.js";
import type { NotificationType } from "../types/notification.js";
import type {
  ActionHandler,
  PluginActionContribution,
  PluginChannelSchema,
  PluginConfirmOptions,
  PluginHostApi,
  PluginIdentity,
  PluginInputBoxOptions,
  PluginIpcHandler,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginProcessApi,
  PluginDuplexProcessHandle,
  PluginDuplexProcessSpawnOptions,
  PluginPtyProcessHandle,
  PluginPtyProcessSpawnOptions,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginSettingsScope,
  PluginStorageScope,
  PluginToastOptions,
  PluginTypedIpcHandler,
  PluginWorktreeSnapshot,
  PluginWorktreesResult,
  PluginAgentSnapshot,
  PluginPanelLifecycleEvent,
  PluginSystemWakeEvent,
  PluginGitCommitResult,
  PluginPanelBadge,
  SettingDefinition,
  SettingsApi,
  StorageApi,
} from "../types/plugin.js";

export interface RegisteredActionRecord {
  descriptor: PluginActionContribution;
  handler: ActionHandler;
}

export interface RegisteredHandlerRecord {
  channel: string;
  handler: PluginIpcHandler;
}

export interface BroadcastRecord {
  channel: string;
  payload: unknown;
}

/** Captured `host.postToPanel(channel, payload, panelId?)` calls — the post-activation push path. */
export interface PostToPanelRecord {
  channel: string;
  payload: unknown;
  /** Per-instance target (#10618): a panel id, or `null` for a broadcast. */
  panelId: string | null;
}

export interface ShownToastRecord {
  message: string;
  type: NotificationType | undefined;
  durationMs: number | undefined;
}

/** Captured `host.process.spawn(command, options)` calls. */
export interface SpawnRecord {
  command: string;
  options:
    | PluginProcessSpawnOptions
    | PluginDuplexProcessSpawnOptions
    | PluginPtyProcessSpawnOptions
    | undefined;
}

export interface DispatchedActionRecord {
  actionId: ActionId;
  args: unknown;
}

/** Captured `host.sendToActiveAgent(text, options)` calls. */
export interface SentToActiveAgentRecord {
  text: string;
  submit: boolean;
}

export interface RegisteredForgeProviderRecord {
  descriptor: ForgeProviderDescriptor;
  impl: ForgeProviderImpl;
}

export interface RegisteredFileDecorationProviderRecord {
  descriptor: FileDecorationProviderDescriptor;
  impl: FileDecorationProviderImpl;
}

export interface InvalidationRecord {
  scope: string;
  paths: string[] | undefined;
}

/** Captured `host.setPanelBadge(panelId, badge)` calls. `null` clears. */
export interface SetPanelBadgeRecord {
  panelId: string;
  badge: PluginPanelBadge | null;
}

/** Captured `host.showQuickPick(items, options)` calls. */
export interface ShowQuickPickRecord {
  items: PluginQuickPickItem[];
  options: PluginQuickPickOptions | undefined;
}

/** Captured `host.showInputBox(options)` calls. */
export interface ShowInputBoxRecord {
  options: PluginInputBoxOptions | undefined;
}

/** Captured `host.showConfirm(options)` calls. */
export interface ShowConfirmRecord {
  options: PluginConfirmOptions;
}

/** Captured `host.fs.writeFile(path, contents)` calls. */
export interface FsWriteRecord {
  path: string;
  contents: string;
}

/** Captured `host.git.commit(worktreePath, options)` calls. */
export interface GitCommitRecord {
  worktreePath: string;
  message: string;
}

export interface MockHostState {
  readonly registeredActions: ReadonlyArray<RegisteredActionRecord>;
  readonly registeredHandlers: ReadonlyArray<RegisteredHandlerRecord>;
  readonly broadcastCalls: ReadonlyArray<BroadcastRecord>;
  readonly postToPanelCalls: ReadonlyArray<PostToPanelRecord>;
  readonly shownToasts: ReadonlyArray<ShownToastRecord>;
  readonly dispatchedActions: ReadonlyArray<DispatchedActionRecord>;
  readonly sentToActiveAgentCalls: ReadonlyArray<SentToActiveAgentRecord>;
  readonly registeredForgeProviders: ReadonlyArray<RegisteredForgeProviderRecord>;
  readonly registeredFileDecorationProviders: ReadonlyArray<RegisteredFileDecorationProviderRecord>;
  readonly invalidationCalls: ReadonlyArray<InvalidationRecord>;
  readonly setPanelBadgeCalls: ReadonlyArray<SetPanelBadgeRecord>;
  readonly showQuickPickCalls: ReadonlyArray<ShowQuickPickRecord>;
  readonly showInputBoxCalls: ReadonlyArray<ShowInputBoxRecord>;
  readonly showConfirmCalls: ReadonlyArray<ShowConfirmRecord>;
  readonly spawnCalls: ReadonlyArray<SpawnRecord>;
  readonly fsWriteCalls: ReadonlyArray<FsWriteRecord>;
  readonly gitCommitCalls: ReadonlyArray<GitCommitRecord>;
  /** Captured `host.clipboard.writeText(text)` calls, in order. */
  readonly clipboardWriteCalls: ReadonlyArray<string>;
  /**
   * Captured `host.clipboard.writeImage(pngData)` calls, in order. Records the
   * byte length rather than the bytes: a test asserts that an image of the
   * right size was written, and holding multi-MiB buffers alive for the
   * lifetime of the mock is a memory trap in a suite that builds many hosts.
   */
  readonly clipboardWriteImageCalls: ReadonlyArray<number>;
  /** Captured `host.system.openPath(path)` calls, in order. */
  readonly systemOpenPathCalls: ReadonlyArray<string>;
  /** Captured `host.system.showItemInFolder(path)` calls, in order. */
  readonly systemShowItemCalls: ReadonlyArray<string>;

  /**
   * Replace the active worktree and notify every `onDidChangeActiveWorktree`
   * subscriber. Helpers are top-level on the {@link MockHostState} side of the
   * intersection so they cannot drift into the production `PluginHostApi`.
   */
  simulateActiveWorktreeChange(snapshot: PluginWorktreeSnapshot | null): void;
  simulateWorktreesChange(snapshots: PluginWorktreeSnapshot[]): void;

  /**
   * Push an agent-state snapshot to every `onDidChangeAgentState` subscriber and
   * update the value `getAgentState()` returns. Mirrors the production host's
   * cache-then-notify behaviour.
   */
  simulateAgentStateChange(snapshot: PluginAgentSnapshot): void;

  /**
   * Push a panel lifecycle transition to every `onDidChangePanelLifecycle`
   * subscriber. Use it to prove a plugin releases durable resources on
   * `"removed"` and survives `"hidden"` — the distinction the single
   * `disposeSignal` could not express (#11301).
   */
  simulatePanelLifecycleChange(event: PluginPanelLifecycleEvent): void;

  /**
   * Push a machine wake to every `onDidWake` subscriber (#12175). Use it to
   * prove a plugin re-validates state it cached before a sleep, rather than
   * waiting for a window to regain focus.
   */
  simulateSystemWake(event: PluginSystemWakeEvent): void;

  /**
   * Pre-seed a deterministic `dispatch()` result for one action id. Overrides
   * the default in-memory routing (which resolves the registered handler).
   */
  setDispatchResult(actionId: ActionId, result: ActionDispatchResult): void;

  /**
   * Replace the action catalog that backs `host.actions.list/get/canDispatch`.
   * Mirrors a snapshot of `ActionService.list()`: pass the slim
   * {@link PluginActionManifestEntry} entries a plugin would discover, then
   * assert how the plugin reacts. Replaces (does not merge) any prior seed;
   * call with `[]` to reset. `canDispatch` derives its verdict from each
   * entry's `danger` the same way production does — `"safe"` → `"ok"`,
   * `"confirm"` → `"confirm"`, unknown id → `"restricted"`.
   */
  seedActionCatalog(entries: PluginActionManifestEntry[]): void;

  /**
   * Fire every active `host.fs.watch` callback with `changedPath`, simulating a
   * filesystem change the watcher would observe. Like the other `simulate*`
   * helpers it notifies every registered watcher without path filtering
   * (containment is a production concern, not modeled here) and lets callback
   * errors propagate so a test sees them.
   */
  simulateFsWatch(changedPath: string): void;

  /**
   * Configure what `showQuickPick` resolves to. Default is `undefined` (the
   * dismiss value a user-cancel produces). Pass a single item or an array for a
   * `canSelectMany` pick. Lets a test drive a plugin's handling of a real
   * selection without wrapping the host.
   */
  simulateQuickPickResponse(result: PluginQuickPickItem | PluginQuickPickItem[] | undefined): void;
  /** Configure what `showInputBox` resolves to (default `undefined` = dismissed). */
  simulateInputBoxResponse(result: string | undefined): void;
  /**
   * Force what `getWorktreesResult()` answers, or pass `null` to go back to the
   * `ok` result derived from the mock's current worktrees.
   */
  simulateWorktreesResult(result: PluginWorktreesResult | null): void;
  /** Configure what `showConfirm` resolves to (default `false` = cancelled). */
  simulateConfirmResponse(result: boolean): void;
}

export interface CreateMockHostOptions {
  pluginId?: string;
  /**
   * Project root for a project-owned `pluginId` (one shaped
   * `project__{projectId}__{manifestId}`). Defaults to a synthetic path; ignored
   * for an app-global plugin, which has no project.
   */
  projectRoot?: string;
  activeWorktree?: PluginWorktreeSnapshot | null;
  worktrees?: PluginWorktreeSnapshot[];
  /**
   * Seed `getWorktreesResult()` with a specific outcome (#12174) — an
   * `unavailable` reason, or an `ok` result naming a particular project. Omit
   * it and the mock derives `{ status: "ok", projectId: "test-project" }` from
   * `worktrees`, so an author who only cares about the happy path gets the
   * authoritative answer for free. Override it with
   * {@link MockHostState.simulateWorktreesResult} to exercise the guards a
   * plugin should have around an unavailable read.
   *
   * While an override is set the legacy `getWorktrees()` / `getActiveWorktree()`
   * project from it too — the real host derives all three from one read, so a
   * mock that answered `unavailable` here while still handing back a populated
   * list there would let a plugin's fallback pass a test it cannot pass in
   * production.
   */
  worktreesResult?: PluginWorktreesResult;
  settings?: {
    user?: Record<string, unknown>;
    project?: Record<string, unknown>;
    /** Per-project, per-machine scope — a flat map here, like the other two. */
    local?: Record<string, unknown>;
  };
  /**
   * Opt-in `contributes.settings` declarations (`id` + `scope` are what matter)
   * so the mock's `settings.get` resolves a key's declared scope the way the real
   * host does (#10586): a `scope: "project"` key reads from the project store when
   * no scope arg is given, and an explicit conflicting scope throws. Omitted by
   * default — the mock has no manifest model (#9878), so loose mode keeps the
   * `scope ?? "user"` default and existing manifest-free tests are unaffected.
   */
  manifestSettings?: SettingDefinition[];
  /** Pre-seed private `host.storage` values per scope. */
  storage?: {
    user?: Record<string, unknown>;
    project?: Record<string, unknown>;
    worktree?: Record<string, unknown>;
  };
  /**
   * Custom resolver for `host.dispatch`. The default routes the call to a
   * matching `registerAction` handler, returning `NOT_FOUND` otherwise — which
   * mirrors `ActionService.dispatch` closely enough for activation-time tests.
   */
  dispatch?: (actionId: ActionId, args?: unknown) => Promise<ActionDispatchResult>;
  /**
   * Declared plugin capabilities (`manifest.capabilities`), gating the agent
   * APIs the way production does (#10617). `getAgentState` requires `agent:read`
   * and `sendToActiveAgent` requires `agent:input`; without the capability the
   * call rejects with `PERMISSION_REQUIRED`, exactly as the real host. Defaults
   * to a permissive set (`agent:read` + `agent:input`) so existing manifest-free
   * tests keep working — pass a restricted list (or `[]`) to assert the
   * rejection a plugin missing the capability would hit.
   */
  capabilities?: readonly string[];
  /**
   * Whether an agent terminal is currently active. When `false`,
   * `sendToActiveAgent` rejects `NO_ACTIVE_AGENT`, mirroring production's "no
   * resolvable active agent" path. Defaults to `true`.
   */
  hasActiveAgent?: boolean;
}

/**
 * Mirrors the action-id regex and kind/danger sets in
 * `electron/services/PluginService.ts` `PLUGIN_ACTION_ID_RE` /
 * `PLUGIN_ACTION_KINDS` / `PLUGIN_ACTION_DANGERS`. The mock can't import
 * those (cross-process boundary), so the values are duplicated here and the
 * production constants are the source of truth. If the production regex or
 * sets change, mirror the change here.
 */
const PLUGIN_ACTION_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;
const PLUGIN_ACTION_KINDS = new Set(["command", "query"]);
const PLUGIN_ACTION_DANGERS = new Set(["safe", "confirm"]);

/**
 * Mirrors `PLUGIN_PANEL_BADGE_LABEL_MAX` in `shared/types/plugin.ts` and the
 * toast/badge enums in `electron/schemas/plugin.ts`. Duplicated (not imported)
 * for the same reason as the action constants above — the mock validates with
 * plain JS rather than pulling the cross-process Zod schemas — and the
 * production definitions remain the source of truth. Mirror any change here.
 */
const MOCK_PANEL_BADGE_LABEL_MAX = 6;
const MOCK_TOAST_TYPES = new Set(["info", "success", "warning", "error"]);
const MOCK_BADGE_COLORS = new Set(["default", "success", "warning", "error"]);
// Allowed-key sets mirroring the production `.strict()` schemas — unknown keys
// are rejected, not silently dropped.
const TOAST_OPTION_KEYS = new Set(["message", "type", "durationMs"]);
const BADGE_DOT_KEYS = new Set(["kind", "color", "tooltip"]);
const BADGE_LABEL_KEYS = new Set(["kind", "text", "color", "tooltip"]);

/**
 * Validate `showToast` options against the same constraints as production's
 * `PluginToastOptionsSchema` (message length, type enum, durationMs bounds,
 * strict unknown-key rejection). Throws a parity-style aggregated error so a
 * plugin tested against the mock fails on a shape the real host would reject
 * (#10617).
 */
function validateToastOptions(opts: PluginToastOptions): void {
  const issues: string[] = [];
  // Production's schema is `.strict()` — unknown keys are rejected, not dropped.
  if (opts && typeof opts === "object") {
    for (const key of Object.keys(opts)) {
      if (!TOAST_OPTION_KEYS.has(key)) issues.push(`${key}: unrecognized option`);
    }
  }
  const message = opts?.message;
  if (typeof message !== "string" || message.trim().length < 1) {
    issues.push("message: must be a non-empty string");
  } else if (message.trim().length > 2000) {
    issues.push("message: must be at most 2000 characters");
  }
  if (opts?.type !== undefined && !MOCK_TOAST_TYPES.has(opts.type)) {
    issues.push("type: must be one of info, success, warning, error");
  }
  if (opts?.durationMs !== undefined) {
    const d = opts.durationMs;
    if (typeof d !== "number" || !Number.isInteger(d) || d <= 0 || d > 60_000) {
      issues.push("durationMs: must be a positive integer at most 60000");
    }
  }
  if (issues.length > 0) {
    throw new Error(`showToast: invalid options — ${issues.join("; ")}`);
  }
}

/**
 * Validate a `setPanelBadge` badge against the same constraints as production's
 * `PluginPanelBadgeSchema` (discriminated on `kind`; label `text` rejected past
 * the length cap rather than truncated). `null` (clear) is handled at the call
 * site. Throws on an invalid shape (#10617).
 */
function validatePanelBadge(badge: PluginPanelBadge): void {
  if (!badge || typeof badge !== "object") {
    throw new Error("setPanelBadge: invalid badge — badge must be an object");
  }
  const color = (badge as { color?: unknown }).color;
  if (color !== undefined && !MOCK_BADGE_COLORS.has(color as string)) {
    throw new Error("setPanelBadge: invalid badge — color: must be a known badge color");
  }
  const tooltip = (badge as { tooltip?: unknown }).tooltip;
  if (
    tooltip !== undefined &&
    (typeof tooltip !== "string" || tooltip.trim().length < 1 || tooltip.trim().length > 200)
  ) {
    throw new Error(
      "setPanelBadge: invalid badge — tooltip: must be a non-empty string at most 200 characters"
    );
  }
  if (badge.kind === "dot") {
    rejectUnknownBadgeKeys(badge, BADGE_DOT_KEYS);
    return;
  }
  if (badge.kind === "label") {
    const text = (badge as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim().length < 1) {
      throw new Error("setPanelBadge: invalid badge — text: must be a non-empty string");
    }
    if (text.trim().length > MOCK_PANEL_BADGE_LABEL_MAX) {
      throw new Error(
        `setPanelBadge: invalid badge — text: must be at most ${MOCK_PANEL_BADGE_LABEL_MAX} characters`
      );
    }
    rejectUnknownBadgeKeys(badge, BADGE_LABEL_KEYS);
    return;
  }
  throw new Error('setPanelBadge: invalid badge — kind: must be "dot" or "label"');
}

/** Production badge schemas are `.strict()`: reject any key outside the variant's set. */
function rejectUnknownBadgeKeys(badge: object, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(badge)) {
    if (!allowed.has(key)) {
      throw new Error(`setPanelBadge: invalid badge — ${key}: unrecognized key`);
    }
  }
}

/**
 * Mirror production's `validateQuickPickItems`: items must be an array of objects
 * with a non-empty string `id` (unique) and a string `label`. Returns the
 * normalized items. Throws on a violation (#10617).
 */
function validateQuickPickItems(items: PluginQuickPickItem[]): PluginQuickPickItem[] {
  if (!Array.isArray(items)) {
    throw new Error("showQuickPick: items must be an array");
  }
  const seen = new Set<string>();
  return items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`showQuickPick: items[${index}] must be an object`);
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new Error(`showQuickPick: items[${index}].id must be a non-empty string`);
    }
    if (typeof item.label !== "string") {
      throw new Error(`showQuickPick: items[${index}].label must be a string`);
    }
    if (seen.has(item.id)) {
      throw new Error(`showQuickPick: duplicate item id "${item.id}" (ids must be unique)`);
    }
    seen.add(item.id);
    return {
      id: item.id,
      label: item.label,
      ...(item.description !== undefined ? { description: String(item.description) } : {}),
      ...(item.detail !== undefined ? { detail: String(item.detail) } : {}),
    };
  });
}

/** Reject a postToPanel/broadcastToRenderer channel the way production does. */
function isInvalidChannel(channel: unknown, allowEmpty: boolean): boolean {
  if (typeof channel !== "string") return true;
  if (!allowEmpty && channel.length === 0) return true;
  return channel.includes(":");
}

export function createMockHost(options: CreateMockHostOptions = {}): PluginHostApi & MockHostState {
  const pluginId = options.pluginId ?? "test.mock";
  let activeWorktree: PluginWorktreeSnapshot | null = options.activeWorktree ?? null;
  let worktrees: PluginWorktreeSnapshot[] = options.worktrees ?? [];
  let worktreesResult: PluginWorktreesResult | null = options.worktreesResult ?? null;

  const registeredActions: RegisteredActionRecord[] = [];
  const registeredHandlers: RegisteredHandlerRecord[] = [];
  const broadcastCalls: BroadcastRecord[] = [];
  const postToPanelCalls: PostToPanelRecord[] = [];
  const shownToasts: ShownToastRecord[] = [];
  const dispatchedActions: DispatchedActionRecord[] = [];
  const sentToActiveAgentCalls: SentToActiveAgentRecord[] = [];
  const registeredForgeProviders: RegisteredForgeProviderRecord[] = [];
  const registeredFileDecorationProviders: RegisteredFileDecorationProviderRecord[] = [];
  const invalidationCalls: InvalidationRecord[] = [];
  const setPanelBadgeCalls: SetPanelBadgeRecord[] = [];
  const showQuickPickCalls: ShowQuickPickRecord[] = [];
  const showInputBoxCalls: ShowInputBoxRecord[] = [];
  const showConfirmCalls: ShowConfirmRecord[] = [];
  const spawnCalls: SpawnRecord[] = [];
  const fsFiles = new Map<string, string>();
  const fsWriteCalls: FsWriteRecord[] = [];
  const gitCommitCalls: GitCommitRecord[] = [];
  const clipboardWriteCalls: string[] = [];
  const clipboardWriteImageCalls: number[] = [];
  const systemOpenPathCalls: string[] = [];
  const systemShowItemCalls: string[] = [];
  let clipboardText = "";

  const activeWorktreeSubs = new Set<(snapshot: PluginWorktreeSnapshot | null) => void>();
  const worktreesSubs = new Set<(snapshots: PluginWorktreeSnapshot[]) => void>();

  let lastAgentSnapshot: PluginAgentSnapshot | null = null;
  const agentStateSubs = new Set<(snapshot: PluginAgentSnapshot) => void>();
  const panelLifecycleSubs = new Set<(event: PluginPanelLifecycleEvent) => void>();
  const systemWakeSubs = new Set<(event: PluginSystemWakeEvent) => void>();

  // Capability gating + active-agent presence for the agent APIs (#10617).
  // Default permissive so manifest-free tests are unaffected; restrict to assert
  // the PERMISSION_REQUIRED / NO_ACTIVE_AGENT rejections production enforces.
  const capabilities = new Set<string>(options.capabilities ?? ["agent:read", "agent:input"]);
  const hasActiveAgent = options.hasActiveAgent ?? true;

  // Configurable answers for the imperative UI prompts. Default to the dismiss
  // value (cancel) a user produces; `simulate*Response` overrides per test.
  let quickPickResponse: PluginQuickPickItem | PluginQuickPickItem[] | undefined;
  let inputBoxResponse: string | undefined;
  let confirmResponse = false;

  const settingsStore: Record<PluginSettingsScope, Map<string, unknown>> = {
    user: new Map(Object.entries(options.settings?.user ?? {})),
    project: new Map(Object.entries(options.settings?.project ?? {})),
    local: new Map(Object.entries(options.settings?.local ?? {})),
  };

  const settingsSubs: Record<PluginSettingsScope, Map<string, Set<(value: unknown) => void>>> = {
    user: new Map(),
    project: new Map(),
    local: new Map(),
  };

  // `user`/`project` scopes are flat maps; `worktree` scope is isolated per
  // active worktree path (#10578). Production resolves a different storage file
  // per worktree, so a value written under worktree A is invisible after
  // `simulateActiveWorktreeChange(B)`. The sub-map is created lazily on first
  // write; the read path returns `undefined` for an unseen worktree.
  const userProjectStore: Record<"user" | "project", Map<string, unknown>> = {
    user: new Map(Object.entries(options.storage?.user ?? {})),
    project: new Map(Object.entries(options.storage?.project ?? {})),
  };
  const worktreeStorageByPath = new Map<string, Map<string, unknown>>();
  // Seed the worktree scope into the initial active worktree's sub-map. With no
  // active worktree there is no target (production would throw on `set`), so the
  // seed is silently dropped rather than placed in an anonymous map.
  if (activeWorktree && options.storage?.worktree) {
    worktreeStorageByPath.set(
      activeWorktree.path,
      new Map(Object.entries(options.storage.worktree))
    );
  }
  /** The storage sub-map for the active worktree, created on demand. */
  const worktreeStore = (): Map<string, unknown> | null => {
    if (!activeWorktree) return null;
    let store = worktreeStorageByPath.get(activeWorktree.path);
    if (!store) {
      store = new Map();
      worktreeStorageByPath.set(activeWorktree.path, store);
    }
    return store;
  };

  // Subscriptions stay keyed by storage key (not worktree path) for every
  // scope, matching production: a worktree-scope `onDidChange` survives a
  // worktree switch and then fires for the now-active worktree's value.
  const storageSubs: Record<PluginStorageScope, Map<string, Set<(value: unknown) => void>>> = {
    user: new Map(),
    project: new Map(),
    worktree: new Map(),
  };

  const dispatchOverrides = new Map<ActionId, ActionDispatchResult>();
  const actionCatalog = new Map<string, PluginActionManifestEntry>();
  // Active `host.fs.watch` registrations; a watcher's disposer removes its
  // record, and `simulateFsWatch` fires each one's callback.
  const fsWatchers = new Set<{ paths: string[]; callback: (changedPath: string) => void }>();

  // Resolve the declared scope for a key from the opt-in `manifestSettings`,
  // mirroring PluginSettingsManager.getDeclaredScope. Returns undefined when no
  // declarations are provided (loose mode) or the key is undeclared.
  const getDeclaredSettingScope = (key: string): PluginSettingsScope | undefined => {
    const def = options.manifestSettings?.find((s) => s.id === key);
    return def ? ((def.scope ?? "user") as PluginSettingsScope) : undefined;
  };

  const settings: SettingsApi = {
    async get<T = unknown>(key: string, scope?: PluginSettingsScope): Promise<T | undefined> {
      // Manifest-aware mode: a declared key resolves to its declared scope, and an
      // explicit conflicting scope throws — matching the real host (#10586). Loose
      // mode (no manifestSettings) keeps the `scope ?? "user"` default.
      const declaredScope = getDeclaredSettingScope(key);
      if (scope !== undefined && declaredScope !== undefined && declaredScope !== scope) {
        throw new Error(
          `settings.get: key "${key}" is declared in "${declaredScope}" scope, not "${scope}"`
        );
      }
      const effectiveScope = declaredScope ?? scope ?? "user";
      return settingsStore[effectiveScope].get(key) as T | undefined;
    },
    async set<T = unknown>(
      key: string,
      value: T,
      scope: PluginSettingsScope = "user"
    ): Promise<void> {
      if (value === undefined) {
        throw new Error("settings.set: value cannot be undefined");
      }
      const prev = settingsStore[scope].get(key);
      settingsStore[scope].set(key, value);
      if (!Object.is(prev, value)) {
        const subs = settingsSubs[scope].get(key);
        if (subs) {
          for (const cb of subs) cb(value as unknown);
        }
      }
    },
    onDidChange<T = unknown>(
      key: string,
      callback: (value: T | undefined) => void,
      scope: PluginSettingsScope = "user"
    ): Promise<() => void> {
      let subs = settingsSubs[scope].get(key);
      if (!subs) {
        subs = new Set();
        settingsSubs[scope].set(key, subs);
      }
      const cb = callback as (value: unknown) => void;
      subs.add(cb);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const set = settingsSubs[scope].get(key);
        if (set) {
          set.delete(cb);
          if (set.size === 0) settingsSubs[scope].delete(key);
        }
      };
      return Promise.resolve(dispose);
    },
  };

  // Private machine-owned storage (#10556). Mirrors the settings mock but adds
  // the "worktree" scope and a `delete` method, and never gates on declared keys.
  // The "worktree" scope resolves its target from the current active worktree
  // (#10578): set with no active worktree throws (matching production's "no
  // active worktree" guard), get resolves undefined, and delete no-ops.
  const storage: StorageApi = {
    async get<T = unknown>(
      key: string,
      scope: PluginStorageScope = "user"
    ): Promise<T | undefined> {
      const store = scope === "worktree" ? worktreeStore() : userProjectStore[scope];
      // No active worktree resolves to undefined rather than throwing, matching
      // production's "unset key" return.
      if (!store) return undefined;
      return store.get(key) as T | undefined;
    },
    async set<T = unknown>(
      key: string,
      value: T,
      scope: PluginStorageScope = "user"
    ): Promise<void> {
      if (value === undefined) {
        throw new Error("storage.set: value cannot be undefined");
      }
      const store = scope === "worktree" ? worktreeStore() : userProjectStore[scope];
      if (!store) {
        // worktree scope with no active worktree — mirror production's message.
        throw new Error(
          `Plugin "${pluginId}" storage.set: no active ${scope} — "${scope}" scope has no target`
        );
      }
      const prev = store.get(key);
      const had = store.has(key);
      store.set(key, value);
      // Mirror the real store's `valuesEqual` (JSON) change detection rather than
      // `Object.is`, so two equal-but-distinct object literals fire onDidChange
      // exactly once — matching production, not reference identity.
      const changed = !had || !jsonEqual(prev, value);
      if (changed) {
        const subs = storageSubs[scope].get(key);
        if (subs) {
          for (const cb of subs) cb(value as unknown);
        }
      }
    },
    async delete(key: string, scope: PluginStorageScope = "user"): Promise<void> {
      const store = scope === "worktree" ? worktreeStore() : userProjectStore[scope];
      // No active worktree — a delete is a no-op rather than a throw (matching
      // production and the "already absent" return of the store).
      if (!store) return;
      const had = store.has(key);
      store.delete(key);
      if (had) {
        const subs = storageSubs[scope].get(key);
        if (subs) {
          for (const cb of subs) cb(undefined);
        }
      }
    },
    onDidChange<T = unknown>(
      key: string,
      callback: (value: T | undefined) => void,
      scope: PluginStorageScope = "user"
    ): Promise<() => void> {
      let subs = storageSubs[scope].get(key);
      if (!subs) {
        subs = new Set();
        storageSubs[scope].set(key, subs);
      }
      const cb = callback as (value: unknown) => void;
      subs.add(cb);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const set = storageSubs[scope].get(key);
        if (set) {
          set.delete(cb);
          if (set.size === 0) storageSubs[scope].delete(key);
        }
      };
      return Promise.resolve(dispose);
    },
  };

  // Identity mirrors the real host: derived from the id via the canonical
  // parser, so a mock built with a project instance key answers exactly as
  // production does.
  const mockManifestId = pluginManifestIdFromInstanceKey(pluginId);
  const mockProjectId = projectIdFromPluginInstanceKey(pluginId);
  // `projectRoot` is null iff `projectId` is — a mock that claimed a project
  // with no root would hand plugin authors a shape production never produces.
  const mockProjectRoot =
    mockProjectId === null ? null : (options.projectRoot ?? `/projects/${mockProjectId}`);
  const pluginInfo: PluginIdentity = Object.freeze({
    instanceId: pluginId,
    manifestId: mockManifestId,
    origin: mockProjectId === null ? ("global" as const) : ("project" as const),
    projectId: mockProjectId,
    projectRoot: mockProjectRoot,
  });

  const host: PluginHostApi & MockHostState = {
    pluginId,
    pluginInfo,
    panelKindId(bareId: string) {
      if (typeof bareId !== "string" || bareId.length === 0) {
        throw new Error(`Plugin "${pluginId}" panelKindId: bareId must be a non-empty string`);
      }
      const qualified = toRuntimePanelKindId(
        { origin: pluginInfo.origin, pluginId: mockManifestId, kindId: bareId },
        mockProjectId
      );
      if (qualified === null) {
        throw new Error(
          `Plugin "${pluginId}" panelKindId: cannot qualify panel kind "${bareId}" for this plugin`
        );
      }
      return qualified;
    },
    registerAction(descriptor, handler) {
      // Mirrors PluginService.createHost L1577-L1631. Validation order matches
      // production: non-object descriptor, non-function handler, non-empty
      // string id, plugin-prefix not already in id, then the
      // validateAndBuildActionDescriptor checks (L2686-L2723) applied to the
      // namespaced id (since production namespaces before that step).
      // Re-registering the same id replaces the prior descriptor + handler
      // (replace-by-id, see host-api.md). A plugin test that calls
      // registerAction with the same id twice should see the second call win,
      // not accumulate two entries.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerAction: descriptor must be an object");
      }
      if (typeof handler !== "function") {
        throw new Error("registerAction: handler must be a function");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerAction: descriptor.id must be a non-empty string");
      }
      if (descriptor.id.startsWith(`${pluginId}.`)) {
        throw new Error(
          `registerAction: descriptor.id "${descriptor.id}" must not include the plugin prefix`
        );
      }
      // Mirrors validateAndBuildActionDescriptor (L2697-L2723). The mock
      // namespaces the id the same way production does and runs the same
      // checks against the namespaced form, so a plugin test that registers
      // an action the production host would reject fails the mock in the
      // same way — no "passes the mock, throws at activation" gap.
      const namespacedId = `${pluginId}.${descriptor.id}`;
      if (!PLUGIN_ACTION_ID_RE.test(namespacedId)) {
        throw new Error(
          `registerAction: descriptor.id "${descriptor.id}" (namespaced to "${namespacedId}") is invalid. Expected "{pluginId}.{actionId}" (lowercase start, alphanumerics, dot/dash/underscore).`
        );
      }
      if (typeof descriptor.title !== "string" || !descriptor.title.trim()) {
        throw new Error("registerAction: descriptor.title must be a non-empty string");
      }
      if (typeof descriptor.description !== "string") {
        throw new Error("registerAction: descriptor.description must be a string");
      }
      if (typeof descriptor.category !== "string" || !descriptor.category.trim()) {
        throw new Error("registerAction: descriptor.category must be a non-empty string");
      }
      if (!PLUGIN_ACTION_KINDS.has(descriptor.kind)) {
        throw new Error(
          `registerAction: descriptor.kind "${descriptor.kind}" is invalid (must be one of: ${[
            ...PLUGIN_ACTION_KINDS,
          ].join(", ")})`
        );
      }
      if (!PLUGIN_ACTION_DANGERS.has(descriptor.danger)) {
        throw new Error(
          `registerAction: descriptor.danger "${descriptor.danger}" is invalid (must be one of: ${[
            ...PLUGIN_ACTION_DANGERS,
          ].join(", ")})`
        );
      }
      const existing = registeredActions.findIndex((r) => r.descriptor.id === descriptor.id);
      if (existing >= 0) {
        registeredActions[existing] = { descriptor, handler };
      } else {
        registeredActions.push({ descriptor, handler });
      }
      // Validation/registry mutation runs synchronously above (sync throws still
      // surface at the call site); only the return value is a resolved promise.
      return Promise.resolve();
    },
    registerHandler<TArgs = unknown, TResult = unknown>(
      channel: string,
      schemaOrHandler: PluginChannelSchema<TArgs, TResult> | PluginIpcHandler,
      handler?: PluginTypedIpcHandler<TArgs, TResult>
    ): Promise<void> {
      // Handle both overloads:
      // 1. registerHandler(channel, schema, handler) — typed
      // 2. registerHandler(channel, handler) — untyped
      if (handler !== undefined) {
        // Typed overload: schemaOrHandler is a schema, handler is the typed handler
        // The cast is necessary because PluginTypedIpcHandler is structurally compatible
        // with PluginIpcHandler and we're storing it in a untyped recording array.
        registeredHandlers.push({
          channel,
          handler: handler as unknown as PluginIpcHandler,
        });
      } else {
        // Untyped overload: schemaOrHandler is the handler
        registeredHandlers.push({
          channel,
          handler: schemaOrHandler as PluginIpcHandler,
        });
      }
      return Promise.resolve();
    },
    broadcastToRenderer(channel, payload) {
      // Mirror production's channel-format guard (#10617): a colon would collide
      // with the `plugin:{id}:{channel}` transport. Reject (not throw) so the
      // mock matches the host's Promise contract. Production allows an empty
      // broadcast channel, so only the colon/non-string checks apply here.
      if (isInvalidChannel(channel, true)) {
        return Promise.reject(
          new Error(
            `broadcastToRenderer: channel must be a string without colons: ${String(channel)}`
          )
        );
      }
      broadcastCalls.push({ channel, payload });
      return Promise.resolve();
    },
    postToPanel(channel, payload, panelId) {
      if (isInvalidChannel(channel, false)) {
        return Promise.reject(
          new Error(
            `postToPanel: channel must be a non-empty string without colons: ${String(channel)}`
          )
        );
      }
      if (panelId !== undefined && panelId !== null) {
        if (typeof panelId !== "string" || panelId.length === 0) {
          throw new Error(
            `postToPanel: panelId must be a non-empty string, null, or undefined: ${String(panelId)}`
          );
        }
      }
      postToPanelCalls.push({ channel, payload, panelId: panelId ?? null });
      return Promise.resolve();
    },
    async getActiveWorktree() {
      if (worktreesResult) {
        return worktreesResult.status === "ok"
          ? (worktreesResult.worktrees.find((w) => w.isCurrent) ?? null)
          : null;
      }
      return activeWorktree;
    },
    async getWorktrees() {
      // Projected from the override when one is set: the real host derives all
      // three getters from a single read, so a mock that let `getWorktrees()`
      // stay populated while the result says `unavailable` would bless a
      // fallback that cannot work in production.
      if (worktreesResult) {
        return worktreesResult.status === "ok" ? worktreesResult.worktrees : [];
      }
      return worktrees;
    },
    async getWorktreesResult() {
      return worktreesResult ?? { status: "ok", projectId: "test-project", worktrees };
    },
    async getWorktreeStatus(path, options) {
      options?.signal?.throwIfAborted();
      const match =
        worktrees.find((w) => w.path === path) ??
        (activeWorktree?.path === path ? activeWorktree : null);
      return match?.status ?? null;
    },
    onDidChangeActiveWorktree(callback) {
      activeWorktreeSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        activeWorktreeSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    onDidChangeWorktrees(callback, _options) {
      // The mock ignores `debounceMs` — coalescing is a host-side concern and is
      // unit-tested against PluginService directly; activation tests just need
      // the subscription wired.
      worktreesSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        worktreesSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    async getAgentState() {
      // Capability gating mirrors production (#10617): without "agent:read" the
      // call rejects PERMISSION_REQUIRED, so a plugin that forgot to declare the
      // capability fails the mock the same way the real host fails it.
      if (!capabilities.has("agent:read")) {
        throw new Error(
          'PERMISSION_REQUIRED: getAgentState requires "agent:read", which is not declared in manifest.capabilities'
        );
      }
      return lastAgentSnapshot;
    },
    async sendToActiveAgent(text, options) {
      // Capability first, then text validation, then active-agent resolution —
      // the same order production enforces (#10617). Whitespace-only text is
      // rejected (a no-op stage can't bank consent, and submit:true can't fire a
      // bare Enter). The mock has no PTY, so a valid call just records its intent.
      if (!capabilities.has("agent:input")) {
        throw new Error(
          'PERMISSION_REQUIRED: sendToActiveAgent requires "agent:input", which is not declared in manifest.capabilities'
        );
      }
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("sendToActiveAgent: text must be a non-empty, non-whitespace string");
      }
      if (!hasActiveAgent) {
        throw new Error("NO_ACTIVE_AGENT: no active agent terminal to receive input");
      }
      sentToActiveAgentCalls.push({ text, submit: options?.submit === true });
    },
    onDidChangeAgentState(callback) {
      agentStateSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        agentStateSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    onDidChangePanelLifecycle(callback) {
      // No capability gate and no replay: the mock holds no panel registry, so
      // tests drive phases explicitly via `simulatePanelLifecycleChange`.
      panelLifecycleSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        panelLifecycleSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    onDidWake(callback) {
      // No capability gate and no replay, matching production: a wake is a
      // one-shot pulse, so tests drive it explicitly via `simulateSystemWake`.
      systemWakeSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        systemWakeSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    registerForgeProvider(descriptor, impl) {
      // Mirrors PluginService.createHost L1738-L1817. Validation order matches
      // production: non-object descriptor, non-empty string id, non-object impl.
      // The manifest-declared-id check is intentionally skipped — the mock has
      // no manifest model (see issue #9878). Re-registering the same id
      // replaces the prior binding (replace-by-id). The disposer's identity
      // guard compares the captured `impl` reference against the currently
      // active entry's `impl`, matching `unregisterForgeProviderImpl`'s
      // `expected` argument: a stale disposer from a re-bound id is a no-op.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerForgeProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerForgeProvider: descriptor.id must be a non-empty string");
      }
      if (!impl || typeof impl !== "object") {
        throw new Error("registerForgeProvider: impl must be an object");
      }
      const contributionId = descriptor.id;
      const existing = registeredForgeProviders.findIndex(
        (r) => r.descriptor.id === contributionId
      );
      if (existing >= 0) {
        registeredForgeProviders[existing] = { descriptor, impl };
      } else {
        registeredForgeProviders.push({ descriptor, impl });
      }
      let disposed = false;
      // Disposer captured synchronously (registry mutation already done above) —
      // only the return value is a resolved promise, never a deferred write.
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        // Identity guard: only remove if the currently active entry is still
        // the one this disposer was captured against. A re-registration with a
        // different impl invalidates the prior disposer (matches production).
        const i = registeredForgeProviders.findIndex(
          (r) => r.descriptor.id === contributionId && r.impl === impl
        );
        if (i >= 0) registeredForgeProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    registerFileDecorationProvider(descriptor, impl) {
      // Mirrors PluginService.createHost L1818-L1875. Validation order matches
      // production: non-object descriptor, non-empty string id, impl must be
      // an object exposing `provideDecorations()`. The manifest-declared-id
      // check is intentionally skipped — the mock has no manifest model (see
      // issue #9878). Re-registering the same id replaces the prior binding
      // (replace-by-id). The disposer's identity guard mirrors
      // `unregisterFileDecorationProviderImpl`'s `expected` argument.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerFileDecorationProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerFileDecorationProvider: descriptor.id must be a non-empty string");
      }
      if (!impl || typeof impl !== "object" || typeof impl.provideDecorations !== "function") {
        throw new Error("registerFileDecorationProvider: impl must expose provideDecorations()");
      }
      const contributionId = descriptor.id;
      const existing = registeredFileDecorationProviders.findIndex(
        (r) => r.descriptor.id === contributionId
      );
      if (existing >= 0) {
        registeredFileDecorationProviders[existing] = { descriptor, impl };
      } else {
        registeredFileDecorationProviders.push({ descriptor, impl });
      }
      let disposed = false;
      // Disposer captured synchronously (registry mutation already done above).
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        // Identity guard: only remove if the currently active entry is still
        // the one this disposer was captured against. A re-registration with a
        // different impl invalidates the prior disposer (matches production).
        const i = registeredFileDecorationProviders.findIndex(
          (r) => r.descriptor.id === contributionId && r.impl === impl
        );
        if (i >= 0) registeredFileDecorationProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    invalidateFileDecorations(scope, paths) {
      // Mirror production's non-empty-scope guard (#10617): reject (not throw),
      // matching the host's Promise contract. The declared-scope gate production
      // also applies is intentionally skipped — the mock has no manifest model
      // (#9878), so it can't know which scopes a plugin declared.
      if (typeof scope !== "string" || scope.length === 0) {
        return Promise.reject(
          new Error("invalidateFileDecorations: scope must be a non-empty string")
        );
      }
      invalidationCalls.push({ scope, paths });
      return Promise.resolve();
    },
    setPanelBadge(panelId, badge) {
      // Validate to production parity (#10617): non-empty panelId, and a badge
      // shape the real host's Zod schema would accept. Reject (not throw) so the
      // mock matches the host's Promise contract. `null`/`undefined` clears.
      if (typeof panelId !== "string" || panelId.length === 0) {
        return Promise.reject(new Error("setPanelBadge: panelId must be a non-empty string"));
      }
      if (badge !== null && badge !== undefined) {
        try {
          validatePanelBadge(badge);
        } catch (err) {
          // validatePanelBadge only throws Error; re-reject it so the validation
          // error stays inside the Promise contract (not a sync throw).
          return Promise.reject(err);
        }
      }
      setPanelBadgeCalls.push({ panelId, badge: badge ?? null });
      return Promise.resolve();
    },
    async showToast(opts: PluginToastOptions) {
      // Full production parity (#10617): message length, type enum, durationMs
      // bounds — not just a truthy-message check. A shape the real host rejects
      // now fails the mock too.
      validateToastOptions(opts);
      shownToasts.push({
        message: opts.message,
        type: opts.type,
        durationMs: opts.durationMs,
      });
    },
    async dispatch(actionId, args) {
      dispatchedActions.push({ actionId, args });
      const override = dispatchOverrides.get(actionId);
      if (override) return override;
      if (options.dispatch) return options.dispatch(actionId, args);
      // Match the real host's contract: dispatch ids are always fully
      // namespaced as `{pluginId}.{descriptor.id}`. Looking up by the full
      // form means a plugin calling `host.dispatch("greet")` against a
      // registered action also id'd `"greet"` returns NOT_FOUND in the mock
      // exactly as it would in production where ActionService never sees an
      // unprefixed id.
      const reg = registeredActions.find((r) => actionId === `${pluginId}.${r.descriptor.id}`);
      if (!reg) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Action not found: ${actionId}` },
        };
      }
      try {
        const result = await reg.handler(args);
        return { ok: true, result };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
    // Imperative UI prompts (#10522, hardened in #10617). The mock has no
    // renderer to drive a dialog, so each prompt validates its arguments to
    // production parity, records the call for assertions, then resolves the
    // configured `simulate*Response` value (default = the user-cancel dismiss
    // value). A shape the real host rejects now fails the mock too.
    showQuickPick: (async (items: PluginQuickPickItem[], options?: PluginQuickPickOptions) => {
      const validItems = validateQuickPickItems(items);
      showQuickPickCalls.push({ items: validItems, options });
      return quickPickResponse;
    }) as PluginHostApi["showQuickPick"],
    async showInputBox(options) {
      showInputBoxCalls.push({ options });
      return inputBoxResponse;
    },
    async showConfirm(options) {
      if (!options || typeof options !== "object" || typeof options.title !== "string") {
        throw new Error("showConfirm: options.title must be a string");
      }
      showConfirmCalls.push({ options });
      return confirmResponse;
    },
    actions: {
      // Backed by the catalog seeded via `seedActionCatalog`. With no seed the
      // catalog is empty — `list()` resolves `[]`, `get()` resolves `null`, and
      // `canDispatch()` resolves `"restricted"`, matching an unloaded plugin.
      async list() {
        return Array.from(actionCatalog.values());
      },
      async get(actionId) {
        return actionCatalog.get(actionId) ?? null;
      },
      async canDispatch(actionId): Promise<PluginCanDispatchResult> {
        const entry = actionCatalog.get(actionId);
        // Mirror production: unknown/absent → "restricted", danger "safe" → "ok",
        // danger "confirm" → "confirm" (dispatch would reject it), anything else
        // (e.g. a "restricted" entry that slipped in) → "restricted".
        if (!entry) return "restricted";
        if (entry.danger === "safe") return "ok";
        if (entry.danger === "confirm") return "confirm";
        return "restricted";
      },
    },
    process: {
      async spawn(
        command: string,
        options?:
          PluginProcessSpawnOptions | PluginDuplexProcessSpawnOptions | PluginPtyProcessSpawnOptions
      ): Promise<PluginProcessHandle | PluginDuplexProcessHandle | PluginPtyProcessHandle> {
        spawnCalls.push({ command, options });
        // A no-op handle: the mock records the call without spawning anything.
        // Lifecycle and data callbacks never fire (no real process), and
        // kill/restart/write/resize are inert — tests that exercise real process
        // behavior use PluginProcessManager directly with an injected fake spawner.
        const base: PluginProcessHandle = {
          id: `mock-process-${spawnCalls.length}`,
          kill: () => {},
          restart: async () => {},
          onExit: () => () => {},
          onCrash: () => () => {},
          onData: () => () => {},
        };
        // Shape matches the real host: `write` exists only for a writable mode
        // (duplex or PTY) and `resize` only for a PTY, so a test asserting "pipe
        // mode has no writable input" stays honest.
        if (options?.mode === "duplex") return { ...base, write: () => {} };
        if (options?.mode !== "pty") return base;
        return { ...base, write: () => {}, resize: () => {} };
      },
    } as PluginProcessApi,
    // In-memory fs mock: writes land in `fsFiles` and are recorded; reads return
    // a previously-written value or reject ENOENT. No containment is modeled
    // (containment lives in pluginFsContainment and is unit-tested directly) —
    // this mock is for exercising a plugin's activate()/handlers, not the guard.
    fs: {
      async readFile(filePath, options) {
        options?.signal?.throwIfAborted();
        const v = fsFiles.get(filePath);
        if (v === undefined) {
          throw new Error(`ENOENT: mock fs has no file "${filePath}"`);
        }
        return v;
      },
      async writeFile(filePath, contents) {
        fsFiles.set(filePath, contents);
        fsWriteCalls.push({ path: filePath, contents });
      },
      async readdir(dirPath, options) {
        options?.signal?.throwIfAborted();
        // Derive entries from files written via writeFile whose parent directory
        // is `dirPath` (#10617). Previously always returned [], so a plugin that
        // wrote files then listed the dir saw nothing — a false-green gap. Each
        // immediate child name is reported once: a name with a deeper path
        // segment is a directory, a name that is itself a written file is a file
        // (basename only, like a real readdir).
        const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
        const isDir = new Map<string, boolean>();
        for (const filePath of fsFiles.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash === -1) {
            if (rest.length > 0 && !isDir.has(rest)) isDir.set(rest, false);
          } else {
            isDir.set(rest.slice(0, slash), true);
          }
        }
        const entries = [...isDir.entries()].map(([name, directory]) => ({
          name,
          isDirectory: directory,
          isFile: !directory,
          isSymbolicLink: false,
          // A detailed read promises size and mtime, so the mock supplies them
          // rather than letting a plugin that reads `entry.size` pass here and
          // fail against the real host. Written files have a real byte length;
          // directories carry no size, matching the production listing. There
          // are no symlinks to classify in an in-memory filesystem.
          ...(options?.detail === true &&
            !directory && { size: fsFiles.get(`${prefix}${name}`)?.length ?? 0 }),
          ...(options?.detail === true && { mtimeMs: 0 }),
        }));
        if (options?.detail !== true) return entries;
        // Same ordering the production listing applies: directories first, then
        // a numeric-aware name collation.
        const collator = new Intl.Collator(undefined, { numeric: true });
        return entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return collator.compare(a.name, b.name);
        });
      },
      async stat(targetPath, options) {
        options?.signal?.throwIfAborted();
        return {
          isDirectory: false,
          isFile: fsFiles.has(targetPath),
          isSymbolicLink: false,
          size: fsFiles.get(targetPath)?.length ?? 0,
          mtimeMs: 0,
        };
      },
      async watch(paths, callback, options) {
        options?.signal?.throwIfAborted();
        // Mirror PluginService.createHost fs.watch validation order so a watch
        // call the production host would reject fails the mock the same way.
        if (typeof callback !== "function") {
          throw new Error(`Plugin "${pluginId}" fs.watch: callback must be a function`);
        }
        if (!Array.isArray(paths) || paths.length === 0) {
          throw new Error(`Plugin "${pluginId}" fs.watch: paths must be a non-empty array`);
        }
        // Record the watcher so `simulateFsWatch` can fire it. The disposer
        // removes the record (idempotent) — once disposed the watcher no longer
        // receives simulated changes.
        const record = { paths, callback };
        fsWatchers.add(record);
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          fsWatchers.delete(record);
        };
      },
    },
    // In-memory git mock. `commit` mirrors the host's #7880 guard — an empty
    // message rejects — so a plugin tested against the mock sees the same
    // no-silent-fallback contract as production.
    git: {
      async status(worktreePath, options) {
        options?.signal?.throwIfAborted();
        return { worktreePath, files: [], changedFileCount: 0 };
      },
      async diff(_worktreePath, _filePath, options) {
        options?.signal?.throwIfAborted();
        return "";
      },
      async add(_worktreePath, _paths, options) {
        options?.signal?.throwIfAborted();
      },
      async commit(worktreePath, options, callOptions): Promise<PluginGitCommitResult> {
        callOptions?.signal?.throwIfAborted();
        const message = typeof options?.message === "string" ? options.message : "";
        if (message.trim().length === 0) {
          throw new Error(
            `COMMIT_MESSAGE_REQUIRED: mock git.commit requires an explicit non-empty message`
          );
        }
        gitCommitCalls.push({ worktreePath, message });
        return { commit: `mock-${gitCommitCalls.length}`, message, preview: "" };
      },
    },
    // In-memory clipboard mock. `writeText` records the text and updates the
    // in-memory buffer `readText` returns, so a round-trip works in tests. No
    // capability gating is modeled (matches the fs/git mocks — gating lives in
    // PluginService and is unit-tested there); `readText` returns "" until the
    // first write, mirroring Electron's empty-clipboard behaviour.
    clipboard: {
      async writeText(text) {
        clipboardWriteCalls.push(text);
        clipboardText = text;
      },
      async writeImage(pngData) {
        clipboardWriteImageCalls.push(pngData.byteLength);
        // A real image write replaces the clipboard, so text no longer reads
        // back — leaving the buffer intact would let a test pass that the
        // real host would fail.
        clipboardText = "";
      },
      async readText() {
        return clipboardText;
      },
    },
    // Records only — a mock must never actually launch a file or open a
    // Finder window, which is exactly what the real implementation does.
    // Containment and capability gating live in PluginService and are unit
    // tested there, matching the fs/git/clipboard mocks.
    system: {
      async openPath(targetPath) {
        systemOpenPathCalls.push(targetPath);
      },
      async showItemInFolder(targetPath) {
        systemShowItemCalls.push(targetPath);
      },
    },
    settings,
    storage,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },

    registeredActions,
    registeredHandlers,
    broadcastCalls,
    postToPanelCalls,
    shownToasts,
    dispatchedActions,
    sentToActiveAgentCalls,
    registeredForgeProviders,
    registeredFileDecorationProviders,
    invalidationCalls,
    setPanelBadgeCalls,
    showQuickPickCalls,
    showInputBoxCalls,
    showConfirmCalls,
    spawnCalls,
    fsWriteCalls,
    gitCommitCalls,
    clipboardWriteCalls,
    clipboardWriteImageCalls,
    systemOpenPathCalls,
    systemShowItemCalls,

    simulateActiveWorktreeChange(snapshot) {
      activeWorktree = snapshot;
      for (const cb of activeWorktreeSubs) cb(snapshot);
    },
    simulateWorktreesChange(snapshots) {
      worktrees = snapshots;
      for (const cb of worktreesSubs) cb(snapshots);
    },
    simulateWorktreesResult(result) {
      worktreesResult = result;
    },
    simulateAgentStateChange(snapshot) {
      lastAgentSnapshot = snapshot;
      for (const cb of agentStateSubs) cb(snapshot);
    },
    simulatePanelLifecycleChange(event) {
      // Frozen like production delivery, so a plugin that mutates the event
      // fails in tests rather than in the wild.
      const frozen = Object.freeze({ ...event });
      for (const cb of [...panelLifecycleSubs]) cb(frozen);
    },
    simulateSystemWake(event) {
      // Frozen like production delivery, for the same reason.
      const frozen = Object.freeze({ ...event });
      for (const cb of [...systemWakeSubs]) cb(frozen);
    },
    setDispatchResult(actionId, result) {
      dispatchOverrides.set(actionId, result);
    },
    seedActionCatalog(entries) {
      actionCatalog.clear();
      for (const entry of entries) actionCatalog.set(entry.id, entry);
    },
    simulateFsWatch(changedPath) {
      // Snapshot before firing so a callback that registers/disposes a watcher
      // doesn't mutate the set mid-iteration.
      for (const { callback } of [...fsWatchers]) callback(changedPath);
    },
    simulateQuickPickResponse(result) {
      quickPickResponse = result;
    },
    simulateInputBoxResponse(result) {
      inputBoxResponse = result;
    },
    simulateConfirmResponse(result) {
      confirmResponse = result;
    },
  };

  return host;
}

/**
 * Value equality matching `PluginSettingsStore.valuesEqual`: reference-equal or
 * JSON-equal. Used by the storage mock so its change detection (and therefore
 * its onDidChange firing) matches the real store rather than reference identity.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
