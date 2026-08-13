import { z } from "zod";
import {
  RemoteLaunchableAgentsRequestSchema,
  RemoteLaunchableAgentsSchema,
  RemoteLaunchAgentRequestSchema,
  RemoteLaunchAgentResultSchema,
  RemoteCloseAgentRequestSchema,
  RemoteCloseAgentResultSchema,
  RemoteProjectSnapshotSchema,
} from "./agents.js";
import {
  RemoteConsoleOutputSchema,
  RemoteConsoleResyncRequiredSchema,
  RemoteConsoleSnapshotSchema,
  RemoteConsoleSubscribeRequestSchema,
  RemoteConsoleUnsubscribeRequestSchema,
  RemotePromptResultSchema,
  RemoteRequestStatusRequestSchema,
  RemoteRequestStatusSchema,
  RemoteSubmitPromptRequestSchema,
} from "./console.js";
import { RemoteErrorSchema, type RemoteError } from "./errors.js";
import { RemoteAppearanceSnapshotSchema } from "./appearance.js";
import {
  RemotePairBeginRequestSchema,
  RemotePairCompleteSchema,
  RemotePairVerificationResponseSchema,
  RemotePairVerifySchema,
  RemoteProtocolRangeSchema,
  RemoteSessionHelloSchema,
  RemoteSessionReadySchema,
  RemoteSessionRevokedSchema,
  RemoteSessionWelcomeSchema,
  type RemoteProtocolRange,
} from "./identity.js";
import {
  RemoteOpaqueIdSchema,
  RemoteProjectOpenRequestSchema,
  RemoteProjectsSnapshotSchema,
  RemoteProjectsUpdatedSchema,
  RemoteProjectUpdatedSchema,
} from "./projects.js";

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_REMOTE_MAX_FRAME_BYTES = 256 * 1024;

const emptyPayloadSchema = z.strictObject({});
const pingPayloadSchema = z.strictObject({ timestamp: z.number().int().nonnegative() });

const baseEnvelopeShape = {
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  sessionId: RemoteOpaqueIdSchema,
};

function requestEnvelope<const TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload
) {
  return z.strictObject({
    ...baseEnvelopeShape,
    kind: z.literal("request"),
    type: z.literal(type),
    requestId: RemoteOpaqueIdSchema,
    payload,
  });
}

function responseEnvelope<const TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload
) {
  return z.strictObject({
    ...baseEnvelopeShape,
    kind: z.literal("response"),
    type: z.literal(type),
    requestId: RemoteOpaqueIdSchema,
    payload,
  });
}

function eventEnvelope<const TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
  options: { revision?: boolean; stream?: boolean } = {}
) {
  return z.strictObject({
    ...baseEnvelopeShape,
    kind: z.literal("event"),
    type: z.literal(type),
    ...(options.stream
      ? { streamId: RemoteOpaqueIdSchema, seq: z.number().int().nonnegative() }
      : {}),
    ...(options.revision ? { revision: z.number().int().nonnegative() } : {}),
    payload,
  });
}

