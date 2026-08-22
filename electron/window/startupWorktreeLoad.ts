import { CHANNELS } from "../ipc/channels.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

/**
 * Startup-only worktree-load reporting for `setupWindowServices` (#8796, #11818).
 *
 * Boot is the one worktree-load path that has to defer its status send until
 * the renderer has finished loading, so it does not share the send site used by
 * project switch, relocation, or retry — those run against a renderer that is
 * already listening. It is extracted here so both the failure branches and the
 * tests exercise the same code instead of a copy of it.
 *
 * The Electron surfaces are declared structurally so this module (and its
 * suite) never pulls in the Electron runtime.
 */

/** The `WebContents` surface the startup status send touches. */
export interface StartupStatusTarget {
  isDestroyed(): boolean;
  isLoadingMainFrame(): boolean;
  once(event: "did-finish-load", listener: () => void): unknown;
  send(channel: string, payload: unknown): void;
}

/**
 * Prefer the project view's webContents, falling through to the window's app
 * webContents when it is already destroyed — a destroyed target would swallow
 * the message and leave the sidebar hanging. A destroyed fallback yields no
 * target at all rather than one that cannot receive anything.
 */
export function selectStatusTarget<T extends { isDestroyed(): boolean }>(
  preferred: T | null | undefined,
  fallback: T | null | undefined
): T | null {
  if (preferred && !preferred.isDestroyed()) return preferred;
  if (fallback && !fallback.isDestroyed()) return fallback;
  return null;
}

/**
 * Push a worktree-load failure to the renderer so the sidebar shows
 * `WorktreeLoadErrorBanner` and its Retry action instead of an endless loading
 * skeleton.
 *
 * Gates the deferral on `isLoadingMainFrame()`, not `isLoading()`: the latter
 * is true while *any* frame is loading (an HTML preview iframe, say), but
 * `did-finish-load` only fires for the main frame, so a bare `isLoading()`
 * parks the send on an event that never arrives. Same reasoning as the
 * Dock-drop send in `menu.ts`.
 *
 * Returns whether a send was performed or scheduled.
 */
export function sendStartupWorktreeLoadFailure(
  target: StartupStatusTarget | null,
  projectId: string | undefined,
  error: unknown
): boolean {
  if (!target || !projectId) return false;

  const worktreeLoadError = formatErrorMessage(error, "Failed to load worktrees");
  const sendLoadStatus = (): void => {
    try {
      if (target.isDestroyed()) return;
      target.send(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, { projectId, worktreeLoadError });
    } catch {
      // The window went away between the liveness check and the send. Nothing
      // is left to notify, and throwing here would abort the rest of startup.
    }
  };

  try {
    if (target.isDestroyed()) return false;
    if (target.isLoadingMainFrame()) {
      target.once("did-finish-load", sendLoadStatus);
    } else {
      sendLoadStatus();
    }
    return true;
  } catch {
    return false;
  }
}

/** Why a startup worktree port never reached the renderer. */
export type StartupPortFailureReason =
  "no-renderer-target" | "no-host" | "no-broker" | "broker-rejected";

export type StartupPortAttachResult =
  { ok: true } | { ok: false; reason: StartupPortFailureReason };

/**
 * Wire the renderer to the workspace host for a project that has just loaded.
 *
 * `loadProject()` resolving is not enough: if the direct-port target is gone,
 * the host is missing, the broker was never constructed, or `brokerPort()`
 * rejects the target, the renderer ends up with no worktree port — which it
 * cannot tell apart from a load that threw. Each of those is reported as a
 * failure rather than silently skipped (#11818).
 */
