// Capability APIs for the dev worker's host proxy (#9304, #14331): state the
// plugin sets in the UI, prompts, dispatch, agents and terminals, and the
// resource APIs (db, fs, git, clipboard, system, documents, artifacts,
// services, account, settings, storage). Each relays over the port to the real
// host in main, which owns the capability gate and consent.

import type {
  PluginHostApi,
  PluginIdentity,
  PluginSettingsScope,
  PluginAccountAccessToken,
  PluginAccountState,
  PluginStorageScope,
  PluginToastOptions,
  PluginNotifyOptions,
  PluginNotifyResult,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginPromptCallOptions,
  PluginDatabase,
  PluginDatabaseLocation,
  PluginFsDirEntry,
  PluginFsWriteResult,
  PluginFsReadWithRevisionResult,
  PluginFsApi,
  PluginFsReadFilesEntry,
  PluginFsReadFilesOptions,
  PluginFsWalkOptions,
  PluginFsWalkResult,
  PluginRenderPdfResult,
  PluginArtifact,
  PluginArtifactUploadResult,
  PluginFsStat,
  PluginGitStatus,
  PluginGitCommitResult,
} from "../../../shared/types/plugin.js";
import type {
  ActionDispatchResult,
  PluginActionManifestEntry,
} from "../../../shared/types/actions.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { normalizePanelMenuItems } from "../../../shared/utils/pluginPanelMenuItems.js";
import { validatePluginContextEntry } from "../../../shared/utils/pluginContextKeys.js";
import { validatePluginWorktreeCardStatus } from "../../../shared/utils/pluginWorktreeCardStatus.js";
import { validatePluginWorktreeReviewChecks } from "../../../shared/utils/pluginWorktreeReviewChecks.js";
import { validatePluginTerminalStatus } from "../../../shared/utils/pluginTerminalStatus.js";
import { validatePluginPanelActivity } from "../../../shared/utils/pluginPanelActivity.js";
import {
  normalizePluginAllAgentsSnapshot,
  UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT,
} from "../../../shared/utils/pluginAllAgentsSnapshot.js";
import type {
  PanelReloadResult,
  WorkerRestartResult,
  PluginAgentPane,
  PluginSendToAgentResult,
  PluginRunRecipeResult,
  PluginTerminalScreenResult,
  PluginAgentInputResult,
  PluginAgentInterruptResult,
  PluginAgentKeysResult,
  PluginToolbarButtonRuntimeState,
} from "../../../shared/types/plugin.js";
import { PLUGIN_SERVICE_MAX_ARGS_BYTES } from "../../../shared/config/pluginBudgets.js";
import type {
  PluginServiceResult,
  PluginServiceStatus,
  PluginServicesApi,
} from "../../../shared/types/pluginServices.js";
import { estimatePayloadBytes } from "./pluginPayloadLimits.js";
import { isHostCallTimeoutError } from "./pluginHostCallDeadline.js";
import { checkedSchemaOptions, openPluginDatabase } from "./pluginDatabase.js";
import type {
  PluginHostCallMethod,
  ArtifactsIdParams,
  ArtifactsListParams,
  ArtifactsTransferParams,
  ServicesCallParams,
} from "../../../shared/types/pluginDevWorker.js";
import type { HostProxyFacetDeps, PluginDevWorkerRpc } from "./pluginDevWorkerRpcClient.js";
/** Only an explicit opt-in to waiting crosses the port; anything else is the default. */
function promptQueueParam(callOptions?: PluginPromptCallOptions): { whenNoFrontend?: "queue" } {
  return callOptions?.whenNoFrontend === "queue" ? { whenNoFrontend: "queue" } : {};
}

/** The fields of a `PluginToolbarButtonRuntimeState`, read explicitly before the copy crosses the port. */
const TOOLBAR_STATE_FIELDS: readonly string[] = [
  "pressed",
  "disabled",
  "disabledReason",
  "busy",
  "tooltip",
  "iconId",
  "menu",
] satisfies readonly (keyof PluginToolbarButtonRuntimeState)[];

export type CapabilityHostApi = Pick<
  PluginHostApi,
  | "invalidateFileDecorations"
  | "setPanelBadge"
  | "setToolbarButtonBadge"
  | "setToolbarButtonState"
  | "setContext"
  | "setWorktreeCardStatus"
  | "setWorktreeReviewChecks"
  | "setTerminalStatus"
  | "setPanelActivity"
  | "setPanelMenuItems"
  | "showToast"
  | "notify"
  | "dispatch"
  | "reloadPanel"
  | "restartWorker"
  | "actions"
  | "sendToActiveAgent"
  | "agents"
  | "terminals"
  | "sendToAgent"
  | "runRecipe"
  | "showQuickPick"
  | "showInputBox"
  | "showConfirm"
  | "logger"
  | "db"
  | "fs"
  | "git"
  | "clipboard"
  | "system"
  | "documents"
  | "artifacts"
  | "services"
  | "account"
  | "settings"
  | "storage"
