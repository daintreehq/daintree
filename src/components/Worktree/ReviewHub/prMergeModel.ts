import type {
  NormalizedPRState,
  PR,
  PRMergeIntent,
  PRMergeMethod,
  PRMergeStatus,
} from "@shared/types/forge";
import type { ForgeRepoMetadataPayload } from "@shared/types/ipc/forge";

/**
 * `arm`: ask GitHub to merge once requirements pass ("Enable auto-merge", or
 * "Merge when ready" on a merge-queue branch). `merge`: merge now, through the
 * existing immediate merge. `cancel`: cancel a pending auto-merge or take the
 * PR out of the merge queue.
 */
export type PrMergeMode = "arm" | "merge" | "cancel";

export interface PrMergeRequest {
  mode: PrMergeMode;
  /** `null`: the forge's default, or the merge queue's own method. */
  method: PRMergeMethod | null;
  /**
   * What the row's own fresh read said, so the confirm can name the PR before
   * its read lands. The confirm's read replaces both once it does.
   */
  title: string;
  baseRef: string;
  queue: boolean;
  intent: PRMergeIntent | null;
}

/** Why the row offers no write at all. Each one is said, never hidden. */
export type PrMergeUnavailableReason =
  "draft" | "conflicts" | "unreported" | "settings-unread" | "no-auto-merge" | "merged" | "closed";

export type PrMergeControlModel =
  | { kind: "hidden" }
  | {
      kind: "unavailable";
      reason: PrMergeUnavailableReason;
      baseRef: string;
      mergeStatus: PRMergeStatus | null;
    }
  | {
      kind: "cancel";
      intent: PRMergeIntent;
      baseRef: string;
      disabledReason: string | null;
    }
  | {
      kind: "arm" | "merge";
      /** The base branch merges through a queue, which picks the method. */
      queue: boolean;
      /** Methods to choose between; empty when there is no choice to offer. */
      methods: PRMergeMethod[];
      defaultMethod: PRMergeMethod | null;
      baseRef: string;
      mergeStatus: PRMergeStatus | null;
      disabledReason: string | null;
    };

export const AUTO_MERGE_OFF_REASON = "Auto-merge is off for this repository";
export const AUTO_MERGE_OFF_DETAIL = "Turn on “Allow auto-merge” in its settings on GitHub";

export const MERGE_SETTINGS_UNREAD_REASON = "Couldn't read this repository's merge methods";

export const CANNOT_CANCEL_REASON = "GitHub doesn't let you cancel it";

export const MERGE_STATUS_UNREPORTED_REASON = "GitHub didn't report whether it can merge";
export const CANNOT_CANCEL_DETAIL = "Only its author or someone with write access can";

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
  // An unreported status decides nothing: the request stands, and the
  // confirm blocks on it rather than presenting a guess as a change.
  if (!pr.mergeStatus) return requested;
  return isImmediatelyMergeable(pr) ? "merge" : "arm";
}

/**
 * What the merge control offers for a PR, from a read taken when the popover
 * opened. Where GitHub wouldn't offer a write either (draft, closed, merged,
 * conflicting, no merge status reported, settings unreadable) the row still
 * answers, with the reason. Only a read that returned no PR at all hides it:
 * the checks above already say that one.
 */
