import { worktreeClient } from "@/clients";
import type { FileChangeDetail, WorktreeChanges } from "@shared/types/git";
import type { SubmoduleDeleteRisk } from "@shared/types/submodule";
import { MCP_PREVIEW_CAUTION_PREFIX } from "@/lib/mcpPreviewLines";

/**
 * Canonical fresh preview for the worktree-delete confirm surfaces (#11343).
 *
 * Both the local `WorktreeDeleteDialog` and the MCP confirm surface must decide
 * the D2/D3 tier and render the changed-file preview from a LIVE git status —
 * a backgrounded worktree's cached snapshot can be ~30s stale, which is exactly
 * what lets a force-delete skip the typed-name gate and discard uncommitted
 * work. This module owns the one fresh fetch and the tracked/untracked
 * classification both surfaces share.
 */

/** Counts derived from a change set, split the way the D3 tier gate needs. */
export interface WorktreeChangeSummary {
  /** Tracked (non-untracked, non-ignored) changes — the D3 escalation input. */
  trackedChangeCount: number;
  /** Untracked files (D2-relevant, never D3 on their own — see #4927). */
  untrackedFileCount: number;
  hasTrackedChanges: boolean;
  hasUntrackedFiles: boolean;
}

/** A fresh delete preview: the change summary plus the raw file list. */
export interface WorktreeDeletePreview extends WorktreeChangeSummary {
  changes: FileChangeDetail[];
  /**
   * Absolute worktree root, carried so previews can render each file relative
   * to it. `FileChangeDetail.path` arrives ABSOLUTE from the only producer
   * (`electron/utils/git.ts` resolves every entry against the git root), which
   * is why the rest of the renderer derives a `relativePath` before display —
   * see `src/lib/workingTreeDiff.ts`. Without the root, a preview repeats the
   * whole worktree path on every row and buries the filename.
   */
  rootPath: string;
  /**
   * What the same delete would destroy INSIDE this worktree's submodules —
   * work the parent's `git status` either describes as a single ` M vendor/lib`
   * row or cannot see at all. Never optional: a preview that could omit it
   * would let a caller read "absent" as "nothing at risk", which is the exact
   * misreading {@link WorktreeSubmoduleRiskState} exists to make impossible.
   */
  submodules: WorktreeSubmoduleRiskState;
}

/**
 * The submodule half of a delete preview, in the only two states a caller can
 * act on.
 *
 * There is deliberately no third "no submodules" state. `verified` with an
 * empty risk already says that, and adding a distinct spelling for it would
 * hand callers a shape to confuse with `unverified` — the failure mode this
 * union is built to prevent.
 *
 * `unverified` covers all three ways the inventory can fail to answer: the
 * fetch rejected, it resolved `null` (the monitor is gone, so nobody looked),
 * or the host completed a partial walk and set `incomplete`. The partial walk
 * still carries its `risk`, because half an inventory is real evidence — it is
 * just not a floor.
 */
export type WorktreeSubmoduleRiskState =
  | { status: "verified"; risk: SubmoduleDeleteRisk }
  | { status: "unverified"; risk: SubmoduleDeleteRisk | null };

/**
 * A preview whose PARENT status fetch failed, carrying whatever the submodule
 * arm managed to establish on its own.
 *
 * The two fetches are independent and only one of them failed, so the surviving
 * answer is real evidence. A `verified` one is as good here as on the happy
 * path: the host runs the same inventory at delete time and will refuse, or
 * demand force, on exactly what it reports.
 */
export class WorktreeDeletePreviewError extends Error {
  readonly submodules: WorktreeSubmoduleRiskState;

  constructor(submodules: WorktreeSubmoduleRiskState, cause: unknown) {
    super("Worktree delete preview could not read the parent status", { cause });
    this.name = "WorktreeDeletePreviewError";
    this.submodules = submodules;
  }
}

/** The submodule half of a failed preview, or `null` when it failed too. */
export function submodulesFromPreviewError(error: unknown): WorktreeSubmoduleRiskState | null {
  return error instanceof WorktreeDeletePreviewError ? error.submodules : null;
}

/** Max at-risk commit rows shown before the tail is collapsed. */
export const SUBMODULE_COMMIT_LIMIT = 5;

