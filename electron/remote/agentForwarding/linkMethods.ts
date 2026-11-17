import { z } from "zod";
import { AGENT_MAX_MESSAGE_BYTES } from "./protocol.js";

/**
 * Session CALLs that carry ssh-agent connections from a Host's project
 * socket to the Shell driving that project (#17432). A connection's requests
 * travel one at a time, each answered with the agent's reply, so the CALL
 * answers are the relay's ordering and flow control.
 *
 * Connection ids are minted by the Host and scoped to one link session.
 */
export const AgentForwardMethod = {
  /** Shell → Host: whether this Shell's switch for the host is on. Sent on every link. */
  CONFIGURE: "agentForward.configure",
  /** Host → Shell: one request on a connection, answered with the agent's reply. */
  REQUEST: "agentForward.request",
  /** Host → Shell: the connection is gone; close the agent socket behind it. */
  CLOSE: "agentForward.close",
  /** Shell → Host: what the Host's ssh config says about IdentityAgent. */
  INSPECT: "agentForward.inspect",
} as const;

/** The destination the Host's ssh config is read for when it is inspected. */
export const INSPECTED_SSH_DESTINATION = "github.com";

const connectionId = z.number().int().min(1).max(0xffffffff);
const message = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= AGENT_MAX_MESSAGE_BYTES);

export const AgentConfigurePayloadSchema = z.object({ enabled: z.boolean() });
export type AgentConfigurePayload = z.infer<typeof AgentConfigurePayloadSchema>;

export const AgentRequestPayloadSchema = z.object({ connectionId, message });
export type AgentRequestPayload = z.infer<typeof AgentRequestPayloadSchema>;

export const AgentReplySchema = z.object({ message });
export interface AgentReply {
  message: Uint8Array;
}

export const AgentClosePayloadSchema = z.object({ connectionId });

export const AgentInspectResultSchema = z.object({
  /** The `identityagent` value `ssh -G` prints for {@link INSPECTED_SSH_DESTINATION}; null when none is set. */
  identityAgent: z.string().max(4096).nullable(),
});
export type AgentInspectResult = z.infer<typeof AgentInspectResultSchema>;
