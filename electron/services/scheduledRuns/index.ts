import { CHANNELS } from "../../ipc/channels.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { getActiveShutdown } from "../../lifecycle/shutdownCoordinator.js";
import { getWebContentsForProject } from "../../window/webContentsRegistry.js";
import { events } from "../events.js";
import type { PtyIncarnationExit, PtyIncarnationLost } from "../PtyClient.js";
import type { SpawnResult } from "../../../shared/types/pty-host.js";
import type { ScheduledRun } from "../../../shared/types/scheduledRuns.js";
import type { ScheduledRunRecorder, ScheduledRunsChange } from "./ScheduledRunRecorder.js";
import { scheduledRunAttention } from "./scheduledRunAttention.js";

/** The parts of `PtyClient` the run history follows. */
export interface ScheduledRunFactSource {
  on(event: "spawn-result", listener: (id: string, result: SpawnResult) => void): unknown;
  on(event: "incarnation-exit", listener: (fact: PtyIncarnationExit) => void): unknown;
  on(event: "incarnation-lost", listener: (fact: PtyIncarnationLost) => void): unknown;
  off(event: "spawn-result", listener: (id: string, result: SpawnResult) => void): unknown;
  off(event: "incarnation-exit", listener: (fact: PtyIncarnationExit) => void): unknown;
  off(event: "incarnation-lost", listener: (fact: PtyIncarnationLost) => void): unknown;
}

let recorder: ScheduledRunRecorder | null = null;
let creating: Promise<ScheduledRunRecorder | null> | null = null;

/**
 * The run history, opened on first use. Opening settles every run an earlier
 * lifetime left open as interrupted, so it happens before any run of this
 * lifetime can be registered. Null when the database can't be opened, or once
 * Daintree is quitting with the history never opened.
 */
export function getScheduledRunRecorder(): Promise<ScheduledRunRecorder | null> {
  if (recorder) return Promise.resolve(recorder);
  if (getActiveShutdown() !== null) return Promise.resolve(null);
  creating ??= (async () => {
    const [
      { getSharedDb, getSharedSqlite },
      { ScheduledRunStore },
      { ScheduledRunRecorder },
      keepAwake,
    ] = await Promise.all([
      import("../persistence/db.js"),
      import("./ScheduledRunStore.js"),
      import("./ScheduledRunRecorder.js"),
      // Keep-awake failing to load must not keep the history closed.
      import("../PowerSaveBlockerService.js").catch((error: unknown) => {
        console.warn("[ScheduledRuns] Keep-awake couldn't load:", error);
        return null;
      }),
    ]);
    getSharedDb();
    const sqlite = getSharedSqlite();
    if (!sqlite) {
      creating = null;
      return null;
    }
    const created = new ScheduledRunRecorder({
      store: new ScheduledRunStore(sqlite),
      isShuttingDown: () => getActiveShutdown() !== null,
      onChanged: pushScheduledRunsChanged,
      onRunStarted: (payload) => {
        // The keep-awake hold (#15981) is taken on this event, so its service
        // is listening before it fires, whichever boot path launched the run.
        // It refuses only once shutdown has disposed it.
        try {
          keepAwake?.getPowerSaveBlockerService();
        } catch (error) {
          console.warn("[ScheduledRuns] Keep-awake is unavailable for a run:", error);
        }
        events.emit("scheduled-run:started", payload);
      },
      onRunEnded: (payload) => events.emit("scheduled-run:ended", payload),
      onRunSettled: notifyIfNeeded,
      onRunsDeleted: (payload) => events.emit("scheduled-runs:deleted", payload),
    });
    created.reconcileInterrupted();
    recorder = created;
    return created;
  })().catch((error: unknown) => {
    console.warn("[ScheduledRuns] Couldn't open the run history:", error);
    creating = null;
    return null;
  });
  return creating;
}

type ScheduledRunNotifierModule = typeof import("./scheduledRunNotifierLive.js");
let notifierModule: Promise<ScheduledRunNotifierModule> | null = null;

/**
 * A run that settled needing a person gets a native notification (#15988).
 * The delivery is loaded only then, so runs that go fine cost nothing, and
 * it never holds up or undoes the recorded settlement.
 */
function notifyIfNeeded(run: ScheduledRun): void {
  const attention = scheduledRunAttention(run);
  if (!attention) return;
  notifierModule ??= import("./scheduledRunNotifierLive.js").catch((error: unknown) => {
    notifierModule = null;
    throw error;
  });
  void notifierModule
    .then(({ notifyScheduledRunAttention }) => notifyScheduledRunAttention(run, attention))
    .catch((error: unknown) => {
      console.warn(`[ScheduledRuns] Couldn't notify about run ${run.id}:`, error);
    });
}

/**
 * The run history if it's open, without opening it. Null means no run of this
 * lifetime exists yet, so nothing can be open: a sleep policy reads this
 * rather than opening the database to find that out.
 */
export function peekScheduledRunRecorder(): ScheduledRunRecorder | null {
  return recorder;
}

/**
 * Follows the PTY and session facts a run records, for the life of the
 * process. Until the history is opened no run of this lifetime exists, so a
 * fact that arrives before then has no run to land on.
 */
export function startScheduledRunFacts(source: ScheduledRunFactSource): () => void {
  const follow =
    <A extends unknown[]>(handle: (target: ScheduledRunRecorder, ...args: A) => void) =>
    (...args: A): void => {
      const target = recorder;
      if (!target) return;
      try {
        handle(target, ...args);
      } catch (error) {
        console.warn("[ScheduledRuns] Couldn't record a terminal fact:", error);
      }
    };
  const onSpawnResult = follow((target, id: string, result: SpawnResult) =>
    target.handleSpawnResult(id, result)
  );
  const onExit = follow((target, fact: PtyIncarnationExit) => target.handleExit(fact));
  const onLost = follow((target, fact: PtyIncarnationLost) => target.handleIncarnationLost(fact));
  source.on("spawn-result", onSpawnResult);
  source.on("incarnation-exit", onExit);
  source.on("incarnation-lost", onLost);
  const offCaptured = events.on(
    "agent-session:captured",
    follow((target, payload) => target.handleSessionCaptured(payload))
  );
  const offHandback = events.on(
    "agent:run-handback-observed",
    follow((target, payload) => target.handleHandback(payload))
  );
  return () => {
    source.off("spawn-result", onSpawnResult);
    source.off("incarnation-exit", onExit);
    source.off("incarnation-lost", onLost);
    offCaptured();
    offHandback();
  };
}

/**
 * Tells the views of one project that its run history changed; they read it
 * again. Only views bound to the project: run history is per-project data.
 */
function pushScheduledRunsChanged(change: ScheduledRunsChange): void {
  const event = {
    name: "scheduled-runs:changed",
    payload: { projectId: change.projectId, scheduleIds: [...change.scheduleIds] },
  };
  for (const wc of getWebContentsForProject(change.projectId)) {
    try {
      wc.send(CHANNELS.EVENTS_PUSH, event);
    } catch {
      // Silently ignore send failures during window initialization/disposal.
    }
  }
  const registry = getEndpointRegistry();
  if (!registry.hasRemote()) return;
  for (const endpoint of registry.getForProject(change.projectId)) {
    if (endpoint.kind !== "remote-view" || endpoint.isClosed()) continue;
    try {
      endpoint.send({ type: "event", channel: CHANNELS.EVENTS_PUSH, args: [event] });
    } catch {
      // A closing link must not break delivery to the remaining endpoints.
    }
  }
}

export function _resetScheduledRunRecorderForTest(): void {
  recorder = null;
  creating = null;
}