const remoteEnvelopeSchemas = [
  requestEnvelope("session.hello", RemoteSessionHelloSchema),
  responseEnvelope("session.welcome", RemoteSessionWelcomeSchema),
  requestEnvelope("session.ready", RemoteSessionReadySchema),
  responseEnvelope("session.ready", RemoteSessionReadySchema),
  requestEnvelope("hosts.pair.begin", RemotePairBeginRequestSchema),
  responseEnvelope("hosts.pair.verify", RemotePairVerificationResponseSchema),
  requestEnvelope("hosts.pair.verify", RemotePairVerifySchema),
  responseEnvelope("hosts.pair.complete", RemotePairCompleteSchema),
  requestEnvelope("projects.list", emptyPayloadSchema),
  responseEnvelope("projects.list", RemoteProjectsSnapshotSchema),
  eventEnvelope("projects.updated", RemoteProjectsUpdatedSchema, { revision: true }),
  requestEnvelope("project.open", RemoteProjectOpenRequestSchema),
  responseEnvelope("project.snapshot", RemoteProjectSnapshotSchema),
  eventEnvelope("project.updated", RemoteProjectUpdatedSchema, { revision: true }),
  requestEnvelope("agents.launchable", RemoteLaunchableAgentsRequestSchema),
  responseEnvelope("agents.launchable", RemoteLaunchableAgentsSchema),
  requestEnvelope("agent.launch", RemoteLaunchAgentRequestSchema),
  responseEnvelope("agent.launchResult", RemoteLaunchAgentResultSchema),
  requestEnvelope("agent.close", RemoteCloseAgentRequestSchema),
  responseEnvelope("agent.closeResult", RemoteCloseAgentResultSchema),
  requestEnvelope("console.subscribe", RemoteConsoleSubscribeRequestSchema),
  responseEnvelope("console.snapshot", RemoteConsoleSnapshotSchema),
  eventEnvelope("console.output", RemoteConsoleOutputSchema, { stream: true }),
  eventEnvelope("console.resyncRequired", RemoteConsoleResyncRequiredSchema),
  requestEnvelope("console.unsubscribe", RemoteConsoleUnsubscribeRequestSchema),
  responseEnvelope("console.unsubscribe", emptyPayloadSchema),
  requestEnvelope("prompt.submit", RemoteSubmitPromptRequestSchema),
  responseEnvelope("prompt.result", RemotePromptResultSchema),
  requestEnvelope("request.status", RemoteRequestStatusRequestSchema),
  responseEnvelope("request.status", RemoteRequestStatusSchema),
  requestEnvelope("session.ping", pingPayloadSchema),
  responseEnvelope("session.pong", pingPayloadSchema),
  eventEnvelope("session.revoked", RemoteSessionRevokedSchema),
  eventEnvelope("appearance.updated", RemoteAppearanceSnapshotSchema, { revision: true }),
  responseEnvelope("request.error", RemoteErrorSchema),
  z.strictObject({
    ...baseEnvelopeShape,
    kind: z.literal("ack"),
    type: z.literal("stream.ack"),
    streamId: RemoteOpaqueIdSchema,
    ack: z.number().int().nonnegative(),
  }),
] as const;

export const RemoteEnvelopeSchema = z.union(remoteEnvelopeSchemas);

export type RemoteEnvelope = z.infer<typeof RemoteEnvelopeSchema>;

export type RemoteProtocolNegotiationResult =
  { ok: true; protocolVersion: typeof REMOTE_PROTOCOL_VERSION } | { ok: false; error: RemoteError };

export function negotiateRemoteProtocol(
  clientRange: RemoteProtocolRange
): RemoteProtocolNegotiationResult {
  const parsedRange = RemoteProtocolRangeSchema.safeParse(clientRange);
  if (
    !parsedRange.success ||
    parsedRange.data.min > REMOTE_PROTOCOL_VERSION ||
    parsedRange.data.max < REMOTE_PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_VERSION",
        message: `Host requires protocol version ${REMOTE_PROTOCOL_VERSION}`,
        retryable: false,
      },
    };
  }

  return { ok: true, protocolVersion: REMOTE_PROTOCOL_VERSION };
}

export type RemoteFrameParseResult =
  { ok: true; envelope: RemoteEnvelope } | { ok: false; error: RemoteError };

export function parseRemoteFrame(
  frame: string,
  maxFrameBytes = DEFAULT_REMOTE_MAX_FRAME_BYTES
): RemoteFrameParseResult {
  if (new TextEncoder().encode(frame).byteLength > maxFrameBytes) {
    return {
      ok: false,
      error: {
        code: "FRAME_TOO_LARGE",
        message: "Remote frame exceeds the configured maximum size",
        retryable: false,
      },
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(frame);
  } catch {
    return {
      ok: false,
      error: {
        code: "MALFORMED_FRAME",
        message: "Remote frame is not valid JSON",
        retryable: false,
      },
    };
  }

  const result = RemoteEnvelopeSchema.safeParse(decoded);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Remote frame does not match the protocol schema",
        retryable: false,
      },
    };
  }

  return { ok: true, envelope: result.data };
}
