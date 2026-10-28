import { getPanelKindConfig } from "../../../shared/config/panelKindRegistry.js";
import {
  isPluginCustomIconRef,
  makePluginCustomIconKey,
} from "../../../shared/config/pluginCustomIcon.js";
import { createListenerFailureState, invokeTrackedListener } from "./pluginCallbackUtils.js";
import {
  PLUGIN_PANEL_ACTIVITY_MAX_PANELS,
  PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT,
} from "../../../shared/types/plugin.js";

import { scopeMatchesPattern } from "../fileDecorationRegistry.js";
import { PLUGIN_PUSH_MAX_PAYLOAD_BYTES } from "../../../shared/config/pluginBudgets.js";
import { assertPayloadWithinLimit, snapshotPayload } from "./pluginPayloadLimits.js";
import {
  PLUGIN_STATE_PANEL_ACTIVITY,
  PLUGIN_STATE_PANEL_BADGES,
  flushPluginPushes,
  getPluginStatePublisher,
  routePluginPush,
  withPushFlushBarrier,
} from "./pluginPushBatcher.js";
import { getPluginPushListenerRegistry } from "./pluginPushListenerRegistry.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  PluginPanelBadgeSchema,
  PluginToolbarButtonRuntimeStateSchema,
} from "../../schemas/plugin.js";
import {
  normalizePanelMenuItems,
  samePanelMenuItems,
} from "../../../shared/utils/pluginPanelMenuItems.js";
import {
  applyPluginContextEntry,
  validatePluginContextEntry,
} from "../../../shared/utils/pluginContextKeys.js";
import {
  sameWorktreeCardStatus,
  validatePluginWorktreeCardStatus,
} from "../../../shared/utils/pluginWorktreeCardStatus.js";
import {
  sameWorktreeReviewChecks,
  validatePluginWorktreeReviewChecks,
} from "../../../shared/utils/pluginWorktreeReviewChecks.js";
import {
  sameTerminalStatus,
  validatePluginTerminalStatus,
} from "../../../shared/utils/pluginTerminalStatus.js";
import {
  samePanelActivity,
  validatePluginPanelActivity,
} from "../../../shared/utils/pluginPanelActivity.js";
import type {
  PluginHostApi,
  PluginWorktreesResult,
  PluginPanelBadge,
  PluginToolbarButtonRuntimeState,
  PluginContextValue,
  PluginHostBinding,
} from "../../../shared/types/plugin.js";
import {
  type PluginHostFactoryDeps,
  trackPluginDisposer,
  isProjectViewUnavailable,
} from "./pluginHostDeps.js";
import type { PluginEventScope } from "./pluginEventScope.js";
import type { PluginRendererDispatcher } from "./PluginRendererDispatcher.js";
import type { PushListenerObserver } from "./pluginInternalApprovers.js";

/**
 * Max file paths a single `host.invalidateFileDecorations` call broadcasts.
 * A misbehaving plugin could otherwise pass an unbounded array, forcing an
 * arbitrarily large IPC payload to every renderer view. Beyond the cap the
 * scope-wide invalidation (no `paths`) is the correct fallback anyway.
 */
const MAX_FILE_DECORATION_PATHS = 1000;

/**
 * Most panels one plugin may hold a runtime menu on at once. Main keeps the
 * lists for replay and cannot tell a closed panel from one moving between
 * windows, so a plugin that never clears is bounded rather than trusted.
 */
const PLUGIN_PANEL_MENUS_MAX_PANELS = 256;
/** Most panels one plugin may badge at once, for the same reason as its menus. */
const PLUGIN_PANEL_BADGES_MAX_PANELS = 256;

/** An omitted colour is `default`, so it is the same badge as one that says so. */
function sameToolbarButtonState(
  a: PluginToolbarButtonRuntimeState,
  b: PluginToolbarButtonRuntimeState
): boolean {
  return (
    a.pressed === b.pressed &&
    a.disabled === b.disabled &&
    a.disabledReason === b.disabledReason &&
    a.busy === b.busy &&
    a.tooltip === b.tooltip &&
    a.iconId === b.iconId &&
    (a.menu === undefined
      ? b.menu === undefined
      : b.menu !== undefined && samePanelMenuItems(a.menu, b.menu))
  );
}

function samePanelBadge(a: PluginPanelBadge, b: PluginPanelBadge): boolean {
  return (
    a.kind === b.kind &&
    (a.color ?? "default") === (b.color ?? "default") &&
    a.tooltip === b.tooltip &&
    (a.kind !== "label" || (b.kind === "label" && a.text === b.text))
  );
}