/**
 * Why the host will refuse this delete outright, or `null` when it won't.
 *
 * This is a "blocked" state, NOT a tier. A tier asks for consent proportional
 * to the damage; these two states have no consent that makes them safe, because
 * `WorkspaceService.guardSubmoduleDelete` throws on both BEFORE it looks at
 * `force`. Offering a typed-name gate for them would take the user through the
 * most emphatic confirmation the app has and then hand them a toast.
 *
 * Mirrors `describeUnrecoverableSubmoduleLoss` in the host — including its
 * ordering, so the reason shown is the reason thrown. `incomplete` sits here
 * rather than with the working-tree content for the host's reason: a failed rev
 * walk sets it just as readily as an unreadable working tree, so an incomplete
 * inventory with no observed commits means "we could not tell whether commits
 * are at stake", never "none are".
 */
export type WorktreeSubmoduleDeleteBlock = "at-risk-commits" | "unverified";

export function submoduleDeleteBlock(
  state: WorktreeSubmoduleRiskState
): WorktreeSubmoduleDeleteBlock | null {
  // Observed commits are observed regardless of whether the walk finished, and
  // they carry the more specific remedy, so they win the ordering.
  if ((state.risk?.atRiskCommits.length ?? 0) > 0) return "at-risk-commits";
  if (state.status === "unverified") return "unverified";
  return null;
}

/**
 * True when the user's `force` is what stands between nested working-tree
 * content and its deletion — the one submodule state `force` genuinely consents
 * to, and the only one that still moves the tier.
 *
 * Deliberately NOT `requiresMechanicalForce`. That flag is about the mere
 * existence of `<gitdir>/modules`, which the host now supplies `--force` for on
 * its own account, so demanding the checkbox for it asked the user to consent to
 * nothing. The inverse matters more: an old-form submodule with an embedded
 * `.git` directory produces no modules directory at all, so the flag is false
 * while its dirty files are just as destroyed. The file count is the fact.
 *
 * Only on a completed inventory: an unverified one is blocked outright
 * ({@link submoduleDeleteBlock}), so there is no state left where this would be
 * deciding anything on evidence we do not have.
 */
export function submoduleForceRequired(state: WorktreeSubmoduleRiskState): boolean {
  return state.status === "verified" && submoduleFileCount(state) > 0;
}

/**
 * True when the at-risk commit list is a FLOOR rather than a total.
 *
 * The host marks the inventory incomplete when the rev walk hits its ceiling,
 * so a submodule holding two hundred unpushed commits arrives here as fifty
 * plus `incomplete`. Stating that fifty as the count is the same confident
 * undercount as the single `M vendor/lib` row this surface replaced, so every
 * sentence that names the number has to say "at least" instead.
 */
export function submoduleCommitsAreCapped(state: WorktreeSubmoduleRiskState): boolean {
  return state.status === "unverified" && (state.risk?.atRiskCommits.length ?? 0) > 0;
}

/** Total nested files (dirty + untracked) a delete would discard. */
export function submoduleFileCount(state: WorktreeSubmoduleRiskState): number {
  const risk = state.risk;
  if (!risk) return 0;
  return risk.dirtyFiles.length + risk.untrackedFiles.length;
}

/**
 * Split a change set into tracked/untracked counts. Ignored files never count
 * (they aren't part of the working tree the user cares about); untracked files
 * are surfaced separately because they gate the D2 preview but must NOT drive
 * the D3 typed-name gate on their own (regressing that collapse is #4927).
 */
export function summarizeWorktreeChanges(
  changes: FileChangeDetail[] | null | undefined
): WorktreeChangeSummary {
  const list = changes ?? [];
  const trackedChangeCount = list.filter(
    (c) => c.status !== "untracked" && c.status !== "ignored"
  ).length;
  const untrackedFileCount = list.filter((c) => c.status === "untracked").length;
  return {
    trackedChangeCount,
    untrackedFileCount,
    hasTrackedChanges: trackedChangeCount > 0,
    hasUntrackedFiles: untrackedFileCount > 0,
  };
}

/**
 * Force a fresh `git status` for the worktree and return its delete preview.
 *
 * Rejects if the fresh fetch fails or times out — callers MUST fail closed on
 * rejection (escalate the tier / warn), never silently fall back to the stale
 * cached snapshot, which would recreate the exact bug being fixed. Resolves
 * `null` only when the worktree's monitor no longer exists (already removed),
 * which callers may treat as "nothing to gate".
 */