>;

export class PluginDevWorkerCapabilityFacet {
  readonly api: CapabilityHostApi;
  private readonly rpc: PluginDevWorkerRpc;
  private readonly pluginId: string;
  private readonly assertActivationOpen: (name: string) => void;
  private readonly identity: PluginIdentity;
  /** Open `host.db` handles, closed on dispose so a reload never leaks a connection. */
  private readonly databases = new Set<PluginDatabase>();

  constructor(deps: HostProxyFacetDeps) {
    this.rpc = deps.rpc;
    this.pluginId = deps.pluginId;
    this.assertActivationOpen = deps.assertActivationOpen;
    this.identity = deps.identity;
    this.api = this.buildApi();
  }

  dispose(): void {
    for (const database of this.databases) void database.close();
    this.databases.clear();
  }

  /**
   * A `host.agents` input call (#14018). One made after disposal sent nothing,
   * so it answers the host's own unload result; one cut off in flight rejects,
   * because main may already have written and "unavailable" would deny it.
   */
  private callAgentInput<T>(
    method: PluginHostCallMethod,
    params: unknown
  ): Promise<T | { readonly status: "unavailable" }> {
    if (this.rpc.disposed) return Promise.resolve({ status: "unavailable" });
    return this.rpc.call<T>(method, params);
  }

