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
  /** Host → Shell: these endpoints missed events; repaint them from a fresh snapshot. */
  ENDPOINT_RESYNC: "endpoint.resync",
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