export function attachStartupWorktreePort<THost, TTarget extends { isDestroyed(): boolean }>(args: {
  target: TTarget | null | undefined;
  // Resolved lazily, in the same order the pre-extraction code used: nothing is
  // looked up until the target has been validated and the direct port attached.
  getHost: () => THost | null | undefined;
  attachDirectPort: (target: TTarget) => void;
  getBrokerPort: () => ((host: THost, target: TTarget) => boolean) | null | undefined;
}): StartupPortAttachResult {
  const { target, getHost, attachDirectPort, getBrokerPort } = args;

  if (!target || target.isDestroyed()) return { ok: false, reason: "no-renderer-target" };

  attachDirectPort(target);

  const host = getHost();
  if (!host) return { ok: false, reason: "no-host" };

  const brokerPort = getBrokerPort();
  if (!brokerPort) return { ok: false, reason: "no-broker" };
  if (!brokerPort(host, target)) return { ok: false, reason: "broker-rejected" };

  return { ok: true };
}

const STARTUP_PORT_FAILURE_MESSAGES: Record<StartupPortFailureReason, string> = {
  "no-renderer-target": "The project window closed before its worktree connection was ready.",
  "no-host": "The workspace service didn't start a host for this project.",
  "no-broker": "The worktree connection broker wasn't available.",
  "broker-rejected": "The worktree connection couldn't be opened.",
};

/** Reader-facing text for a port that never reached the renderer. */
export function describeStartupPortFailure(reason: StartupPortFailureReason): string {
  return STARTUP_PORT_FAILURE_MESSAGES[reason];
}

/** Reader-facing text for a boot that had no workspace client at all. */
export const STARTUP_NO_WORKSPACE_CLIENT_MESSAGE =
  "The workspace service wasn't available when this window started.";

/** How a window's startup worktree load ended. */
export type StartupWorktreeLoadOutcome =
  | { status: "loaded" }
  | { status: "no-client" }
  | { status: "load-failed"; error: unknown }
  | { status: "attach-failed"; error: unknown }
  | { status: "port-failed"; reason: StartupPortFailureReason };

/**
 * Run a window's startup worktree load and report every outcome that leaves the
 * renderer without a port.
 *
 * The reporting lives in here rather than at the call site because the whole
 * defect in #11818 was a branch that silently did nothing: keeping the decision
 * flow and its reporting together means the tests cover the thing that broke,
 * instead of a copy of it.
 *
 * `loadProject` is null when no workspace client was available — that is the
 * case that used to be skipped without a trace.
 */
export async function runStartupWorktreeLoad<
  THost,
  TTarget extends { isDestroyed(): boolean },
>(args: {
  loadProject: (() => Promise<void>) | null;
  getPortTarget: () => TTarget | null | undefined;
  getHost: () => THost | null | undefined;
  attachDirectPort: (target: TTarget) => void;
  // Resolved after the load rather than before it, so a broker constructed
  // during init is still picked up, and a genuinely absent one stays
  // distinguishable from one that rejected the target.
  getBrokerPort: () => ((host: THost, target: TTarget) => boolean) | null | undefined;
  report: (error: unknown) => void;
}): Promise<StartupWorktreeLoadOutcome> {
  const { loadProject, getPortTarget, getHost, attachDirectPort, getBrokerPort, report } = args;

  if (!loadProject) {
    report(new Error(STARTUP_NO_WORKSPACE_CLIENT_MESSAGE));
    return { status: "no-client" };
  }

  try {
    await loadProject();
  } catch (error) {
    report(error);
    return { status: "load-failed", error };
  }

  // Attachment stays inside an error boundary alongside the load: before this
  // flow was extracted, one `try` covered the load, the direct attach and the
  // brokering together. A synchronous throw escaping here would reject window
  // startup itself rather than surfacing as a worktree failure.
  let attachResult: StartupPortAttachResult;
  try {
    attachResult = attachStartupWorktreePort({
      target: getPortTarget(),
      getHost,
      attachDirectPort,
      getBrokerPort,
    });
  } catch (error) {
    report(error);
    return { status: "attach-failed", error };
  }
  if (attachResult.ok) return { status: "loaded" };

  // A resolved loadProject() is not enough — with no port the renderer sits in
  // exactly the state a thrown load leaves it in, so it gets the same banner.
  report(new Error(describeStartupPortFailure(attachResult.reason)));
  return { status: "port-failed", reason: attachResult.reason };
}
