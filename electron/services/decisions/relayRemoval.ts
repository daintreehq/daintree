import type { PtyIncarnationExit, PtyIncarnationLost } from "../PtyClient.js";
import type { SpawnResult } from "../../../shared/types/pty-host.js";
import type {
  DecisionsRelayRemoval,
  DecisionsRelayRemovalLocal,
} from "../../../shared/types/decisions.js";

/** The parts of `PtyClient` a removal follows. */
export interface RelayRemovalFactSource {
  on(event: "spawn-result", listener: (id: string, result: SpawnResult) => void): unknown;
  on(event: "incarnation-exit", listener: (fact: PtyIncarnationExit) => void): unknown;
  on(event: "incarnation-lost", listener: (fact: PtyIncarnationLost) => void): unknown;
  on(event: "terminal-lost", listener: (id: string) => void): unknown;
  on(event: "project-kill-requested", listener: (projectId: string) => void): unknown;
  off(event: "spawn-result", listener: (id: string, result: SpawnResult) => void): unknown;
  off(event: "incarnation-exit", listener: (fact: PtyIncarnationExit) => void): unknown;
  off(event: "incarnation-lost", listener: (fact: PtyIncarnationLost) => void): unknown;
  off(event: "terminal-lost", listener: (id: string) => void): unknown;
  off(event: "project-kill-requested", listener: (projectId: string) => void): unknown;
  getTerminalProjectId(id: string): string | null;
}

/** The identity the setting recorded when a removal started, as it is compared later. */
export interface RemovedRelayRecord {
  relayOrigin: string;
  installationId: string | null;
  deviceId: string | null;
}

export interface RelayRemovalsDeps {
  source: RelayRemovalFactSource;
  /**
   * Whether the spawn handler sent the removal itself under this id since the
   * last ask (see `relayRemovalLaunches.ts`); asking clears it.
   */
  takeLaunch(terminalId: string): boolean;
  /**
   * Forgets `record`, and with `deleteLocalHistory` this computer's decision
   * history too, only if the setting still records exactly that identity.
   */
  forget(
    record: RemovedRelayRecord,
    deleteLocalHistory: boolean
  ): Promise<DecisionsRelayRemovalLocal>;
  isShuttingDown(): boolean;
  /** Something a removal shows changed. */
  onChanged(): void;
  logWarn?: (message: string) => void;
}

/** Ended removals kept for their panes to show; older ones are dropped. */
export const KEPT_RELAY_REMOVALS = 8;

/**
 * How long a removal waits for its terminal to start. The pane opens as soon
 * as Settings has closed; one that never did (refused at the panel limit, say)
 * ends the wait, so nothing waits on it for the rest of the run.
 */
export const RELAY_REMOVAL_LAUNCH_WINDOW_MS = 2 * 60_000;

interface Attempt {
  view: DecisionsRelayRemoval;
  record: RemovedRelayRecord | null;
  /** The incarnation the removal runs in, from its spawn answer or its exit, whichever came first. */
  spawnedAt: number | null;
  launchWindow: ReturnType<typeof setTimeout> | null;
}

/**
 * The guided relay removals of this run (#16202). Each runs `decisions remove`
 * as its terminal's own process, so the PTY's status is the CLI's, and only
 * the incarnation the spawn handler launched the removal in, ending by itself
 * with status 0, forgets the relay. Anything else (a non-zero status, a kill,
 * restart or project close Daintree made, a signal, a lost pty-host, a spawn
 * that never ran the removal, quitting) keeps the record: the CLI's own report
 * in the pane says what is left in Cloudflare. Kept in memory: after a restart
 * nothing here says how an earlier removal went, so nothing is forgotten.
 */
export class RelayRemovals {
  private readonly attempts = new Map<string, Attempt>();
  private following = false;
  private disposed = false;

  private readonly onSpawnResult = (id: string, result: SpawnResult) => {
    const attempt = this.running(id);
    if (!attempt) return;
    if (attempt.spawnedAt === null) {
      // The first spawn under the id must be the removal's own launch.
      const spawnedAt = result.success ? result.spawnedAt : undefined;
      if (!this.deps.takeLaunch(id) || typeof spawnedAt !== "number") {
        this.settle(attempt, { state: "interrupted" });
        return;
      }
      this.claim(attempt, spawnedAt);
      return;
    }
    // A second incarnation is a restart, which kills the removal's for a plain
    // shell; a refused one means another launch was in flight under the id, so
    // which of the two is running can't be told.
    if (!result.success || result.spawnedAt !== attempt.spawnedAt) {
      this.settle(attempt, { state: "interrupted" });
    }
  };

  private readonly onExit = (fact: PtyIncarnationExit) => {
    const attempt = this.running(fact.terminalId);
    if (!attempt) return;
    const spawnedAt = fact.spawnedAt;
    if (typeof spawnedAt !== "number") {
      // An exit nothing ties to the removal's incarnation can't confirm it.
      this.settle(attempt, { state: "interrupted" });
      return;
    }
    if (attempt.spawnedAt === null) {
      // An exit can come before its spawn answer; it is the launch's only if one was sent.
      if (!this.deps.takeLaunch(fact.terminalId)) {
        this.settle(attempt, { state: "interrupted" });
        return;
      }
      this.claim(attempt, spawnedAt);
    } else if (attempt.spawnedAt !== spawnedAt) {
      return;
    }
    if (fact.stopped || (fact.signal !== null && fact.signal !== 0) || this.deps.isShuttingDown()) {
      this.settle(attempt, { state: "interrupted" });
      return;
    }
    if (fact.exitCode !== 0) {
      this.settle(attempt, { state: "exited", exitCode: fact.exitCode, local: "kept" });
      return;
    }
    const record = attempt.record;
    if (record === null) {
      this.settle(attempt, { state: "exited", exitCode: 0, local: "none" });
      return;
    }
    this.settle(attempt, { state: "exited", exitCode: 0, local: "pending" });
    const deleteLocalHistory = attempt.view.deleteLocalHistory;
    void this.deps
      .forget(record, deleteLocalHistory)
      .catch((error: unknown): DecisionsRelayRemovalLocal => {
        this.deps.logWarn?.(`[Decisions] Couldn't forget the removed relay: ${String(error)}`);
        return "failed";
      })
      .then((local) => {
        if (this.disposed) return;
        attempt.view = { ...attempt.view, outcome: { state: "exited", exitCode: 0, local } };
        this.deps.onChanged();
      });
  };