export async function buildWorktreeDeletePreview(
  worktreeId: string
): Promise<WorktreeDeletePreview | null> {
  // Both fetches start together — the submodule inventory walks module
  // directories and is the slower of the two, and serialising them would add
  // its latency to a dialog the user is already waiting in front of.
  //
  // The submodule arm settles to `unverified` instead of rejecting: the
  // parent's status is what the fail-closed contract above is about, and
  // letting a submodule inventory failure reject the whole preview would turn
  // a partial answer into no answer, which is strictly less safe.
  const submodulePromise: Promise<WorktreeSubmoduleRiskState> = worktreeClient
    .getSubmoduleDeleteRisk(worktreeId)
    .then((risk) =>
      risk === null || risk.incomplete
        ? ({ status: "unverified", risk } as const)
        : ({ status: "verified", risk } as const)
    )
    .catch(() => ({ status: "unverified", risk: null }) as const);
  let fresh: WorktreeChanges | null;
  try {
    fresh = await worktreeClient.getFreshChanges(worktreeId);
  } catch (error) {
    // The two arms are independent, so a parent failure must not throw the
    // submodule answer away. It used to: the rejection propagated before the
    // settled submodule arm was ever read, and the dialog then rendered its
    // generic "couldn't verify" warning over an inventory that had completed
    // and found nested files. A force delete from that state destroys content
    // the D2 preview never showed, which is the one thing this module exists
    // to prevent. Carried on the error so the parent arm keeps rejecting and
    // callers keep their existing fail-closed branch.
    throw new WorktreeDeletePreviewError(await submodulePromise, error);
  }
  if (!fresh) {
    // Monitor gone — the worktree is already removed, so there is nothing left
    // to gate. Await the settled submodule arm anyway so it can never surface
    // as an unhandled rejection.
    await submodulePromise;
    return null;
  }
  const changes = fresh.changes ?? [];
  return {
    ...summarizeWorktreeChanges(changes),
    changes,
    rootPath: fresh.rootPath,
    submodules: await submodulePromise,
  };
}

/** Max file rows shown in a compact preview before collapsing the tail. */
export const PREVIEW_FILE_LIMIT = 12;

/**
 * Spoken form of each status. The visible column is a single glyph, which is
 * right for scanning and useless to a screen reader — without this a listener
 * hears a list of paths with no way to tell a deletion from an addition.
 */
export const STATUS_LABEL: Record<FileChangeDetail["status"], string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  conflicted: "Conflicted",
  untracked: "Untracked",
  ignored: "Ignored",
};

const STATUS_GLYPH: Record<FileChangeDetail["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  conflicted: "U",
  untracked: "?",
  ignored: "!",
};

/**
 * Strip the worktree root off an absolute change path.
 *
 * `FileChangeDetail.path` is absolute (see {@link WorktreeDeletePreview.rootPath}),
 * so a preview that renders it raw repeats the entire worktree path on every
 * row and pushes the only distinguishing part — the filename — past the wrap.
 * Mirrors `getRelativePath` in `src/lib/workingTreeDiff.ts`; a path that
 * escapes the root (or a root we weren't given) is left alone rather than
 * mangled, because showing a wrong path here is worse than showing a long one.
 */
function toDisplayPath(filePath: string, rootPath: string | undefined): string {
  if (!rootPath) return filePath;
  // Both separators: Daintree runs on Windows, where the producer emits
  // backslash paths. A `/`-only check left every Windows row absolute — the
  // exact defect this function exists to prevent, just on the other platform.
  const trimmed = rootPath.replace(/[/\\]+$/, "");
  for (const sep of ["/", "\\"]) {
    const root = trimmed + sep;
    if (filePath.startsWith(root)) return filePath.slice(root.length);
  }
  return filePath;
}

/**
 * Render a change set as capped, glyph-prefixed file rows (`  M src/app.ts`),
 * shared by the local delete dialog and the MCP preview so both show the same
 * actual content (the D2 "a count is insufficient" rule). Ignored files are
 * dropped — they're not part of what a delete discards.
 *
 * Pass `rootPath` to get worktree-relative rows; without it the raw (absolute)
 * paths are rendered, which is the legacy behaviour.
 */
export function formatWorktreeChangeRows(
  changes: FileChangeDetail[],
  limit: number = PREVIEW_FILE_LIMIT,
  rootPath?: string
): string[] {
  const shown = changes.filter((c) => c.status !== "ignored");
  const rows = shown
    .slice(0, limit)
    .map((c) => `  ${STATUS_GLYPH[c.status] ?? "?"} ${toDisplayPath(c.path, rootPath)}`);
  if (shown.length > limit) {
    rows.push(`  …and ${shown.length - limit} more`);
  }
  return rows;
}

