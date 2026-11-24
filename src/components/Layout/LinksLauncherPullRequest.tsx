import { useEffect, useState } from "react";
import { GitPullRequest } from "@/components/icons";
import type { NormalizedPRState } from "@shared/types/forge";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";
import { forgeClient } from "@/clients/forgeClient";
import { FactRun } from "@/components/ui/FactSeparator";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import {
  checkRowLabel,
  isFailingOrRunningCheck,
  preparePrChecks,
  type PrCheckRow,
} from "@/components/Worktree/ReviewHub/prChecks";
import { pullRequestWords, type PullRequestWords } from "@/components/Worktree/ReviewHub/prWords";
import { usePullRequestTerm } from "@/components/Worktree/ReviewHub/usePullRequestTerm";
import { useSkeletonFloor, useSkeletonGate } from "@/hooks/useDeferredLoading";
import type { LauncherPullRequest } from "@/hooks/useLinksLauncher";
import { cn } from "@/lib/utils";
import { LinksLauncherRow } from "./LinksLauncherRow";

/**
 * What the launcher knows of the pull request's checks for this opening.
 * `no-pr` is the forge answering that the pull request doesn't exist, which
 * outranks the worktree's record of it until the host catches up.
 */
export type LauncherChecks =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; rows: PrCheckRow[] }
  | { kind: "no-pr" }
  | { kind: "error" };

const IDLE: LauncherChecks = { kind: "idle" };
const LOADING: LauncherChecks = { kind: "loading" };
const NO_PR: LauncherChecks = { kind: "no-pr" };
const ERROR: LauncherChecks = { kind: "error" };

const PR_STATE_LABEL: Record<NormalizedPRState, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
  declined: "Declined",
};

/**
 * The checks the launcher lists: running, failed or timed out, with a page to
 * open. Prepared from the whole response first, so a name two workflows share
 * is still qualified, and in Review Hub's order.
 */
export function launcherCheckRows(checks: readonly ForgeCheckRun[]): PrCheckRow[] {
  return preparePrChecks(checks).filter(
    (row) => row.detailsUrl !== undefined && isFailingOrRunningCheck(row)
  );
}

/**
 * Reads the pull request's checks once per opening of the launcher (`seq`),
 * the way Review Hub's checks popover reads them once per click: nothing
 * polls, and a read made for one opening or pull request never paints under
 * another, nor under the same one selected again. `seq` is `null` while this
 * host's launcher is closed.
 */
export function useLauncherPullRequestChecks(
  pullRequest: LauncherPullRequest | null,
  seq: number | null
): LauncherChecks {
  const path = pullRequest?.worktreePath ?? null;
  const prNumber = pullRequest?.number ?? null;
  const key =
    seq === null || pullRequest === null
      ? null
      : [seq, pullRequest.providerId, pullRequest.worktreeId, path, prNumber, pullRequest.url].join(
          "\u0000"
        );
  const [result, setResult] = useState<{ key: string; checks: LauncherChecks } | null>(null);
  // Dropped whenever the key moves, so coming back to a pull request within
  // one opening waits for its new read instead of repainting the old one.
  const [readFor, setReadFor] = useState(key);
  if (readFor !== key) {
    setReadFor(key);
    setResult(null);
  }

  useEffect(() => {
    if (key === null || path === null || prNumber === null) return;
    let live = true;
    // StrictMode replays this effect inside one commit; starting a microtask
    // later lets only the run that stays mounted ask the forge.
    queueMicrotask(() => {
      if (!live) return;
      forgeClient.getChecks(path, prNumber).then(
        (response) => {
          if (!live) return;
          setResult({
            key,
            checks:
              response === null
                ? NO_PR
                : { kind: "loaded", rows: launcherCheckRows(response.checks) },
          });
        },
        () => {
          if (live) setResult({ key, checks: ERROR });
        }
      );
    });
    return () => {
      live = false;
    };
  }, [key, path, prNumber]);

  if (key === null) return IDLE;
  return result?.key === key ? result.checks : LOADING;
}

/** The section shows unless the forge has just said the pull request doesn't exist. */
export function showsPullRequest(
  pullRequest: LauncherPullRequest | null,
  checks: LauncherChecks
): pullRequest is LauncherPullRequest {
  return pullRequest !== null && checks.kind !== "no-pr";
}

/** What the pull request's row is named by: its title, else the forge's noun and number. */
export function pullRequestTitle(
  pullRequest: LauncherPullRequest,
  words: PullRequestWords
): string {
  return pullRequest.title ?? `${words.title} ${words.ref(pullRequest.number)}`;
}

/** The facts under the title: its reference ("PR #42") and its state. */
export function pullRequestFacts(
  pullRequest: LauncherPullRequest,
  words: PullRequestWords
): [string, string] {
  return [`${words.short} ${words.ref(pullRequest.number)}`, PR_STATE_LABEL[pullRequest.state]];
}

/**
 * The active worktree's section of the launcher (#17253): its pull request,
 * then the pages of the checks on it that are failing or running.
 */
export function LinksLauncherPullRequest({
  pullRequest,
  checks,
  sectionId,
  onOpen,
  onOpenExternal,
}: {
  pullRequest: LauncherPullRequest;
  checks: LauncherChecks;
  sectionId: string;
  onOpen: (url: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const words = pullRequestWords(usePullRequestTerm(pullRequest.providerId));
  const showSkeleton = useSkeletonFloor(useSkeletonGate(checks.kind === "loading"));
  const headingId = `${sectionId}-heading`;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="flex min-w-0 items-baseline gap-2 px-3 pt-1.5 pb-1">
        <span className={cn(LIST_LABEL_CLASS, "shrink-0")}>{words.title}</span>{" "}
        <span className="min-w-0 truncate text-xs text-text-secondary">
          {pullRequest.worktreeLabel}
        </span>
      </h2>
      <ul className="flex flex-col">
        <LinksLauncherRow
          rowId={`${sectionId}-pr`}
          icon={
            <GitPullRequest className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          }
          title={pullRequestTitle(pullRequest, words)}
          detail={<FactRun facts={pullRequestFacts(pullRequest, words)} />}
          url={pullRequest.url}
          onOpen={onOpen}
          onOpenExternal={onOpenExternal}
        />
        {checks.kind === "loaded" &&
          !showSkeleton &&
          checks.rows.map((row) => (
            <LinksLauncherRow
              key={row.key}
              rowId={`${sectionId}-check-${row.key}`}
              icon={
                <row.outcome.Icon
                  className={cn("h-4 w-4 shrink-0", row.outcome.toneClass)}
                  aria-hidden="true"
                />
              }
              title={checkRowLabel(row)}
              detail={row.outcome.label}
              url={row.detailsUrl!}
              onOpen={onOpen}
              onOpenExternal={onOpenExternal}
            />
          ))}
      </ul>
      {showSkeleton && (
        <Skeleton label="Loading checks" className="flex flex-col gap-3 px-3 pt-1.5 pb-3">
          <div className="flex items-center gap-2.5">
            <SkeletonBone immediate className="h-4 w-4 rounded-full" />
            <SkeletonBone immediate className="h-2.5 w-2/3" />
          </div>
        </Skeleton>
      )}
      {/* Mounted with the section, so a failure landing after the skeleton is announced. */}
      <div role="status" aria-live="polite">
        {checks.kind === "error" && !showSkeleton && (
          <p className="px-3 pb-2 text-xs text-text-secondary">Couldn't load checks</p>
        )}
      </div>
    </section>
  );
}