  private readonly onIncarnationLost = (fact: PtyIncarnationLost) => this.lost(fact.terminalId);
  private readonly onTerminalLost = (id: string) => this.lost(id);

  /**
   * A project close, Sleep or restart kills its terminals without a per-pane
   * kill, so whatever status those exits carry is the teardown's.
   */
  private readonly onProjectKillRequested = (projectId: string) => {
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.view.outcome.state !== "running") continue;
      if (this.deps.source.getTerminalProjectId(attempt.view.terminalId) === projectId) {
        this.settle(attempt, { state: "interrupted" });
      }
    }
  };

  constructor(private readonly deps: RelayRemovalsDeps) {}

  /**
   * Watches a removal from before its terminal is spawned, so no fact about
   * it can come first. `record` is the identity to forget once it exits 0,
   * null when the relay isn't the one recorded here.
   */
  start(
    terminalId: string,
    origin: string,
    record: RemovedRelayRecord | null,
    deleteLocalHistory: boolean
  ): DecisionsRelayRemoval {
    if (this.disposed) throw new Error("Decisions has stopped for this run");
    if (this.attempts.has(terminalId)) {
      throw new Error("A relay removal is already watched under this terminal id");
    }
    this.follow();
    const view: DecisionsRelayRemoval = {
      terminalId,
      origin,
      recorded: record !== null,
      // Nothing ties another relay's removal to this computer's history.
      deleteLocalHistory: record !== null && deleteLocalHistory,
      outcome: { state: "running" },
    };
    const attempt: Attempt = { view, record, spawnedAt: null, launchWindow: null };
    attempt.launchWindow = setTimeout(() => {
      attempt.launchWindow = null;
      if (attempt.spawnedAt === null && this.running(terminalId) === attempt) {
        this.settle(attempt, { state: "interrupted" });
      }
    }, RELAY_REMOVAL_LAUNCH_WINDOW_MS);
    attempt.launchWindow.unref?.();
    this.attempts.set(terminalId, attempt);
    this.prune();
    this.deps.onChanged();
    return view;
  }

  /** Every removal of this run, oldest first. */
  list(): DecisionsRelayRemoval[] {
    return [...this.attempts.values()].map((attempt) => attempt.view);
  }

  dispose(): void {
    this.disposed = true;
    for (const attempt of this.attempts.values()) this.endLaunchWindow(attempt);
    if (!this.following) return;
    this.following = false;
    const { source } = this.deps;
    source.off("spawn-result", this.onSpawnResult);
    source.off("incarnation-exit", this.onExit);
    source.off("incarnation-lost", this.onIncarnationLost);
    source.off("terminal-lost", this.onTerminalLost);
    source.off("project-kill-requested", this.onProjectKillRequested);
  }

  private follow(): void {
    if (this.following) return;
    this.following = true;
    const { source } = this.deps;
    source.on("spawn-result", this.onSpawnResult);
    source.on("incarnation-exit", this.onExit);
    source.on("incarnation-lost", this.onIncarnationLost);
    source.on("terminal-lost", this.onTerminalLost);
    source.on("project-kill-requested", this.onProjectKillRequested);
  }

  private running(terminalId: string): Attempt | null {
    if (this.disposed) return null;
    const attempt = this.attempts.get(terminalId);
    return attempt?.view.outcome.state === "running" ? attempt : null;
  }

  private claim(attempt: Attempt, spawnedAt: number): void {
    attempt.spawnedAt = spawnedAt;
    this.endLaunchWindow(attempt);
  }

  private endLaunchWindow(attempt: Attempt): void {
    if (attempt.launchWindow === null) return;
    clearTimeout(attempt.launchWindow);
    attempt.launchWindow = null;
  }

  private lost(terminalId: string): void {
    const attempt = this.running(terminalId);
    if (attempt) this.settle(attempt, { state: "interrupted" });
  }

  private settle(attempt: Attempt, outcome: DecisionsRelayRemoval["outcome"]): void {
    attempt.view = { ...attempt.view, outcome };
    this.endLaunchWindow(attempt);
    // A launch sent after the removal stopped waiting for it is no one's to take.
    this.deps.takeLaunch(attempt.view.terminalId);
    this.prune();
    this.deps.onChanged();
  }

  /** Drops the oldest ended removals past the bound; a running one is always kept. */
  private prune(): void {
    let excess = this.attempts.size - KEPT_RELAY_REMOVALS;
    for (const [id, attempt] of this.attempts) {
      if (excess <= 0) return;
      if (attempt.view.outcome.state === "running") continue;
      this.attempts.delete(id);
      excess -= 1;
    }
  }
}
