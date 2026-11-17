import { AUTO_RESTART_STARTUP_SAMPLES } from "../../shared/config/memoryLeakPolicy.js";
import type { TerminalResourceBatchPayload } from "../../shared/types/pty-host.js";
import type { IpcEventBusMap } from "../../shared/types/ipc/maps.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

export type MemoryLeakRestartRequest = IpcEventBusMap["terminal:memory-leak-restart-requested"];

/**
 * Who restarts a terminal of a project: the one view that drives it, nobody
 * yet while its driver is away, or the host itself when no view is attached.
 */
export type MemoryLeakRestartTarget =
  | {
      kind: "view";
      /** `isCurrent` says whether the decision still holds when the view can take it. */
      deliver: (request: MemoryLeakRestartRequest, isCurrent: () => boolean) => void;
    }
  | { kind: "wait" }
  | { kind: "host" };

export interface MemoryLeakTerminalRead {
  projectId?: string | null;
  agentState?: string;
  isExited?: boolean;
  isTrashed?: boolean;
}

/**
 * What a restart on the host rechecks. A restart already under way finishes its
 * respawn even when the decision no longer holds: stopping between the kill and
 * the respawn would leave the terminal dead, so `stillWanted` is read only up to
 * the first change, and `isCurrent` throughout.
 */
export interface MemoryLeakHostRestartGuards {
  /** Whether the terminal still runs the launch the decision was taken on. */
  isCurrent: () => boolean;
  /** Whether the decision still holds against the policy and the newest sample. */
  stillWanted: () => boolean;
}

export interface MemoryLeakAutoRestartDeps {
  onMetrics(listener: (metrics: TerminalResourceBatchPayload) => void): () => void;
  onExit(listener: (terminalId: string) => void): () => void;
  readPolicy(): { enabled: boolean; thresholdMb: number };
  /** The launch the terminal's samples belong to; a respawn under the same id starts a new one. */
  generationOf(terminalId: string): number | undefined;
  readTerminal(terminalId: string): Promise<MemoryLeakTerminalRead | null>;
  pickTarget(projectId: string): MemoryLeakRestartTarget;
  restartOnHost(
    projectId: string,
    terminalId: string,
    guards: MemoryLeakHostRestartGuards
  ): Promise<string>;
  now(): number;
}

/** How long a terminal still over the threshold waits before it is tried again. */
export const AUTO_RESTART_RETRY_MS = 60_000;

interface TerminalTrack {
  generation: number | undefined;
  samples: number;
  /** The newest sample, which a decision still waiting to run is held against. */
  memoryKb: number;
  /** The decision waiting to run, until a newer one replaces it or it is dropped. */
  decision: object | null;
  lastAttemptAt: number | null;
  inFlight: boolean;
}

/**
 * The host's memory-leak auto-restart (#14703). The threshold is a policy about
 * the host's own processes, so it is decided here, once per terminal, whether
 * or not any view has the project open: a view used to decide it for itself,
 * which left a windowless host's leaks running and let two views of one
 * project both restart the same terminal.
 *
 * The restart runs once: in the project's driving view when one is attached,
 * where it is the same restart the user's own Restart runs, or on the host
 * when none is. A terminal waiting for input is never restarted, here or in
 * the view; it is tried again once the retry interval passes. Warnings stay in
 * every view.
 */
export class MemoryLeakAutoRestartService {
  private readonly tracks = new Map<string, TerminalTrack>();
  private readonly disposers: Array<() => void>;
  private disposed = false;

  constructor(private readonly deps: MemoryLeakAutoRestartDeps) {
    this.disposers = [
      deps.onMetrics((metrics) => this.handleBatch(metrics)),
      deps.onExit((terminalId) => this.tracks.delete(terminalId)),
    ];
  }

  /**
   * The policy was written. Every decision it no longer backs is dropped now
   * rather than at its next check, which might find the change already undone:
   * a policy turned off and on, or a threshold raised and lowered again, before
   * a pending lookup or thaw settles. A policy that can't be read drops them
   * all, without failing the settings write that called this.
   */
  policyChanged(): void {
    if (this.disposed) return;
    try {
      const policy = this.deps.readPolicy();
      if (policy.enabled) {
        const thresholdKb = policy.thresholdMb * 1024;
        for (const track of this.tracks.values()) {
          if (track.memoryKb <= thresholdKb) track.decision = null;
        }
        return;
      }
    } catch (err) {
      console.warn(
        "[MemoryLeak] Dropped pending auto-restarts: policy unreadable:",
        formatErrorMessage(err, "unknown")
      );
    }
    this.tracks.clear();
  }

