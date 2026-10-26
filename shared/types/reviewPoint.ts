import { z } from "zod";

/**
 * A review point: what one worktree held at one moment, captured without
 * writing to the repository (#14582). Comparing a worktree against one (#14583)
 * and keeping one as a review mark (#14584) both read this shape, and a stored
 * mark is validated against it, since the file it lives in is user-editable.
 *
 * Scope is the branch's change set: every path that differs between the merge
 * base and HEAD, in the index, or in the working tree, untracked files
 * included. A path that is not listed was, as git compares it, the same in
 * HEAD, the index and the working tree as at every merge base. Clean and
 * process filters never run during a capture, so that comparison never runs a
 * repository's own programs.
 *
 * A listed path's working-tree identity is the git blob id of its raw bytes on
 * disk, never git's "matches the index", which is a comparison after line-ending
 * conversion and filters and can call two different files equal. Being
 * content-addressed, that id resolves in git only to exactly those bytes.
 */

export const REVIEW_POINT_VERSION = 1;

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** A tracked path's entry in a tree or the index. */
const gitEntry = z.object({
  mode: z.enum(["100644", "100755", "120000", "160000"]),
  oid,
});

const reviewPointPath = {
  /**
   * The repository-relative path as git spells it, `/`-separated. Exact when
   * `pathBytes` is absent; when present this is a display form only.
   */
  path: z
    .string()
    .min(1)
    .max(16_384)
    .refine((value) => !value.startsWith("/") && !value.includes("\0")),
  /** Base64 of the exact path bytes, only when they are not valid UTF-8. */
  pathBytes: z.string().max(22_000).optional(),
};

const indexIdentity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("entry"), ...gitEntry.shape }),
  /** `git add -N`: tracked, with no content staged yet. */
  z.object({ kind: z.literal("intent-to-add") }),
  z.object({
    kind: z.literal("conflicted"),
    stages: z
      .array(z.object({ stage: z.union([z.literal(1), z.literal(2), z.literal(3)]), ...gitEntry.shape }))
      .min(1)
      .max(3),
  }),
]);

export const REVIEW_POINT_UNVERIFIABLE_REASONS = [
  /** Larger than the per-file limit. */
  "file-too-large",
  /** The capture's total byte budget ran out first. */
  "byte-limit",
  /** The capture's time budget ran out first. */
  "deadline",
  "unreadable",
  /** A FIFO, socket or device: never opened. */
  "special-file",
] as const;

export type ReviewPointUnverifiableReason = (typeof REVIEW_POINT_UNVERIFIABLE_REASONS)[number];

const worktreeIdentity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  /** `oid` is the blob id of the raw bytes, with no filter or conversion. */
  z.object({
    kind: z.literal("file"),
    mode: z.enum(["100644", "100755"]),
    oid,
    size: z.number().int().nonnegative(),
  }),
  /** `oid` is the blob id of the link text. The target is never followed. */
  z.object({ kind: z.literal("symlink"), oid }),
  /** A directory where a file or link was tracked; its files are paths of their own. */
  z.object({ kind: z.literal("directory") }),
  z.object({
    kind: z.literal("submodule"),
    /** The commit checked out inside it, or null when it isn't populated. */
    commit: oid.nullable(),
    /**
     * Whether anything inside it differs from that commit. Only `clean` is a
     * claim about its contents; `dirty` and `unknown` mean they aren't covered.
     */
    contents: z.enum(["clean", "dirty", "unknown"]),
  }),
  z.object({ kind: z.literal("unverifiable"), reason: z.enum(REVIEW_POINT_UNVERIFIABLE_REASONS) }),
]);

const entry = z.object({
  ...reviewPointPath,
  /** The path in the HEAD commit, or null when HEAD doesn't have it. */
  head: gitEntry.nullable(),
  index: indexIdentity,
  worktree: worktreeIdentity,
});

export const REVIEW_POINT_GAP_REASONS = [
  ...REVIEW_POINT_UNVERIFIABLE_REASONS,
  /** Past the limit on paths, so it has no entry at all. */
  "path-limit",
  /** An untracked repository nested in the worktree; git doesn't list inside it. */
  "nested-repository",
  /** An untracked directory listed whole because its files were too many to list. */
  "untracked-directory",
  /** A submodule whose contents differ from its commit, or couldn't be checked. */
  "submodule-contents",
] as const;