/** What the presentation surface reads from `createHost`. */
export interface PluginHostPresentationContext {
  readonly boundPlugin: PluginEventScope["boundPlugin"];
  readonly boundProjectId: PluginHostBinding["projectId"];
  readonly deps: Pick<
    PluginHostFactoryDeps,
    | "declaredCapabilities"
    | "emitContextKeys"
    | "emitPanelActivity"
    | "emitTerminalStatuses"
    | "emitToolbarBadges"
    | "emitToolbarStates"
    | "emitWorktreeCardStatuses"
    | "emitWorktreeReviewChecks"
    | "isTerminalStatusProjectClosed"
    | "isWorktreeCardTargetRetired"
    | "nextPanelActivityRevision"
    | "panelLifecycleBroker"
    | "panelReloadDispatcher"
    | "pluginBadges"
    | "pluginContextKeys"
    | "pluginEventCleanups"
    | "pluginPanelActivity"
    | "pluginPanelMenus"
    | "pluginTerminalStatuses"
    | "pluginToolbarBadges"
    | "pluginToolbarStates"
    | "pluginWorktreeCardStatuses"
    | "pluginWorktreeReviewChecks"
    | "plugins"
    | "recordPushRejected"
    | "serializePluginBadges"
    | "serializePluginPanelMenus"
    | "terminalStatusCloseRevision"
    | "terminalStatusGeneration"
    | "worktreeCardStatusGeneration"
    | "worktreeCardTargetRevision"
    | "worktreeReviewChecksGeneration"
  >;
  /** Delivers this plugin's pending pushes before each renderer round-trip. */
  readonly dispatcher: PluginRendererDispatcher;
  readonly getWorktreesResult: () => Promise<PluginWorktreesResult>;
  readonly isBound: PluginEventScope["isBound"];
  /** True once `activate()` has returned; activation-only registrations refuse after it. */
  readonly isRevoked: () => boolean;
  readonly manifestId: string;
  readonly pluginId: string;
  /** `sendToScope` after delivering this plugin's pending pushes. */
  readonly pushToRenderers: (channel: string, ...args: unknown[]) => void;
  /** Renderer delivery to the views this host's binding reaches, with no flush. */
  readonly sendToScope: (channel: string, ...args: unknown[]) => void;
}

/**
 * The host's renderer pushes and the state it publishes to views: badges,
 * activity, toolbar state, context keys, worktree and terminal statuses, panel
 * menus and reloads. `observePushListeners` backs the worker bridge's
 * `hasListeners` cache and is registered against the composed host.
 */
