import { z } from "zod";
import type {
  CheckDestinationPayload,
  CloneAndOpenOutcome,
  CloneAndOpenPayload,
  DestinationCheck,
  HostCloneEnvironment,
  HostProjectOpened,
  PlaceWorktreePayload,
  ProjectIdentity,
  ProjectMatchCandidate,
  PushBranchOutcome,
  PushBranchPayload,
  SourceProjectDescription,
} from "../../../shared/types/ipc/projectMatch.js";
import type { OperationOutcome } from "../../../shared/types/remoteHosts.js";
import type { HostDirectoryListing, HostPickerRoots } from "../../../shared/types/ipc/hostFiles.js";

/**
 * Session CALL methods a Shell uses to move a project between its hosts.
 * They are session-level, not view-level: the target host has no view of the
 * project yet. Every payload is validated on the host and every answer on
 * the Shell.
 */
export const ProjectLinkMethod = {
  DESCRIBE_SOURCE: "projects.describe-source",
  PUSH_BRANCH: "projects.push-branch",
  /** Kill the push this session started under that opId. */
  PUSH_CANCEL: "projects.push-cancel",
  ENVIRONMENT: "projects.environment",
  MATCH: "projects.match",
  CHECK_DESTINATION: "projects.check-destination",
  SUGGEST_DESTINATION: "projects.suggest-destination",
  /** Starts the clone-and-open operation and answers at once; progress is polled by opId. */
  START_CLONE: "projects.start-clone",
  OPERATION_STATUS: "projects.operation-status",
  OPERATION_CANCEL: "projects.operation-cancel",
  OPEN: "projects.open",
  CHECK_OUT: "projects.check-out",
  BUNDLE_CREATE: "projects.bundle-create",
  /** The host sends one of its bundles to the Shell, into a sink the Shell minted. */
  BUNDLE_SEND: "projects.bundle-send",
  /** The host mints a token its transfer sink accepts one bundle for. */
  BUNDLE_EXPECT: "projects.bundle-expect",
  BUNDLE_DISCARD: "projects.bundle-discard",
  /** A project's remotes and committed id, for another host to match it by. */
  IDENTIFY: "projects.identify",
  /** Registered projects only (no disk scan): cheap enough for a menu to ask. */
  FIND: "projects.find",
  /** Starts creating a placed worktree and answers at once; followed by opId like a clone. */
  START_PLACE_WORKTREE: "projects.start-place-worktree",
  /** The host's own folder listing, for Daintree's picker browsing it from another host's window. */
  LIST_DIRECTORY: "projects.list-directory",
  PICKER_ROOTS: "projects.picker-roots",
} as const;

/**
 * What only crosses the link. The host mints a destination grant for a free
 * folder it checked for this session, and a clone starts only into a granted
 * folder; a push carries the opId its cancel names.
 */
export type LinkCheckDestinationPayload = CheckDestinationPayload & { mintGrant?: boolean };
export type LinkDestinationCheck = DestinationCheck & { grant?: string | null };
export type LinkStartClonePayload = CloneAndOpenPayload & { destinationGrant?: string | null };
export type LinkPushBranchPayload = PushBranchPayload & { opId?: string };

/** Transfer destinations for bundles, each followed by the receiver's token. */
export const BUNDLE_SINK_PREFIX = "daintree-bundle:";

const text = (max: number) => z.string().max(max);
const hostPath = z.string().min(1).max(4096);
const projectId = z.string().min(1).max(256);
const opId = z.string().min(1).max(128);
const token = z.string().regex(/^[0-9a-f]{32}$/);
const branchName = z.string().min(1).max(512);
const remoteUrls = z.array(z.string().max(4096)).max(64);
const remotes = z.array(z.object({ name: text(256), url: text(4096) })).max(64);

const branchTarget = z.object({ name: branchName, remoteBranch: branchName });

export const DescribeSourceSchema = z.object({ projectId, worktreePath: hostPath.nullable() });
export const PushBranchSchema = z.object({
  projectId,
  worktreePath: hostPath,
  branch: branchName,
  remote: z.string().min(1).max(256),
  remoteBranch: branchName,
  opId: opId.optional(),
});
export const EmptySchema = z.union([z.null(), z.undefined(), z.object({}).strict()]);
export const MatchSchema = z.object({ remoteUrls, committedProjectId: projectId.nullable() });
export const CheckDestinationSchema = z.object({
  path: hostPath,
  remoteUrls,
  mintGrant: z.boolean().optional(),
});
export const SuggestDestinationSchema = z.object({
  homeRelativePath: hostPath.nullable(),
  repoName: z.string().min(1).max(255),
  remoteUrls,
});
export const StartCloneSchema = z.object({
  opId,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("remote"), url: z.string().min(1).max(4096) }),
    z.object({ kind: z.literal("bundle"), token }),
  ]),
  destination: hostPath,
  branch: branchTarget.nullable(),
  options: z.object({
    submodules: z.boolean(),
    depth: z.enum(["full", "shallow", "partial"]),
  }),
  setupRecipeId: z.string().min(1).max(256).nullable(),
  destinationGrant: token.nullable().optional(),
});
export const OpIdSchema = z.object({ opId });
export const OpenSchema = z.object({
  projectId: projectId.nullable(),
  path: hostPath,
  remoteUrls,
  branch: branchTarget.nullable(),
  branchRemoteUrl: z.string().max(4096).nullable(),
});
export const CheckOutSchema = z.object({
  projectId,
  branch: branchTarget,
  branchRemoteUrl: z.string().max(4096).nullable(),
});
export const BundleCreateSchema = z.object({ projectId });
export const IdentifySchema = z.object({ projectId });
export const StartPlaceWorktreeSchema: z.ZodType<PlaceWorktreePayload> = z.object({
  opId,
  projectId,
  worktree: z.object({
    newBranch: branchName,
    baseBranch: branchName,
    fromRemote: z.boolean(),
    useExistingBranch: z.boolean(),
    relativePath: z.string().min(1).max(1024).nullable(),
    recipeId: z.string().min(1).max(256).nullable(),
  }),
});
export const ListDirectorySchema = z.object({ path: hostPath, showHidden: z.boolean().optional() });
export const BundleSendSchema = z.object({ token, sinkToken: token });
export const BundleTokenSchema = z.object({ token });

