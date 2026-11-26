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
  /**
   * Shell → Host, right before the Shell acts on the Host's idleness (#17922):
   * the Host reads afresh and grants this link its ended idle time, at most
   * once per idle time. A Host from before it answers `UNSUPPORTED`.
   */
  CLAIM_IDLE: "host.claim-idle",
  /**
   * Shell → Host, for a Shell standing in for a cloud machine's own idle stop
   * that was refused (#17924): as {@link LinkMethod.CLAIM_IDLE}, but refused
   * while one of the Host's keepers would stop its machine itself, so a
   * keeper given a working key or permission meanwhile keeps that idle time.
   * A Host from before it answers `UNSUPPORTED`.
   */
  CLAIM_IDLE_STAND_IN: "host.claim-idle-stand-in",
  /**
   * Shell → Host, once, on the first link to a cloud machine whose person
   * asked for it when adding it (#18187): turn this host's MCP server on. It
   * only ever turns it on, and answers whether it runs. A Host from before it
   * answers `UNSUPPORTED`.
   */
  ENABLE_MCP_SERVER: "host.enable-mcp-server",
  /**
   * Shell → Host (#18257): the SSH host public keys of the sshd listeners this
   * Host's user can see on its machine, read here rather than over the SSH
   * path a caller means to pin. A Host from before it answers `UNSUPPORTED`.
   */
  SSH_HOST_KEYS: "host.ssh-host-keys",
  /**
   * Shell → Host, on a resumed session: the endpoints this Shell holds. Any
   * other the Host kept for it, and not opened again since, was closed in a
   * frame still queued when the link dropped.
   */
  ENDPOINT_RECONCILE: "endpoint.reconcile",
  /** Host → Shell: these endpoints missed events; repaint them from a fresh snapshot. */
  ENDPOINT_RESYNC: "endpoint.resync",
  /** Host → Shell: whether a live Daintree Assistant is pinned to each of these endpoints. */
  ENDPOINT_ASSISTANT: "endpoint.assistant",
  /** Host → Shell: whether an agent in each of these endpoints' projects is active here. */
  ENDPOINT_AGENT_ACTIVITY: "endpoint.agent-activity",
  /** Host → Shell: whether the user granted each of these endpoints' projects residency here. */
  ENDPOINT_RESIDENCY: "endpoint.residency",
  /** Host → Shell: whether an MCP session here is bound live to each of these endpoints' projects. */
  ENDPOINT_MCP_BINDING: "endpoint.mcp-binding",
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

export interface EndpointReconcilePayload {
  endpointIds: string[];
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

/**
 * The host-side "keep this workspace resident" grant for an endpoint's project.
 * Same `projectId` rule as {@link EndpointAssistantState}.
 */
export interface EndpointResidencyState {
  endpointId: string;
  projectId: string | null;
  keepResident: boolean;
}

export interface EndpointResidencyPayload {
  endpoints: EndpointResidencyState[];
}

/**
 * Whether an external MCP session on the host is bound, over a live transport,
 * to an endpoint's project. Same `projectId` rule as {@link EndpointAssistantState}.
 */
export interface EndpointMcpBindingState {
  endpointId: string;
  projectId: string | null;
  liveBinding: boolean;
}

export interface EndpointMcpBindingPayload {
  endpoints: EndpointMcpBindingState[];
}

const endpointId = z.string().min(1).max(256);
const hostPath = z.string().min(1).max(4096);

export const HostInfoSchema = z.object({
  platform: z.enum(["darwin", "linux"]),
  homeDir: hostPath,
  tmpDir: hostPath,
});

export const EmptyPayloadSchema = z.union([z.null(), z.undefined(), z.object({}).strict()]);

/** The Host's answer to {@link LinkMethod.ENABLE_MCP_SERVER}: whether its server runs now. */
export const McpServerEnabledAnswerSchema = z.object({ running: z.boolean() });
export type McpServerEnabledAnswer = z.infer<typeof McpServerEnabledAnswerSchema>;

/**
 * The Host's answer to {@link LinkMethod.CLAIM_IDLE}: granted, the idle time
 * that ended is this link's alone to act on, now; refused, nothing is.
 */
export const IdleClaimAnswerSchema = z.object({ granted: z.boolean() });
export type IdleClaimAnswer = z.infer<typeof IdleClaimAnswerSchema>;

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
        /** Absent from a host that predates it (#14122). */
        frontendAttached: z.boolean().optional(),
      })
      .strip()
  )
  .max(MAX_LISTED_PROJECTS);

export const EndpointResyncPayloadSchema = z.object({
  endpointIds: z.array(endpointId).max(4096),
  reason: z.enum(["overflow", "reattached"]),
});

