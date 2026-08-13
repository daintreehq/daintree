import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteEnvelope,
} from "../../../shared/types/remote/index.js";
import type { RemoteConsoleObservationService } from "./RemoteConsoleObservationService.js";
import type { RemoteAgentLaunchService } from "./RemoteAgentLaunchService.js";
import type { RemoteProjectDetailProjectionService } from "./RemoteProjectDetailProjectionService.js";
import type { RemoteProjectDetailSubscriptionService } from "./RemoteProjectDetailSubscriptionService.js";
import type { RemoteProjectProjectionService } from "./RemoteProjectProjectionService.js";
import {
  RemoteProjectViewError,
  type RemoteProjectViewBroker,
  type RemoteProjectViewLease,
} from "./RemoteProjectViewBroker.js";
import type { RemotePromptSubmissionService } from "./RemotePromptSubmissionService.js";
import type { RemoteProtocolRouter } from "./RemoteProtocolRouter.js";
import type { RemoteSession } from "./RemoteSessionRegistry.js";

export interface RemoteApplicationDependencies {
  projection: Pick<RemoteProjectProjectionService, "snapshot">;
  detailProjection: Pick<RemoteProjectDetailProjectionService, "snapshot">;
  detailSubscriptions: Pick<RemoteProjectDetailSubscriptionService, "select">;
  projectViews: Pick<RemoteProjectViewBroker, "ensureBackgroundView">;
  consoleObservation: Pick<RemoteConsoleObservationService, "subscribe" | "unsubscribe">;
  prompts: Pick<RemotePromptSubmissionService, "submit" | "status">;
  launches: Pick<RemoteAgentLaunchService, "launchable" | "launch" | "close" | "status">;
  sender: Pick<RemoteProtocolRouter, "sendApplicationEnvelope" | "sendApplicationError">;
}

export function createRemoteApplicationHandler(dependencies: RemoteApplicationDependencies) {
  const {
    projection,
    detailProjection,
    detailSubscriptions,
    projectViews,
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
    if (envelope.type === "agent.close") {
      await launches.close(session, envelope.requestId, envelope.payload);
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
      let lease: RemoteProjectViewLease | null = null;
      try {
        lease = await projectViews.ensureBackgroundView(envelope.payload.projectId);
        const snapshot = await detailProjection.snapshot(envelope.payload.projectId);
        sender.sendApplicationEnvelope(session.connection.id, {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          sessionId: session.id,
          kind: "response",
          type: "project.snapshot",
          requestId: envelope.requestId,
          payload: snapshot,
        });
        detailSubscriptions.select(
          session.id,
          snapshot.project.id,
          snapshot.revision,
          lease.release
        );
        lease = null;
      } catch (error) {
        const notFound = error instanceof Error && error.message === "PROJECT_NOT_FOUND";
        const resourcePressure =
          error instanceof RemoteProjectViewError && error.code === "HOST_RESOURCE_PRESSURE";
        const hostUnavailable =
          error instanceof RemoteProjectViewError && error.code === "HOST_UI_UNAVAILABLE";
        sender.sendApplicationError(
          session.connection.id,
          envelope.requestId,
          notFound
            ? "NOT_FOUND"
            : resourcePressure
              ? "HOST_RESOURCE_PRESSURE"
              : hostUnavailable
                ? "HOST_UI_UNAVAILABLE"
                : "INTERNAL_ERROR",
          notFound
            ? "Project was not found"
            : resourcePressure
              ? "Not enough memory is available to prepare this project. Close an app on the host and retry."
              : hostUnavailable
                ? "Open a Daintree window on the host and retry"
                : "Project details are temporarily unavailable"
        );
      } finally {
        lease?.release();
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
