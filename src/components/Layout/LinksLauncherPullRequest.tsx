import { useEffect, useState } from "react";
import { GitPullRequest } from "@/components/icons";
import type { NormalizedPRState } from "@shared/types/forge";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";
import { forgeClient } from "@/clients/forgeClient";
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

/** What the launcher knows of the pull request's checks for this opening. */
export type LauncherChecks =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; rows: PrCheckRow[] }
  | { kind: "error" };

const IDLE: LauncherChecks = { kind: "idle" };
const LOADING: LauncherChecks = { kind: "loading" };

export const PR_STATE_LABEL: Record<NormalizedPRState, string> = {
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
 * another. `seq` is `null` while this host's launcher is closed.
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
      : [seq, pullRequest.providerId, pullRequest.worktreeId, path, prNumber].join("\u0000");
  const [result, setResult] = useState<{ key: string; checks: LauncherChecks } | null>(null);

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
          // `null` is the forge saying it has no such pull request: nothing to
          // list, and the worktree's own record is the host's to clear.
          const rows = response === null ? [] : launcherCheckRows(response.checks);
          setResult({ key, checks: { kind: "loaded", rows } });
        },
        () => {
          if (live) setResult({ key, checks: { kind: "error" } });
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

function pullRequestTitle(pullRequest: LauncherPullRequest, words: PullRequestWords): string {
  return pullRequest.title ?? `${words.title} ${words.ref(pullRequest.number)}`;
}

function pullRequestDetail(pullRequest: LauncherPullRequest, words: PullRequestWords): string {
  return `${words.short} ${words.ref(pullRequest.number)} · ${PR_STATE_LABEL[pullRequest.state]}`;
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
}: {
  pullRequest: LauncherPullRequest;
  checks: LauncherChecks;
  sectionId: string;
  onOpen: (url: string) => void;
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
          detail={pullRequestDetail(pullRequest, words)}
          url={pullRequest.url}
          onOpen={onOpen}
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
      {checks.kind === "error" && !showSkeleton && (
        <p className="px-3 pb-2 text-xs text-text-secondary">Couldn't load checks</p>
      )}
    </section>
  );
}

/** The menu row's words for the pull request, for the `…` menu's inlined launcher. */
export function pullRequestMenuWords(
  pullRequest: LauncherPullRequest,
  words: PullRequestWords
): { title: string; detail: string } {
  return {
    title: pullRequestTitle(pullRequest, words),
    detail: pullRequestDetail(pullRequest, words),
  };
}
