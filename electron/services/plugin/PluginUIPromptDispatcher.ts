import { ipcMain, webContents } from "electron";
import { randomUUID } from "node:crypto";
import { CHANNELS } from "../../ipc/channels.js";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { resolveTargetWebContents, type PluginTargetProjectId } from "./rendererTargeting.js";
import {
  promptOpensDialog,
  type PluginUiPromptParams,
  type PluginUiPromptResponse,
  type PluginUiPromptResultValue,
  type PluginUiPromptWhenNoFrontend,
} from "../../../shared/types/pluginUiPrompt.js";
import {
  noFrontendAttached,
  onPluginFrontendChange,
  resolvePluginFrontend,
  type PluginFrontend,
} from "./pluginFrontendRouting.js";
import { coercePromptAnswer, PluginFrontendMethod } from "./pluginFrontendRequests.js";

/**
 * The cancel/dismiss outcome for a prompt kind: `false` for a confirm (the user
 * did not confirm), `{ status: "cancelled" }` for a send-to-agent, `undefined`
 * for quick-pick / input-box (no selection). Used whenever a prompt resolves
 * without an explicit user answer — renderer gone, plugin unloaded, or service
 * disposed.
 */
function cancelValueFor(kind: PluginUiPromptParams["kind"]): PluginUiPromptResultValue {
  if (kind === "confirm") return false;
  if (kind === "sendToAgent") return { status: "cancelled" };
  return undefined;
}

/**
 * The answer for a prompt turned away because the plugin already has one open.
 * A send-to-agent says so, since "cancelled" would claim the user dismissed a
 * picker they never saw; the other kinds keep their dismiss value.
 */
function busyValueFor(params: PluginUiPromptParams): PluginUiPromptResultValue {
  if (params.kind === "sendToAgent") {
    return { status: "refused", reason: promptOpensDialog(params) ? "prompt-open" : "busy" };
  }
  return cancelValueFor(params.kind);
}

function capFor(opensDialog: boolean): number {
  return opensDialog ? MAX_PENDING_PROMPTS_PER_PLUGIN : MAX_PENDING_TARGETED_SENDS_PER_PLUGIN;
}

/**
 * What a request that opens no dialog resolves to when the renderer never
 * answers. Because the renderer only acts before the deadline and answers in
 * the same task it acts in, and main waits a grace period past the deadline
 * for that answer, silence means nothing was drafted: the project view that
 * should have answered is what is missing.
 */
function timeoutValueFor(params: PluginUiPromptParams): PluginUiPromptResultValue {
  if (params.kind === "sendToAgent") return { status: "refused", reason: "project-unavailable" };
  return cancelValueFor(params.kind);
}

/**
 * One in-flight prompt per plugin (#10621). A plugin host prompt is a modal
 * round-trip with no deadline; without a cap a buggy or adversarial plugin can
 * fire prompts faster than the user dismisses them, stacking unbounded dialogs
 * and leaking a `pending` entry each time. A second request while one is open
 * (or waiting for someone to attach) resolves immediately instead of being
 * sent. Only dialogs count here: a targeted send-to-agent answers without one
 * and has its own cap below.
 */
const MAX_PENDING_PROMPTS_PER_PLUGIN = 1;

/** Link failures that mean the person went away, not that the Shell refused. */
const FRONTEND_GONE_CODES = new Set(["HOST_DISCONNECTED", "STALE_GENERATION", "OUTCOME_UNKNOWN"]);

/**
 * Targeted send-to-agent requests in flight per plugin. They draft and answer
 * at once, so a handful covers a plugin handing several cards out together;
 * anything beyond that is a loop, and is refused as `busy` rather than queued.
 */
export const MAX_PENDING_TARGETED_SENDS_PER_PLUGIN = 8;

/**
 * The deadline a request that opens no dialog carries: the renderer acts on it
 * only before this, and drops it after. It has no user in the loop — the
 * renderer drafts and answers in one task — so it only lapses for a view that
 * is frozen, hung or gone.
 */
export const IMMEDIATE_PROMPT_TIMEOUT_MS = 10_000;

/**
 * How long past that deadline main keeps waiting for the answer. A renderer
 * that acted at the last moment has already sent its answer; this is the time
 * it has to arrive, so main never reports "not drafted" for a draft that
 * happened.
 */
export const IMMEDIATE_PROMPT_ACK_GRACE_MS = 5_000;

