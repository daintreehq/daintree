import type { RemoteProjectSnapshot } from "../../../shared/types/remote/index.js";
import type { RemoteSession } from "./RemoteSessionRegistry.js";

const DETAIL_POLL_MS = 5_000;

export interface RemoteDetailSnapshotSource {
  snapshot(projectId: string): Promise<RemoteProjectSnapshot>;
}

export interface RemoteReadySessionSource {
  readySessions(): RemoteSession[];
}

export class RemoteProjectDetailSubscriptionService {
  private readonly selections = new Map<
    string,
    { projectId: string; revision: number; releaseView: () => void }
  >();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly details: RemoteDetailSnapshotSource,
    private readonly sessions: RemoteReadySessionSource,
    private readonly sendUpdate: (
      session: RemoteSession,
      update: { projectId: string; baseRevision: number; revision: number }
    ) => void
  ) {}

  select(
    sessionId: string,
    projectId: string,
    revision: number,
    releaseView: () => void = () => {}
  ): void {
    this.releaseSelection(sessionId);
    this.selections.set(sessionId, { projectId, revision, releaseView });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollNow(), DETAIL_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const sessionId of [...this.selections.keys()]) this.releaseSelection(sessionId);
  }

  async pollNow(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const ready = new Map(this.sessions.readySessions().map((session) => [session.id, session]));
      for (const [sessionId, selection] of this.selections) {
        const session = ready.get(sessionId);
        if (!session || !session.capabilities.includes("observe-projects")) {
          this.releaseSelection(sessionId);
          continue;
        }
        try {
          const snapshot = await this.details.snapshot(selection.projectId);
          if (snapshot.revision === selection.revision) continue;
          this.sendUpdate(session, {
            projectId: selection.projectId,
            baseRevision: selection.revision,
            revision: snapshot.revision,
          });
          this.selections.set(sessionId, {
            ...selection,
            revision: snapshot.revision,
          });
        } catch {
          // Keep the last rendered state and selection. A later successful read
          // will produce a new degraded or recovered revision.
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private releaseSelection(sessionId: string): void {
    const selection = this.selections.get(sessionId);
    if (!selection) return;
    this.selections.delete(sessionId);
    selection.releaseView();
  }
}