/** One row of the rendered change preview, split so the UI can lay it out. */
export interface WorktreeChangeRow {
  /** Status glyph (`M`, `D`, `?`…) or `null` for the overflow tail row. */
  glyph: string | null;
  /** Spoken status ("Modified"), for assistive tech. `null` on the tail row. */
  statusLabel: string | null;
  /** Worktree-relative path, or the "…and N more" text on the tail row. */
  label: string;
  /** True for the synthesised overflow row, which is not a file. */
  isOverflow: boolean;
}

/**
 * The same capped, relativised preview as {@link formatWorktreeChangeRows},
 * but structured rather than pre-joined.
 *
 * The string form has to stay for the MCP confirm surface, which renders plain
 * text. A UI rendering those strings in a wrapping `<pre>` loses the row
 * boundary the moment a path is longer than the box: the continuation line
 * starts at the left edge, under the status column, so two long paths read as
 * four files and the glyph detaches from the name it belongs to. Structured
 * rows let the surface pin the glyph in its own column and hang the wrap under
 * the path (#11977).
 */
export function buildWorktreeChangeRows(
  changes: FileChangeDetail[],
  limit: number = PREVIEW_FILE_LIMIT,
  rootPath?: string
): WorktreeChangeRow[] {
  const shown = changes.filter((c) => c.status !== "ignored");
  const rows: WorktreeChangeRow[] = shown.slice(0, limit).map((c) => ({
    glyph: STATUS_GLYPH[c.status] ?? "?",
    statusLabel: STATUS_LABEL[c.status] ?? "Changed",
    label: toDisplayPath(c.path, rootPath),
    isOverflow: false,
  }));
  if (shown.length > limit) {
    rows.push({
      glyph: null,
      statusLabel: null,
      label: `…and ${shown.length - limit} more`,
      isOverflow: true,
    });
  }
  return rows;
}

/** One at-risk commit, split for layout. */
export interface SubmoduleCommitRow {
  /** Full OID. Identity — seven characters is short enough to collide. */
  oid: string;
  /** Git's own abbreviation, for display. */
  shortOid: string;
  subject: string;
  /** True for the synthesised overflow tail, which is not a commit. */
  isOverflow: boolean;
}

/** Git's own abbreviation length — the form every other tool prints. */
function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

/**
 * The nested files a delete would discard, as the same structured rows the
 * parent's change list uses.
 *
 * The paths arrive already prefixed with their submodule path, so they read as
 * `vendor/lib/src/main.c` — the whole point being that the parent's own status
 * collapses every one of them into a single ` M vendor/lib`.
 */
export function buildSubmoduleFileRows(
  risk: SubmoduleDeleteRisk | null,
  limit: number = PREVIEW_FILE_LIMIT
): WorktreeChangeRow[] {
  if (!risk) return [];
  const all: WorktreeChangeRow[] = [
    ...risk.dirtyFiles.map((path) => ({
      glyph: STATUS_GLYPH.modified,
      statusLabel: STATUS_LABEL.modified,
      label: path,
      isOverflow: false,
    })),
    ...risk.untrackedFiles.map((path) => ({
      glyph: STATUS_GLYPH.untracked,
      statusLabel: STATUS_LABEL.untracked,
      label: path,
      isOverflow: false,
    })),
  ];
  const rows = all.slice(0, limit);
  if (all.length > limit) {
    rows.push({
      glyph: null,
      statusLabel: null,
      label: `…and ${all.length - limit} more`,
      isOverflow: true,
    });
  }
  return rows;
}

/** The at-risk commits, capped, as structured rows. */
export function buildSubmoduleCommitRows(
  risk: SubmoduleDeleteRisk | null,
  limit: number = SUBMODULE_COMMIT_LIMIT
): SubmoduleCommitRow[] {
  if (!risk) return [];
  const rows: SubmoduleCommitRow[] = risk.atRiskCommits.slice(0, limit).map((commit) => ({
    oid: commit.oid,
    shortOid: shortOid(commit.oid),
    subject: commit.subject,
    isOverflow: false,
  }));
  if (risk.atRiskCommits.length > limit) {
    rows.push({
      oid: "",
      shortOid: "",
      subject: `…and ${risk.atRiskCommits.length - limit} more`,
      isOverflow: true,
    });
  }
  return rows;
}

