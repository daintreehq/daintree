import { projectRemoteAppearance, resolveAppTheme } from "../../../shared/theme/index.js";
import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteAppearanceSnapshot,
  type RemoteEnvelope,
} from "../../../shared/types/remote/index.js";
import type { AppColorScheme, AppThemeConfig } from "../../../shared/types/appTheme.js";
import type { RemoteSession, RemoteSessionRegistry } from "./RemoteSessionRegistry.js";

export interface RemoteAppearanceConfigSource {
  get(): Partial<AppThemeConfig>;
  subscribe(listener: () => void): () => void;
}

export interface RemoteAppearanceSender {
  sendApplicationEnvelope(connectionId: string, envelope: RemoteEnvelope): void;
}

export class RemoteAppearanceSyncService {
  private snapshot: RemoteAppearanceSnapshot;
  private cleanup: (() => void) | null = null;
  private warningIssued = false;

  constructor(
    private readonly source: RemoteAppearanceConfigSource,
    private readonly sessions: Pick<RemoteSessionRegistry, "readySessions" | "onSessionReady">,
    private readonly sender: RemoteAppearanceSender
  ) {
    this.snapshot = this.project(1);
  }

  current(): RemoteAppearanceSnapshot {
    return this.snapshot;
  }

  start(): void {
    if (this.cleanup) return;
    const sourceCleanup = this.source.subscribe(() => this.publishCommittedChange());
    const readyCleanup = this.sessions.onSessionReady((session) =>
      this.send(session, this.snapshot)
    );
    this.cleanup = () => {
      sourceCleanup();
      readyCleanup();
    };
  }

  dispose(): void {
    this.cleanup?.();
    this.cleanup = null;
  }

  private publishCommittedChange(): void {
    let next: RemoteAppearanceSnapshot;
    try {
      next = this.project(this.snapshot.revision + 1);
    } catch {
      if (!this.warningIssued) {
        this.warningIssued = true;
        console.warn("[RemoteAppearanceSync] Ignoring invalid committed appearance state");
      }
      return;
    }
    if (this.semanticValue(next) === this.semanticValue(this.snapshot)) return;
    this.snapshot = next;
    for (const session of this.sessions.readySessions()) this.send(session, next);
  }

  private project(revision: number): RemoteAppearanceSnapshot {
    const config = this.source.get();
    const customSchemes = Array.isArray(config.customSchemes)
      ? (config.customSchemes as AppColorScheme[])
      : [];
    const scheme = resolveAppTheme(
      typeof config.colorSchemeId === "string" ? config.colorSchemeId : "daintree",
      customSchemes
    );
    return projectRemoteAppearance(scheme, {
      revision,
      accentColorOverride: config.accentColorOverride,
    });
  }

  private semanticValue(snapshot: RemoteAppearanceSnapshot): string {
    return JSON.stringify({ ...snapshot, revision: 0 });
  }

  private send(session: RemoteSession, snapshot: RemoteAppearanceSnapshot): void {
    try {
      this.sender.sendApplicationEnvelope(session.connection.id, {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        sessionId: session.id,
        kind: "event",
        type: "appearance.updated",
        revision: snapshot.revision,
        payload: snapshot,
      });
    } catch {
      // A disconnected session must not prevent remaining ready sessions from converging.
    }
  }
}
