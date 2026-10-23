import { z } from "zod";
import {
  ASSISTANT_VIEWER_CHANNELS,
  CANOPY_HOST_CHANNELS,
} from "../../../shared/types/ipc/canopyHost.js";
import { AgentDirectorySchema } from "../../../shared/types/agentDirectory.js";
import { AssistantWorkHostReadingSchema } from "../../../shared/types/assistantWork.js";

/**
 * Session-level methods behind Canopy reading a host the view isn't bound to.
 * They need no endpoint, so a Shell can read a host it shows no project of.
 */
export const CanopyLinkMethod = {
  /** Shell → Host: one Canopy call, as the Shell's viewer of that name. */
  INVOKE: "canopy.invoke",
  /** Shell → Host: the viewer's panel is gone; forget everything it said. */
  RELEASE: "canopy.release",
  /** Host → Shell: a push to the viewer was lost, and the viewer with it; read again. */
  VIEWER_LOST: "canopy.viewer-lost",
  /**
   * Shell → Host: one call of a person's assistant viewer (#14163). A host
   * from before this answers UNSUPPORTED, which the Shell says as that host's
   * assistants being unavailable; its workers still read through `invoke`.
   */
  ASSISTANT_INVOKE: "canopy.assistant-invoke",
  /** Shell → Host: the assistants this host holds, for a person's picker. */
  ASSISTANTS: "canopy.assistants",
  /**
   * Shell → Host: which of this host's workers an assistant made or holds
   * (#14166). A host from before this answers UNSUPPORTED, which the Shell
   * says as unread rather than as no work.
   */
  ASSISTANT_WORK: "canopy.assistant-work",
} as const;

/**
 * What a host's pushes to a viewer are addressed to, in place of a view's
 * endpoint: a Shell routes these to the view reading that host, never to the
 * views bound to it.
 */
export { CANOPY_VIEWER_ENDPOINT_PREFIX, isCanopyViewerEndpointId } from "../../ipc/endpoint.js";

/** The most args any allowed Canopy call takes, with room to spare. */
export const MAX_CANOPY_INVOKE_ARGS = 8;

const VIEWER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isCanopyViewerId(value: unknown): value is string {
  return typeof value === "string" && VIEWER_ID_PATTERN.test(value);
}

const viewerId = z.string().regex(VIEWER_ID_PATTERN);

export const CanopyInvokePayloadSchema = z.object({
  viewerId,
  channel: z.enum(CANOPY_HOST_CHANNELS),
  args: z.array(z.unknown()).max(MAX_CANOPY_INVOKE_ARGS),
  /**
   * The Shell takes the viewer's terminal stream on the interactive lane. A
   * Shell that never says so hears it as an event, as before: an interactive
   * kind it doesn't know would end the link.
   */
  interactive: z.boolean().optional(),
});
export type CanopyInvokePayload = z.infer<typeof CanopyInvokePayloadSchema>;

export const CanopyReleasePayloadSchema = z.object({ viewerId });

export const CanopyViewerLostPayloadSchema = z.object({ viewerId });

export const CanopyAssistantInvokePayloadSchema = z.object({
  viewerId,
  channel: z.enum(ASSISTANT_VIEWER_CHANNELS),
  args: z.array(z.unknown()).max(MAX_CANOPY_INVOKE_ARGS),
  interactive: z.boolean().optional(),
});
export type CanopyAssistantInvokePayload = z.infer<typeof CanopyAssistantInvokePayloadSchema>;

export const CanopyAssistantsPayloadSchema = z.object({
  projectId: z.string().min(1).max(256).optional(),
});

/** A host's answer: its assistant viewer protocol, and its assistants as it read them. */
export const CanopyAssistantsAnswerSchema = z.object({
  version: z.number().int().positive(),
  directory: AgentDirectorySchema,
});
export type CanopyAssistantsAnswer = z.infer<typeof CanopyAssistantsAnswerSchema>;

export const CanopyAssistantWorkPayloadSchema = z.object({});

/** A host's answer: its assistant work protocol, and its workers' links as it read them. */
export const CanopyAssistantWorkAnswerSchema = z.object({
  version: z.number().int().positive(),
  reading: AssistantWorkHostReadingSchema,
});
export type CanopyAssistantWorkAnswer = z.infer<typeof CanopyAssistantWorkAnswerSchema>;