export type ReviewPointGapReason = (typeof REVIEW_POINT_GAP_REASONS)[number];

export const REVIEW_POINT_INCOMPLETE_REASONS = [
  ...REVIEW_POINT_GAP_REASONS,
  /** No base ref resolved, so committed changes on the branch aren't covered. */
  "base-unavailable",
  /** The change set was too large to list at all. */
  "change-set-too-large",
] as const;

export type ReviewPointIncompleteReason = (typeof REVIEW_POINT_INCOMPLETE_REASONS)[number];

const head = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), branch: z.string().min(1), commit: oid }),
  z.object({ kind: z.literal("detached"), commit: oid }),
  z.object({ kind: z.literal("unborn"), branch: z.string().min(1) }),
]);

const baseRequest = z.discriminatedUnion("kind", [
  /** Resolved the way the worktree card's behind count resolves it. */
  z.object({ kind: z.literal("branch"), branch: z.string().min(1) }),
  /** A fully qualified ref, taken as given. */
  z.object({ kind: z.literal("ref"), ref: z.string().startsWith("refs/") }),
]);

export const ReviewPointSchema = z.object({
  version: z.literal(REVIEW_POINT_VERSION),
  /** Epoch ms when the capture finished and its state was last confirmed. */
  capturedAt: z.number().int().nonnegative(),
  /** The worktree's top level, as the host spells it. */
  worktreePath: z.string().min(1),
  /** The worktree's own git dir. */
  gitDir: z.string().min(1),
  /** The repository every worktree of it shares. */
  commonDir: z.string().min(1),
  objectFormat: z.enum(["sha1", "sha256"]),
  head,
  base: z.object({
    requested: baseRequest,
    /** The fully qualified ref it resolved to, or null when none exists. */
    ref: z.string().startsWith("refs/").nullable(),
    tip: oid.nullable(),
    /**
     * Every best common ancestor of HEAD and the tip; the change set covers all
     * of them. Empty for an unborn branch or unrelated histories, when every
     * path in HEAD is in the change set.
     */
    mergeBases: z.array(oid).max(64),
  }),
  /** Sorted by path bytes, one per path. */
  entries: z.array(entry),
  /** Null when the point covers its whole change set. */
  incomplete: z
    .object({
      reasons: z.array(z.enum(REVIEW_POINT_INCOMPLETE_REASONS)).min(1),
      /**
       * Paths it couldn't cover, a directory ending in `/` for a whole subtree.
       * Listed up to a cap; `uncoveredCount` is the full number, or null when
       * the change set couldn't be listed and the number is unknown.
       */
      uncovered: z.array(z.object({ ...reviewPointPath, reason: z.enum(REVIEW_POINT_GAP_REASONS) })),
      uncoveredCount: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
});

export type ReviewPoint = z.infer<typeof ReviewPointSchema>;
export type ReviewPointEntry = ReviewPoint["entries"][number];
export type ReviewPointGitEntry = z.infer<typeof gitEntry>;
export type ReviewPointIndexIdentity = z.infer<typeof indexIdentity>;
export type ReviewPointWorktreeIdentity = z.infer<typeof worktreeIdentity>;
export type ReviewPointHead = ReviewPoint["head"];
export type ReviewPointBaseRequest = z.infer<typeof baseRequest>;
export type ReviewPointIncomplete = NonNullable<ReviewPoint["incomplete"]>;
export type ReviewPointUncovered = ReviewPointIncomplete["uncovered"][number];

export type ReviewPointCaptureFailure =
  | "not-a-repository"
  | "invalid-request"
  | "cancelled"
  | "deadline"
  | "git-failed";

export type ReviewPointCaptureResult =
  | { kind: "captured"; point: ReviewPoint }
  /** The worktree, index or HEAD moved while the capture ran; nothing mixed is returned. */
  | { kind: "changed-during-capture" }
  | { kind: "failed"; reason: ReviewPointCaptureFailure; message: string };

/** One key per path, exact in bytes, for matching entries across review points. */
export function reviewPointPathKey(path: { path: string; pathBytes?: string }): string {
  return path.pathBytes === undefined ? `u:${path.path}` : `b:${path.pathBytes}`;
}