/** `N commits` / `N files`, for a heading that must not overstate precision. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The submodule half of the MCP preview.
 *
 * Renders the real nested paths and the real commit subjects rather than a
 * count, for the same reason the parent list does — except the stakes are
 * higher here, because the parent's own status shows these two hundred files
 * as one row that reads as precise, and shows the commits as nothing at all.
 */
export function formatSubmodulePreviewLines(state: WorktreeSubmoduleRiskState): string[] {
  const lines: string[] = [];
  const risk = state.risk;
  const fileRows = buildSubmoduleFileRows(risk);
  const commitRows = buildSubmoduleCommitRows(risk);
  if (fileRows.length > 0) {
    lines.push(
      `Inside submodules — ${plural(submoduleFileCount(state), "file")} the parent's status shows as one entry:`
    );
    for (const row of fileRows) {
      lines.push(row.isOverflow ? `  ${row.label}` : `  ${row.glyph} ${row.label}`);
    }
  }
  if (commitRows.length > 0 && risk) {
    // "On no remote this clone knows about" and not "exists nowhere else":
    // the inventory can only prove a commit is unreachable from this module
    // repository's own remote-tracking refs. A commit someone already pushed
    // from another checkout looks identical from here, so the claim is scoped
    // to what was actually measured.
    //
    // Stated as a refusal, not a risk: the host throws on this before it reads
    // `force`, so an approver told the delete "may destroy" these commits would
    // be consenting to something that cannot happen either way.
    const count = risk.atRiskCommits.length;
    // "At least" when the walk was capped: the host reports a ceiling hit as an
    // incomplete inventory, and naming the retained length as the total there
    // understates it by however many it stopped short of.
    const capped = submoduleCommitsAreCapped(state);
    const measured = capped ? `at least ${plural(count, "commit")}` : plural(count, "commit");
    lines.push(
      `${MCP_PREVIEW_CAUTION_PREFIX}${measured} inside submodules ${count === 1 && !capped ? "is" : "are"} on no remote this clone knows about — the worktree cannot be deleted until ${count === 1 && !capped ? "it is" : "they are"} pushed:`
    );
    for (const row of commitRows) {
      lines.push(row.isOverflow ? `  ${row.subject}` : `  ${row.shortOid} ${row.subject}`);
    }
  }
  if (state.status === "unverified") {
    lines.push(
      `${MCP_PREVIEW_CAUTION_PREFIX}Could not finish checking this worktree's submodules — the worktree cannot be deleted until that check completes.`
    );
  }
  return lines;
}

/**
 * Render a preview as plain lines for the MCP confirm surface — a header
 * naming the tracked/untracked counts, then the actual file list (capped), so
 * the approver sees the real content a force-delete would discard rather than
 * just raw args (the #11343 MCP gap, and the D2 "preview of actual content"
 * rule). `null` means the fresh fetch could not be verified: surface that
 * explicitly rather than implying a clean tree.
 */
export function formatWorktreeDeletePreviewLines(preview: WorktreeDeletePreview | null): string[] {
  if (preview === null) {
    return [
      `${MCP_PREVIEW_CAUTION_PREFIX}Could not verify current changes — proceed with caution.`,
    ];
  }
  const { trackedChangeCount, untrackedFileCount, changes, rootPath, submodules } = preview;
  const submoduleLines = formatSubmodulePreviewLines(submodules);
  if (changes.length === 0) {
    // Only claim a clean tree when nothing nested contradicts it. Saying "No
    // uncommitted changes." above a list of submodule commits about to be
    // destroyed is the misleading-precision failure this whole surface exists
    // to avoid — the parent really IS clean in that state, which is the point.
    if (submoduleLines.length === 0) return ["No uncommitted changes."];
    return ["No uncommitted changes in the worktree itself.", ...submoduleLines];
  }
  const parts: string[] = [];
  if (trackedChangeCount > 0) {
    parts.push(
      `${trackedChangeCount} uncommitted tracked file${trackedChangeCount === 1 ? "" : "s"}`
    );
  }
  if (untrackedFileCount > 0) {
    parts.push(`${untrackedFileCount} untracked file${untrackedFileCount === 1 ? "" : "s"}`);
  }
  return [
    `${parts.join(" and ")}:`,
    ...formatWorktreeChangeRows(changes, PREVIEW_FILE_LIMIT, rootPath),
    ...submoduleLines,
  ];
}
