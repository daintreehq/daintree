import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteEnvelope,
} from "../../../shared/types/remote/index.js";
import type { RemoteConsoleObservationService } from "./RemoteConsoleObservationService.js";
import type { RemoteAgentLaunchService } from "./RemoteAgentLaunchService.js";
import type { RemoteProjectDetailProjectionService } from "./RemoteProjectDetailProjectionService.js";
import type { RemoteProjectDetailSubscriptionService } from "./RemoteProjectDetailSubscriptionService.js";
import type { RemoteProjectProjectionService } from "./RemoteProjectProjectionService.js";
import type { RemotePromptSubmissionService } from "./RemotePromptSubmissionService.js";
import type { RemoteProtocolRouter } from "./RemoteProtocolRouter.js";
import type { RemoteSession } from "./RemoteSessionRegistry.js";

export interface RemoteApplicationDependencies {
  projection: Pick<RemoteProjectProjectionService, "snapshot">;
  detailProjection: Pick<RemoteProjectDetailProjectionService, "snapshot">;
  detailSubscriptions: Pick<RemoteProjectDetailSubscriptionService, "select">;
  consoleObservation: Pick<RemoteConsoleObservationService, "subscribe" | "unsubscribe">;
  prompts: Pick<RemotePromptSubmissionService, "submit" | "status">;
  launches: Pick<RemoteAgentLaunchService, "launchable" | "launch" | "status">;
  sender: Pick<RemoteProtocolRouter, "sendApplicationEnvelope" | "sendApplicationError">;
}

export function createRemoteApplicationHandler(dependencies: RemoteApplicationDependencies) {
  const {
    projection,
    detailProjection,
    detailSubscriptions,
    consoleObservation,
    prompts,
    launches,
    sender,
  } = dependencies;
  return async (session: RemoteSession, envelope: RemoteEnvelope): Promise<void> => {
    if (envelope.kind !== "request") return;
    if (envelope.type === "prompt.submit") {
      await prompts.submit(session, envelope.requestId, envelope.payload);
      return;
    }
    if (envelope.type === "request.status") {
      launches.status(session, envelope.requestId, envelope.payload.idempotencyKey);
      return;
    }
    if (envelope.type === "agents.launchable") {
      await launches.launchable(session, envelope.requestId, envelope.payload);
      return;
    }
    if (envelope.type === "agent.launch") {
      await launches.launch(session, envelope.requestId, envelope.payload);
      return;
    }
    if (!session.capabilities.includes("observe-projects")) {
      sender.sendApplicationError(
        session.connection.id,
        envelope.requestId,
        "FORBIDDEN",
        "Project observation capability is required"
      );
      return;
    }
    if (envelope.type === "console.subscribe") {
      await consoleObservation.subscribe(session, envelope.requestId, envelope.payload);
      return;
    }
    if (envelope.type === "console.unsubscribe") {
      consoleObservation.unsubscribe(session, envelope.requestId, envelope.payload.streamId);
      return;
    }
    if (envelope.type === "project.open") {
      try {
        const snapshot = await detailProjection.snapshot(envelope.payload.projectId);
        sender.sendApplicationEnvelope(session.connection.id, {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          sessionId: session.id,
          kind: "response",
          type: "project.snapshot",
          requestId: envelope.requestId,
          payload: snapshot,
        });
        detailSubscriptions.select(session.id, snapshot.project.id, snapshot.revision);
      } catch (error) {
        const notFound = error instanceof Error && error.message === "PROJECT_NOT_FOUND";
        sender.sendApplicationError(
          session.connection.id,
          envelope.requestId,
          notFound ? "NOT_FOUND" : "INTERNAL_ERROR",
          notFound ? "Project was not found" : "Project details are temporarily unavailable"
        );
      }
      return;
    }
    if (envelope.type !== "projects.list") return;
    sender.sendApplicationEnvelope(session.connection.id, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: session.id,
      kind: "response",
      type: "projects.list",
      requestId: envelope.requestId,
      payload: projection.snapshot(),
    });
  };
}
