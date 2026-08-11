import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import {
  REMOTE_GATEWAY_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteConsoleSubscribeRequest,
  type RemoteEnvelope,
  type RemoteErrorCode,
} from "../../../shared/types/remote/index.js";
import type { SerializedTerminalSnapshot } from "../../../shared/types/terminal.js";
import type { RemoteProjectDetailProjectionService } from "./RemoteProjectDetailProjectionService.js";
import type { RemoteSession } from "./RemoteSessionRegistry.js";

interface ConsoleChunk {
  seq: number;
  data: string;
  encoding: "base64";
  bytes: number;
}

interface ConsoleObservationResult {
  mode: "snapshot" | "resume" | "resync";
  reason?: "gap" | "generation-changed";
  throughSeq: number;
  state: SerializedTerminalSnapshot | null;
  chunks: ConsoleChunk[];
}

interface PtyConsoleSource extends EventEmitter {
  beginConsoleObservation(
    id: string,
    observerId: string,
    launchGeneration: number,
    afterSeq?: number
  ): Promise<ConsoleObservationResult>;
  endConsoleObservation(id: string, observerId: string): void;
}

interface ConsoleSessionSource {
  onConsoleStreamRemoved(listener: (connectionId: string, streamId: string) => void): () => void;
  onSessionRemoved(listener: (connectionId: string) => void): () => void;
  cancelConsoleSubscription(connectionId: string, requestId: string): void;
}

interface ConsoleEnvelopeSender {
  sendApplicationEnvelope(connectionId: string, envelope: RemoteEnvelope): void;
  sendApplicationError(
    connectionId: string,
    requestId: string,
    code: RemoteErrorCode,
    message: string
  ): void;
}

interface ActiveObservation {
  connectionId: string;
  sessionId: string;
  requestId: string;
  panelId: string;
  launchGeneration: number;
  ready: boolean;
  stopped: boolean;
  pendingBytes: number;
  pending: ConsoleChunk[];
  lastSeq: number;
  pendingResyncReason: "gap" | "generation-changed" | "queue-overflow" | "host-restarted" | null;
}

type ConsoleTarget = RemoteConsoleSubscribeRequest;

export class RemoteConsoleObservationService {
  private readonly observations = new Map<string, ActiveObservation>();
  private readonly cleanup: Array<() => void>;

  constructor(
    private readonly details: RemoteProjectDetailProjectionService,
    private readonly pty: PtyConsoleSource,
    private readonly sessions: ConsoleSessionSource,
    private readonly sender: ConsoleEnvelopeSender,
    private readonly createStreamId: () => string = randomUUID
  ) {
    const onOutput = (
      event: ConsoleChunk & {
        id: string;
        observerId: string;
        launchGeneration: number;
      }
    ) => this.handleOutput(event);
    const onInvalidated = (event: {
      id: string;
      observerId: string;
      launchGeneration: number;
      reason: "generation-changed" | "host-restarted";
    }) => this.handleInvalidated(event);
    this.pty.on("console-output", onOutput);
    this.pty.on("console-invalidated", onInvalidated);
    const onHostCrash = () => {
      for (const streamId of Array.from(this.observations.keys())) {
        this.requireResync(streamId, "host-restarted");
      }
    };
    this.pty.on("host-crash", onHostCrash);
    this.cleanup = [
      () => this.pty.off("console-output", onOutput),
      () => this.pty.off("console-invalidated", onInvalidated),
      () => this.pty.off("host-crash", onHostCrash),
      sessions.onConsoleStreamRemoved((connectionId, streamId) => {
        const observation = this.observations.get(streamId);
        if (observation?.connectionId === connectionId) this.stop(streamId);
      }),
      sessions.onSessionRemoved((connectionId) => {
        for (const [streamId, observation] of this.observations) {
          if (observation.connectionId === connectionId) this.stop(streamId);
        }
      }),
    ];
  }

