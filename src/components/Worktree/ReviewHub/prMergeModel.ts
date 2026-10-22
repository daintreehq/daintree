import type { PR, PRMergeIntent, PRMergeMethod } from "@shared/types/forge";
import type { ForgeRepoMetadataPayload } from "@shared/types/ipc/forge";

/**
 * `arm`: ask GitHub to merge once requirements pass ("Merge when ready").
 * `merge`: merge now, through the existing immediate merge. `cancel`: cancel a
 * pending auto-merge or take the PR out of the merge queue.
 */
export type PrMergeMode = "arm" | "merge" | "cancel";

export interface PrMergeRequest {
  mode: PrMergeMode;
  /** `null`: the forge's default, or the merge queue's own method. */
  method: PRMergeMethod | null;
}

export type PrMergeControlModel =
  | { kind: "hidden" }
  | { kind: "cancel"; intent: PRMergeIntent; disabledReason: string | null }
  | {
      kind: "arm" | "merge";
      /** The base branch merges through a queue, which picks the method. */
      queue: boolean;
      /** Methods to choose between; empty when there is no choice to offer. */
      methods: PRMergeMethod[];
      defaultMethod: PRMergeMethod | null;
      disabledReason: string | null;
    };

export const AUTO_MERGE_OFF_REASON =
  "Auto-merge is off for this repository (Settings › General › Allow auto-merge)";

export const MERGE_SETTINGS_UNREAD_REASON = "Couldn't read this repository's merge methods";

export const CANNOT_CANCEL_REASON =
  "GitHub doesn't let you cancel this merge — only its author and people with write access can";

/**
 * Whether GitHub would merge this PR now rather than arm it. `clean`,
 * `has_hooks` and `unstable` are the states GitHub refuses to arm and `gh pr
 * merge --auto` merges immediately; a queue branch always goes through the
 * queue.
 */
export function isImmediatelyMergeable(pr: PR): boolean {
  if (pr.mergeQueueRequired === true) return false;
  return (
    pr.mergeStatus === "clean" || pr.mergeStatus === "has_hooks" || pr.mergeStatus === "unstable"
  );
}

/** The mode a fresh read says the user's request now amounts to. */
export function effectiveMergeMode(pr: PR, requested: PrMergeMode): PrMergeMode {
  if (requested === "cancel") return "cancel";
  return isImmediatelyMergeable(pr) ? "merge" : "arm";
}

/**
 * What the merge control offers for a PR, from a read taken when the popover
 * opened. Hidden wherever GitHub wouldn't offer it either (draft, closed,
 * merged, conflicting), and when the read didn't carry a merge status at all.
 */
export function derivePrMergeControl(
  pr: PR | null,
  metadata: ForgeRepoMetadataPayload | null
): PrMergeControlModel {
  if (!pr || !metadata) return { kind: "hidden" };
  if (pr.state !== "open" || pr.merged || pr.isDraft) return { kind: "hidden" };

  if (pr.mergeIntent) {
    if (!metadata.autoMergeSupported) return { kind: "hidden" };
    return {
      kind: "cancel",
      intent: pr.mergeIntent,
      disabledReason: pr.viewerCanDisableAutoMerge === false ? CANNOT_CANCEL_REASON : null,
    };
  }

  if (!pr.mergeStatus || pr.mergeStatus === "dirty") return { kind: "hidden" };

  const queue = pr.mergeQueueRequired === true;
  const immediate = isImmediatelyMergeable(pr);
  if (!immediate && !metadata.autoMergeSupported) return { kind: "hidden" };

  const settings = metadata.mergeSettings;
  // No silent default: without the repository's own list there is no method
  // to preview, so a non-queue merge waits rather than guessing one.
  if (!queue && (!settings || settings.allowedMethods.length === 0)) {
    return {
      kind: immediate ? "merge" : "arm",
      queue,
      methods: [],
      defaultMethod: null,
      disabledReason: MERGE_SETTINGS_UNREAD_REASON,
    };
  }
  const allowed = settings?.allowedMethods ?? [];
  const methods = queue || allowed.length < 2 ? [] : allowed;
  const defaultMethod = queue
    ? null
    : settings?.viewerDefaultMethod && allowed.includes(settings.viewerDefaultMethod)
      ? settings.viewerDefaultMethod
      : (allowed[0] ?? null);

  // The repository switch governs arming only; a queue branch enqueues without it.
  const disabledReason =
    !immediate && !queue && settings?.autoMergeAllowed === false ? AUTO_MERGE_OFF_REASON : null;

  return { kind: immediate ? "merge" : "arm", queue, methods, defaultMethod, disabledReason };
}

/**
 * Why the confirm can't go ahead on this read, or `null`. A D2 confirm previews
 * what lands; a preview missing any part of it — the repository, the head, the
 * commits, the method — blocks the write rather than proceeding on less.
 */
export function confirmBlockReason(
  pr: PR,
  mode: PrMergeMode,
  context: { repository: string | null; method: PRMergeMethod | null }
): string | null {
  if (pr.state !== "open" || pr.merged) return "This pull request is no longer open";
  if (mode === "cancel") {
    return pr.viewerCanDisableAutoMerge === false ? CANNOT_CANCEL_REASON : null;
  }
  if (pr.isDraft) return "This pull request is a draft";
  if (pr.mergeStatus === "dirty") return "This pull request conflicts with its base branch";
  if (!pr.headSha) return "GitHub didn't report the head commit";
  if (!pr.commits) return "GitHub didn't list the commits this would merge";
  if (!context.repository) return "The repository couldn't be identified";
  if (pr.mergeQueueRequired !== true && context.method === null)
    return MERGE_SETTINGS_UNREAD_REASON;
  return null;
}

export function mergeActionLabel(mode: PrMergeMode, intent?: PRMergeIntent | null): string {
  if (mode === "merge") return "Merge";
  if (mode === "arm") return "Merge when ready";
  return intent?.kind === "queued" ? "Remove from queue" : "Cancel auto-merge";
}
