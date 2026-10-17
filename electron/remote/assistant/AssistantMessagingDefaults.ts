import type { RunningLane, RunningLaneSession } from "../../services/HelpSessionService.js";
import type { AssistantMessagingPolicy, MessagingShell } from "./AssistantMessagingPolicy.js";

export interface AssistantMessagingDefaultsDeps {
  policy: Pick<AssistantMessagingPolicy, "enrollByDefault" | "isSupported">;
  listRunningLanes(): RunningLane[];
  getRunningLaneSession(projectId: string, slot: number): RunningLaneSession | null;
  /**
   * The Shell whose view a run is pinned to: this machine for one of its own
   * project views, a remote Shell for an open view of its link session, or
   * null when it's neither or the view now shows another project.
   */
  viewShell(running: RunningLaneSession, projectId: string): MessagingShell | null;
  /** This machine's saved "accept messages from other machines by default", read at each pass. */
  acceptsByDefault(): boolean;
}

/**
 * Applies this machine's saved default to its running assistants, so nobody
 * has to turn each run on: every run a remote Shell's view runs is offered to
 * that Shell, through `enrollByDefault`, which refuses whatever a person or
 * another Shell already decided, so what the run starts on its own goes to
 * that Shell. This machine's own runs need nothing (#13468). A run that isn't
 * there yet waits for the next pass; nothing here starts one. Passes are
 * coalesced to one per tick.
 */
export class AssistantMessagingDefaults {
  private queued = false;
  private disposed = false;

  constructor(private readonly deps: AssistantMessagingDefaultsDeps) {}

  schedule(): void {
    if (this.queued || this.disposed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      try {
        this.apply();
      } catch (err) {
        console.error("[AssistantMessagingDefaults] Applying the saved default failed:", err);
      }
    });
  }

  apply(): void {
    if (this.disposed || !this.deps.policy.isSupported() || !this.deps.acceptsByDefault()) return;
    for (const lane of this.deps.listRunningLanes()) {
      if (lane.attached === false) continue;
      const running = this.deps.getRunningLaneSession(lane.projectId, lane.slot);
      if (!running) continue;
      const shell = this.deps.viewShell(running, lane.projectId);
      if (shell === null || shell.kind === "local") continue;
      this.deps.policy.enrollByDefault({ projectId: lane.projectId, slot: lane.slot }, shell);
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
