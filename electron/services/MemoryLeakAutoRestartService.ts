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

export interface MemoryLeakAutoRestartDeps {
  onMetrics(listener: (metrics: TerminalResourceBatchPayload) => void): () => void;
  onExit(listener: (terminalId: string) => void): () => void;
  readPolicy(): { enabled: boolean; thresholdMb: number };
  /** The launch the terminal's samples belong to; a respawn under the same id starts a new one. */
  generationOf(terminalId: string): number | undefined;
  readTerminal(terminalId: string): Promise<MemoryLeakTerminalRead | null>;
  pickTarget(projectId: string): MemoryLeakRestartTarget;
  restartOnHost(projectId: string, terminalId: string, isCurrent: () => boolean): Promise<string>;
  now(): number;
}

/** How long a terminal still over the threshold waits before it is tried again. */
export const AUTO_RESTART_RETRY_MS = 60_000;

interface TerminalTrack {
  generation: number | undefined;
  samples: number;
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
 * the view, nor is an agent on the host while it has no room to relaunch it;
 * each is tried again once the retry interval passes. Warnings stay in every
 * view.
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
        track = { generation, samples: 0, lastAttemptAt: null, inFlight: false };
        this.tracks.set(terminalId, track);
      }
      track.samples++;

      if (track.samples < AUTO_RESTART_STARTUP_SAMPLES) continue;
      if (metric.memoryKb <= thresholdKb) continue;
      if (track.inFlight) continue;
      if (track.lastAttemptAt !== null && now - track.lastAttemptAt < AUTO_RESTART_RETRY_MS) {
        continue;
      }

      track.inFlight = true;
      track.lastAttemptAt = now;
      const settled = track;
      void this.attempt(terminalId, generation, policy.thresholdMb).finally(() => {
        settled.inFlight = false;
      });
    }
  }

  private async attempt(
    terminalId: string,
    generation: number | undefined,
    thresholdMb: number
  ): Promise<void> {
    try {
      const info = await this.deps.readTerminal(terminalId);
      if (this.disposed || !info || info.isExited === true || info.isTrashed === true) return;
      // A restart while the read was out replaced the process these samples
      // measured; its successor gets its own startup grace.
      if (this.deps.generationOf(terminalId) !== generation) return;
      const projectId = info.projectId;
      if (!projectId) return;
      if (info.agentState === "waiting") return;

      const isCurrent = () => !this.disposed && this.deps.generationOf(terminalId) === generation;
      const target = this.deps.pickTarget(projectId);
      switch (target.kind) {
        case "wait":
          return;
        case "view":
          target.deliver({ terminalId, thresholdMb }, isCurrent);
          return;
        case "host": {
          const outcome = await this.deps.restartOnHost(projectId, terminalId, isCurrent);
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