export function buildPresentationHostApi(ctx: PluginHostPresentationContext): {
  api: Pick<
    PluginHostApi,
    | "broadcastToRenderer"
    | "postToPanel"
    | "hasListeners"
    | "onDidChangeListeners"
    | "invalidateFileDecorations"
    | "setPanelBadge"
    | "setPanelActivity"
    | "setToolbarButtonBadge"
    | "setToolbarButtonState"
    | "setContext"
    | "setWorktreeCardStatus"
    | "setWorktreeReviewChecks"
    | "setTerminalStatus"
    | "setPanelMenuItems"
    | "reloadPanel"
  >;
  observePushListeners: PushListenerObserver;
} {
  const {
    boundPlugin,
    boundProjectId,
    deps,
    dispatcher,
    getWorktreesResult,
    isBound,
    isRevoked,
    manifestId,
    pluginId,
    pushToRenderers,
    sendToScope,
  } = ctx;
  const panelReloadDispatcher = withPushFlushBarrier(deps.panelReloadDispatcher);
  /**
   * The `plugin:{pluginId}:{channel}` transport shared by broadcastToRenderer
   * and postToPanel. Throws on an oversize payload (each caller surfaces that
   * the way it surfaces its other validation errors); the worker proxy applies
   * the same cap before the payload crosses its port, and this re-check covers
   * builtins and a worker that skipped it. Delivery is batched per renderer and, for a
   * targeted push, narrowed to the renderer holding the panel.
   */
  const pushPluginMessage = (channel: string, panelId: string | null, payload: unknown): void => {
    const what = `push payload on "${channel}"`;
    let bytes: number;
    let snapshot: unknown;
    try {
      bytes = assertPayloadWithinLimit(pluginId, what, payload, PLUGIN_PUSH_MAX_PAYLOAD_BYTES);
      // Delivery is deferred to the next flush, so a builtin that mutates and
      // re-posts one object must not have both pushes carry its final state.
      // Cloning here also refuses an uncloneable payload on the call that made
      // it, instead of failing a whole renderer batch later.
      snapshot = snapshotPayload(pluginId, what, payload);
    } catch (err) {
      // Metered here because a refused push never reaches the batcher's flush
      // observer, which is where accepted pushes are counted.
      if (isBound()) deps.recordPushRejected?.(pluginId);
      throw err;
    }
    routePluginPush({
      pluginId,
      projectId: boundProjectId,
      channel: `plugin:${pluginId}:${channel}`,
      panelId,
      payload: snapshot,
      bytes,
      locatePanel: (target, owner) => deps.panelLifecycleBroker.pushTargetsFor(target, owner),
    });
  };

  /** Validate a push channel name and return its `plugin:{pluginId}:{channel}` transport. */
  const pushListenerChannel = (method: string, channel: unknown): string => {
    if (typeof channel !== "string" || channel.length === 0 || channel.includes(":")) {
      throw new Error(
        `Plugin "${pluginId}" ${method}: channel must be a non-empty string without colons: ${String(channel)}`
      );
    }
    return `plugin:${pluginId}:${channel}`;
  };

  let worktreeCardStatusChain: Promise<void> = Promise.resolve();
  let worktreeReviewChecksChain: Promise<void> = Promise.resolve();
  let terminalStatusChain: Promise<void> = Promise.resolve();
  const api: Pick<
    PluginHostApi,
    | "broadcastToRenderer"
    | "postToPanel"
    | "hasListeners"
    | "onDidChangeListeners"
    | "invalidateFileDecorations"
    | "setPanelBadge"
    | "setPanelActivity"
    | "setToolbarButtonBadge"
    | "setToolbarButtonState"
    | "setContext"
    | "setWorktreeCardStatus"
    | "setWorktreeReviewChecks"
    | "setTerminalStatus"
    | "setPanelMenuItems"
    | "reloadPanel"
  > = {
    broadcastToRenderer: (channel, payload) => {
      if (isRevoked()) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: broadcastToRenderer called after activate() returned or timed out`
        );
      }
      if (typeof channel !== "string" || channel.includes(":")) {
        throw new Error(
          `Plugin broadcast channel must be a string without colons: ${String(channel)}`
        );
      }
      // Wrap in the per-instance envelope (panelId: null = broadcast) so the
      // preload dispatcher sees the same shape for every push over this
      // transport — broadcastToRenderer, postToPanel, and the process stream
      // share the `plugin:{pluginId}:{channel}` channel and one `plugin.on`
      // subscriber receives all three.
      pushPluginMessage(channel, null, payload);
      return Promise.resolve();
    },
    // The post-activation-safe sibling of broadcastToRenderer: same
    // `plugin:{pluginId}:{channel}` transport, but NOT revoke-guarded — it is
    // called from the plugin's own timers, polls, and subscription callbacks
    // long after activate() resolves, so a plugin can stream live data into
    // its panels without the renderer degrading to invoke() polling. Liveness
    // is plugin membership (mirrors invalidateFileDecorations/showToast): once
    // the plugin unloads this silently no-ops.
    postToPanel: (channel, payload, panelId) => {
      if (!isBound()) return Promise.resolve();
      if (typeof channel !== "string" || channel.length === 0 || channel.includes(":")) {
        // Reject (not sync throw): this is a post-activation runtime-surface
        // method returning a Promise, so a validation error must stay inside
        // the Promise contract a plugin can `.catch()` (#10617). The liveness
        // no-op above stays a silent resolve.
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" postToPanel: channel must be a non-empty string without colons: ${String(channel)}`
          )
        );
      }
      // `undefined` (arg omitted) and `null` both mean broadcast; only a
      // non-empty string targets a single panel instance. An empty string is
      // an authoring mistake (it would silently match no subscriber), so
      // reject it loudly rather than coercing to broadcast.
      if (panelId !== undefined && panelId !== null) {
        if (typeof panelId !== "string" || panelId.length === 0) {
          // Rejects like the channel check (#10617).
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" postToPanel: panelId must be a non-empty string, null, or undefined: ${String(panelId)}`
            )
          );
        }
      }
      try {
        pushPluginMessage(channel, panelId ?? null, payload);
      } catch (err) {
        // An oversize payload rejects like the channel check above (#10617).
        return Promise.reject(err);
      }
      return Promise.resolve();
    },
    // Neither is revoke-guarded: a plugin reads them from its own timers and
    // subscription callbacks, like postToPanel. Liveness is membership.
    hasListeners: (channel) => {
      const transport = pushListenerChannel("hasListeners", channel);
      if (!isBound()) return false;
      return getPluginPushListenerRegistry().hasListeners(boundProjectId, transport);
    },
    onDidChangeListeners: (channel, callback) => {
      const transport = pushListenerChannel("onDidChangeListeners", channel);
      if (typeof callback !== "function") {
        throw new Error(`Plugin "${pluginId}" onDidChangeListeners: callback must be a function`);
      }
      if (!isBound()) return () => {};
      const failures = createListenerFailureState();
      const unwatch = getPluginPushListenerRegistry().watch(
        boundProjectId,
        transport,
        (hasListeners) => {
          if (!isBound()) return;
          invokeTrackedListener(
            failures,
            pluginId,
            "onDidChangeListeners",
            () => callback(hasListeners),
            () => dispose()
          );
        }
      );
      // Tracked like every other host event subscription, so it holds the
      // worker against idle disposal: a disposed worker could not run the
      // callback, and nothing re-forks it on a listener change.
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, unwatch);
      return dispose;
    },
    // NOT revoke-guarded: called from the plugin's own post-activation
    // subscription callbacks (worktree changes, polling timers). The
    // liveness guard is plugin membership, not the activation window — once
    // the plugin unloads this becomes a silent no-op.
    invalidateFileDecorations: (scope, paths) => {
      if (!deps.plugins.has(pluginId)) return Promise.resolve();
      if (typeof scope !== "string" || scope.length === 0) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" invalidateFileDecorations: scope must be a non-empty string`
          )
        );
      }
      // A plugin may only invalidate scopes it actually declared in
      // `contributes.fileDecorationProviders`. Without this a plugin could
      // force unrelated renderer views to re-pull. Mirrors the
      // registration-time declared-id guard so the manifest stays the
      // single source of truth for what a plugin owns.
      const declaredScopes = deps.plugins
        .get(pluginId)
        ?.manifest.contributes.fileDecorationProviders.flatMap((c) => c.scopes);
      if (
        !declaredScopes ||
        !declaredScopes.some((pattern) => scopeMatchesPattern(scope, pattern))
      ) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" invalidateFileDecorations: scope "${scope}" is not covered by any declared contributes.fileDecorationProviders[].scopes`
          )
        );
      }
      let narrowed =
        Array.isArray(paths) && paths.length > 0
          ? paths.filter((p): p is string => typeof p === "string" && p.length > 0)
          : undefined;
      if (narrowed && narrowed.length > MAX_FILE_DECORATION_PATHS) {
        // Over the cap, fall back to a scope-wide invalidation (drop `paths`)
        // rather than truncating: a truncated list would silently omit the
        // tail, and the renderer skips a re-pull for any visible file not in
        // the list — leaving stale decorations with no error surfaced. A
        // path-less broadcast forces an unconditional re-pull, which is
        // correct (just broader) for this pathological case.
        console.warn(
          `Plugin "${pluginId}" invalidateFileDecorations: ${narrowed.length} paths exceeds cap of ${MAX_FILE_DECORATION_PATHS} for scope "${scope}"; falling back to scope-wide invalidation`
        );
        narrowed = undefined;
      }
      pushToRenderers(CHANNELS.EVENTS_PUSH, {
        name: "plugin:decorations-changed",
        payload: { scope, ...(narrowed && narrowed.length > 0 ? { paths: narrowed } : {}) },
      });
      return Promise.resolve();
    },
    // NOT revoke-guarded for the same reason as invalidateFileDecorations:
    // plugins set badges from post-activation worktree/agent subscription
    // callbacks. Liveness is plugin membership, so it no-ops once unloaded
    // (unloadPlugin clears the plugin's whole badge set).
    setPanelBadge: (panelId, badge) => {
      if (!deps.plugins.has(pluginId)) return Promise.resolve();
      if (typeof panelId !== "string" || panelId.length === 0) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setPanelBadge: panelId must be a non-empty string`)
        );
      }
      let validated: PluginPanelBadge | null = null;
      if (badge !== null && badge !== undefined) {
        const parsed = PluginPanelBadgeSchema.safeParse(badge);
        if (!parsed.success) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelBadge: invalid badge — ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")}`
            )
          );
        }
        validated = parsed.data;
      }
      let panelMap = deps.pluginBadges.get(pluginId);
      const previous = panelMap?.get(panelId);
      if (validated === null) {
        // Clear: drop just this panel's badge; prune the plugin's map when empty.
        if (!panelMap || previous === undefined) return Promise.resolve();
        panelMap.delete(panelId);
        if (panelMap.size === 0) deps.pluginBadges.delete(pluginId);
      } else {
        // A badge set again from a timer or a subscription would otherwise send
        // the plugin's whole map to every renderer for no change.
        if (previous !== undefined && samePanelBadge(previous, validated)) {
          return Promise.resolve();
        }
        if (previous === undefined && (panelMap?.size ?? 0) >= PLUGIN_PANEL_BADGES_MAX_PANELS) {
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelBadge: badges are already set on ${PLUGIN_PANEL_BADGES_MAX_PANELS} panels — clear a closed panel's with null`
            )
          );
        }
        if (!panelMap) {
          panelMap = new Map<string, PluginPanelBadge>();
          deps.pluginBadges.set(pluginId, panelMap);
        }
        panelMap.set(panelId, validated);
      }
      // Coalesced: a fleet badged one panel at a time sends the final map once,
      // not one complete map per panel (#14128).
      getPluginStatePublisher().publish(PLUGIN_STATE_PANEL_BADGES, pluginId, () => {
        if (!deps.plugins.has(pluginId)) return;
        sendToScope(CHANNELS.EVENTS_PUSH, {
          name: "plugin:panel-badges-changed",
          payload: { pluginId, badges: deps.serializePluginBadges(pluginId) },
        });
      });
      return Promise.resolve();
    },
    // NOT revoke-guarded, like setPanelBadge: work is reported from callbacks
    // long after activate(). Unlike a badge, a report only ever lands on this
    // plugin's own panels of a kind declaring `reportsActivity`, settled
    // against main's kind registry rather than anything the caller says
    // (#13820). An id no renderer has reported yet is held, since
    // `panel.openPluginPanel` hands one back before the view reports it, and
    // the renderer draws it only once the panel is this plugin's.
    setPanelActivity: (panelId, activity) => {
      // Identity, not id membership: a callback left over from before a same-id
      // reload must not report on its successor's panels.
      if (!isBound() || !boundPlugin) return Promise.resolve();
      let entry: ReturnType<typeof validatePluginPanelActivity>;
      try {
        entry = validatePluginPanelActivity(panelId, activity);
      } catch (err) {
        // A hostile activity object can make the validator throw; this method
        // must still reject (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setPanelActivity: activity could not be read`, {
            cause: err,
          })
        );
      }
      if (!entry.ok) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(new Error(`Plugin "${pluginId}" setPanelActivity: ${entry.error}`));
      }
      const target = entry.panelId;
      let panelMap = deps.pluginPanelActivity.get(pluginId);
      const previous = panelMap?.get(target);
      // Coalesced like a badge; the flush still delivers this plugin's earlier
      // panel pushes first.
      const publish = (): void => {
        getPluginStatePublisher().publish(PLUGIN_STATE_PANEL_ACTIVITY, pluginId, () =>
          deps.emitPanelActivity(pluginId)
        );
      };
      const drop = (): void => {
        if (!panelMap || previous === undefined) return;
        panelMap.delete(target);
        if (panelMap.size === 0) deps.pluginPanelActivity.delete(pluginId);
        publish();
      };
      // A clear only ever touches this plugin's own report, so it needs no
      // ownership answer and survives the kind dropping its declaration.
      if (entry.activity === null) {
        drop();
        return Promise.resolve();
      }
      if (
        !boundPlugin.manifest.contributes.panels.some((panel) => panel.reportsActivity === true)
      ) {
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setPanelActivity: none of this plugin's contributes.panels declares reportsActivity: true`
          )
        );
      }
      const ownership = deps.panelLifecycleBroker.ownership(target, pluginId);
      switch (ownership.kind) {
        case "foreign":
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelActivity: panel "${target}" belongs to another plugin`
            )
          );
        case "non-plugin":
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelActivity: panel "${target}" is not a plugin panel`
            )
          );
        case "unavailable":
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelActivity: whose panel "${target}" is cannot be settled right now`
            )
          );
        case "owned":
          if (getPanelKindConfig(ownership.panelKindId)?.reportsActivity !== true) {
            return Promise.reject(
              new Error(
                `Plugin "${pluginId}" setPanelActivity: panel kind "${ownership.panelKindId}" does not declare reportsActivity: true`
              )
            );
          }
          break;
        case "missing":
          // Closed for good: nothing will draw it, so holding it would only
          // spend a slot under the cap.
          if (deps.panelLifecycleBroker.pushTargetsFor(target, pluginId) === "closed") {
            drop();
            return Promise.resolve();
          }
          break;
      }
      // Reported again from a timer or a subscription, the same state would
      // otherwise send the plugin's whole map to every view for no change.
      if (samePanelActivity(previous, entry.activity)) return Promise.resolve();
      if (previous === undefined && (panelMap?.size ?? 0) >= PLUGIN_PANEL_ACTIVITY_MAX_PANELS) {
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setPanelActivity: activity is already reported on ${PLUGIN_PANEL_ACTIVITY_MAX_PANELS} panels — clear a closed panel's with null`
          )
        );
      }
      if (!panelMap) {
        panelMap = new Map();
        deps.pluginPanelActivity.set(pluginId, panelMap);
      }
      panelMap.set(target, { ...entry.activity, revision: deps.nextPanelActivityRevision() });
      publish();
      return Promise.resolve();
    },
    // NOT revoke-guarded, like setPanelBadge: a count is set from the same
    // post-activation subscriptions. The id must be one this plugin's manifest
    // contributed, so a plugin can never light another plugin's button.
    setToolbarButtonBadge: (buttonId, badge) => {
      // Identity, not id membership: a callback left over from before a same-id
      // reload must not set or clear its successor's badges.
      if (!isBound() || !boundPlugin) return Promise.resolve();
      if (typeof buttonId !== "string" || buttonId.length === 0) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setToolbarButtonBadge: buttonId must be a non-empty string`
          )
        );
      }
      if (!boundPlugin.manifest.contributes.toolbarButtons.some((btn) => btn.id === buttonId)) {
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setToolbarButtonBadge: "${buttonId}" is not one of this plugin's contributes.toolbarButtons`
          )
        );
      }
      let validated: PluginPanelBadge | null = null;
      if (badge !== null && badge !== undefined) {
        const parsed = PluginPanelBadgeSchema.safeParse(badge);
        if (!parsed.success) {
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setToolbarButtonBadge: invalid badge — ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")}`
            )
          );
        }
        validated = parsed.data;
      }
      let buttonMap = deps.pluginToolbarBadges.get(pluginId);
      if (validated === null) {
        if (!buttonMap || !buttonMap.has(buttonId)) return Promise.resolve();
        buttonMap.delete(buttonId);
        if (buttonMap.size === 0) deps.pluginToolbarBadges.delete(pluginId);
      } else {
        if (!buttonMap) {
          buttonMap = new Map<string, PluginPanelBadge>();
          deps.pluginToolbarBadges.set(pluginId, buttonMap);
        }
        buttonMap.set(buttonId, validated);
      }
      // Deliver this plugin's queued pushes first, as every direct send does.
      flushPluginPushes();
      deps.emitToolbarBadges(pluginId);
      return Promise.resolve();
    },
    // NOT revoke-guarded, like setToolbarButtonBadge, and owned the same way:
    // the id must be one this plugin's manifest contributed (#13785).
    setToolbarButtonState: (buttonId, state) => {
      if (!isBound() || !boundPlugin) return Promise.resolve();
      if (typeof buttonId !== "string" || buttonId.length === 0) {
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setToolbarButtonState: buttonId must be a non-empty string`
          )
        );
      }
      if (!boundPlugin.manifest.contributes.toolbarButtons.some((btn) => btn.id === buttonId)) {
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setToolbarButtonState: "${buttonId}" is not one of this plugin's contributes.toolbarButtons`
          )
        );
      }
      let validated: PluginToolbarButtonRuntimeState | null = null;
      if (state !== null && state !== undefined) {
        let parsed: ReturnType<typeof PluginToolbarButtonRuntimeStateSchema.safeParse>;
        try {
          parsed = PluginToolbarButtonRuntimeStateSchema.safeParse(state);
        } catch (err) {
          // A throwing getter escapes safeParse; it still has to reject.
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setToolbarButtonState: invalid state — ${formatErrorMessage(err, "unreadable")}`
            )
          );
        }
        if (!parsed.success) {
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setToolbarButtonState: invalid state — ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")}`
            )
          );
        }
        validated = parsed.data;
        // A `./icon.svg` reference names one of this plugin's own files; the
        // renderer knows it by the runtime key the manifest's icons load under.
        if (isPluginCustomIconRef(validated.iconId)) {
          validated = { ...validated, iconId: makePluginCustomIconKey(pluginId, validated.iconId) };
        }
        if (validated.menu !== undefined) {
          const button = boundPlugin.manifest.contributes.toolbarButtons.find(
            (btn) => btn.id === buttonId
          );
          if (button?.popover !== undefined) {
            return Promise.reject(
              new Error(
                `Plugin "${pluginId}" setToolbarButtonState: invalid state — menu: "${buttonId}" opens a popover and can't carry a menu`
              )
            );
          }
          // Own namespace and no repeats, as a panel's runtime menu; the items
          // come back in the instance's namespace, where they dispatch.
          const menu = normalizePanelMenuItems(validated.menu, manifestId, pluginId);
          if (!menu.ok) {
            return Promise.reject(
              new Error(
                `Plugin "${pluginId}" setToolbarButtonState: invalid state — menu: ${menu.error}`
              )
            );
          }
          validated = { ...validated, menu: [...menu.items] };
        }
        // An empty state is the manifest default, the same as a clear.
        if (Object.keys(validated).length === 0) validated = null;
      }
      let buttonMap = deps.pluginToolbarStates.get(pluginId);
      if (validated === null) {
        if (!buttonMap || !buttonMap.has(buttonId)) return Promise.resolve();
        buttonMap.delete(buttonId);
        if (buttonMap.size === 0) deps.pluginToolbarStates.delete(pluginId);
      } else {
        const previous = buttonMap?.get(buttonId);
        if (previous !== undefined && sameToolbarButtonState(previous, validated)) {
          return Promise.resolve();
        }
        if (!buttonMap) {
          buttonMap = new Map<string, PluginToolbarButtonRuntimeState>();
          deps.pluginToolbarStates.set(pluginId, buttonMap);
        }
        buttonMap.set(buttonId, validated);
      }
      flushPluginPushes();
      deps.emitToolbarStates(pluginId);
      return Promise.resolve();
    },
    // NOT revoke-guarded, like setPanelBadge: a key tracks state the plugin
    // learns from post-activation subscriptions (#13506).
    setContext: (key, value) => {
      // Identity, not id membership: a callback left over from before a same-id
      // reload must not set its successor's keys.
      if (!isBound()) return Promise.resolve();
      const entry = validatePluginContextEntry(key, value);
      if (!entry.ok) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(new Error(`Plugin "${pluginId}" setContext: ${entry.error}`));
      }
      let keys = deps.pluginContextKeys.get(pluginId);
      if (!keys) {
        if (entry.value === null) return Promise.resolve();
        keys = new Map<string, PluginContextValue>();
        deps.pluginContextKeys.set(pluginId, keys);
      }
      // An emptied map stays until unload: a project instance with no keys
      // still owns its namespace over an installed copy's.
      const applied = applyPluginContextEntry(keys, entry.key, entry.value);
      if (!applied.ok) {
        return Promise.reject(new Error(`Plugin "${pluginId}" setContext: ${applied.error}`));
      }
      if (!applied.changed) return Promise.resolve();
      // Deliver this plugin's queued pushes first, as every direct send does.
      flushPluginPushes();
      deps.emitContextKeys(pluginId);
      return Promise.resolve();
    },
    // NOT revoke-guarded, like setPanelBadge: a status follows state the
    // plugin learns from its own subscriptions (#13704). The worktree must be
    // one this host's own worktree read names, which is what keeps a project
    // plugin on its own project's cards; an unavailable read refuses rather
    // than guessing, and never prunes what is already shown.
    setWorktreeCardStatus: (worktreeId, status) => {
      if (!isBound()) return Promise.resolve();
      const entry = validatePluginWorktreeCardStatus(worktreeId, status, manifestId, pluginId);
      if (!entry.ok) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setWorktreeCardStatus: ${entry.error}`)
        );
      }
      // Taken at the call, not when the queued run starts: a call the previous
      // worker generation made must not land after that generation's clear.
      const generation = deps.worktreeCardStatusGeneration(pluginId);
      // Same for the worktree's lifecycle: a call queued behind another must
      // not outlive a removal that happened while it waited.
      const since = { revision: deps.worktreeCardTargetRevision(), at: Date.now() };
      const run = async (): Promise<void> => {
        const result = await getWorktreesResult();
        if (!isBound() || deps.worktreeCardStatusGeneration(pluginId) !== generation) return;
        if (result.status !== "ok") {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeCardStatus: worktrees are unavailable (${result.reason})`
          );
        }
        const target = result.worktrees.find(
          (w) => w.id === entry.worktreeId || w.worktreeId === entry.worktreeId
        );
        if (!target) {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeCardStatus: "${entry.worktreeId}" is not a worktree this plugin can see`
          );
        }
        const projectId = result.projectId;
        // The card is keyed by the snapshot's own id, whichever spelling the
        // plugin passed.
        const cardId = target.id;
        if (deps.isWorktreeCardTargetRetired(projectId, cardId, since)) {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeCardStatus: "${entry.worktreeId}" was removed`
          );
        }
        let byProject = deps.pluginWorktreeCardStatuses.get(pluginId);
        let statuses = byProject?.get(projectId);
        if (entry.status === null) {
          if (!statuses?.delete(cardId)) return;
          if (statuses.size === 0) byProject!.delete(projectId);
          if (byProject!.size === 0) deps.pluginWorktreeCardStatuses.delete(pluginId);
        } else {
          if (sameWorktreeCardStatus(statuses?.get(cardId), entry.status)) return;
          if (!byProject) {
            byProject = new Map();
            deps.pluginWorktreeCardStatuses.set(pluginId, byProject);
          }
          if (!statuses) {
            statuses = new Map();
            byProject.set(projectId, statuses);
          }
          statuses.set(cardId, entry.status);
        }
        // Deliver this plugin's queued pushes first, as every direct send does.
        flushPluginPushes();
        deps.emitWorktreeCardStatuses(pluginId, projectId);
      };
      // Serialized, so a set followed by a clear can never land in the other
      // order because the reads behind them resolved out of order. A rejected
      // call does not poison the ones queued behind it.
      const next = worktreeCardStatusChain.then(run);
      worktreeCardStatusChain = next.catch(() => {});
      return next;
    },
    // Same gates as setWorktreeCardStatus (#13806): the worktree must be one
    // this host's own worktree read names, an unavailable read refuses and
    // never prunes, and a call queued behind another cannot outlive a removal
    // or a clear. Each accepted call replaces the plugin's whole list there.
    setWorktreeReviewChecks: (worktreeId, checks) => {
      if (!isBound()) return Promise.resolve();
      const entry = validatePluginWorktreeReviewChecks(worktreeId, checks, manifestId, pluginId);
      if (!entry.ok) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setWorktreeReviewChecks: ${entry.error}`)
        );
      }
      const generation = deps.worktreeReviewChecksGeneration(pluginId);
      const since = { revision: deps.worktreeCardTargetRevision(), at: Date.now() };
      const run = async (): Promise<void> => {
        const result = await getWorktreesResult();
        if (!isBound() || deps.worktreeReviewChecksGeneration(pluginId) !== generation) return;
        if (result.status !== "ok") {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeReviewChecks: worktrees are unavailable (${result.reason})`
          );
        }
        const target = result.worktrees.find(
          (w) => w.id === entry.worktreeId || w.worktreeId === entry.worktreeId
        );
        if (!target) {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeReviewChecks: "${entry.worktreeId}" is not a worktree this plugin can see`
          );
        }
        const projectId = result.projectId;
        const checkId = target.id;
        if (deps.isWorktreeCardTargetRetired(projectId, checkId, since)) {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeReviewChecks: "${entry.worktreeId}" was removed`
          );
        }
        let byProject = deps.pluginWorktreeReviewChecks.get(pluginId);
        let stored = byProject?.get(projectId);
        if (entry.checks === null) {
          if (!stored?.delete(checkId)) return;
          if (stored.size === 0) byProject!.delete(projectId);
          if (byProject!.size === 0) deps.pluginWorktreeReviewChecks.delete(pluginId);
        } else {
          if (sameWorktreeReviewChecks(stored?.get(checkId), entry.checks)) return;
          if (!byProject) {
            byProject = new Map();
            deps.pluginWorktreeReviewChecks.set(pluginId, byProject);
          }
          if (!stored) {
            stored = new Map();
            byProject.set(projectId, stored);
          }
          stored.set(checkId, entry.checks);
        }
        flushPluginPushes();
        deps.emitWorktreeReviewChecks(pluginId, projectId);
      };
      const next = worktreeReviewChecksChain.then(run);
      worktreeReviewChecksChain = next.catch(() => {});
      return next;
    },
    // NOT revoke-guarded, like setWorktreeCardStatus. The terminal must be one
    // this host's own agents.list names (so it needs `agent:read`, and a project
    // plugin stays on its own project's panes); an unreadable list refuses and
    // never prunes what is already shown (#13802).
    setTerminalStatus: (terminalId, status) => {
      if (!isBound()) return Promise.resolve();
      if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
        return Promise.reject(
          new Error(
            `PERMISSION_REQUIRED: plugin "${pluginId}" setTerminalStatus requires "agent:read", which is not declared in manifest.capabilities`
          )
        );
      }
      let entry: ReturnType<typeof validatePluginTerminalStatus>;
      try {
        entry = validatePluginTerminalStatus(terminalId, status, manifestId, pluginId);
      } catch (err) {
        // A hostile status object can make the validator throw; this method
        // must still reject (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setTerminalStatus: status could not be read`, {
            cause: err,
          })
        );
      }
      if (!entry.ok) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(new Error(`Plugin "${pluginId}" setTerminalStatus: ${entry.error}`));
      }
      const generation = deps.terminalStatusGeneration(pluginId);
      const closeRevision = deps.terminalStatusCloseRevision();
      const run = async (): Promise<void> => {
        let read: Awaited<ReturnType<typeof dispatcher.sendAgentsListWithProject>>;
        try {
          read = await dispatcher.sendAgentsListWithProject(boundProjectId, pluginId);
        } catch (err) {
          if (isProjectViewUnavailable(err)) {
            throw new Error(
              `Plugin "${pluginId}" setTerminalStatus: terminals are unavailable (project view not open)`,
              { cause: err }
            );
          }
          throw err;
        }
        if (!isBound() || deps.terminalStatusGeneration(pluginId) !== generation) return;
        const projectId = read.projectId;
        if (projectId === null) {
          throw new Error(`Plugin "${pluginId}" setTerminalStatus: terminals are unavailable`);
        }
        const pane = read.agents.find((a) => a.terminalId === entry.terminalId);
        if (!pane) {
          throw new Error(
            `Plugin "${pluginId}" setTerminalStatus: "${entry.terminalId}" is not a terminal this plugin can see`
          );
        }
        if (deps.isTerminalStatusProjectClosed(projectId, closeRevision)) {
          throw new Error(`Plugin "${pluginId}" setTerminalStatus: the project was closed`);
        }
        let byProject = deps.pluginTerminalStatuses.get(pluginId);
        let statuses = byProject?.get(projectId);
        let changed = false;
        const publish = (): void => {
          flushPluginPushes();
          deps.emitTerminalStatuses(pluginId, projectId);
        };
        if (entry.status === null) {
          if (!statuses?.delete(entry.terminalId)) return;
          if (statuses.size === 0) byProject!.delete(projectId);
          if (byProject!.size === 0) deps.pluginTerminalStatuses.delete(pluginId);
        } else {
          if (sameTerminalStatus(statuses?.get(entry.terminalId), entry.status)) return;
          if (
            statuses &&
            !statuses.has(entry.terminalId) &&
            statuses.size >= PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT
          ) {
            // At the cap, free the slots of terminals that have left the list
            // (closed, exited). Only here: a list is a projection that can omit
            // a live pane, so pruning on every call could drop a shown chip.
            const live = new Set(read.agents.map((a) => a.terminalId));
            for (const held of [...statuses.keys()]) {
              if (live.has(held)) continue;
              statuses.delete(held);
              changed = true;
            }
          }
          if (
            statuses &&
            !statuses.has(entry.terminalId) &&
            statuses.size >= PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT
          ) {
            if (changed) publish();
            throw new Error(
              `Plugin "${pluginId}" setTerminalStatus: at most ${PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT} terminals can hold a status at once`
            );
          }
          if (!byProject) {
            byProject = new Map();
            deps.pluginTerminalStatuses.set(pluginId, byProject);
          }
          if (!statuses) {
            statuses = new Map();
            byProject.set(projectId, statuses);
          }
          statuses.set(entry.terminalId, entry.status);
        }
        publish();
      };
      // Serialized, so a set followed by a clear lands in call order.
      const next = terminalStatusChain.then(run);
      terminalStatusChain = next.catch(() => {});
      return next;
    },
    // NOT revoke-guarded, like setPanelBadge: a plugin republishes its menu
    // from lifecycle callbacks and its own state changes (#13213). Ownership is
    // not checked against the panel here — `panel.openPluginPanel` hands back an
    // id before the renderer has reported it — so the renderer shows a list
    // only on a panel whose kind this plugin contributed.
    setPanelMenuItems: (panelId, items) => {
      if (!deps.plugins.has(pluginId)) return Promise.resolve();
      if (typeof panelId !== "string" || panelId.length === 0) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setPanelMenuItems: panelId must be a non-empty string`)
        );
      }
      const result = normalizePanelMenuItems(items, manifestId, pluginId);
      if (!result.ok) {
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setPanelMenuItems: invalid items — ${result.error}`)
        );
      }
      let panelMap = deps.pluginPanelMenus.get(pluginId);
      const previous = panelMap?.get(panelId);
      if (result.items.length === 0) {
        if (!panelMap || previous === undefined) return Promise.resolve();
        panelMap.delete(panelId);
        if (panelMap.size === 0) deps.pluginPanelMenus.delete(pluginId);
      } else {
        if (previous !== undefined && samePanelMenuItems(previous, result.items)) {
          return Promise.resolve();
        }
        if (previous === undefined && (panelMap?.size ?? 0) >= PLUGIN_PANEL_MENUS_MAX_PANELS) {
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelMenuItems: menus are already published on ${PLUGIN_PANEL_MENUS_MAX_PANELS} panels — clear a closed panel's with null`
            )
          );
        }
        if (!panelMap) {
          panelMap = new Map();
          deps.pluginPanelMenus.set(pluginId, panelMap);
        }
        panelMap.set(panelId, result.items);
      }
      pushToRenderers(CHANNELS.EVENTS_PUSH, {
        name: "plugin:panel-menus-changed",
        payload: { pluginId, menus: deps.serializePluginPanelMenus(pluginId) },
      });
      return Promise.resolve();
    },
    // NOT revoke-guarded: a worker reloads a view when its own work finishes,
    // long after activate() returned. No capability gate — the target must be
    // a panel of a kind this exact instance contributed, which the broker
    // resolves from main's kind registry; the caller is identified by this
    // closure's `pluginId`, never by an argument (#12610).
    reloadPanel: async (panelId) => {
      if (typeof panelId !== "string" || panelId.trim().length === 0) {
        throw new Error(`Plugin "${pluginId}" reloadPanel: panelId must be a non-empty string`);
      }
      if (!isBound()) return "unavailable";
      return panelReloadDispatcher.reload(pluginId, panelId, boundProjectId);
    },
  };
  // The worker bridge's backing for its synchronous `hasListeners` cache. Not a
  // plugin event subscription: untracked in `pluginEventCleanups` (so a read
  // never holds the worker against idle disposal) and passive in the registry
  // (so it never keeps the periodic reconcile running). The bridge disposes it
  // with its other subscriptions on worker teardown; one that outlives its
  // plugin's binding unwatches itself on the next change.
  const observePushListeners: PushListenerObserver = (channel, callback) => {
    const transport = pushListenerChannel("hasListeners", channel);
    // Unbound answers as `hasListeners` does, and never changes.
    if (!isBound()) return { current: false, dispose: () => {} };
    const registry = getPluginPushListenerRegistry();
    const unwatch = registry.watch(
      boundProjectId,
      transport,
      (hasListeners) => {
        if (!isBound()) {
          unwatch();
          return;
        }
        callback(hasListeners);
      },
      { passive: true }
    );
    return { current: registry.hasListeners(boundProjectId, transport), dispose: unwatch };
  };
  return { api, observePushListeners };
}