  private handleBatch(metrics: TerminalResourceBatchPayload): void {
    if (this.disposed) return;
    const policy = this.deps.readPolicy();
    if (!policy.enabled) {
      this.tracks.clear();
      return;
    }
    const thresholdKb = policy.thresholdMb * 1024;
    const now = this.deps.now();

    // A batch is one shard's terminals, not the host's: a terminal it leaves
    // out is not gone, so tracks are dropped on exit rather than by absence.
    for (const [terminalId, metric] of Object.entries(metrics)) {
      const generation = this.deps.generationOf(terminalId);
      let track = this.tracks.get(terminalId);
      if (!track || track.generation !== generation) {
        track = {
          generation,
          samples: 0,
          memoryKb: 0,
          decision: null,
          lastAttemptAt: null,
          inFlight: false,
        };
        this.tracks.set(terminalId, track);
      }
      track.samples++;
      track.memoryKb = metric.memoryKb;

      if (metric.memoryKb <= thresholdKb) {
        // A decision still waiting to run is dropped for good, even if a later
        // sample climbs back over: that one waits out the retry interval.
        track.decision = null;
        continue;
      }
      if (track.samples < AUTO_RESTART_STARTUP_SAMPLES) continue;
      if (track.inFlight) continue;
      if (track.lastAttemptAt !== null && now - track.lastAttemptAt < AUTO_RESTART_RETRY_MS) {
        continue;
      }

      track.inFlight = true;
      track.lastAttemptAt = now;
      const decision = {};
      track.decision = decision;
      const settled = track;
      void this.attempt(terminalId, track, decision, policy.thresholdMb).finally(() => {
        settled.inFlight = false;
      });
    }
  }

  /**
   * Whether `decision` still holds. The policy and the samples move on while it
   * waits for its lookup and its delivery: the policy turned off (which also
   * forgets every track, so turning it on again doesn't revive it), a threshold
   * raised past the newest sample, or a newer sample back under it drops it. The
   * policy is read here rather than left to the next batch, which never comes
   * once resource monitoring is off. Once dropped, it stays dropped, and a
   * policy that can't be read drops it too: a deferred send calls this outside
   * any handler.
   */
  private stillWanted(terminalId: string, track: TerminalTrack, decision: object): boolean {
    if (this.tracks.get(terminalId) !== track || track.decision !== decision) return false;
    try {
      const policy = this.deps.readPolicy();
      if (policy.enabled && track.memoryKb > policy.thresholdMb * 1024) return true;
    } catch (err) {
      console.warn(
        `[MemoryLeak] Dropped the auto-restart of terminal ${terminalId.slice(0, 8)}: policy unreadable:`,
        formatErrorMessage(err, "unknown")
      );
    }
    track.decision = null;
    return false;
  }

  private async attempt(
    terminalId: string,
    track: TerminalTrack,
    decision: object,
    thresholdMb: number
  ): Promise<void> {
    try {
      const info = await this.deps.readTerminal(terminalId);
      // A restart while the read was out replaced the process these samples
      // measured; its successor gets its own startup grace.
      const isCurrent = () =>
        !this.disposed && this.deps.generationOf(terminalId) === track.generation;
      const stillWanted = () => this.stillWanted(terminalId, track, decision);
      if (!isCurrent() || !stillWanted()) return;
      if (!info || info.isExited === true || info.isTrashed === true) return;
      const projectId = info.projectId;
      if (!projectId) return;
      if (info.agentState === "waiting") return;

      const target = this.deps.pickTarget(projectId);
      switch (target.kind) {
        case "wait":
          return;
        case "view":
          // The view takes the restart when it is sent, so the decision has to
          // hold until then, past a thaw that defers the send.
          target.deliver({ terminalId, thresholdMb }, () => isCurrent() && stillWanted());
          return;
        case "host": {
          const outcome = await this.deps.restartOnHost(projectId, terminalId, {
            isCurrent,
            stillWanted,
          });
          if (outcome === "restarted") {
            console.log(
              `[MemoryLeak] Auto-restarted terminal ${terminalId.slice(0, 8)}: RSS exceeded ${thresholdMb} MB`
            );
          }
          return;
        }
      }
    } catch (err) {
      console.warn(
        `[MemoryLeak] Auto-restart of terminal ${terminalId.slice(0, 8)} failed:`,
        formatErrorMessage(err, "unknown")
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.tracks.clear();
  }
}

let active: MemoryLeakAutoRestartService | null = null;

export function getActiveMemoryLeakAutoRestart(): MemoryLeakAutoRestartService | null {
  return active;
}

export function setActiveMemoryLeakAutoRestart(next: MemoryLeakAutoRestartService | null): void {
  active = next;
}

export function disposeMemoryLeakAutoRestart(): void {
  active?.dispose();
  active = null;
}
