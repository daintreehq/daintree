import { z } from "zod";

/**
 * A review point: what one worktree held at one moment, captured without
 * writing to the repository (#14582). Comparing a worktree against one (#14583)
 * and keeping one as a review mark (#14584) both read this shape, and a stored
 * mark is validated against it, since the file it lives in is user-editable.
 *
 * Scope is the branch's change set: every path that differs between the merge
 * base and HEAD, in the index, or in the working tree, untracked files
 * included. In a complete point (`incomplete: null`), a path that isn't listed
 * was the same in HEAD, the index and the working tree as at every merge base,
 * as git compares them: line endings converted, and with clean and process
 * filters switched off, so the comparison never runs a repository's own
 * programs. An incomplete point makes no claim about a path it doesn't list:
 * it names what it couldn't cover only up to a cap, and when listing failed
 * outright it can't name them at all.
 *
 * A listed path's working-tree identity is the git blob id of its raw bytes on
 * disk, never git's "matches the index", which is a comparison after line-ending
 * conversion and filters and can call two different files equal. Being
 * content-addressed, that id resolves in git only to exactly those bytes.
 */

export const REVIEW_POINT_VERSION = 1;

const OID_LENGTH = { sha1: 40, sha256: 64 } as const;
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
  path: z.string().min(1).max(16_384),
  /** Base64 of the exact path bytes, present only when they are not valid UTF-8. */
  pathBytes: z.string().max(22_000).optional(),
};

const encoder = new TextEncoder();
// `ignoreBOM`: a name may start with U+FEFF, and that is part of the name.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * The exact bytes a path stands for, or null when its two fields don't describe
 * one path consistently. Bytes are carried only for names that aren't valid
 * UTF-8, in canonical base64 with `path` as their display form, so every path
 * has exactly one spelling.
 */
export function reviewPointPathBytes(value: {
  path: string;
  pathBytes?: string;
}): Uint8Array | null {
  if (value.pathBytes === undefined) {
    const bytes = encoder.encode(value.path);
    // A lone surrogate encodes as U+FFFD, which git never wrote.
    return lenientUtf8.decode(bytes) === value.path ? bytes : null;
  }
  let binary: string;
  try {
    binary = atob(value.pathBytes);
  } catch {
    return null;
  }
  if (btoa(binary) !== value.pathBytes) return null;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    strictUtf8.decode(bytes);
    return null;
  } catch {
    // Not valid UTF-8, which is the only reason to carry bytes.
  }
  return lenientUtf8.decode(bytes) === value.path ? bytes : null;
}

/** One key per path, exact in bytes, for matching entries across review points. */
export function reviewPointPathKey(path: { path: string; pathBytes?: string }): string {
  return path.pathBytes === undefined ? `u:${path.path}` : `b:${path.pathBytes}`;
}

/** Relative, no `.`, `..` or empty segments; a trailing `/` only where a directory may stand. */
function isRepositoryPath(bytes: Uint8Array, allowDirectory: boolean): boolean {
  if (bytes.length === 0 || bytes.includes(0)) return false;
  let current: number[] = [];
  const segments: number[][] = [current];
  for (const byte of bytes) {
    if (byte === 0x2f) {
      current = [];
      segments.push(current);
    } else {
      current.push(byte);
    }
  }
  if (allowDirectory && segments.length > 1 && current.length === 0) segments.pop();
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      !(segment.length === 1 && segment[0] === 0x2e) &&
      !(segment.length === 2 && segment[0] === 0x2e && segment[1] === 0x2e)
  );
}

function comparePathBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function checkPath(
  value: { path: string; pathBytes?: string },
  ctx: z.RefinementCtx,
  allowDirectory: boolean
): void {
  const bytes = reviewPointPathBytes(value);
  if (!bytes || !isRepositoryPath(bytes, allowDirectory)) {
    ctx.addIssue({ code: "custom", message: "Not a repository-relative path", path: ["path"] });
  }
}

const indexIdentity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("entry"), ...gitEntry.shape }),
  /** `git add -N`: tracked, with no content staged yet. */
  z.object({ kind: z.literal("intent-to-add"), mode: gitEntry.shape.mode }),
  z.object({
    kind: z.literal("conflicted"),
    stages: z
      .array(
        z.object({ stage: z.union([z.literal(1), z.literal(2), z.literal(3)]), ...gitEntry.shape })
      )
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

const entry = z
  .object({
    ...reviewPointPath,
    /** The path in the HEAD commit, or null when HEAD doesn't have it. */
    head: gitEntry.nullable(),
    index: indexIdentity,
    worktree: worktreeIdentity,
  })
  .superRefine((value, ctx) => checkPath(value, ctx, false));

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
  /** Part of the change set was too large to list at all. */
  "change-set-too-large",
] as const;

export type ReviewPointIncompleteReason = (typeof REVIEW_POINT_INCOMPLETE_REASONS)[number];

/**
 * A ref or branch name, by git's own rule: no ASCII control characters or
 * space, none of `~^:?*[\`, no `..` or `@{`. Anything else, non-ASCII spaces
 * included, git accepts.
 */
function isRefName(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return !/[~^:?*[\\]|\.\.|@\{/.test(value) && !value.startsWith("-");
}

const refName = z.string().min(1).max(1024).refine(isRefName);

const fullRef = refName.refine((value) => value.startsWith("refs/"));

const head = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), branch: refName, commit: oid }),
  z.object({ kind: z.literal("detached"), commit: oid }),
  z.object({ kind: z.literal("unborn"), branch: refName }),
]);

