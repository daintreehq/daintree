/**
 * Presentation for `createMockHost`: badges, toolbar state, context keys,
 * worktree and terminal status, panel activity and menus, toasts,
 * notifications, tasks and the imperative prompts, each validated as the
 * real host validates it and recorded for assertions.
 */

import {
  PLUGIN_NOTIFY_MAX_ACTIONS,
  PLUGIN_PANEL_ACTIVITY_MAX_PANELS,
  PLUGIN_TASK_MAX_LIVE,
  PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT,
} from "../../types/plugin.js";
import {
  pluginTaskAbortReason,
  validatePluginTaskProgress,
  validatePluginTaskResult,
  validatePluginTaskStart,
} from "../../utils/pluginTasks.js";
import { toRuntimePanelKindId } from "../../config/panelKindRegistry.js";
import { normalizePanelMenuItems } from "../../utils/pluginPanelMenuItems.js";
import {
  applyPluginContextEntry,
  validatePluginContextEntry,
} from "../../utils/pluginContextKeys.js";
import { validatePluginWorktreeCardStatus } from "../../utils/pluginWorktreeCardStatus.js";
import { validatePluginWorktreeReviewChecks } from "../../utils/pluginWorktreeReviewChecks.js";
import { validatePluginTerminalStatus } from "../../utils/pluginTerminalStatus.js";
import { validatePluginPanelActivity } from "../../utils/pluginPanelActivity.js";
import type {
  PluginHostApi,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginHostCallOptions,
  PluginToastOptions,
  PluginNotifyOptions,
  PluginNotifyResult,
  PluginTaskHandle,
  PluginWorktreesResult,
  PluginAgentPane,
  PluginPanelLifecycleEvent,
  WorkerRestartResult,
  PluginPanelBadge,
  PluginToolbarButtonRuntimeState,
  PluginContextValue,
  PluginWorktreeCardStatus,
  PluginWorktreeReviewCheck,
  PluginTerminalStatus,
  PluginPanelActivity,
} from "../../types/plugin.js";
import type { MockHostIdentity } from "./identity.js";
import type {
  ShownToastRecord,
  NotificationRecord,
  MockTaskRecord,
  SetToolbarButtonBadgeRecord,
  SetToolbarButtonStateRecord,
  SetContextRecord,
  SetWorktreeReviewChecksRecord,
  SetWorktreeCardStatusRecord,
  SetTerminalStatusRecord,
  SetPanelActivityRecord,
  SetPanelBadgeRecord,
  SetPanelMenuItemsRecord,
  ShowQuickPickRecord,
  ShowInputBoxRecord,
  ShowConfirmRecord,
  CreateMockHostOptions,
  MockHost,
} from "./types.js";

export type PresentationMembers = Pick<
  MockHost,
  | "setPanelBadge"
  | "setToolbarButtonBadge"
  | "setToolbarButtonState"
  | "setContext"
  | "setWorktreeCardStatus"
  | "setWorktreeReviewChecks"
  | "setTerminalStatus"
  | "setPanelActivity"
  | "setPanelMenuItems"
  | "reloadPanel"
  | "restartWorker"
  | "showToast"
  | "notify"
  | "tasks"
  | "showQuickPick"
  | "showInputBox"
  | "showConfirm"
  | "shownToasts"
  | "notifications"
  | "setPanelBadgeCalls"
  | "setToolbarButtonBadgeCalls"
  | "setToolbarButtonStateCalls"
  | "setContextCalls"
  | "contextKeys"
  | "setWorktreeCardStatusCalls"
  | "worktreeCardStatuses"
  | "setWorktreeReviewChecksCalls"
  | "worktreeReviewChecks"
  | "setTerminalStatusCalls"
  | "terminalStatuses"
  | "startedTasks"
  | "setPanelActivityCalls"
  | "panelActivity"
  | "setPanelMenuItemsCalls"
  | "reloadPanelCalls"
  | "restartWorkerCalls"
  | "showQuickPickCalls"
  | "showInputBoxCalls"
  | "showConfirmCalls"
  | "simulateTaskCancel"
  | "simulateTaskInterrupt"
  | "simulateQuickPickResponse"
  | "simulateInputBoxResponse"
  | "simulateConfirmResponse"
