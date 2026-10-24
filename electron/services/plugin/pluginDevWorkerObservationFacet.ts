// Observation and push for the dev worker's host proxy (#9304, #14331): what
// the plugin reads and watches of the host (worktrees, agents, panels, wake,
// push-channel listeners) and the pushes it sends to its renderers.

import type {
  PluginHostApi,
  PluginWorktreeSnapshot,
  PluginWorktreeStatus,
  PluginWorktreesResult,
  PluginAgentSnapshot,
  PluginPanelLifecycleEvent,
  PluginSystemWakeEvent,
} from "../../../shared/types/plugin.js";
import { toPluginTerminalLifecycleEvent } from "../../../shared/utils/pluginTerminalLifecycle.js";
import { toPluginFocusedPanel } from "../../../shared/utils/pluginFocusedPanel.js";
import { toPluginProjectPresence } from "../../../shared/utils/pluginProjectPresence.js";
import { normalizePluginAllAgentsSnapshot } from "../../../shared/utils/pluginAllAgentsSnapshot.js";
import { PLUGIN_PUSH_MAX_PAYLOAD_BYTES } from "../../../shared/config/pluginBudgets.js";
import { assertPayloadWithinLimit } from "./pluginPayloadLimits.js";
import type { PluginWorkerWorktreesEvent } from "../../../shared/types/pluginDevWorker.js";
import type { HostProxyFacetDeps, PluginDevWorkerRpc } from "./pluginDevWorkerRpcClient.js";
/** Push channels one worker may watch for listeners; past it `hasListeners` answers `true`. */
const MAX_WATCHED_PUSH_CHANNELS = 256;

interface ListenerState {
  value: boolean;
  callbacks: Set<(hasListeners: boolean) => void>;
  /** Applies a value from either of main's streams for this channel. */
  update: (payload: unknown) => void;
  /**
   * The `push-listeners` subscription held while any `onDidChangeListeners`
   * callback is registered — a real event subscription main counts against
   * idle disposal. `null` when only `hasListeners` reads use the channel.
   */
  hold: (() => void) | null;
}

export type ObservationHostApi = Pick<
  PluginHostApi,
  | "broadcastToRenderer"
  | "postToPanel"
  | "hasListeners"
  | "onDidChangeListeners"
  | "getActiveWorktree"
  | "getWorktrees"
  | "getWorktreesResult"
  | "getWorktreeStatus"
  | "getAgentState"
  | "onDidChangeAgentState"
  | "onDidChangeTerminalLifecycle"
  | "onDidChangeAllAgents"
  | "onDidChangeFocusedPanel"
  | "onDidChangeProjectPresence"
  | "onDidChangePanelLifecycle"
  | "onDidWake"
  | "onDidChangeActiveWorktree"
  | "onDidChangeWorktrees"
>;

export class PluginDevWorkerObservationFacet {
  readonly api: ObservationHostApi;
  private readonly rpc: PluginDevWorkerRpc;
  private readonly pluginId: string;
  private readonly assertActivationOpen: (name: string) => void;
  /**
   * Per push channel: whether main last said a renderer listens, and the
   * `onDidChangeListeners` callbacks for it. Opened on first use and kept for
   * the worker's life, so `hasListeners` stays a synchronous local read.
   */
  private readonly listenerStates = new Map<string, ListenerState>();

  constructor(deps: HostProxyFacetDeps) {
    this.rpc = deps.rpc;
    this.pluginId = deps.pluginId;
    this.assertActivationOpen = deps.assertActivationOpen;
    this.api = this.buildApi();
  }

  dispose(): void {
    this.listenerStates.clear();
  }

  /**
   * Refuse an oversize push before it is cloned across the parent port, so the
   * plugin sees the failure on the call that caused it rather than as a log
   * line in main, which applies the same cap again on arrival.
   */
  private assertPushWithinLimit(channel: string, payload: unknown): void {
    try {
      assertPayloadWithinLimit(
        this.pluginId,
        `push payload on "${channel}"`,
        payload,
        PLUGIN_PUSH_MAX_PAYLOAD_BYTES
      );
    } catch (err) {
      this.reportPushRejected();
      throw err;
    }
  }