// Answers, checked on the Shell before anything reaches a renderer.

const branchCheck = z.union([
  z.object({ kind: z.literal("same-tip"), remote: text(256), sha: text(128) }),
  z.object({ kind: z.literal("ahead"), remote: text(256), ahead: z.number().int().min(0) }),
  z.object({ kind: z.literal("diverged"), remote: text(256) }),
  z.object({
    kind: z.literal("not-on-remote"),
    remote: text(256).nullable(),
    upstream: text(1024).nullable(),
  }),
  z.object({
    kind: z.literal("remote-unreachable"),
    remote: text(256).nullable(),
    detail: text(8192).nullable(),
  }),
  z.object({ kind: z.literal("detached") }),
  z.object({
    kind: z.literal("behind"),
    remote: text(256),
    behind: z.number().int().min(0),
    sha: text(128),
  }),
]);

export const SourceDescriptionSchema: z.ZodType<SourceProjectDescription> = z.object({
  projectId,
  projectName: text(1024),
  projectPath: hostPath,
  worktreePath: hostPath,
  branch: text(512).nullable(),
  branchCheck: branchCheck.nullable(),
  remoteBranch: text(512).nullable(),
  remote: text(256).nullable(),
  cloneUrl: text(4096).nullable(),
  hasUncommittedChanges: z.boolean(),
  unpushedCommits: z.array(z.object({ sha: text(64), subject: text(1024) })).max(50),
  remotes,
  committedProjectId: projectId.nullable(),
  homeRelativePath: hostPath.nullable(),
  repoName: z.string().min(1).max(255),
  usesLfs: z.boolean(),
  hasSubmodules: z.boolean(),
  recipes: z.array(z.object({ id: text(256), name: text(1024) })).max(500),
  defaultRecipeId: text(256).nullable(),
});

export const PushOutcomeSchema: z.ZodType<PushBranchOutcome> = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: text(128), message: text(16384) }),
]);

export const EnvironmentSchema: z.ZodType<HostCloneEnvironment> = z.object({
  homeDir: hostPath,
  projectsDir: hostPath,
  gitLfsAvailable: z.boolean(),
});

export const CandidatesSchema: z.ZodType<ProjectMatchCandidate[]> = z
  .array(
    z.object({
      projectId: projectId.nullable(),
      path: hostPath,
      name: text(1024),
      remotes,
      source: z.enum(["registered", "on-disk"]),
      matchedBy: z.enum(["remote-url", "committed-id"]),
      lastOpenedAt: z.number().nullable(),
    })
  )
  .max(200);

export const DestinationSchema: z.ZodType<LinkDestinationCheck> = z.object({
  path: z.string().max(4096),
  status: z.enum(["free", "same-repository", "occupied", "invalid"]),
  detail: text(1024).nullable(),
  suggestion: hostPath.nullable(),
  grant: token.nullable().optional(),
});

const openedFields = {
  projectId,
  projectPath: hostPath,
  projectName: text(1024),
  worktreePath: hostPath.nullable(),
  canCheckOutBranch: z.boolean(),
  branchNote: text(16384).nullable(),
  setupRecipeId: text(256).nullable(),
};

export const OpenedSchema: z.ZodType<HostProjectOpened> = z.object(openedFields);

export const CloneOutcomeSchema: z.ZodType<CloneAndOpenOutcome> = z.union([
  z.object({ ok: z.literal(true), ...openedFields }),
  z.object({ ok: z.literal(false), reason: text(128), message: text(16384) }),
]);

export const OperationOutcomeSchema: z.ZodType<OperationOutcome> = z.union([
  z.object({
    status: z.literal("running"),
    progress: z
      .object({
        opId,
        kind: text(64),
        fraction: z.number().nullable(),
        stage: text(256).nullable(),
        message: text(4096).nullable(),
        at: z.number(),
      })
      .nullable(),
  }),
  z.object({ status: z.literal("succeeded"), result: z.unknown(), settledAt: z.number() }),
  z.object({
    status: z.literal("failed"),
    error: z.object({ code: text(128).nullable(), message: text(16384) }),
    settledAt: z.number(),
  }),
  z.object({ status: z.literal("cancelled"), settledAt: z.number() }),
  z.object({ status: z.literal("unknown") }),
]) as z.ZodType<OperationOutcome>;

export const BundleCreatedSchema = z.object({ token, size: z.number().int().min(0) });
export const BundleExpectedSchema = z.object({ token });

export const IdentitySchema: z.ZodType<ProjectIdentity> = z.object({
  remotes,
  committedProjectId: projectId.nullable(),
});

export const ListingSchema: z.ZodType<HostDirectoryListing> = z.object({
  path: hostPath,
  parent: hostPath.nullable(),
  entries: z
    .array(
      z.object({
        name: text(4096),
        kind: z.enum(["file", "directory", "symlink", "other"]),
        size: z.number().nullable(),
        mtimeMs: z.number().nullable(),
      })
    )
    .max(5000),
  truncated: z.boolean(),
});

export const PickerRootsSchema: z.ZodType<HostPickerRoots> = z.object({
  home: hostPath,
  projectsDir: hostPath.nullable(),
  roots: z.array(z.object({ label: text(256), path: hostPath })).max(64),
});