/**
 * An imperative UI prompt awaiting its renderer response. Unlike the dispatch
 * bridge a dialog has NO per-request timeout: a user-facing prompt has no
 * deadline racing it (mirrors `pluginConfirmStore`'s no-timeout stance). A
 * request that opens no dialog is the exception and times out. It
 * settles on the renderer response, a renderer `destroyed`, a caller's aborted
 * signal, a per-plugin cancel (unload), or {@link PluginUIPromptDispatcher.dispose}.
 */
interface PendingPrompt {
  resolve: (value: PluginUiPromptResultValue) => void;
  /** The local renderer showing it; null while it is with a remote frontend or parked. */
  webContentsId: number | null;
  /** The remote frontend showing it, told to take it down on cancel. */
  endpoint?: ClientEndpoint;
  pluginId: string;
  /** Value to resolve with when the prompt is cancelled rather than answered. */
  cancelValue: PluginUiPromptResultValue;
  /** Whether it put a dialog on screen, which is what the per-plugin cap counts. */
  opensDialog: boolean;
  /**
   * A send-to-agent picker whose user chose a row that starts an agent first.
   * The dialog is closed and the work is the user's: the prompt settles on the
   * renderer's report of what happened, never on a cancel.
   */
  accepted?: boolean;
  /**
   * Whether a caller's abort waits for the renderer's answer instead of
   * settling at once. Only a send-to-agent picker can be accepted, and an
   * acceptance already on its way must win over an abort that arrives after it.
   */
  answersAbort: boolean;
  /** Bounds the wait for that answer, so a hung renderer cannot hold the caller. */
  abortAckTimer?: ReturnType<typeof setTimeout>;
  /**
   * Detaches every listener this prompt registered — the WebContents
   * `destroyed` hook and the caller's `abort` hook. One combined disposer so a
   * settlement path can never remember to drop one and leak the other; called
   * on every terminal path.
   */
  cleanup?: () => void;
}

/** A prompt that asked to wait until someone attaches. */
interface ParkedPrompt {
  pluginId: string;
  params: PluginUiPromptParams;
  projectId: string | null;
  signal?: AbortSignal;
  options: PromptRequestOptions;
  askedAt: number;
  resolve: (value: PluginUiPromptResultValue) => void;
  reject: (error: Error) => void;
  cancelValue: PluginUiPromptResultValue;
  cleanup: () => void;
}

export interface PromptRequestOptions {
  /**
   * With nobody attached, `"fail"` (the default) rejects with
   * `NO_FRONTEND_ATTACHED`; `"queue"` holds the prompt until a frontend
   * attaches and shows it there, marked with when it was asked.
   */
  whenNoFrontend?: PluginUiPromptWhenNoFrontend;
  /** How a remote frontend names the plugin. */
  pluginDisplayName?: string;
}

interface PluginUIPromptDispatcherDeps {
  /** Getter so the collaborator never holds a stale snapshot of the disposed flag. */
  isDisposed: () => boolean;
  now?: () => number;
}

/**
 * Owns the imperative `host.showQuickPick`/`showInputBox`/`showConfirm`
 * main→renderer round-trip (#10522): resolving the renderer that should answer,
 * the lazy `ipcMain` response listener, the pending-request map with
 * destroyed-cleanup, the per-plugin cancel drain on unload, and teardown of
 * pending prompts on disposal. Mirrors {@link PluginRendererDispatcher} but
 * resolves a value — a dismissed or cancelled prompt is `undefined`/`false`,
 * not a failure.
 *
 * With Host-mode routing on, the prompt goes to the frontend that drives the
 * project, which may be a Shell on another machine; with nobody attached it
 * fails with `NO_FRONTEND_ATTACHED` unless the plugin asked to wait.
 */
export class PluginUIPromptDispatcher {
  private readonly deps: PluginUIPromptDispatcherDeps;

  /** In-flight prompts keyed by `promptId`. */
  private pending = new Map<string, PendingPrompt>();
  private parked = new Map<string, ParkedPrompt>();
  private parkedSubscription: (() => void) | null = null;
  /** Removes the lazily-registered `ipcMain` response listener. */
  private responseListenerCleanup: (() => void) | null = null;

  constructor(deps: PluginUIPromptDispatcherDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Lazily register the single `ipcMain` listener that resolves prompt
   * responses. The handler validates `event.sender.id` against the pending
   * request's `webContentsId` so a renderer in another window cannot resolve a
   * prompt initiated for a different window (mirrors the dispatch bridge, #4641).
   */
  private ensureResponseListener(): void {
    if (this.responseListenerCleanup) return;
    const handler = (event: Electron.IpcMainEvent, payload: PluginUiPromptResponse) => {
      if (!payload || typeof payload.promptId !== "string") return;
      const pending = this.pending.get(payload.promptId);
      if (!pending) return;
      if (event.sender.id !== pending.webContentsId) {
        console.warn(
          `[PluginService] Ignoring UI-prompt response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, promptId=${payload.promptId})`
        );
        return;
      }
      if (!("result" in payload)) {
        if (payload.accepted === true && pending.answersAbort) {
          pending.accepted = true;
          if (pending.abortAckTimer !== undefined) clearTimeout(pending.abortAckTimer);
          pending.abortAckTimer = undefined;
        }
        return;
      }
      pending.cleanup?.();
      this.pending.delete(payload.promptId);
      pending.resolve(payload.result);
    };
    ipcMain.on(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE, handler);
    this.responseListenerCleanup = () => {
      ipcMain.removeListener(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE, handler);
    };
  }

  /**
   * Send a prompt request to a renderer and await the user's answer. Resolves
   * with a {@link PluginUiPromptResultValue} — no renderer, renderer destroyed,
   * plugin unload, and disposal all resolve the kind's cancel value rather than
   * rejecting.
   *
   * `projectId` binds the prompt to one project's renderer, including a cached
   * (not currently visible) view so the user finds it on switching back; it
   * rejects with `PROJECT_VIEW_UNAVAILABLE` when that project has no view.
   * With Host-mode routing on it may also reject with `NO_FRONTEND_ATTACHED`:
   * nobody is attached, which is not the same answer as a dismissal.
   *
   * `signal` ties the prompt to the lifetime of whatever asked for it. Aborting
   * dismisses the open dialog and resolves the cancel value — it never rejects,
   * because a cancelled prompt is a dismissal and callers document a
   * never-throws contract. This is what lets a dev worker's retired generation
   * take its own questions off the user's screen (#12279). A send-to-agent
   * picker the user has already accepted is the exception: it resolves with
   * what the launch it started actually did.
   */
  requestPrompt(
    pluginId: string,
    params: PluginUiPromptParams,
    projectId?: PluginTargetProjectId,
    signal?: AbortSignal,
    options: PromptRequestOptions = {}
  ): Promise<PluginUiPromptResultValue> {
    const cancelValue = cancelValueFor(params.kind);
    return new Promise((resolve, reject) => {
      if (this.deps.isDisposed()) {
        resolve(cancelValue);
        return;
      }
      // Already cancelled before anything reached the renderer — never open a
      // dialog the caller has stopped waiting for.
      if (signal?.aborted) {
        resolve(cancelValue);
        return;
      }
      const frontend = resolvePluginFrontend(projectId ?? null, pluginId);
      if (frontend.kind === "local") {
        // Unbound: deliberately ambient — an installed plugin's prompt belongs in
        // front of whoever is looking, which is the focused project view.
        const target = resolveTargetWebContents(projectId, `Plugin ${params.kind} prompt`);
        if (!target) {
          resolve(cancelValue);
          return;
        }
        this.showInWebContents(target, pluginId, params, signal).then(resolve, reject);
        return;
      }
      const opensDialog = promptOpensDialog(params);
      if (this.activeCount(pluginId, opensDialog) >= capFor(opensDialog)) {
        resolve(busyValueFor(params));
        return;
      }
      this.deliverElsewhere(frontend, {
        pluginId,
        params,
        projectId: projectId ?? null,
        signal,
        options,
        askedAt: this.now(),
        resolve,
        reject,
        cancelValue,
        cleanup: () => {},
      });
    });
  }

  /**
   * Show a prompt in one known renderer and await its answer. The local path
   * of {@link requestPrompt}, and what a Shell uses to put a host's prompt in
   * front of the view that drives it.
   */
  showInWebContents(
    target: Electron.WebContents,
    pluginId: string,
    params: PluginUiPromptParams,
    signal?: AbortSignal
  ): Promise<PluginUiPromptResultValue> {
    const cancelValue = cancelValueFor(params.kind);
    return new Promise((resolve) => {
      if (this.deps.isDisposed() || signal?.aborted || target.isDestroyed()) {
        resolve(cancelValue);
        return;
      }

      // Enforce the per-plugin cap before sending so a runaway plugin can't stack
      // dialogs or leak `pending` entries. Checked here (not renderer-side) so the
      // guard holds regardless of renderer queue behavior.
      // Dialogs and immediate requests are counted separately, so neither can
      // starve the other.
      const opensDialog = promptOpensDialog(params);
      if (this.activeCount(pluginId, opensDialog) >= capFor(opensDialog)) {
        resolve(busyValueFor(params));
        return;
      }

      this.ensureResponseListener();

      const promptId = randomUUID();
      const webContentsId = target.id;

      const onDestroyed = () => {
        const pending = this.pending.get(promptId);
        if (!pending) return;
        pending.cleanup?.();
        this.pending.delete(promptId);
        resolve(opensDialog ? cancelValue : timeoutValueFor(params));
      };
      target.once("destroyed", onDestroyed);

      // Settles this one prompt when its caller goes away. Scoped by `promptId`
      // so a late abort can only ever dismiss the request it belongs to — never
      // a successor the same plugin opened after this one settled.
      //
      // Dialogs only. An immediate request is atomic on the renderer — it acts
      // and answers in one task, and a cancel sent after it would arrive behind
      // it and find nothing to stop — so resolving "cancelled" early would be a
      // guess that can be wrong. It keeps waiting for the answer instead, which
      // the deadline below bounds.
      //
      // A send-to-agent picker the user has accepted is past cancelling: the
      // work is theirs, and its outcome is the answer. One not yet accepted is
      // dismissed and answered by the renderer, whose acceptance — if the user
      // chose a row just before this abort — arrives first on the same channel,
      // so "cancelled" is never reported for an agent that is starting.
      const onAbort = () => {
        const pending = this.pending.get(promptId);
        if (!pending || pending.accepted) return;
        this.sendCancel(webContentsId, pluginId, promptId);
        if (pending.answersAbort) {
          pending.abortAckTimer = setTimeout(() => {
            const current = this.pending.get(promptId);
            if (current !== pending || current.accepted) return;
            current.cleanup?.();
            this.pending.delete(promptId);
            resolve(cancelValue);
          }, IMMEDIATE_PROMPT_ACK_GRACE_MS);
          return;
        }
        pending.cleanup?.();
        this.pending.delete(promptId);
        resolve(cancelValue);
      };
      if (opensDialog) signal?.addEventListener("abort", onAbort, { once: true });

      // An immediate request has no user in the loop, so an unanswered one is a
      // stuck renderer. The renderer acts only before `expiresAt`, and main
      // waits a grace period past it for the answer, so the answer it reports
      // is what the renderer did — never "not drafted" for a draft that landed.
      const expiresAt = opensDialog ? undefined : Date.now() + IMMEDIATE_PROMPT_TIMEOUT_MS;
      const timer = opensDialog
        ? undefined
        : setTimeout(() => {
            const pending = this.pending.get(promptId);
            if (!pending) return;
            pending.cleanup?.();
            this.pending.delete(promptId);
            resolve(timeoutValueFor(params));
          }, IMMEDIATE_PROMPT_TIMEOUT_MS + IMMEDIATE_PROMPT_ACK_GRACE_MS);

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        const entry = this.pending.get(promptId);
        if (entry?.abortAckTimer !== undefined) clearTimeout(entry.abortAckTimer);
        try {
          target.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort; webContents may already be gone
        }
        if (opensDialog) signal?.removeEventListener("abort", onAbort);
      };

      this.pending.set(promptId, {
        resolve,
        webContentsId,
        pluginId,
        cancelValue,
        opensDialog,
        answersAbort: opensDialog && params.kind === "sendToAgent",
        cleanup,
      });

      try {
        target.send(CHANNELS.PLUGIN_UI_PROMPT_REQUEST, {
          promptId,
          pluginId,
          params,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
      } catch {
        cleanup();
        this.pending.delete(promptId);
        resolve(cancelValue);
      }
    });
  }

  /**
   * Prompts of one kind — dialogs or immediate requests — this plugin has open
   * or waiting. An accepted picker has left the screen; what it still waits on
   * is the user's own launch.
   */
  private activeCount(pluginId: string, opensDialog: boolean): number {
    let count = 0;
    for (const pending of this.pending.values()) {
      if (pending.accepted) continue;
      if (pending.pluginId === pluginId && pending.opensDialog === opensDialog) count += 1;
    }
    for (const parked of this.parked.values()) {
      if (parked.pluginId === pluginId && promptOpensDialog(parked.params) === opensDialog) {
        count += 1;
      }
    }
    return count;
  }

  /** A remote driver, or nobody: send it there, park it, or fail it. */
  private deliverElsewhere(frontend: PluginFrontend, prompt: ParkedPrompt): void {
    if (frontend.kind === "remote") {
      this.sendRemote(frontend.endpoint, prompt);
      return;
    }
    if (frontend.kind === "local") {
      const target = resolveTargetWebContents(
        prompt.projectId,
        `Plugin ${prompt.params.kind} prompt`
      );
      if (!target) {
        prompt.resolve(prompt.cancelValue);
        return;
      }
      this.showInWebContents(target, prompt.pluginId, prompt.params, prompt.signal).then(
        prompt.resolve,
        prompt.reject
      );
      return;
    }
    if (prompt.options.whenNoFrontend === "queue") {
      this.park(prompt);
      return;
    }
    prompt.reject(noFrontendAttached(prompt.pluginId, `${prompt.params.kind} prompt`));
  }

  private sendRemote(endpoint: ClientEndpoint, prompt: ParkedPrompt): void {
    const promptId = randomUUID();
    const { pluginId, signal, cancelValue } = prompt;
    const onAbort = () => {
      const pending = this.pending.get(promptId);
      if (!pending) return;
      pending.cleanup?.();
      this.pending.delete(promptId);
      this.sendRemoteCancel(endpoint, pluginId, promptId);
      prompt.resolve(cancelValue);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    this.pending.set(promptId, {
      resolve: prompt.resolve,
      webContentsId: null,
      endpoint,
      pluginId,
      cancelValue,
      opensDialog: promptOpensDialog(prompt.params),
      answersAbort: false,
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    });
    const parkedFor = this.now() - prompt.askedAt;
    endpoint
      .request(
        PluginFrontendMethod.PROMPT,
        {
          promptId,
          pluginId,
          pluginDisplayName: prompt.options.pluginDisplayName ?? pluginId,
          params: prompt.params,
          // Only a prompt that actually waited says when it was asked.
          ...(parkedFor > 0 ? { askedAt: prompt.askedAt } : {}),
        },
        // No deadline, like a local prompt: the person answers when they answer.
        { timeoutMs: 0 }
      )
      .then(
        (answer) => {
          const pending = this.pending.get(promptId);
          if (!pending) return;
          pending.cleanup?.();
          this.pending.delete(promptId);
          prompt.resolve(coercePromptAnswer(prompt.params, answer));
        },
        (error: unknown) => {
          const pending = this.pending.get(promptId);
          if (!pending) return;
          pending.cleanup?.();
          this.pending.delete(promptId);
          const code = (error as { code?: unknown } | null)?.code;
          const gone =
            endpoint.isClosed() || (typeof code === "string" && FRONTEND_GONE_CODES.has(code));
          if (!gone) {
            prompt.reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (this.deps.isDisposed() || signal?.aborted) {
            prompt.resolve(cancelValue);
            return;
          }
          // The person left before answering. A plugin that asked to wait keeps
          // waiting for the next one; any other plugin learns nobody is there.
          this.deliverElsewhere(resolvePluginFrontend(prompt.projectId, pluginId), prompt);
        }
      );
  }

  private park(prompt: ParkedPrompt): void {
    const parkId = randomUUID();
    const onAbort = () => {
      if (!this.parked.delete(parkId)) return;
      this.releaseParkedSubscription();
      prompt.resolve(prompt.cancelValue);
    };
    prompt.signal?.addEventListener("abort", onAbort, { once: true });
    prompt.cleanup = () => prompt.signal?.removeEventListener("abort", onAbort);
    this.parked.set(parkId, prompt);
    this.parkedSubscription ??= onPluginFrontendChange(() => this.drainParked());
  }

  private drainParked(): void {
    for (const [parkId, prompt] of [...this.parked]) {
      const frontend = resolvePluginFrontend(prompt.projectId, prompt.pluginId);
      if (frontend.kind === "none") continue;
      this.parked.delete(parkId);
      prompt.cleanup();
      this.deliverElsewhere(frontend, prompt);
    }
    this.releaseParkedSubscription();
  }

  private releaseParkedSubscription(): void {
    if (this.parked.size > 0 || !this.parkedSubscription) return;
    this.parkedSubscription();
    this.parkedSubscription = null;
  }

  /**
   * Resolve every pending prompt for `pluginId` with its cancel value and tell
   * the renderer to dismiss the open dialog. Invoked from `unloadPlugin` so a
   * plugin that is disabled/unloaded mid-prompt doesn't leave the caller's
   * promise hanging or a stranded dialog on screen.
   *
   * Immediate requests are left to settle on their own answer or deadline:
   * there is nothing on screen to dismiss, and the renderer has either acted on
   * one already or will drop it, so reporting "cancelled" now could be wrong.
   * An accepted picker is left the same way — its dialog is gone, and the
   * launch it started is the user's.
   */
  cancelForPlugin(pluginId: string): void {
    let notifiedWebContentsId: number | null = null;
    const notifiedEndpoints = new Set<ClientEndpoint>();
    for (const [promptId, pending] of [...this.pending.entries()]) {
      if (pending.pluginId !== pluginId || !pending.opensDialog || pending.accepted) continue;
      pending.cleanup?.();
      this.pending.delete(promptId);
      // Dismiss the visible dialog. One broadcast per affected window suffices —
      // the renderer drops every queued prompt for this plugin.
      if (pending.endpoint) {
        if (!notifiedEndpoints.has(pending.endpoint)) {
          notifiedEndpoints.add(pending.endpoint);
          this.sendRemoteCancel(pending.endpoint, pluginId);
        }
      } else if (
        pending.webContentsId !== null &&
        notifiedWebContentsId !== pending.webContentsId
      ) {
        notifiedWebContentsId = pending.webContentsId;
        this.sendCancel(pending.webContentsId, pluginId);
      }
      pending.resolve(pending.cancelValue);
    }
    for (const [parkId, parked] of [...this.parked]) {
      if (parked.pluginId !== pluginId) continue;
      this.parked.delete(parkId);
      parked.cleanup();
      parked.resolve(parked.cancelValue);
    }
    this.releaseParkedSubscription();
  }

  /**
   * Tell a renderer to drop prompts for `pluginId`. With `promptId` only that
   * one request is dismissed; without it every prompt for the plugin goes.
   */
  private sendCancel(webContentsId: number, pluginId: string, promptId?: string): void {
    // Target the window the prompt was originally sent to by id — NOT the
    // currently-focused window. In a multi-window session the user may have
    // switched projects between prompt-open and unload; resolving "active" here
    // would deliver the dismiss to the wrong window and strand the dialog.
    const target = webContents.fromId(webContentsId);
    if (target && !target.isDestroyed()) {
      try {
        target.send(CHANNELS.PLUGIN_UI_PROMPT_CANCEL, {
          pluginId,
          ...(promptId ? { promptId } : {}),
        });
      } catch {
        // best-effort
      }
    }
  }

  private sendRemoteCancel(endpoint: ClientEndpoint, pluginId: string, promptId?: string): void {
    if (endpoint.isClosed()) return;
    endpoint
      .request(
        PluginFrontendMethod.PROMPT_CANCEL,
        { pluginId, ...(promptId ? { promptId } : {}) },
        { timeoutMs: 10_000 }
      )
      .catch(() => {
        // Best-effort: a Shell that is gone has no dialog left to take down.
      });
  }

  /**
   * Tear down the response listener and resolve every pending prompt with its
   * cancel value. Invoked from `PluginService.dispose`. Never rejects (#9322).
   */
  dispose(): void {
    this.responseListenerCleanup?.();
    this.responseListenerCleanup = null;
    for (const pending of this.pending.values()) {
      try {
        pending.cleanup?.();
        pending.resolve(pending.cancelValue);
      } catch {
        // best-effort — one prompt's resolve must not strand the rest
      }
    }
    this.pending.clear();
    for (const parked of this.parked.values()) {
      try {
        parked.cleanup();
        parked.resolve(parked.cancelValue);
      } catch {
        // best-effort
      }
    }
    this.parked.clear();
    this.parkedSubscription?.();
    this.parkedSubscription = null;
  }
}