>;

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

const NOTIFY_OPTION_KEYS = new Set([
  "title",
  "body",
  "severity",
  "delivery",
  "target",
  "actions",
  "os",
  "dedupeKey",
]);
const NOTIFY_SEVERITIES = new Set(["info", "warning", "error"]);
const NOTIFY_DELIVERIES = new Set(["active", "passive"]);
const NOTIFY_ACTION_KEYS = new Set(["id", "label", "actionId", "args"]);
const NOTIFY_ARGS_MAX_BYTES = 4096;

function isNotifyArgs(args: unknown): boolean {
  if (args === null || typeof args !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(args);
  if (proto !== Object.prototype && proto !== null) return false;
  try {
    const json = JSON.stringify(args);
    return json !== undefined && new TextEncoder().encode(json).length <= NOTIFY_ARGS_MAX_BYTES;
  } catch {
    return false;
  }
}

/**
 * Validate `host.notify` options against the constraints production's
 * `PluginNotifyOptionsSchema` and namespace check apply (#13505), so a plugin
 * tested against the mock fails on a shape the real host would reject.
 */
function validateNotifyOptions(
  opts: PluginNotifyOptions,
  manifestId: string,
  capabilities: ReadonlySet<string>
): void {
  const issues: string[] = [];
  if (!opts || typeof opts !== "object") {
    throw new Error("notify: invalid options — (root): must be an object");
  }
  for (const key of Object.keys(opts)) {
    if (!NOTIFY_OPTION_KEYS.has(key)) issues.push(`${key}: unrecognized option`);
  }
  const text = (name: string, value: unknown, max: number) => {
    if (typeof value !== "string" || value.trim().length < 1) {
      issues.push(`${name}: must be a non-empty string`);
    } else if (value.trim().length > max) {
      issues.push(`${name}: must be at most ${max} characters`);
    }
  };
  text("title", opts.title, 200);
  text("body", opts.body, 2000);
  if (opts.actions !== undefined) {
    if (!Array.isArray(opts.actions)) {
      issues.push("actions: must be an array");
    } else {
      if (opts.actions.length > PLUGIN_NOTIFY_MAX_ACTIONS) {
        issues.push(`actions: at most ${PLUGIN_NOTIFY_MAX_ACTIONS} entries`);
      }
      const ids = new Set<string>();
      for (let i = 0; i < opts.actions.length; i++) {
        const action = opts.actions[i];
        if (!action || typeof action !== "object") {
          issues.push(`actions.${i}: must be an object`);
          continue;
        }
        for (const key of Object.keys(action)) {
          if (!NOTIFY_ACTION_KEYS.has(key)) issues.push(`actions.${i}.${key}: unrecognized option`);
        }
        text(`actions.${i}.id`, action.id, 64);
        text(`actions.${i}.label`, action.label, 40);
        if (typeof action.id === "string") {
          const id = action.id.trim();
          if (ids.has(id)) issues.push("actions: action ids must be unique");
          ids.add(id);
        }
        const actionId: unknown = action.actionId;
        if (
          typeof actionId !== "string" ||
          actionId.length > 200 ||
          !actionId.startsWith(`${manifestId}.`) ||
          actionId.length === manifestId.length + 1
        ) {
          issues.push(
            `actions.${i}.actionId: must be one of this plugin's own actions, written "${manifestId}.<id>"`
          );
        }
        if (action.args !== undefined && !isNotifyArgs(action.args)) {
          issues.push(
            `actions.${i}.args: must be a JSON-serializable object of at most ${NOTIFY_ARGS_MAX_BYTES} bytes`
          );
        }
      }
    }
  }
  if (opts.os !== undefined && typeof opts.os !== "boolean") issues.push("os: must be a boolean");
  if (opts.dedupeKey !== undefined) text("dedupeKey", opts.dedupeKey, 200);
  if (opts.severity !== undefined && !NOTIFY_SEVERITIES.has(opts.severity)) {
    issues.push('severity: must be "info", "warning" or "error"');
  }
  if (opts.delivery !== undefined && !NOTIFY_DELIVERIES.has(opts.delivery)) {
    issues.push('delivery: must be "active" or "passive"');
  }
  // Only the target's shape: whether the panel is the plugin's own and the
  // worktree one it can see is the real host's to check (#13818).
  if (opts.target !== undefined) {
    const target: unknown = opts.target;
    const keys = target && typeof target === "object" ? Object.keys(target) : [];
    const [key] = keys;
    const value = key ? (target as Record<string, unknown>)[key] : undefined;
    if (
      keys.length !== 1 ||
      (key !== "panelId" && key !== "worktreeId") ||
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > (key === "panelId" ? 256 : 4096)
    ) {
      issues.push("target: must be { panelId } or { worktreeId } with a non-empty string");
    }
  }
  if (opts.severity === "error" && (!Array.isArray(opts.actions) || opts.actions.length !== 1)) {
    issues.push('actions: an "error" notification needs exactly one action, the way out of it');
  }
  if (opts.delivery === "passive" && opts.severity === "error") {
    issues.push('delivery: an "error" notification can\'t be passive');
  }
  if (opts.delivery === "passive" && opts.os === true) {
    issues.push("os: a passive notification stays in the inbox and can't page the OS");
  }
  if (issues.length > 0) {
    throw new Error(`notify: invalid options — ${issues.join("; ")}`);
  }
  if (opts.os && !capabilities.has("notification:os")) {
    throw new Error(
      'PERMISSION_REQUIRED: notify with os: true requires "notification:os", which is not declared in manifest.capabilities'
    );
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

const TOOLBAR_STATE_BOOLEAN_KEYS = ["pressed", "disabled", "busy"] as const;
const TOOLBAR_STATE_TEXT_KEYS = ["disabledReason", "tooltip"] as const;
const TOOLBAR_STATE_KEYS: ReadonlySet<string> = new Set([
  ...TOOLBAR_STATE_BOOLEAN_KEYS,
  ...TOOLBAR_STATE_TEXT_KEYS,
  "iconId",
  "menu",
]);
/** Mirrors `PLUGIN_TOOLBAR_BUTTON_STATE_TEXT_MAX` in `shared/types/plugin.ts`. */
const MOCK_TOOLBAR_STATE_TEXT_MAX = 200;

/** Mirror production's `PluginToolbarButtonRuntimeStateSchema` (#13785). */
function validateToolbarButtonState(
  state: PluginToolbarButtonRuntimeState,
  manifestId: string,
  pluginId: string
): void {
  const fail = (message: string): never => {
    throw new Error(`setToolbarButtonState: invalid state — ${message}`);
  };
  if (!state || typeof state !== "object" || Array.isArray(state)) fail("state must be an object");
  for (const key of Object.keys(state)) {
    if (!TOOLBAR_STATE_KEYS.has(key)) fail(`${key}: unrecognized key`);
  }
  for (const key of TOOLBAR_STATE_BOOLEAN_KEYS) {
    const value = (state as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "boolean") fail(`${key}: must be a boolean`);
  }
  for (const key of TOOLBAR_STATE_TEXT_KEYS) {
    const value = (state as Record<string, unknown>)[key];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        value.trim().length < 1 ||
        value.trim().length > MOCK_TOOLBAR_STATE_TEXT_MAX)
    ) {
      fail(`${key}: must be a non-empty string at most ${MOCK_TOOLBAR_STATE_TEXT_MAX} characters`);
    }
  }
  const iconId = (state as { iconId?: unknown }).iconId;
  if (
    iconId !== undefined &&
    (typeof iconId !== "string" || iconId.length < 1 || iconId.length > 256)
  ) {
    fail("iconId: must be a non-empty string at most 256 characters");
  }
  if (state.menu !== undefined) {
    if (!Array.isArray(state.menu)) fail("menu: must be an array");
    // Production's strict item schema: only `actionId` and a 1 to 80 character label.
    for (const item of state.menu) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      for (const key of Object.keys(item)) {
        if (key !== "actionId" && key !== "label") fail(`menu: ${key}: unrecognized key`);
      }
      const label = (item as { label?: unknown }).label;
      if (
        label !== undefined &&
        (typeof label !== "string" || label.trim().length < 1 || label.trim().length > 80)
      ) {
        fail("menu: label: must be a non-empty string at most 80 characters");
      }
    }
    // The host's own vetting, so a menu it refuses rejects here too.
    const menu = normalizePanelMenuItems(state.menu, manifestId, pluginId);
    if (!menu.ok) fail(`menu: ${menu.error}`);
  }
  if (state.disabled === true && state.disabledReason === undefined) {
    fail("disabledReason: a disabled button needs a disabledReason");
  }
  if (state.disabled !== true && state.disabledReason !== undefined) {
    fail("disabledReason: disabledReason is only valid with disabled: true");
  }
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

export interface PresentationFacet {
  members: PresentationMembers;
}

export function createPresentationFacet(
  identity: MockHostIdentity,
  options: CreateMockHostOptions,
  collaborators: {
    resolveWorktreesResult(): PluginWorktreesResult;
    agentPanes(): readonly PluginAgentPane[];
    panelPhases: ReadonlyMap<string, PluginPanelLifecycleEvent>;
    /** The composed host's `notify`, so a task's notification goes through it. */
    notify(options: PluginNotifyOptions): Promise<PluginNotifyResult>;
  }
): PresentationFacet {
  const {
    pluginId,
    manifestId: mockManifestId,
    projectId: mockProjectId,
    pluginInfo,
    capabilities,
  } = identity;
  const { resolveWorktreesResult, agentPanes, panelPhases } = collaborators;
  const shownToasts: ShownToastRecord[] = [];
  const notifications: NotificationRecord[] = [];
  const setPanelBadgeCalls: SetPanelBadgeRecord[] = [];
  const setToolbarButtonBadgeCalls: SetToolbarButtonBadgeRecord[] = [];
  const setToolbarButtonStateCalls: SetToolbarButtonStateRecord[] = [];
  const setContextCalls: SetContextRecord[] = [];
  const contextKeys = new Map<string, PluginContextValue>();
  const setWorktreeCardStatusCalls: SetWorktreeCardStatusRecord[] = [];
  const worktreeCardStatuses = new Map<string, PluginWorktreeCardStatus>();
  const setWorktreeReviewChecksCalls: SetWorktreeReviewChecksRecord[] = [];
  const worktreeReviewChecks = new Map<string, readonly PluginWorktreeReviewCheck[]>();
  const setTerminalStatusCalls: SetTerminalStatusRecord[] = [];
  const terminalStatuses = new Map<string, PluginTerminalStatus>();
  const setPanelActivityCalls: SetPanelActivityRecord[] = [];
  const tasks: MockTaskRecord[] = [];
  const taskControllers = new Map<string, AbortController>();
  const panelActivity = new Map<string, PluginPanelActivity>();
  const setPanelMenuItemsCalls: SetPanelMenuItemsRecord[] = [];
  const reloadPanelCalls: string[] = [];
  const restartWorkerCalls: WorkerRestartResult[] = [];
  const showQuickPickCalls: ShowQuickPickRecord[] = [];
  const showInputBoxCalls: ShowInputBoxRecord[] = [];
  const showConfirmCalls: ShowConfirmRecord[] = [];
  // Configurable answers for the imperative UI prompts. Default to the dismiss
  // value (cancel) a user produces; `simulate*Response` overrides per test.
  let quickPickResponse: PluginQuickPickItem | PluginQuickPickItem[] | undefined;
  let inputBoxResponse: string | undefined;
  let confirmResponse = false;

  const members: PresentationMembers = {
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
    setToolbarButtonBadge(buttonId, badge) {
      if (typeof buttonId !== "string" || buttonId.length === 0) {
        return Promise.reject(
          new Error("setToolbarButtonBadge: buttonId must be a non-empty string")
        );
      }
      if (options.toolbarButtonIds && !options.toolbarButtonIds.includes(buttonId)) {
        return Promise.reject(
          new Error(
            `setToolbarButtonBadge: "${buttonId}" is not one of this plugin's contributes.toolbarButtons`
          )
        );
      }
      if (badge !== null && badge !== undefined) {
        try {
          validatePanelBadge(badge);
        } catch (err) {
          return Promise.reject(
            new Error((err as Error).message.replace(/^setPanelBadge:/, "setToolbarButtonBadge:"))
          );
        }
      }
      setToolbarButtonBadgeCalls.push({ buttonId, badge: badge ?? null });
      return Promise.resolve();
    },
    setToolbarButtonState(buttonId, state) {
      if (typeof buttonId !== "string" || buttonId.length === 0) {
        return Promise.reject(
          new Error("setToolbarButtonState: buttonId must be a non-empty string")
        );
      }
      if (options.toolbarButtonIds && !options.toolbarButtonIds.includes(buttonId)) {
        return Promise.reject(
          new Error(
            `setToolbarButtonState: "${buttonId}" is not one of this plugin's contributes.toolbarButtons`
          )
        );
      }
      if (state !== null && state !== undefined) {
        try {
          validateToolbarButtonState(state, mockManifestId, pluginId);
        } catch (err) {
          return Promise.reject(err);
        }
      }
      setToolbarButtonStateCalls.push({ buttonId, state: state ?? null });
      return Promise.resolve();
    },
    setContext(key, value) {
      // The host's own validator and cap, so a call the real host refuses
      // rejects here too.
      const entry = validatePluginContextEntry(key, value);
      if (!entry.ok) return Promise.reject(new Error(`setContext: ${entry.error}`));
      const applied = applyPluginContextEntry(contextKeys, entry.key, entry.value);
      if (!applied.ok) return Promise.reject(new Error(`setContext: ${applied.error}`));
      setContextCalls.push({ key: entry.key, value: entry.value });
      return Promise.resolve();
    },
    async setWorktreeCardStatus(worktreeId, status) {
      // The host's own validator and worktree check, against whatever
      // `getWorktreesResult()` answers right now.
      const entry = validatePluginWorktreeCardStatus(worktreeId, status, mockManifestId, pluginId);
      if (!entry.ok) throw new Error(`setWorktreeCardStatus: ${entry.error}`);
      const result: PluginWorktreesResult = resolveWorktreesResult();
      if (result.status !== "ok") {
        throw new Error(`setWorktreeCardStatus: worktrees are unavailable (${result.reason})`);
      }
      const target = result.worktrees.find(
        (w) => w.id === entry.worktreeId || w.worktreeId === entry.worktreeId
      );
      if (!target) {
        throw new Error(
          `setWorktreeCardStatus: "${entry.worktreeId}" is not a worktree this plugin can see`
        );
      }
      if (entry.status === null) worktreeCardStatuses.delete(target.id);
      else worktreeCardStatuses.set(target.id, entry.status);
      setWorktreeCardStatusCalls.push({ worktreeId: target.id, status: entry.status });
    },
    async setWorktreeReviewChecks(worktreeId, checks) {
      const entry = validatePluginWorktreeReviewChecks(
        worktreeId,
        checks,
        mockManifestId,
        pluginId
      );
      if (!entry.ok) throw new Error(`setWorktreeReviewChecks: ${entry.error}`);
      const result: PluginWorktreesResult = resolveWorktreesResult();
      if (result.status !== "ok") {
        throw new Error(`setWorktreeReviewChecks: worktrees are unavailable (${result.reason})`);
      }
      const target = result.worktrees.find(
        (w) => w.id === entry.worktreeId || w.worktreeId === entry.worktreeId
      );
      if (!target) {
        throw new Error(
          `setWorktreeReviewChecks: "${entry.worktreeId}" is not a worktree this plugin can see`
        );
      }
      if (entry.checks === null) worktreeReviewChecks.delete(target.id);
      else worktreeReviewChecks.set(target.id, entry.checks);
      setWorktreeReviewChecksCalls.push({ worktreeId: target.id, checks: entry.checks });
    },
    async setTerminalStatus(terminalId, status) {
      // Same order as production: capability, then the shared validator, then
      // membership in whatever `agents.list()` answers right now.
      if (!capabilities.has("agent:read")) {
        throw new Error(
          'PERMISSION_REQUIRED: setTerminalStatus requires "agent:read", which is not declared in manifest.capabilities'
        );
      }
      const entry = validatePluginTerminalStatus(terminalId, status, mockManifestId, pluginId);
      if (!entry.ok) throw new Error(`setTerminalStatus: ${entry.error}`);
      if (!agentPanes().some((pane) => pane.terminalId === entry.terminalId)) {
        throw new Error(
          `setTerminalStatus: "${entry.terminalId}" is not a terminal this plugin can see`
        );
      }
      if (entry.status === null) terminalStatuses.delete(entry.terminalId);
      else {
        if (
          !terminalStatuses.has(entry.terminalId) &&
          terminalStatuses.size >= PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT
        ) {
          throw new Error(
            `setTerminalStatus: at most ${PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT} terminals can hold a status at once`
          );
        }
        terminalStatuses.set(entry.terminalId, entry.status);
      }
      setTerminalStatusCalls.push({ terminalId: entry.terminalId, status: entry.status });
    },
    async setPanelActivity(panelId, activity) {
      // Same order as production: the shared validator, then the declaration,
      // then whose the panel is as far as the simulated lifecycle says.
      const entry = validatePluginPanelActivity(panelId, activity);
      if (!entry.ok) throw new Error(`setPanelActivity: ${entry.error}`);
      if (entry.activity === null) {
        panelActivity.delete(entry.panelId);
        setPanelActivityCalls.push({ panelId: entry.panelId, activity: null });
        return;
      }
      const declared = options.reportsActivityPanelIds;
      if (declared && declared.length === 0) {
        throw new Error(
          "setPanelActivity: none of this plugin's contributes.panels declares reportsActivity: true"
        );
      }
      const known = panelPhases.get(entry.panelId);
      if (known && known.pluginId !== pluginId) {
        throw new Error(`setPanelActivity: panel "${entry.panelId}" belongs to another plugin`);
      }
      if (
        known &&
        declared &&
        !declared.some(
          (id) =>
            known.panelKindId === id ||
            known.panelKindId ===
              toRuntimePanelKindId(
                { origin: pluginInfo.origin, pluginId: mockManifestId, kindId: id },
                mockProjectId
              )
        )
      ) {
        throw new Error(
          `setPanelActivity: panel kind "${known.panelKindId}" does not declare reportsActivity: true`
        );
      }
      if (
        !panelActivity.has(entry.panelId) &&
        panelActivity.size >= PLUGIN_PANEL_ACTIVITY_MAX_PANELS
      ) {
        throw new Error(
          `setPanelActivity: activity is already reported on ${PLUGIN_PANEL_ACTIVITY_MAX_PANELS} panels — clear a closed panel's with null`
        );
      }
      panelActivity.set(entry.panelId, entry.activity);
      setPanelActivityCalls.push({ panelId: entry.panelId, activity: entry.activity });
    },
    setPanelMenuItems(panelId, items) {
      // Vetted by the host's own normalizer, so a list the real host refuses
      // rejects here too.
      if (typeof panelId !== "string" || panelId.length === 0) {
        return Promise.reject(new Error("setPanelMenuItems: panelId must be a non-empty string"));
      }
      const result = normalizePanelMenuItems(items, mockManifestId, pluginId);
      if (!result.ok) {
        return Promise.reject(new Error(`setPanelMenuItems: invalid items — ${result.error}`));
      }
      setPanelMenuItemsCalls.push({ panelId, items: items ?? null });
      return Promise.resolve();
    },
    async reloadPanel(panelId) {
      if (typeof panelId !== "string" || panelId.trim().length === 0) {
        throw new Error("reloadPanel: panelId must be a non-empty string");
      }
      reloadPanelCalls.push(panelId);
      if (options.reloadPanel) return options.reloadPanel(panelId);
      const known = panelPhases.get(panelId);
      if (!known) return "not-mounted";
      if (known.pluginId !== pluginId) {
        throw new Error(`reloadPanel: panel "${panelId}" belongs to another plugin`);
      }
      if (known.phase === "mounted") return "scheduled";
      if (known.phase === "render-failed") return "unavailable";
      return "not-mounted";
    },
    async restartWorker() {
      const result = options.restartWorker ? await options.restartWorker() : "scheduled";
      restartWorkerCalls.push(result);
      return result;
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
    async notify(opts: PluginNotifyOptions): Promise<PluginNotifyResult> {
      validateNotifyOptions(opts, mockManifestId, capabilities);
      const id = `mock-notification-${notifications.length + 1}`;
      notifications.push({ id, options: opts });
      return { id };
    },
    tasks: {
      async start(startOptions): Promise<PluginTaskHandle> {
        const vetted = validatePluginTaskStart(startOptions);
        if (!vetted.ok) throw new Error(`tasks.start: ${vetted.error}`);
        const { actionId } = vetted.value.retry;
        if (!actionId.startsWith(`${mockManifestId}.`) || actionId === `${mockManifestId}.`) {
          throw new Error(
            `tasks.start: retry.actionId "${actionId}" must be one of this plugin's own actions, written "${mockManifestId}.<id>"`
          );
        }
        const live = tasks.filter((t) => t.state === "working" || t.state === "cancelling");
        if (live.length >= PLUGIN_TASK_MAX_LIVE) {
          throw new Error(
            `tasks.start: already has ${PLUGIN_TASK_MAX_LIVE} unfinished tasks — finish one before starting another`
          );
        }
        const record: MockTaskRecord = {
          id: `mock-task-${tasks.length + 1}`,
          options: vetted.value,
          state: "working",
          fraction: vetted.value.fraction,
          detail: vetted.value.detail,
          reports: [],
          result: undefined,
        };
        tasks.push(record);
        const controller = new AbortController();
        taskControllers.set(record.id, controller);
        const running = () => record.state === "working" || record.state === "cancelling";
        return {
          id: record.id,
          signal: controller.signal,
          report(progress) {
            const vettedProgress = validatePluginTaskProgress(progress);
            if (!vettedProgress.ok) throw new Error(`task.report: ${vettedProgress.error}`);
            if (!running()) return;
            record.reports.push(vettedProgress.value);
            if (vettedProgress.value.fraction !== undefined) {
              record.fraction = vettedProgress.value.fraction;
            }
            if (vettedProgress.value.detail !== undefined) {
              record.detail = vettedProgress.value.detail || undefined;
            }
          },
          async finish(result) {
            const vettedResult = validatePluginTaskResult(result);
            if (!vettedResult.ok) throw new Error(`task.finish: ${vettedResult.error}`);
            if (!running()) return;
            const cancelRequested = record.state === "cancelling";
            const outcome = vettedResult.value;
            record.state = outcome.outcome;
            record.result = outcome;
            taskControllers.delete(record.id);
            // The same notifications the real host raises; a task the user
            // cancelled shows nothing, however it ended.
            if (cancelRequested) return;
            if (outcome.outcome === "failed") {
              await collaborators.notify({
                title: `${record.options.title} failed`,
                body: outcome.message,
                severity: "error",
                actions: [{ id: "retry", label: "Retry", ...record.options.retry }],
                dedupeKey: `task:${record.id}`,
              });
            } else if (outcome.outcome === "succeeded" && outcome.message !== undefined) {
              await collaborators.notify({
                title: record.options.title,
                body: outcome.message,
                delivery: "passive",
                dedupeKey: `task:${record.id}`,
              });
            }
          },
        };
      },
    },
    // Imperative UI prompts (#10522, hardened in #10617). The mock has no
    // renderer to drive a dialog, so each prompt validates its arguments to
    // production parity, records the call for assertions, then resolves the
    // configured `simulate*Response` value (default = the user-cancel dismiss
    // value). A shape the real host rejects now fails the mock too.
    // An already-aborted signal dismisses without recording a call, matching
    // production — a plugin test must not get a configured answer to a question
    // the real host would never have asked (#12279).
    showQuickPick: (async (
      items: PluginQuickPickItem[],
      options?: PluginQuickPickOptions,
      callOptions?: PluginHostCallOptions
    ) => {
      const validItems = validateQuickPickItems(items);
      if (callOptions?.signal?.aborted) return undefined;
      showQuickPickCalls.push({ items: validItems, options });
      return quickPickResponse;
    }) as PluginHostApi["showQuickPick"],
    async showInputBox(options, callOptions) {
      if (callOptions?.signal?.aborted) return undefined;
      showInputBoxCalls.push({ options });
      return inputBoxResponse;
    },
    async showConfirm(options, callOptions) {
      if (!options || typeof options !== "object" || typeof options.title !== "string") {
        throw new Error("showConfirm: options.title must be a string");
      }
      if (callOptions?.signal?.aborted) return false;
      showConfirmCalls.push({ options });
      return confirmResponse;
    },
    shownToasts,
    notifications,
    setPanelBadgeCalls,
    setToolbarButtonBadgeCalls,
    setToolbarButtonStateCalls,
    setContextCalls,
    contextKeys,
    setWorktreeCardStatusCalls,
    worktreeCardStatuses,
    setWorktreeReviewChecksCalls,
    worktreeReviewChecks,
    setTerminalStatusCalls,
    terminalStatuses,
    startedTasks: tasks,
    setPanelActivityCalls,
    panelActivity,
    setPanelMenuItemsCalls,
    reloadPanelCalls,
    restartWorkerCalls,
    showQuickPickCalls,
    showInputBoxCalls,
    showConfirmCalls,
    simulateTaskCancel(taskId) {
      const record = tasks.find((t) => t.id === taskId);
      if (!record || record.state !== "working" || !record.options.cancellable) {
        throw new Error(`simulateTaskCancel: "${taskId}" is not a running cancellable task`);
      }
      record.state = "cancelling";
      taskControllers.get(taskId)?.abort(pluginTaskAbortReason("cancelled"));
    },
    simulateTaskInterrupt(taskId) {
      const record = tasks.find((t) => t.id === taskId);
      if (!record || (record.state !== "working" && record.state !== "cancelling")) {
        throw new Error(`simulateTaskInterrupt: "${taskId}" is not a running task`);
      }
      record.state = "interrupted";
      const controller = taskControllers.get(taskId);
      taskControllers.delete(taskId);
      controller?.abort(pluginTaskAbortReason("interrupted"));
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

  return { members };
}