const baseRequest = z.discriminatedUnion("kind", [
  /** Resolved the way the worktree card's behind count resolves it. */
  z.object({ kind: z.literal("branch"), branch: refName }),
  /** A fully qualified ref, taken as given. */
  z.object({ kind: z.literal("ref"), ref: fullRef }),
]);

const uncovered = z
  .object({ ...reviewPointPath, reason: z.enum(REVIEW_POINT_GAP_REASONS) })
  .superRefine((value, ctx) => checkPath(value, ctx, true));

const ReviewPointShape = z.object({
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
    ref: fullRef.nullable(),
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
       * part of the change set couldn't be listed and the number is unknown.
       */
      uncovered: z.array(uncovered),
      uncoveredCount: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
});

/**
 * What a captured point always satisfies across its fields, so a stored one
 * edited into something no capture produces is refused rather than compared
 * against.
 */
function checkPoint(point: z.infer<typeof ReviewPointShape>, ctx: z.RefinementCtx): void {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const { base, head, incomplete } = point;
  const oids: string[] = [...base.mergeBases];
  if (head.kind !== "unborn") oids.push(head.commit);
  if (base.tip) oids.push(base.tip);

  if ((base.ref === null) !== (base.tip === null)) fail("A base ref and its tip go together");
  if (base.tip === null && base.mergeBases.length > 0) fail("Merge bases need a base tip");
  if (new Set(base.mergeBases).size !== base.mergeBases.length) fail("Duplicate merge base");
  if (head.kind === "unborn" && base.mergeBases.length > 0) {
    fail("An unborn branch has no merge base");
  }

  const reasons = new Set<string>(incomplete?.reasons ?? []);
  if (incomplete && reasons.size !== incomplete.reasons.length) fail("Duplicate reason");

  let previous: Uint8Array | null = null;
  for (const item of point.entries) {
    const bytes = reviewPointPathBytes(item);
    if (bytes && previous && comparePathBytes(previous, bytes) >= 0) {
      fail("Entries are sorted by path bytes, one per path");
    }
    previous = bytes;

    if (item.head) oids.push(item.head.oid);
    if (head.kind === "unborn" && item.head) fail("An unborn branch's HEAD has no paths");
    if (item.index.kind === "entry") oids.push(item.index.oid);
    if (item.index.kind === "conflicted") {
      const stages = item.index.stages.map((stage) => stage.stage);
      if (stages.some((stage, i) => i > 0 && stage <= (stages[i - 1] ?? 0))) {
        fail("Conflict stages repeat");
      }
      oids.push(...item.index.stages.map((stage) => stage.oid));
    }

    const { worktree } = item;
    if (worktree.kind === "file" || worktree.kind === "symlink") oids.push(worktree.oid);
    if (worktree.kind === "submodule" && worktree.commit) oids.push(worktree.commit);
    const gap =
      worktree.kind === "unverifiable"
        ? worktree.reason
        : worktree.kind === "submodule" && worktree.contents !== "clean"
          ? "submodule-contents"
          : null;
    if (gap && !reasons.has(gap)) fail("An uncovered entry's reason is missing");
  }

  if (oids.some((value) => value.length !== OID_LENGTH[point.objectFormat])) {
    fail("Object ids don't match the object format");
  }

  if (incomplete) {
    for (const gap of incomplete.uncovered) {
      if (!reasons.has(gap.reason)) fail("An uncovered path's reason is missing");
    }
    const keys = new Set(incomplete.uncovered.map(reviewPointPathKey));
    if (keys.size !== incomplete.uncovered.length) fail("Duplicate uncovered path");
    if (incomplete.uncoveredCount !== null && incomplete.uncoveredCount < keys.size) {
      fail("Fewer uncovered paths counted than listed");
    }
  }
}

export const ReviewPointSchema = ReviewPointShape.superRefine(checkPoint);

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
  "not-a-repository" | "invalid-request" | "cancelled" | "deadline" | "git-failed";

export type ReviewPointCaptureResult =
  | { kind: "captured"; point: ReviewPoint }
  /** The worktree, index or HEAD moved while the capture ran; nothing mixed is returned. */
  | { kind: "changed-during-capture" }
  | { kind: "failed"; reason: ReviewPointCaptureFailure; message: string };