  async subscribe(session: RemoteSession, requestId: string, target: ConsoleTarget): Promise<void> {
    if (!session.capabilities.includes("observe-projects")) {
      this.error(session, requestId, "FORBIDDEN", "Project observation capability is required");
      return;
    }
    let revision: number;
    try {
      revision = (await this.details.snapshot(target.projectId)).revision;
    } catch {
      this.error(session, requestId, "NOT_FOUND", "Project was not found");
      return;
    }
    const verdict = this.details.validateBinding({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      panelId: target.panelId,
      launchGeneration: target.launchGeneration,
      projectionRevision: revision,
    });
    if (!verdict.ok) {
      const stale =
        verdict.code === "RUN_GENERATION_CHANGED" || verdict.code === "PROJECTION_STALE";
      this.error(
        session,
        requestId,
        stale ? "STALE_GENERATION" : "NOT_FOUND",
        stale ? "Agent generation changed" : "Agent target was not found"
      );
      return;
    }

    const streamId = this.createStreamId();
    const observation: ActiveObservation = {
      connectionId: session.connection.id,
      sessionId: session.id,
      requestId,
      panelId: target.panelId,
      launchGeneration: target.launchGeneration,
      ready: false,
      stopped: false,
      pendingBytes: 0,
      pending: [],
      lastSeq: -1,
      pendingResyncReason: null,
    };
    this.observations.set(streamId, observation);
    let result: ConsoleObservationResult;
    try {
      result = await this.pty.beginConsoleObservation(
        target.panelId,
        streamId,
        target.launchGeneration,
        target.afterSeq
      );
    } catch {
      this.stop(streamId);
      this.error(session, requestId, "HOST_UI_UNAVAILABLE", "Console is temporarily unavailable");
      return;
    }
    if (observation.stopped) return;
    if (result.mode === "snapshot" && result.state === null) {
      this.sessions.cancelConsoleSubscription(session.connection.id, requestId);
      this.requireResync(streamId, "generation-changed");
      return;
    }
    if (
      result.state &&
      Buffer.byteLength(result.state.data, "utf8") > REMOTE_GATEWAY_LIMITS.maxConsoleSnapshotBytes
    ) {
      this.stop(streamId);
      this.error(session, requestId, "HOST_RESOURCE_PRESSURE", "Console snapshot exceeds 5 MiB");
      return;
    }
    observation.lastSeq = result.throughSeq;
    this.send(session.connection.id, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: session.id,
      kind: "response",
      type: "console.snapshot",
      requestId,
      payload: {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        panelId: target.panelId,
        launchGeneration: target.launchGeneration,
        streamId,
        mode: result.mode,
        throughSeq: result.throughSeq,
        snapshot: result.state,
        chunks: result.chunks,
      },
    });
    observation.ready = true;
    if (result.mode === "resync") {
      this.requireResync(streamId, result.reason ?? "gap");
      return;
    }
    if (observation.pendingResyncReason) {
      this.requireResync(streamId, observation.pendingResyncReason);
      return;
    }
    const pending = observation.pending;
    observation.pending = [];
    observation.pendingBytes = 0;
    for (const chunk of pending) {
      if (chunk.seq <= result.throughSeq) continue;
      if (!this.forward(streamId, chunk)) return;
    }
  }

  unsubscribe(session: RemoteSession, requestId: string, streamId: string): void {
    const observation = this.observations.get(streamId);
    if (observation?.connectionId === session.connection.id) this.stop(streamId);
    this.send(session.connection.id, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: session.id,
      kind: "response",
      type: "console.unsubscribe",
      requestId,
      payload: {},
    });
  }

  dispose(): void {
    for (const streamId of Array.from(this.observations.keys())) this.stop(streamId);
    for (const cleanup of this.cleanup) cleanup();
  }

  private handleOutput(
    event: ConsoleChunk & {
      id: string;
      observerId: string;
      launchGeneration: number;
    }
  ): void {
    const observation = this.observations.get(event.observerId);
    if (
      !observation ||
      observation.panelId !== event.id ||
      observation.launchGeneration !== event.launchGeneration ||
      observation.stopped
    ) {
      return;
    }
    if (event.bytes > 64 * 1024) {
      observation.pendingResyncReason = "queue-overflow";
      if (observation.ready) this.requireResync(event.observerId, "queue-overflow");
      return;
    }
    if (!observation.ready) {
      if (observation.pendingBytes + event.bytes > REMOTE_GATEWAY_LIMITS.maxQueuedBytes) {
        observation.pendingResyncReason = "queue-overflow";
        observation.pending = [];
        observation.pendingBytes = 0;
        return;
      }
      observation.pending.push(event);
      observation.pendingBytes += event.bytes;
      return;
    }
    this.forward(event.observerId, event);
  }

  private handleInvalidated(event: {
    id: string;
    observerId: string;
    launchGeneration: number;
    reason: "generation-changed" | "host-restarted";
  }): void {
    const observation = this.observations.get(event.observerId);
    if (
      !observation ||
      observation.panelId !== event.id ||
      observation.launchGeneration !== event.launchGeneration
    ) {
      return;
    }
    if (!observation.ready) {
      observation.pendingResyncReason = event.reason;
      return;
    }
    this.requireResync(event.observerId, event.reason);
  }

  private forward(streamId: string, chunk: ConsoleChunk): boolean {
    const observation = this.observations.get(streamId);
    if (!observation) return false;
    if (chunk.seq !== observation.lastSeq + 1) {
      this.requireResync(streamId, "gap");
      return false;
    }
    observation.lastSeq = chunk.seq;
    this.send(observation.connectionId, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: observation.sessionId,
      kind: "event",
      type: "console.output",
      streamId,
      seq: chunk.seq,
      payload: {
        streamId,
        panelId: observation.panelId,
        launchGeneration: observation.launchGeneration,
        seq: chunk.seq,
        data: chunk.data,
        encoding: chunk.encoding,
        bytes: chunk.bytes,
      },
    });
    return true;
  }

  private requireResync(
    streamId: string,
    reason: "gap" | "generation-changed" | "queue-overflow" | "host-restarted"
  ): void {
    const observation = this.observations.get(streamId);
    if (!observation) return;
    this.send(observation.connectionId, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: observation.sessionId,
      kind: "event",
      type: "console.resyncRequired",
      payload: { streamId, reason },
    });
    this.stop(streamId);
  }

  private stop(streamId: string): void {
    const observation = this.observations.get(streamId);
    if (!observation || observation.stopped) return;
    observation.stopped = true;
    this.observations.delete(streamId);
    this.sessions.cancelConsoleSubscription(observation.connectionId, observation.requestId);
    this.pty.endConsoleObservation(observation.panelId, streamId);
  }

  private error(
    session: RemoteSession,
    requestId: string,
    code: RemoteErrorCode,
    message: string
  ): void {
    this.sessions.cancelConsoleSubscription(session.connection.id, requestId);
    this.sender.sendApplicationError(session.connection.id, requestId, code, message);
  }

  private send(connectionId: string, envelope: RemoteEnvelope): void {
    this.sender.sendApplicationEnvelope(connectionId, envelope);
  }
}