  /**
   * Send an accepted push. A payload structured clone refuses fails in
   * `postMessage` itself, so that refusal is reported like an oversize one.
   */
  private sendPush(method: "broadcastToRenderer" | "postToPanel", params: unknown): void {
    try {
      this.rpc.notify(method, params);
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === "DataCloneError") this.reportPushRejected();
      throw err;
    }
  }

  /**
   * Tell main a push was refused before it crossed the port, so its metrics
   * see the rejection. Payload-free, and never allowed to mask the refusal.
   */
  private reportPushRejected(): void {
    try {
      this.rpc.notify("pushRejected", {});
    } catch {
      // The port is closing; the plugin still gets the original error.
    }
  }
  private pushListenerChannel(method: string, channel: unknown): string {
    if (typeof channel !== "string" || channel.length === 0 || channel.includes(":")) {
      throw new Error(
        `Plugin "${this.pluginId}" ${method}: channel must be a non-empty string without colons: ${String(channel)}`
      );
    }
    return channel;
  }

  /**
   * The listener state for `channel`, opening main's passive observation the
   * first time (`push-listeners-observe`, which idle governance ignores). Until
   * main's first value lands the answer is `true`, the same "assume someone is
   * listening" main gives for a renderer it has not heard from; a value that
   * differs fires the channel's callbacks. Both of main's streams for a channel
   * carry the same answer, so a repeat is dropped here.
   */
  private listenerState(channel: string): ListenerState | null {
    const existing = this.listenerStates.get(channel);
    if (existing) return existing;
    if (this.listenerStates.size >= MAX_WATCHED_PUSH_CHANNELS) return null;
    const state: ListenerState = {
      value: true,
      callbacks: new Set(),
      hold: null,
      update: (payload) => {
        const next = payload === true;
        if (next === state.value) return;
        state.value = next;
        for (const callback of [...state.callbacks]) {
          try {
            callback(next);
          } catch (err) {
            console.error(
              `[plugin-dev:${this.pluginId}] onDidChangeListeners callback threw:`,
              err
            );
          }
        }
      },
    };
    this.listenerStates.set(channel, state);
    this.rpc.subscribe("push-listeners-observe", state.update, channel);
    return state;
  }

  private buildApi(): ObservationHostApi {
    return {
      broadcastToRenderer: (channel, payload) => {
        this.assertActivationOpen("broadcastToRenderer");
        if (typeof channel !== "string" || channel.includes(":")) {
          throw new Error(
            `Plugin broadcast channel must be a string without colons: ${String(channel)}`
          );
        }
        this.assertPushWithinLimit(channel, payload);
        this.sendPush("broadcastToRenderer", { channel, payload });
        return Promise.resolve();
      },
      // Post-activation-safe sibling of broadcastToRenderer: no
      // assertActivationOpen guard, so dev-worker plugins can stream live data
      // to their panels from timers and subscription callbacks.
      postToPanel: (channel, payload, panelId) => {
        if (typeof channel !== "string" || channel.length === 0 || channel.includes(":")) {
          // Reject (not sync throw): runtime-surface Promise method must keep
          // validation errors inside the Promise contract, mirroring the
          // main-side host (#10617). notify() is fire-and-forget/sync, so this
          // method can't simply be `async`.
          return Promise.reject(
            new Error(
              `Plugin "${this.pluginId}" postToPanel: channel must be a non-empty string without colons: ${String(channel)}`
            )
          );
        }
        if (panelId !== undefined && panelId !== null) {
          if (typeof panelId !== "string" || panelId.length === 0) {
            // Rejects like the channel check (#10617).
            return Promise.reject(
              new Error(
                `Plugin "${this.pluginId}" postToPanel: panelId must be a non-empty string, null, or undefined: ${String(panelId)}`
              )
            );
          }
        }
        // Forward panelId verbatim (including `undefined`/`null`) — the real
        // main-side host wraps the envelope and resolves the broadcast-vs-target
        // routing. Structured clone over the parent-port preserves `undefined`.
        try {
          this.assertPushWithinLimit(channel, payload);
          this.sendPush("postToPanel", { channel, payload, panelId });
        } catch (err) {
          return Promise.reject(err);
        }
        return Promise.resolve();
      },
      hasListeners: (channel) => {
        const name = this.pushListenerChannel("hasListeners", channel);
        if (this.rpc.disposed) return false;
        return this.listenerState(name)?.value ?? true;
      },
      onDidChangeListeners: (channel, callback) => {
        const name = this.pushListenerChannel("onDidChangeListeners", channel);
        if (typeof callback !== "function") {
          throw new Error(
            `Plugin "${this.pluginId}" onDidChangeListeners: callback must be a function`
          );
        }
        const state = this.rpc.disposed ? null : this.listenerState(name);
        if (!state) return () => {};
        const registered = (hasListeners: boolean): void => callback(hasListeners);
        state.callbacks.add(registered);
        state.hold ??= this.rpc.subscribe("push-listeners", state.update, name);
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          state.callbacks.delete(registered);
          if (state.callbacks.size > 0 || !state.hold) return;
          const release = state.hold;
          state.hold = null;
          release();
        };
      },
      getActiveWorktree: () =>
        this.rpc.call<PluginWorktreeSnapshot | null>("getActiveWorktree", undefined),
      getWorktrees: () => this.rpc.call<PluginWorktreeSnapshot[]>("getWorktrees", undefined),
      // callWithGrace, not call: the host contract for this method is that it
      // degrades to an `unavailable` result on unload rather than throwing, so a
      // dev-worker call in flight when the proxy is disposed must resolve the
      // same way the real host would (#12174).
      getWorktreesResult: () =>
        this.rpc.callWithGrace<PluginWorktreesResult>("getWorktreesResult", undefined, {
          status: "unavailable",
          reason: "plugin-unloaded",
        }),
      getWorktreeStatus: (path, options) =>
        this.rpc.call<PluginWorktreeStatus | null>("getWorktreeStatus", path, options?.signal),
      getAgentState: () => this.rpc.call<PluginAgentSnapshot | null>("getAgentState", undefined),
      onDidChangeAgentState: (callback, options) => {
        this.assertActivationOpen("onDidChangeAgentState");
        // Subscription wired synchronously; only the disposer is async. The
        // window is applied host-side; an omitted option crosses the port as
        // absent, so main applies the same default an in-process plugin gets.
        const dispose = this.rpc.subscribe(
          "agent-state",
          (payload) => callback(payload as PluginAgentSnapshot),
          undefined,
          undefined,
          options?.debounceMs
        );
        return Promise.resolve(dispose);
      },
      onDidChangeTerminalLifecycle: (callback) => {
        this.assertActivationOpen("onDidChangeTerminalLifecycle");
        // Re-projected on arrival: the port's structured clone hands back a
        // plain mutable object, and the allowlist is re-applied this side too.
        // The callback's result is returned so the dispatcher can catch an
        // async listener's rejection, as it does for every sibling.
        const dispose = this.rpc.subscribe("terminal-lifecycle", (payload) => {
          const event = toPluginTerminalLifecycleEvent(payload);
          return event === null ? undefined : callback(event);
        });
        return Promise.resolve(dispose);
      },
      onDidChangeAllAgents: (callback, options) => {
        this.assertActivationOpen("onDidChangeAllAgents");
        // Same re-freeze as listAll: the snapshot arrives as a plain clone.
        const dispose = this.rpc.subscribe(
          "all-agents",
          (payload) => callback(normalizePluginAllAgentsSnapshot(payload)),
          undefined,
          undefined,
          options?.debounceMs
        );
        return Promise.resolve(dispose);
      },
      onDidChangeFocusedPanel: (callback, options) => {
        this.assertActivationOpen("onDidChangeFocusedPanel");
        // Rebuilt and re-frozen on arrival: the port's structured clone hands
        // back a plain mutable object.
        const dispose = this.rpc.subscribe(
          "focused-panel",
          (payload) => callback(toPluginFocusedPanel(payload)),
          undefined,
          undefined,
          options?.debounceMs
        );
        return Promise.resolve(dispose);
      },
      onDidChangeProjectPresence: (callback, options) => {
        this.assertActivationOpen("onDidChangeProjectPresence");
        // Rebuilt and re-frozen on arrival, like focused-panel above. Main only
        // ever sends a valid presence, so a malformed one is dropped, not guessed.
        const dispose = this.rpc.subscribe(
          "project-presence",
          (payload) => {
            const presence = toPluginProjectPresence(payload);
            // Returned, so the dispatcher can catch an async callback's rejection.
            return presence ? callback(presence) : undefined;
          },
          undefined,
          undefined,
          options?.debounceMs
        );
        return Promise.resolve(dispose);
      },
      onDidChangePanelLifecycle: (callback) => {
        this.assertActivationOpen("onDidChangePanelLifecycle");
        // Subscription wired synchronously; only the disposer is async. The
        // host replays live panels on its side, so a plugin activated by a view
        // opening still receives that panel's phase (#11301).
        // Re-freeze on arrival: main freezes the event, but the port's
        // structured clone reconstructs a plain mutable object — frozen
        // descriptors do not survive the hop. Without this the documented
        // "events are frozen" contract would hold in-process and silently not
        // hold for every user-installed plugin, which all run in a worker.
        const dispose = this.rpc.subscribe("panel-lifecycle", (payload) =>
          callback(Object.freeze(payload as PluginPanelLifecycleEvent))
        );
        return Promise.resolve(dispose);
      },
      onDidWake: (callback) => {
        this.assertActivationOpen("onDidWake");
        // Subscription wired synchronously; only the disposer is async. Same
        // re-freeze as panel-lifecycle above: the port's structured clone hands
        // back a plain mutable object, so main's freeze does not survive the
        // hop and the documented contract has to be re-established here.
        const dispose = this.rpc.subscribe("system-wake", (payload) =>
          callback(Object.freeze(payload as PluginSystemWakeEvent))
        );
        return Promise.resolve(dispose);
      },
      onDidChangeActiveWorktree: (callback, options) => {
        this.assertActivationOpen("onDidChangeActiveWorktree");
        // Subscription wired synchronously; only the disposer is async.
        const dispose = this.rpc.subscribe(
          "active-worktree",
          (payload) => callback(payload as PluginWorktreeSnapshot | null),
          undefined,
          undefined,
          options?.debounceMs
        );
        return Promise.resolve(dispose);
      },
      onDidChangeWorktrees: (callback, options) => {
        this.assertActivationOpen("onDidChangeWorktrees");
        // Coalescing and the change set are computed host-side: the worker
        // forwards `debounceMs` and main pushes one event per delivery.
        const dispose = this.rpc.subscribe(
          "worktrees",
          (payload) => {
            const event = payload as PluginWorkerWorktreesEvent;
            callback(event.snapshots, event.change);
          },
          undefined,
          undefined,
          options?.debounceMs
        );
        return Promise.resolve(dispose);
      },
    };
  }
}