  /**
   * An `artifacts.*` transfer: the signal rides `host-cancel`, and
   * `onProgress` a subscription registered before the call (so no report can
   * beat it) and dropped when the call settles. The same shape checks as the
   * host's run first, so a bad argument rejects without a round trip.
   */
  private artifactTransfer<T>(
    method: "artifacts.import" | "artifacts.download" | "artifacts.upload",
    target: unknown,
    options: unknown,
    artifactId?: unknown
  ): Promise<T> {
    const op = method.slice("artifacts.".length);
    const invalid = (message: string) =>
      Promise.reject(
        Object.assign(
          new Error(`VALIDATION: plugin "${this.pluginId}" artifacts.${op}: ${message}`),
          { code: "VALIDATION" }
        )
      );
    if (options !== undefined && (typeof options !== "object" || options === null)) {
      return invalid("options must be an object");
    }
    const { signal, onProgress, ...rest } = (options ?? {}) as {
      signal?: AbortSignal;
      onProgress?: unknown;
    };
    if (onProgress !== undefined && typeof onProgress !== "function") {
      return invalid("onProgress must be a function");
    }
    let progressSubscriptionId: string | undefined;
    if (typeof onProgress === "function") {
      progressSubscriptionId = this.rpc.nextSubscriptionId();
      // Returned, so the dispatcher sees an async callback's rejection.
      this.rpc.addSubscription(progressSubscriptionId, (payload) =>
        (onProgress as (progress: unknown) => unknown)(payload)
      );
    }
    const params: ArtifactsTransferParams = {
      target,
      options: rest,
      ...(artifactId !== undefined ? { artifactId } : {}),
      ...(progressSubscriptionId ? { progressSubscriptionId } : {}),
    };
    const done = () => {
      if (progressSubscriptionId) this.rpc.deleteSubscription(progressSubscriptionId);
    };
    return this.rpc.call<T>(method, params, signal).then(
      (value) => {
        done();
        return value;
      },
      (error: unknown) => {
        done();
        // A cancel settled here carries the same code as one main settled,
        // whatever reason the caller aborted with.
        if (signal?.aborted || (error as { name?: unknown } | null)?.name === "AbortError") {
          throw Object.assign(new Error("ABORT_ERR: the transfer was cancelled"), {
            name: "AbortError",
            code: "ABORT_ERR",
          });
        }
        throw error;
      }
    );
  }
  /**
   * `host.services.call`: main answers every outcome, a cancel included, so a
   * failure is a typed result here too and the promise never rejects. What
   * main can't answer — a worker-side deadline, arguments the port refuses —
   * is mapped to the same reasons.
   */
  private async callService(
    name: unknown,
    method: unknown,
    args: unknown,
    options: unknown
  ): Promise<PluginServiceResult> {
    if (options !== undefined && options !== null && typeof options !== "object") {
      return { ok: false, reason: "invalid", message: "options must be an object" };
    }
    const { signal, timeoutMs } = (options ?? {}) as { signal?: unknown; timeoutMs?: unknown };
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      return { ok: false, reason: "invalid", message: "options.signal must be an AbortSignal" };
    }
    if (signal?.aborted) {
      return {
        ok: false,
        reason: "cancelled",
        message: "the call was cancelled before it started",
      };
    }
    // Refused before the clone across the port; main checks again on arrival.
    let bytes: number;
    try {
      bytes = estimatePayloadBytes(args, PLUGIN_SERVICE_MAX_ARGS_BYTES);
    } catch (err) {
      return {
        ok: false,
        reason: "invalid",
        message: formatErrorMessage(err, "unreadable arguments"),
      };
    }
    if (bytes > PLUGIN_SERVICE_MAX_ARGS_BYTES) {
      return {
        ok: false,
        reason: "payload-too-large",
        message: `arguments for "${String(name)}.${String(method)}" exceed the ${PLUGIN_SERVICE_MAX_ARGS_BYTES}-byte limit`,
      };
    }
    const params: ServicesCallParams = {
      name: name as string,
      method: method as string,
      args,
      ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
    };
    try {
      return await this.rpc.call<PluginServiceResult>("services.call", params, signal, {
        hostAnswersAbort: true,
      });
    } catch (err) {
      if (isHostCallTimeoutError(err)) {
        return { ok: false, reason: "timeout", message: formatErrorMessage(err, "no answer") };
      }
      if (err instanceof Error && err.name === "DataCloneError") {
        return {
          ok: false,
          reason: "invalid",
          message: formatErrorMessage(err, "arguments can't be copied"),
        };
      }
      return {
        ok: false,
        reason: "unavailable",
        message: formatErrorMessage(err, "the call failed"),
      };
    }
  }

  private buildApi(): CapabilityHostApi {
    const manifestId = this.identity.manifestId;
    return {
      invalidateFileDecorations: (scope, paths) => {
        if (typeof scope !== "string" || scope.length === 0) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(
              `Plugin "${this.pluginId}" invalidateFileDecorations: scope must be a non-empty string`
            )
          );
        }
        this.rpc.notify("invalidateFileDecorations", { scope, paths });
        return Promise.resolve();
      },
      // Post-activation-safe sibling of invalidateFileDecorations: forward the
      // badge fire-and-forget; the real host re-validates the badge shape.
      setPanelBadge: (panelId, badge) => {
        if (typeof panelId !== "string" || panelId.length === 0) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(`Plugin "${this.pluginId}" setPanelBadge: panelId must be a non-empty string`)
          );
        }
        this.rpc.notify("setPanelBadge", { panelId, badge: badge ?? null });
        return Promise.resolve();
      },
      // Same fire-and-forget shape: the real host checks the id is one of this
      // plugin's own toolbar buttons and re-validates the badge.
      setToolbarButtonBadge: (buttonId, badge) => {
        if (typeof buttonId !== "string" || buttonId.length === 0) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(
              `Plugin "${this.pluginId}" setToolbarButtonBadge: buttonId must be a non-empty string`
            )
          );
        }
        this.rpc.notify("setToolbarButtonBadge", { buttonId, badge: badge ?? null });
        return Promise.resolve();
      },
      // A call, not a notify: only main knows this plugin's buttons and
      // validates the state, and that refusal has to reach the caller's
      // `await`. Resolves once torn down, like setContext.
      setToolbarButtonState: (buttonId, state) => {
        if (this.rpc.disposed) return Promise.resolve();
        if (typeof buttonId !== "string" || buttonId.length === 0) {
          return Promise.reject(
            new Error(
              `Plugin "${this.pluginId}" setToolbarButtonState: buttonId must be a non-empty string`
            )
          );
        }
        // Every valid field is a boolean or a string, so a copy of the
        // primitive fields is all main needs — and all the port can clone.
        // Unknown keys travel too, even undefined ones, so main's strict
        // schema refuses them exactly as it does in process.
        let copy: Record<string, string | boolean | number | undefined> | null = null;
        if (state !== null && state !== undefined) {
          if (typeof state !== "object" || Array.isArray(state)) {
            return Promise.reject(
              new Error(
                `Plugin "${this.pluginId}" setToolbarButtonState: invalid state — state must be an object`
              )
            );
          }
          let entries: [string, unknown][];
          try {
            // Known fields are read as the in-process schema reads them, so an
            // inherited getter counts; any other own key is carried along.
            const fields = state as Record<string, unknown>;
            entries = [
              ...TOOLBAR_STATE_FIELDS.map((key): [string, unknown] => [key, fields[key]]),
              ...Object.keys(fields)
                .filter((key) => !TOOLBAR_STATE_FIELDS.includes(key))
                .map((key): [string, unknown] => [key, fields[key]]),
            ];
          } catch (err) {
            return Promise.reject(
              new Error(
                `Plugin "${this.pluginId}" setToolbarButtonState: invalid state — ${formatErrorMessage(err, "unreadable")}`
              )
            );
          }
          // `menu` is the one structured field: a list of plain entries, each
          // copied as own data so the port clones it and main's schema vets it.
          try {
            entries = entries.map(([key, value]): [string, unknown] => {
              if (key !== "menu" || !Array.isArray(value)) return [key, value];
              return [
                key,
                value.map((item: unknown) =>
                  item !== null && typeof item === "object" && !Array.isArray(item)
                    ? Object.fromEntries(
                        Object.keys(item).map((k) => [k, (item as Record<string, unknown>)[k]])
                      )
                    : item
                ),
              ];
            });
          } catch (err) {
            return Promise.reject(
              new Error(
                `Plugin "${this.pluginId}" setToolbarButtonState: invalid state — ${formatErrorMessage(err, "unreadable")}`
              )
            );
          }
          for (const [key, value] of entries) {
            if (key === "menu" && Array.isArray(value)) continue;
            if (
              value !== undefined &&
              typeof value !== "string" &&
              typeof value !== "boolean" &&
              typeof value !== "number"
            ) {
              return Promise.reject(
                new Error(
                  `Plugin "${this.pluginId}" setToolbarButtonState: invalid state — ${key}: must be a boolean or a string`
                )
              );
            }
          }
          // `fromEntries` defines every key as an own property — even
          // `__proto__` — so main's strict schema still sees it.
          copy = Object.fromEntries(
            entries.filter(
              ([key, value]) => value !== undefined || !TOOLBAR_STATE_FIELDS.includes(key)
            )
          ) as Record<string, string | boolean | number | undefined>;
        }
        return this.rpc.callWithGrace<void>(
          "setToolbarButtonState",
          { buttonId, state: copy as PluginToolbarButtonRuntimeState | null },
          undefined
        );
      },
      // Vetted here with the host's own rules so a bad call rejects without a
      // round trip, then sent as a call so main's per-plugin key cap rejects
      // back to the caller too. Resolves (not rejects) once the worker is torn
      // down, matching the in-process host's silent no-op after unload.
      setContext: (key, value) => {
        if (this.rpc.disposed) return Promise.resolve();
        const entry = validatePluginContextEntry(key, value);
        if (!entry.ok) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(new Error(`Plugin "${this.pluginId}" setContext: ${entry.error}`));
        }
        return this.rpc.callWithGrace<void>(
          "setContext",
          { key: entry.key, value: entry.value },
          undefined
        );
      },
      // Vetted here with the host's own rules, then sent as a call: only main
      // knows which worktrees this plugin may reach, and that refusal has to
      // reach the caller's `await`. Resolves once torn down, like setContext.
      // A command stays in the authored namespace (instance = manifest), as a
      // panel menu's does, so main's own qualification still applies.
      setWorktreeCardStatus: (worktreeId, status) => {
        if (this.rpc.disposed) return Promise.resolve();
        const entry = validatePluginWorktreeCardStatus(worktreeId, status, manifestId, manifestId);
        if (!entry.ok) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(`Plugin "${this.pluginId}" setWorktreeCardStatus: ${entry.error}`)
          );
        }
        return this.rpc.callWithGrace<void>(
          "setWorktreeCardStatus",
          { worktreeId: entry.worktreeId, status: entry.status },
          undefined
        );
      },
      // Same shape as setWorktreeCardStatus (#13806): commands stay authored.
      setWorktreeReviewChecks: (worktreeId, checks) => {
        if (this.rpc.disposed) return Promise.resolve();
        const entry = validatePluginWorktreeReviewChecks(
          worktreeId,
          checks,
          manifestId,
          manifestId
        );
        if (!entry.ok) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(`Plugin "${this.pluginId}" setWorktreeReviewChecks: ${entry.error}`)
          );
        }
        return this.rpc.callWithGrace<void>(
          "setWorktreeReviewChecks",
          { worktreeId: entry.worktreeId, checks: entry.checks },
          undefined
        );
      },
      // Same shape as setWorktreeCardStatus (#13802): vetted here so a mistake
      // rejects to the caller, then main checks the terminal against its own
      // agents.list read.
      setTerminalStatus: (terminalId, status) => {
        if (this.rpc.disposed) return Promise.resolve();
        let entry: ReturnType<typeof validatePluginTerminalStatus>;
        try {
          entry = validatePluginTerminalStatus(terminalId, status, manifestId, manifestId);
        } catch (err) {
          return Promise.reject(
            new Error(`Plugin "${this.pluginId}" setTerminalStatus: status could not be read`, {
              cause: err,
            })
          );
        }
        if (!entry.ok) {
          return Promise.reject(
            new Error(`Plugin "${this.pluginId}" setTerminalStatus: ${entry.error}`)
          );
        }
        return this.rpc.callWithGrace<void>(
          "setTerminalStatus",
          { terminalId: entry.terminalId, status: entry.status },
          undefined
        );
      },
      // Same shape (#13820): vetted here so a mistake rejects to the caller,
      // then main settles whether the panel is this plugin's own.
      setPanelActivity: (panelId, activity) => {
        if (this.rpc.disposed) return Promise.resolve();
        let entry: ReturnType<typeof validatePluginPanelActivity>;
        try {
          entry = validatePluginPanelActivity(panelId, activity);
        } catch (err) {
          return Promise.reject(
            new Error(`Plugin "${this.pluginId}" setPanelActivity: activity could not be read`, {
              cause: err,
            })
          );
        }
        if (!entry.ok) {
          return Promise.reject(
            new Error(`Plugin "${this.pluginId}" setPanelActivity: ${entry.error}`)
          );
        }
        return this.rpc.callWithGrace<void>(
          "setPanelActivity",
          { panelId: entry.panelId, activity: entry.activity },
          undefined
        );
      },
      // Vetted here with the host's own rules, so an authoring mistake rejects
      // back to the caller rather than only being logged in main, then sent as
      // a plain copy that always survives the port. Main vets it again and
      // owns the per-plugin panel cap.
      setPanelMenuItems: (panelId, items) => {
        if (typeof panelId !== "string" || panelId.length === 0) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(
              `Plugin "${this.pluginId}" setPanelMenuItems: panelId must be a non-empty string`
            )
          );
        }
        // Normalized into the authored namespace (instance = manifest), so what
        // crosses is exactly what was vetted, read once, and main's own
        // qualification still applies.
        const result = normalizePanelMenuItems(items, manifestId, manifestId);
        if (!result.ok) {
          return Promise.reject(
            new Error(
              `Plugin "${this.pluginId}" setPanelMenuItems: invalid items — ${result.error}`
            )
          );
        }
        this.rpc.notify("setPanelMenuItems", { panelId, items: result.items });
        return Promise.resolve();
      },
      showToast: (options: PluginToastOptions) =>
        this.rpc.call<void>("showToast", {
          message: options?.message,
          type: options?.type,
          durationMs: options?.durationMs,
        }),
      notify: (options: PluginNotifyOptions) =>
        this.rpc.call<PluginNotifyResult>("notify", { options }),
      dispatch: (actionId, args, options) =>
        this.rpc.call<ActionDispatchResult>(
          "dispatch",
          options === undefined ? { actionId, args } : { actionId, args, options }
        ),
      // Relayed like dispatch; the real host validates, authorizes against its
      // own binding, and routes. Only `panelId` crosses — the worker cannot
      // name whose panel it is (#12610). Degrades to "unavailable" on unload,
      // matching the real host.
      reloadPanel: (panelId) => {
        if (typeof panelId !== "string" || panelId.trim().length === 0) {
          return Promise.reject(
            new Error(`Plugin "${this.pluginId}" reloadPanel: panelId must be a non-empty string`)
          );
        }
        return this.rpc.callWithGrace<PanelReloadResult>("reloadPanel", { panelId }, "unavailable");
      },
      // Main schedules the restart after this answer is posted, so the reply
      // reaches this worker before its teardown does (#13410).
      restartWorker: () =>
        this.rpc.callWithGrace<WorkerRestartResult>("restartWorker", undefined, "unavailable"),
      // Built-in action catalog (#10561). list/get relay over the port like
      // dispatch; canDispatch is derived locally from get() (no extra
      // round-trip), mirroring the real host. callWithGrace resolves the
      // empty/absent fallback ([] / null / "restricted") on plugin unload
      // instead of rejecting, matching the host contract.
      actions: {
        list: () =>
          this.rpc.callWithGrace<PluginActionManifestEntry[]>("actions.list", undefined, []),
        get: (actionId) =>
          this.rpc.callWithGrace<PluginActionManifestEntry | null>(
            "actions.get",
            { actionId },
            null
          ),
        canDispatch: async (actionId) => {
          // Honor the never-throws contract: a host-side error on the underlying
          // get() degrades to "restricted" rather than rejecting.
          let entry: PluginActionManifestEntry | null;
          try {
            entry = await this.rpc.callWithGrace<PluginActionManifestEntry | null>(
              "actions.get",
              { actionId },
              null
            );
          } catch {
            return "restricted";
          }
          if (!entry) return "restricted";
          if (entry.danger === "confirm") return "confirm";
          // Fail closed: only an explicit "safe" entry maps to "ok".
          if (entry.danger === "safe") return "ok";
          return "restricted";
        },
      },
      // Capability check, consent prompt, active-agent resolution, and the PTY
      // write all run on the real main-side host — the worker only relays.
      sendToActiveAgent: (text, options) =>
        this.rpc.call<void>("sendToActiveAgent", { text, options }),
      // Listing and drafting both run on the real host in main, which owns the
      // capability gate, the consent prompt and the project binding. Grace
      // values match the host's own unload answers ([] / cancelled).
      agents: {
        list: () => this.rpc.callWithGrace<PluginAgentPane[]>("agents.list", undefined, []),
        // Re-frozen on arrival: the port's structured clone drops main's freeze.
        listAll: () =>
          this.rpc
            .callWithGrace<unknown>(
              "agents.listAll",
              undefined,
              UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT
            )
            .then(normalizePluginAllAgentsSnapshot),
        // Ownership, capability, consent and the write all run on the real host
        // in main.
        interrupt: (terminalId) =>
          this.callAgentInput<PluginAgentInterruptResult>("agents.interrupt", { terminalId }),
        sendKeys: (terminalId, input) =>
          this.callAgentInput<PluginAgentKeysResult>("agents.sendKeys", { terminalId, input }),
        submit: (terminalId, text) =>
          this.callAgentInput<PluginAgentInputResult>("agents.submit", { terminalId, text }),
      },
      // Capability, consent, rate limit and project scope all live on the real
      // host in main; the grace value is the host's own unload answer.
      terminals: {
        readScreen: (terminalId, options) =>
          this.rpc.callWithGrace<PluginTerminalScreenResult>(
            "terminals.readScreen",
            { terminalId, options },
            { status: "unavailable" }
          ),
      },
      // A cancel is main's to answer: a targeted draft, or a picker the user
      // already accepted, lands anyway, and settling "cancelled" here would
      // report a draft that happened as one that did not.
      sendToAgent: (text, options, callOptions) =>
        this.rpc.callWithGrace<PluginSendToAgentResult>(
          "sendToAgent",
          { text, options },
          { status: "cancelled" },
          callOptions?.signal,
          { hostAnswersAbort: true }
        ),
      // Likewise: once the user confirms, the run is theirs and main reports it.
      runRecipe: (recipeId, options, callOptions) =>
        this.rpc.callWithGrace<PluginRunRecipeResult>(
          "runRecipe",
          { recipeId, options },
          { status: "cancelled" },
          callOptions?.signal,
          { hostAnswersAbort: true }
        ),
      // Imperative UI prompts (#10522). Post-activation-safe (no
      // assertActivationOpen): plugins prompt from command handlers. They use
      // callWithGrace so a plugin unload mid-prompt resolves the dismiss value
      // (undefined / false) instead of rejecting — matching the host contract.
      showQuickPick: ((
        items: PluginQuickPickItem[],
        options?: PluginQuickPickOptions,
        callOptions?: PluginPromptCallOptions
      ) =>
        this.rpc.callWithGrace<PluginQuickPickItem | PluginQuickPickItem[] | undefined>(
          "showQuickPick",
          { items, options, ...promptQueueParam(callOptions) },
          undefined,
          callOptions?.signal
        )) as PluginHostApi["showQuickPick"],
      showInputBox: (options, callOptions) =>
        this.rpc.callWithGrace<string | undefined>(
          "showInputBox",
          { options, ...promptQueueParam(callOptions) },
          undefined,
          callOptions?.signal
        ),
      showConfirm: (options, callOptions) =>
        this.rpc.callWithGrace<boolean>(
          "showConfirm",
          { options, ...promptQueueParam(callOptions) },
          false,
          callOptions?.signal
        ),
      logger: {
        info: (message, fields) => this.rpc.notify("logger.info", { message, fields }),
        warn: (message, fields) => this.rpc.notify("logger.warn", { message, fields }),
        error: (message, fields) => this.rpc.notify("logger.error", { message, fields }),
      },
      // host.fs request/response methods are fully async, so they relay over the
      // port to the real (contained, capability-gated) host like settings/get.
      // `watch` is a host-call that BOTH wires the watcher (rejecting on a
      // missing capability / out-of-scope path, preserving the in-process
      // contract) and opens a subscription whose change events arrive over the
      // subscription-event channel keyed by the same id.
      // The host resolves and contains the path; the connection is opened
      // here, in the worker, so queries never cross the port.
      db: {
        resolve: (id, options) =>
          this.rpc.call<PluginDatabaseLocation>("db.resolve", {
            id,
            ...(options?.readonly === true && { readonly: true }),
          }),
        open: async (id, options) => {
          // Checked here, not only in openPluginDatabase: the host prompts for
          // project-write consent on resolve, and a malformed open must not
          // bank a grant (#10524).
          const schema = checkedSchemaOptions(id, options);
          const params = { id, ...(options?.readonly === true && { readonly: true }) };
          const location = await this.rpc.call<PluginDatabaseLocation>("db.resolve", params);
          const database: PluginDatabase = await openPluginDatabase(location, {
            ...options,
            ...schema,
            revalidate: () => this.rpc.call<PluginDatabaseLocation>("db.resolve", params),
            // Only a call has a caller to hold to the lease; background work
            // skips the round trip, as the host would pass it anyway.
            authorizeWrite: async () => {
              if (location.location !== "project" || this.rpc.currentInvocation() === undefined) {
                return;
              }
              await this.rpc.call<void>("db.authorizeWrite", { id, path: location.path });
            },
            prepareBackup: (destPath) =>
              this.rpc.call<string>("db.prepareBackup", { id, destPath }),
            onClosed: () => this.databases.delete(database),
          });
          if (this.rpc.disposed) {
            await database.close();
            throw new Error(
              `PLUGIN_UNLOADED: plugin "${this.pluginId}" db.open: plugin is no longer loaded`
            );
          }
          this.databases.add(database);
          return database;
        },
      },
      fs: {
        readFile: (filePath, options) =>
          this.rpc.call<string>("fs.readFile", { path: filePath }, options?.signal),
        readFileBytes: (filePath, options) =>
          this.rpc.call<Uint8Array>("fs.readFileBytes", { path: filePath }, options?.signal),
        readFileWithRevision: (filePath, options) =>
          this.rpc.call<PluginFsReadWithRevisionResult>(
            "fs.readFileWithRevision",
            { path: filePath },
            options?.signal
          ),
        readFiles: ((paths: readonly string[], options?: PluginFsReadFilesOptions) =>
          this.rpc.call<PluginFsReadFilesEntry<string | Uint8Array>[]>(
            "fs.readFiles",
            {
              paths,
              // Forwarded as given so the host rejects a malformed value.
              ...(options?.encoding !== undefined && { encoding: options.encoding }),
              ...(options?.maxBytesPerFile !== undefined && {
                maxBytesPerFile: options.maxBytesPerFile,
              }),
            },
            options?.signal
          )) as NonNullable<PluginFsApi["readFiles"]>,
        mkdir: (dirPath) => this.rpc.call<void>("fs.mkdir", { path: dirPath }),
        appendFile: (filePath, contents) =>
          this.rpc.call<void>("fs.appendFile", { path: filePath, contents }),
        writeFile: (filePath, contents, options) =>
          this.rpc.call<PluginFsWriteResult>("fs.writeFile", {
            path: filePath,
            contents,
            ...(options !== undefined && { options }),
          }),
        readdir: (dirPath, options) =>
          this.rpc.call<PluginFsDirEntry[]>(
            "fs.readdir",
            { path: dirPath, ...(options?.detail === true && { detail: true }) },
            options?.signal
          ),
        walk: (root: string, options?: PluginFsWalkOptions) => {
          // Forwarded as given (minus the signal, which cancels the call) so
          // the host rejects a malformed option rather than it reading as absent.
          let forwarded: unknown = options;
          if (options !== null && typeof options === "object") {
            const { signal: _signal, ...rest } = options;
            forwarded = rest;
          }
          return this.rpc.call<PluginFsWalkResult>(
            "fs.walk",
            { root, ...(forwarded !== undefined && { options: forwarded }) },
            options?.signal
          );
        },
        stat: (targetPath, options) =>
          this.rpc.call<PluginFsStat>("fs.stat", { path: targetPath }, options?.signal),
        watch: async (paths, callback, options) => {
          const subscriptionId = this.rpc.nextSubscriptionId();
          // Register the change callback before the call so an event can't race
          // ahead of the subscription map; tear it down if the watch rejects.
          this.rpc.addSubscription(subscriptionId, (payload) => callback(payload as string));
          try {
            await this.rpc.call<void>(
              "fs.watch",
              {
                subscriptionId,
                paths,
                // Forwarded as given so the host rejects a malformed value.
                ...(options?.recursive !== undefined && { recursive: options.recursive }),
                ...(options?.debounceMs !== undefined && { debounceMs: options.debounceMs }),
                ...(options?.allowMissing !== undefined && { allowMissing: options.allowMissing }),
              },
              options?.signal
            );
          } catch (err) {
            this.rpc.deleteSubscription(subscriptionId);
            // A cancel that reaches main after the watch settled finds no call
            // to abort, so main would keep a watcher nobody listens to; this
            // releases it (and is a no-op when main never registered one). A
            // timed-out watch is the same race.
            if (options?.signal?.aborted || isHostCallTimeoutError(err)) {
              try {
                this.rpc.post({ type: "unsubscribe", subscriptionId });
              } catch {
                // best-effort
              }
            }
            throw err;
          }
          let disposed = false;
          return () => {
            if (disposed) return;
            disposed = true;
            this.rpc.deleteSubscription(subscriptionId);
            this.rpc.post({ type: "unsubscribe", subscriptionId });
          };
        },
      },
      git: {
        status: (worktreePath, options) =>
          this.rpc.call<PluginGitStatus>("git.status", { worktreePath }, options?.signal),
        diff: (worktreePath, filePath, options) =>
          this.rpc.call<string>("git.diff", { worktreePath, filePath }, options?.signal),
        add: (worktreePath, paths, options) =>
          this.rpc.call<void>("git.add", { worktreePath, paths }, options?.signal),
        commit: (worktreePath, options, callOptions) =>
          this.rpc.call<PluginGitCommitResult>(
            "git.commit",
            {
              worktreePath,
              message: options?.message,
            },
            callOptions?.signal
          ),
      },
      clipboard: {
        writeText: (text) => this.rpc.call<void>("clipboard.writeText", { text }),
        // The typed array survives structured clone, so the bytes reach the
        // real host unchanged and are validated there — the worker is the
        // untrusted side, so no size check is worth doing here.
        writeImage: (pngData) => this.rpc.call<void>("clipboard.writeImage", { pngData }),
        readText: () => this.rpc.call<string>("clipboard.readText", undefined),
      },
      system: {
        openPath: (targetPath) => this.rpc.call<void>("system.openPath", { targetPath }),
        showItemInFolder: (targetPath) =>
          this.rpc.call<void>("system.showItemInFolder", { targetPath }),
        openExternal: (url) => this.rpc.call<void>("system.openExternal", { url }),
      },
      // Rendering needs Electron's printToPDF, which only exists in main.
      documents: {
        renderPdf: (options) =>
          this.rpc.call<PluginRenderPdfResult>("documents.renderPdf", { options }),
      },
      // The bytes stay in main; only handles and progress cross the port.
      artifacts: {
        import: (source, options) =>
          this.artifactTransfer<PluginArtifact>("artifacts.import", source, options),
        download: (request, options) =>
          this.artifactTransfer<PluginArtifact>("artifacts.download", request, options),
        upload: (artifactId, request, options) =>
          this.artifactTransfer<PluginArtifactUploadResult>(
            "artifacts.upload",
            request,
            options,
            artifactId
          ),
        stat: (artifactId) =>
          this.rpc.call<PluginArtifact | null>("artifacts.stat", {
            artifactId,
          } satisfies ArtifactsIdParams),
        list: (options) =>
          this.rpc.call<PluginArtifact[]>("artifacts.list", {
            options,
          } satisfies ArtifactsListParams),
        release: (artifactId) =>
          this.rpc.call<boolean>("artifacts.release", { artifactId } satisfies ArtifactsIdParams),
      },
      // The ref crosses as given — an omitted one as `undefined` — so main
      // alone decides which project and connection it means.
      services: {
        call: ((name: unknown, method: unknown, args: unknown, options?: unknown) =>
          this.callService(name, method, args, options)) as PluginServicesApi["call"],
        status: (name) => this.rpc.call<PluginServiceStatus>("services.status", { name }),
      },
      account: {
        getState: (ref) => this.rpc.call<PluginAccountState>("account.getState", { ref }),
        getAccessToken: (ref) =>
          this.rpc.call<PluginAccountAccessToken | null>("account.getAccessToken", { ref }),
        onDidChange: (callback, ref) => {
          if (typeof callback !== "function") {
            throw new Error(
              `Plugin "${this.pluginId}" account.onDidChange: callback must be a function`
            );
          }
          const { connection, projectId } = (ref ?? {}) as Record<string, unknown>;
          if (
            (ref !== undefined && (ref === null || typeof ref !== "object")) ||
            (connection !== undefined && typeof connection !== "string") ||
            (projectId !== undefined && typeof projectId !== "string")
          ) {
            throw new Error(
              `Plugin "${this.pluginId}" account.onDidChange: ref must be { connection?: string; projectId?: string }`
            );
          }
          if (this.rpc.disposed) return () => {};
          const subscriptionId = this.rpc.nextSubscriptionId();
          return this.rpc.openSubscription(
            {
              type: "subscribe",
              subscriptionId,
              kind: "account",
              key: connection as string | undefined,
              projectId: projectId as string | undefined,
            },
            (payload) => callback(payload as PluginAccountState)
          );
        },
      },
      settings: {
        // Forward an omitted scope as `undefined` (not a defaulted "user") so the
        // real host resolves the key's manifest-declared scope on read (#10586) —
        // defaulting here would send an explicit "user" that a project-scoped key
        // rejects.
        get: <T = unknown>(key: string, scope?: PluginSettingsScope) =>
          this.rpc.call<T | undefined>("settings.get", { key, scope }),
        // Omitted scopes cross as `undefined` for the same reason as `get`.
        set: <T = unknown>(key: string, value: T, scope?: PluginSettingsScope) =>
          this.rpc.call<void>("settings.set", { key, value, scope }),
        unset: (key, scope) => this.rpc.call<void>("settings.unset", { key, scope }),
        open: (key?: string) =>
          this.rpc.call<void>("settings.open", key === undefined ? {} : { key }),
        missingRequired: () => this.rpc.call<string[]>("settings.missingRequired", {}),
        onDidChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
          scope?: PluginSettingsScope
        ) => {
          this.assertActivationOpen("settings.onDidChange");
          const dispose = this.rpc.subscribe(
            "settings",
            (payload) => callback(payload as T | undefined),
            key,
            scope
          );
          return Promise.resolve(dispose);
        },
      },
      storage: {
        get: <T = unknown>(key: string, scope: PluginStorageScope = "user") =>
          this.rpc.call<T | undefined>("storage.get", { key, scope }),
        set: <T = unknown>(key: string, value: T, scope: PluginStorageScope = "user") =>
          this.rpc.call<void>("storage.set", { key, value, scope }),
        delete: (key: string, scope: PluginStorageScope = "user") =>
          this.rpc.call<void>("storage.delete", { key, scope }),
        onDidChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
          scope: PluginStorageScope = "user"
        ) => {
          this.assertActivationOpen("storage.onDidChange");
          const dispose = this.rpc.subscribe(
            "storage",
            (payload) => callback(payload as T | undefined),
            key,
            scope
          );
          return Promise.resolve(dispose);
        },
      },
    };
  }
}