export function derivePrMergeControl(
  pr: PR | null,
  metadata: ForgeRepoMetadataPayload | null
): PrMergeControlModel {
  if (!pr) return { kind: "hidden" };
  const baseRef = pr.baseRef;
  const mergeStatus = pr.mergeStatus ?? null;
  const unavailable = (reason: PrMergeUnavailableReason): PrMergeControlModel => ({
    kind: "unavailable",
    reason,
    baseRef,
    mergeStatus,
  });

  if (pr.merged || pr.state === "merged") return unavailable("merged");
  if (pr.state !== "open") return unavailable("closed");
  if (pr.isDraft) return unavailable("draft");
  // Whether the forge can arm or cancel at all lives in the settings.
  if (!metadata) return unavailable("settings-unread");

  if (pr.mergeIntent) {
    if (!metadata.autoMergeSupported) return unavailable("no-auto-merge");
    return {
      kind: "cancel",
      intent: pr.mergeIntent,
      baseRef,
      disabledReason: pr.viewerCanDisableAutoMerge === false ? CANNOT_CANCEL_REASON : null,
    };
  }

  if (pr.mergeStatus === "dirty") return unavailable("conflicts");
  if (!pr.mergeStatus) return unavailable("unreported");

  const queue = pr.mergeQueueRequired === true;
  const immediate = isImmediatelyMergeable(pr);
  if (!immediate && !metadata.autoMergeSupported) return unavailable("no-auto-merge");

  const settings = metadata.mergeSettings;
  // No silent default: without the repository's own list there is no method
  // to preview, so a non-queue merge waits rather than guessing one.
  if (!queue && (!settings || settings.allowedMethods.length === 0)) {
    return {
      kind: immediate ? "merge" : "arm",
      queue,
      methods: [],
      defaultMethod: null,
      baseRef,
      mergeStatus,
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

  return {
    kind: immediate ? "merge" : "arm",
    queue,
    methods,
    defaultMethod,
    baseRef,
    mergeStatus,
    disabledReason,
  };
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
    if (!pr.mergeIntent) return "GitHub reports nothing pending to cancel";
    return pr.viewerCanDisableAutoMerge === false ? CANNOT_CANCEL_REASON : null;
  }
  if (pr.isDraft) return "This pull request is a draft";
  if (pr.mergeStatus === "dirty") return "This pull request conflicts with its base branch";
  if (!pr.mergeStatus) return MERGE_STATUS_UNREPORTED_REASON;
  if (!pr.headSha) return "GitHub didn't report the head commit";
  if (!pr.commits) return "GitHub didn't list the commits this would merge";
  if (!context.repository) return "The repository couldn't be identified";
  if (pr.mergeQueueRequired !== true && context.method === null)
    return MERGE_SETTINGS_UNREAD_REASON;
  return null;
}

/**
 * The verb on the row's button and the confirm's primary. Auto-merge and the
 * merge queue keep GitHub's own words — "Enable auto-merge" arms a merge,
 * "Merge when ready" hands the PR to a queue — so the two never read as one.
 */
export function mergeActionLabel(
  mode: PrMergeMode,
  options: { queue?: boolean; intent?: PRMergeIntent | null } = {}
): string {
  if (mode === "merge") return "Merge pull request";
  if (mode === "arm") return options.queue ? "Merge when ready" : "Enable auto-merge";
  return options.intent?.kind === "queued" ? "Remove from queue" : "Cancel auto-merge";
}

/**
 * What GitHub reported back after a write, as the chip and its announcement
 * show it until the next detection pass catches up. Built only from the
 * forge's own reply — a queue position it didn't report is never invented.
 */
export type PrMergeOutcome =
  | { kind: "merged"; baseRef: string }
  | { kind: "merge-requested"; baseRef: string }
  | { kind: "armed"; intent: PRMergeIntent }
  /** GitHub accepted the request but didn't say what it armed. */
  | { kind: "arm-requested"; queue: boolean }
  | { kind: "disarmed" }
  | { kind: "dequeued" }
  | { kind: "not-pending" };

export function describeMergeOutcome(
  outcome: PrMergeOutcome,
  prNumber: number
): { short: string; spoken: string } {
  switch (outcome.kind) {
    case "merged":
      return {
        short: `Merged into ${outcome.baseRef}`,
        spoken: `Pull request #${prNumber} merged into ${outcome.baseRef}`,
      };
    case "merge-requested":
      return {
        short: "Merge requested",
        spoken: `Merge of pull request #${prNumber} requested`,
      };
    case "armed":
      if (outcome.intent.kind === "queued") {
        return {
          short: "Added to the merge queue",
          spoken: `Pull request #${prNumber} added to the merge queue`,
        };
      }
      return { short: "Auto-merge enabled", spoken: `Auto-merge enabled for #${prNumber}` };
    case "arm-requested":
      return outcome.queue
        ? {
            short: "Merge when ready requested",
            spoken: `Merge when ready requested for #${prNumber}`,
          }
        : { short: "Auto-merge requested", spoken: `Auto-merge requested for #${prNumber}` };
    case "disarmed":
      return { short: "Auto-merge cancelled", spoken: `Auto-merge cancelled for #${prNumber}` };
    case "dequeued":
      return {
        short: "Removed from the merge queue",
        spoken: `Pull request #${prNumber} removed from the merge queue`,
      };
    case "not-pending":
      return { short: "Nothing was pending", spoken: `Nothing was pending for #${prNumber}` };
  }
}

interface ChipMergeState {
  prState: NormalizedPRState;
  mergeIntent: PRMergeIntent | null;
}

/** Whether detection has caught up with what GitHub replied to the write. */
export function isMergeOutcomeReflected(outcome: PrMergeOutcome, current: ChipMergeState): boolean {
  switch (outcome.kind) {
    case "merged":
      return current.prState === "merged";
    case "armed":
      return current.mergeIntent?.kind === outcome.intent.kind;
    case "merge-requested":
    case "arm-requested":
      return true;
    default:
      return current.mergeIntent === null;
  }
}

/** The PR state and pending merge the chip should show while `outcome` is newer than detection. */
export function applyMergeOutcome(
  outcome: PrMergeOutcome,
  current: ChipMergeState
): ChipMergeState {
  switch (outcome.kind) {
    case "merged":
      return { prState: "merged", mergeIntent: null };
    case "armed":
      return { prState: current.prState, mergeIntent: outcome.intent };
    case "merge-requested":
    case "arm-requested":
      return current;
    default:
      return { prState: current.prState, mergeIntent: null };
  }
}

/**
 * A rejected write, in words. `gh` and GraphQL errors are implementation
 * output; the reader needs what happened and what to do, and the raw text
 * stays available behind a disclosure for the cases this doesn't recognise.
 */
export function describeMergeRejection(
  message: string,
  mode: PrMergeMode,
  context: { baseRef: string; queue: boolean }
): { title: string; summary: string } {
  const text = message.toLowerCase();
  const failed =
    mode === "merge"
      ? "GitHub didn't merge it"
      : mode === "arm"
        ? context.queue
          ? "GitHub didn't queue it"
          : "GitHub didn't enable auto-merge"
        : "GitHub didn't cancel it";
  if (
    /head (branch )?(was )?modified|expected head|head sha|head ref.*(changed|moved)/.test(text)
  ) {
    return {
      title: "New commits landed first",
      summary:
        "The branch moved after the preview was read. Check the commits below before you try again.",
    };
  }
  if (/merge conflict|conflicts?/.test(text)) {
    return {
      title: `Conflicts with ${context.baseRef}`,
      summary: "Resolve the conflicts, then try again.",
    };
  }
  if (/auto.?merge/.test(text) && /(not allowed|disabled|isn't allowed|not enabled)/.test(text)) {
    return { title: AUTO_MERGE_OFF_REASON, summary: `${AUTO_MERGE_OFF_DETAIL}.` };
  }
  if (
    /base branch policy|protected branch|required status|approving review|review.*required|not mergeable/.test(
      text
    )
  ) {
    return {
      title: "Branch rules blocked it",
      summary: `Required checks or approving reviews on ${context.baseRef} haven't passed yet. Once they have, try again.`,
    };
  }
  if (/permission|not authorized|forbidden|\b403\b|must have (write|admin)/.test(text)) {
    return {
      title: "You don't have permission",
      summary: "GitHub needs write access to this repository for that.",
    };
  }
  if (
    /timed? ?out|timeout|econnreset|enotfound|network|socket|\b50[0-9]\b|could not resolve host/.test(
      text
    )
  ) {
    return {
      title: "Couldn't confirm the result",
      summary:
        "GitHub didn't answer cleanly. The preview below was read again to show where it stands.",
    };
  }
  return {
    title: failed,
    summary: "The preview below was read again. Check it before you try again.",
  };
}