export const EndpointReconcilePayloadSchema = z.object({
  endpointIds: z.array(endpointId).max(4096),
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

export const EndpointResidencyPayloadSchema = z.object({
  endpoints: z
    .array(
      z.object({
        endpointId,
        projectId: z.string().min(1).max(256).nullable(),
        keepResident: z.boolean(),
      })
    )
    .max(4096),
});

export const EndpointMcpBindingPayloadSchema = z.object({
  endpoints: z
    .array(
      z.object({
        endpointId,
        projectId: z.string().min(1).max(256).nullable(),
        liveBinding: z.boolean(),
      })
    )
    .max(4096),
});

export const MAX_SSH_LISTENERS = 32;
export const MAX_SSH_HOST_KEYS_PER_LISTENER = 32;
export const MAX_SSH_LISTEN_ADDRESSES = 64;
export const MAX_SSH_LISTEN_ADDRESS_LENGTH = 512;
export const MAX_SSH_PATH_LENGTH = 4096;
/** Key text and paths across a whole answer, well inside one link frame. */
export const MAX_SSH_ANSWER_KEY_BYTES = 1024 * 1024;
const sshPath = z.string().min(1).max(MAX_SSH_PATH_LENGTH);

/** Why one configured host key's public file gave no key. */
export const SshHostKeyGapSchema = z.enum([
  "missing",
  "permission-denied",
  /** Not a regular file, a symlink, or the private key itself under another name. */
  "not-a-public-file",
  /** Read, but not an OpenSSH public key line. */
  "invalid",
  /** A relative `HostKey` is the daemon's to resolve, not this Host's. */
  "relative-path",
  "unreadable",
]);
export type SshHostKeyGap = z.infer<typeof SshHostKeyGapSchema>;

export const SshHostKeyFileSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("read"),
    /** The `HostKey` as configured: the private key, never opened. */
    hostKeyPath: sshPath,
    publicKeyPath: sshPath,
    type: z.string().min(1).max(64),
    /** `type base64`, as the public file holds it now, not as sshd loaded it. */
    publicKey: z
      .string()
      .min(1)
      .max(16 * 1024 + 80),
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  }),
  z.object({
    outcome: SshHostKeyGapSchema,
    hostKeyPath: sshPath,
    publicKeyPath: sshPath,
  }),
]);
export type SshHostKeyFile = z.infer<typeof SshHostKeyFileSchema>;

/** Why a listener's keys are missing or incomplete, beyond its own key files. */
export const SshListenerGapSchema = z.enum([
  /** Its command line couldn't be read, or its retitled command line couldn't be parsed. */
  "command-line-unreadable",
  /** Another container's or chroot's daemon: its paths aren't this Host's. */
  "other-namespace",
  /** What the daemon sees as `/` couldn't be read, so its paths may not be this Host's. */
  "namespace-unknown",
  /** No daemon binary this Host would run: unknown, or writable by someone else. */
  "untrusted-binary",
  /** A relative `-f` or `-h`, resolved against a directory this Host can't see. */
  "relative-path",
  /** `sshd -G` couldn't read its configuration. */
  "config-unreadable",
  /** An sshd from before `-G` (OpenSSH 9.3): only the command line's own keys are known. */
  "config-dump-unavailable",
  "config-dump-failed",
  "timed-out",
  /** The process went away, or its pid was reused, while it was being read. */
  "exited",
  /** More keys, addresses or path than an answer carries. */
  "truncated",
]);
export type SshListenerGap = z.infer<typeof SshListenerGapSchema>;

export const SshListenerReadingSchema = z
  .object({
    /**
     * The same listener across restarts on this Host: its config file and the
     * addresses it binds. Null when that can't be known, or another listener
     * shares it; such a reading is never a baseline.
     */
    listenerId: z.string().min(1).max(128).nullable(),
    /** Diagnostic only: a restart changes it. */
    pid: z.number().int().positive(),
    /** Every configured key was read, and nothing else is missing. */
    complete: z.boolean(),
    gaps: z.array(SshListenerGapSchema).max(SshListenerGapSchema.options.length),
    /** `-f` as given, or null for the daemon's built-in default. */
    configFile: sshPath.nullable(),
    listenAddresses: z
      .array(z.string().min(1).max(MAX_SSH_LISTEN_ADDRESS_LENGTH))
      .max(MAX_SSH_LISTEN_ADDRESSES),
    keys: z.array(SshHostKeyFileSchema).max(MAX_SSH_HOST_KEYS_PER_LISTENER),
  })
  // A reading may only call itself complete on the evidence it carries.
  .refine(
    (reading) =>
      !reading.complete ||
      (reading.gaps.length === 0 &&
        reading.keys.length > 0 &&
        reading.keys.every((key) => key.outcome === "read")),
    { message: "A complete listener reading has every key and no gaps" }
  );
export type SshListenerReading = z.infer<typeof SshListenerReadingSchema>;

/**
 * The Host's answer to {@link LinkMethod.SSH_HOST_KEYS}. "Couldn't read" is
 * an ordinary answer here: a Host that runs without root sees only what its
 * user may read.
 */
export const SshHostKeysAnswerSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("reading"),
      /** Every listener is complete, and none was left out. */
      complete: z.boolean(),
      /** More listeners than an answer carries were seen. */
      truncated: z.boolean(),
      listeners: z.array(SshListenerReadingSchema).min(1).max(MAX_SSH_LISTENERS),
    })
    .refine(
      (answer) =>
        !answer.complete ||
        (!answer.truncated && answer.listeners.every((listener) => listener.complete)),
      { message: "A complete reading has every listener complete" }
    ),
  /** The process table was readable and showed no sshd listener this Host's user can see. */
  z.object({ status: z.literal("no-sshd-visible") }),
  /** The process table itself couldn't be read. */
  z.object({ status: z.literal("discovery-failed") }),
  /** The read didn't finish in time; a later call may. */
  z.object({ status: z.literal("timed-out") }),
  z.object({ status: z.literal("unsupported-platform"), platform: z.string().min(1).max(64) }),
]);
export type SshHostKeysAnswer = z.infer<typeof SshHostKeysAnswerSchema>;
