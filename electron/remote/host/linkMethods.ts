import { z } from "zod";
import type { HostProjectSummary } from "../../../shared/types/ipc/remoteHosts.js";
import type { HostPlatform } from "../../../shared/types/remoteHosts.js";

/**
 * Session-level CALL methods the Shell and the Host ask each other, beside
 * the IPC channels that travel as INVOKE. Every payload and every answer is
 * validated on the receiving side.
 */
export const LinkMethod = {
  /** Shell → Host: the platform and directories commands and paths are built for. */
  HOST_INFO: "host.info",
  /** Shell → Host: the folder a project lives in on the Host, for a view about to open it. */
  DESCRIBE_PROJECT: "host.describe-project",
  /** Shell → Host: every project the Host has, for the Shell's other-hosts listings. */
  LIST_PROJECTS: "host.list-projects",
  /** Shell → Host: one of this Shell's windows now shows this project (or scratch). */
  NOTE_ACTIVE_PROJECT: "host.note-active-project",
  /** Shell → Host: the project this Shell last showed here, if the Host still has it. */
  LAST_ACTIVE_PROJECT: "host.last-active-project",
  /** Host → Shell: these endpoints missed events; repaint them from a fresh snapshot. */
  ENDPOINT_RESYNC: "endpoint.resync",
  /** Host → Shell: whether a live Daintree Assistant is pinned to each of these endpoints. */
  ENDPOINT_ASSISTANT: "endpoint.assistant",
  /** Host → Shell: whether an agent in each of these endpoints' projects is active here. */
  ENDPOINT_AGENT_ACTIVITY: "endpoint.agent-activity",
} as const;

export interface HostInfo {
  platform: HostPlatform;
  homeDir: string;
  tmpDir: string;
}

export interface ProjectDescription {
  projectId: string;
  path: string;
  name: string;
}

export type HostProjectList = HostProjectSummary[];

/** Why a Shell is told to resync: its events were dropped, or it was away. */
export type EndpointResyncReason = "overflow" | "reattached";

export interface EndpointResyncPayload {
  endpointIds: string[];
  reason: EndpointResyncReason;
}

/**
 * One endpoint's assistant, as the host sees it. `projectId` is the binding the
 * answer was computed for, so a Shell that has since moved the view to another
 * project ignores it rather than pinning the new binding.
 */
export interface EndpointAssistantState {
  endpointId: string;
  projectId: string | null;
  live: boolean;
}

export interface EndpointAssistantPayload {
  endpoints: EndpointAssistantState[];
}

/**
 * Whether an agent in an endpoint's project is working, waiting or directing
 * on the host. Same `projectId` rule as {@link EndpointAssistantState}.
 */
export interface EndpointAgentActivityState {
  endpointId: string;
  projectId: string | null;
  active: boolean;
}

export interface EndpointAgentActivityPayload {
  endpoints: EndpointAgentActivityState[];
}

const endpointId = z.string().min(1).max(256);
const hostPath = z.string().min(1).max(4096);

export const HostInfoSchema = z.object({
  platform: z.enum(["darwin", "linux"]),
  homeDir: hostPath,
  tmpDir: hostPath,
});

export const EmptyPayloadSchema = z.union([z.null(), z.undefined(), z.object({}).strict()]);

export const DescribeProjectPayloadSchema = z.object({ projectId: z.string().min(1).max(256) });

export const ProjectDescriptionSchema = z
  .object({
    projectId: z.string().min(1).max(256),
    path: hostPath,
    name: z.string().max(1024),
  })
  .nullable();

/** A Host's project list is bounded, so a hostile or broken Host can't flood the Shell. */
export const MAX_LISTED_PROJECTS = 2000;
export const MAX_PROJECT_EMOJI_LENGTH = 64;

export const HostProjectListSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(256),
        name: z.string().max(1024),
        path: hostPath,
        emoji: z.string().max(MAX_PROJECT_EMOJI_LENGTH).optional(),
      })
      .strip()
  )
  .max(MAX_LISTED_PROJECTS);

export const EndpointResyncPayloadSchema = z.object({
  endpointIds: z.array(endpointId).max(4096),
  reason: z.enum(["overflow", "reattached"]),
});

export const EndpointAssistantPayloadSchema = z.object({
  endpoints: z
    .array(
      z.object({
        endpointId,
        projectId: z.string().min(1).max(256).nullable(),
        live: z.boolean(),
      })
    )
    .max(4096),
});

export const EndpointAgentActivityPayloadSchema = z.object({
  endpoints: z
    .array(
      z.object({
        endpointId,
        projectId: z.string().min(1).max(256).nullable(),
        active: z.boolean(),
      })
    )
    .max(4096),
});
