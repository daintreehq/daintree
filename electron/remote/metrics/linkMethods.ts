import { z } from "zod";

/** Bounds on what one host answers, so a busy host can't flood a Shell. */
export const MAX_FLEET_TARGETS = 500;
export const MAX_HOST_WORKTREES = 2000;
export const MAX_FLEET_SUBMIT_CHARS = 1024 * 1024;

/**
 * Session-level methods behind the hosts overview and the fleet features.
 * They ride every session, including a summary-only one with no view bound,
 * so a Shell can reach a host it isn't showing.
 */
export const MetricsLinkMethod = {
  /** Host → Shell: an agent on the host needs someone. The host decided; the Shell presents. */
  ATTENTION: "host.attention",
  /** Shell → Host: the host's agent runs, as fleet targets. */
  LIST_FLEET_TARGETS: "fleet.list-targets",
  /** Shell → Host: submit a fleet prompt to one of the host's agents. */
  SUBMIT_FLEET: "fleet.submit",
  /** Shell → Host: every worktree of the host's open projects. */
  LIST_WORKTREES: "host.list-worktrees",
} as const;

const id = z.string().min(1).max(256);
const name = z.string().max(1024);

export const AttentionPayloadSchema = z.object({
  kind: z.literal("waiting"),
  terminalId: id,
  projectName: name.nullable(),
  agentName: name.nullable(),
  /** The host's own quiet hours hold this back: the Shell files it in the inbox without a toast. */
  quiet: z.boolean(),
});
export type AttentionPayload = z.infer<typeof AttentionPayloadSchema>;

const FLEET_OP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** A Shell-minted fleet opId, or null when absent or malformed. */
export function normalizeFleetOpId(value: unknown): string | null {
  return typeof value === "string" && FLEET_OP_ID_PATTERN.test(value) ? value : null;
}

export const SubmitFleetPayloadSchema = z.object({
  terminalId: id,
  text: z.string().min(1).max(MAX_FLEET_SUBMIT_CHARS),
  /** The Shell's id for this one submit: a resend with it never types the prompt twice. */
  opId: z.string().regex(FLEET_OP_ID_PATTERN).nullish(),
});

const agentState = z.enum(["idle", "working", "waiting", "directing", "completed", "exited"]);

export const FleetTargetListSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            terminalId: id,
            title: name,
            projectId: id.nullable(),
            projectName: name.nullable(),
            agentId: id.nullable(),
            agentState: agentState.nullable(),
          })
          .strip()
      )
      .max(MAX_FLEET_TARGETS),
    complete: z.boolean(),
  })
  .strip();

const hostPath = z.string().min(1).max(4096);

export const WorktreeListSchema = z
  .array(
    z
      .object({
        projectId: id,
        projectName: name,
        worktreeId: z.string().min(1).max(4096),
        name,
        branch: name.nullable(),
        path: hostPath,
        isMainWorktree: z.boolean(),
        modifiedCount: z.number().int().min(0).nullable(),
        lastActivityAt: z.number().finite().nullable(),
      })
      .strip()
  )
  .max(MAX_HOST_WORKTREES);
