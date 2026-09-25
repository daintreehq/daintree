import path from "node:path";
import { z } from "zod";
import type {
  WorktreePortAction,
  WorktreePortResourceAction,
} from "../../../shared/types/worktree-port.js";

/**
 * What a remote endpoint may ask of its project's workspace host. Locally the
 * renderer is trusted and the port carries whatever it sends; over the link
 * the sender is another machine, so every request is held to the protocol in
 * `shared/types/worktree-port.ts` before it reaches the trusted port, and any
 * root path must be the endpoint's own project root.
 *
 * Worktree ids are not path-checked: a linked worktree can live anywhere on
 * disk, and the workspace host a bridge talks to is the one for the
 * endpoint's project, which holds monitors for that project's worktrees only.
 */

const requestId = z.union([z.string().min(1).max(256), z.number().int().min(0)]);
const worktreeId = z.string().min(1).max(4096);
const rootPath = z.string().min(1).max(4096);
const optionalEmpty = z.object({}).optional();

const RESOURCE_ACTIONS = [
  "provision",
  "teardown",
  "resume",
  "pause",
  "status",
] as const satisfies readonly WorktreePortResourceAction[];

const PAYLOAD_SCHEMAS = {
  "get-all-states": optionalEmpty,
  "set-active": z.object({ worktreeId, origin: z.string().max(256).optional() }),
  "set-agent-activity": z.object({ worktreeIds: z.array(worktreeId).max(1024) }),
  refresh: z.object({ worktreeId: worktreeId.optional() }).optional(),
  "create-worktree": z.object({
    rootPath,
    options: z.looseObject({
      baseBranch: z.string().max(1024),
      newBranch: z.string().max(1024),
      path: z.string().min(1).max(4096),
    }),
  }),
  "delete-worktree": z.object({
    worktreeId,
    force: z.boolean().optional(),
    deleteBranch: z.boolean().optional(),
    forceDeleteBranch: z.boolean().optional(),
    mutationId: z.string().min(1).max(256).optional(),
  }),
  "list-branches": z.object({ rootPath }),
  "get-recent-branches": z.object({ rootPath }),
  "refresh-prs": optionalEmpty,
  "reconcile-topology": z.object({ force: z.boolean().optional() }).optional(),
  "resource-action": z.object({ worktreeId, action: z.enum(RESOURCE_ACTIONS) }),
  "run-lifecycle-setup": z.object({ worktreeId }),
  "get-lifecycle-command-approval": z.object({ worktreeId }),
  "approve-lifecycle-commands": z.object({ worktreeId, fingerprint: z.string().min(1).max(512) }),
  "switch-worktree-environment": z.object({ worktreeId, envKey: z.string().min(1).max(256) }),
  "has-resource-config": z.object({ rootPath }),
  "get-worktree-changes": z.object({ worktreeId }),
  "get-submodule-delete-risk": z.object({ worktreeId }),
  "get-delete-teardown-preview": z.object({ worktreeId }),
  "report-switch-status-timing": z.object({
    switchId: z.string().min(1).max(256),
    epoch: z.string().min(1).max(256),
    appliedAt: z.number().finite().nullable(),
    worktreeCount: z.number().int().min(0),
    statusCount: z.number().int().min(0),
  }),
} satisfies Record<WorktreePortAction, z.ZodType>;

const ACTIONS = Object.keys(PAYLOAD_SCHEMAS) as [WorktreePortAction, ...WorktreePortAction[]];

const EnvelopeSchema = z.object({
  id: requestId,
  action: z.enum(ACTIONS),
  payload: z.unknown().optional(),
});

export type RemoteWorktreePortCheck =
  | { ok: true; request: { id: string | number; action: WorktreePortAction; payload: unknown } }
  | { ok: false; id: string | number | null; error: string };

function sameRoot(a: string, b: string): boolean {
  return path.isAbsolute(a) && path.resolve(a) === path.resolve(b);
}

/**
 * Validates one request from a remote endpoint. `projectRoot` is the root of
 * the endpoint's project, or null when it has none (nothing path-bearing is
 * then allowed). A refusal carries the request id when it had a usable one,
 * so the caller can fail that request instead of leaving it to time out.
 */
export function checkRemoteWorktreePortRequest(
  raw: unknown,
  projectRoot: string | null
): RemoteWorktreePortCheck {
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const id = requestId.safeParse((raw as { id?: unknown } | null)?.id);
    return { ok: false, id: id.success ? id.data : null, error: "Invalid worktree request" };
  }
  const { id, action } = envelope.data;
  const payload = PAYLOAD_SCHEMAS[action].safeParse(envelope.data.payload);
  if (!payload.success) {
    return { ok: false, id, error: `Invalid payload for ${action}` };
  }
  const data = payload.data as { rootPath?: unknown } | undefined;
  if (data && typeof data.rootPath === "string") {
    if (projectRoot === null || !sameRoot(data.rootPath, projectRoot)) {
      return { ok: false, id, error: "Path is outside this project" };
    }
  }
  return { ok: true, request: { id, action, payload: payload.data } };
}
