import { useState, useEffect, useRef } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { TypedNameConfirmInput } from "@/components/ui/TypedNameConfirmInput";
import { TitleEntity } from "@/components/ui/TitleEntity";
import { AlertTriangle, Trash2 } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { collectRunningAgentTerminals } from "@/utils/destructiveSessionConfirm";
import { deriveEffectiveTier } from "@/services/actions/deriveEffectiveTier";
import {
  buildWorktreeDeletePreview,
  buildWorktreeChangeRows,
  buildSubmoduleCommitRows,
  buildSubmoduleFileRows,
  submoduleCommitsAreCapped,
  submoduleDeleteBlock,
  submoduleFileCount,
  submoduleForceRequired,
  submodulesFromPreviewError,
  summarizeWorktreeChanges,
  PREVIEW_FILE_LIMIT,
  type WorktreeDeletePreview,
  type WorktreeSubmoduleRiskState,
} from "@/components/Worktree/worktreeDeletePreview";
import { Button } from "@/components/ui/button";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeState } from "@/types";
import { cn } from "@/lib/utils";
import { isProtectedBranch as isProtectedBranchName } from "@shared/utils/gitConstants";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";

interface WorktreeDeleteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  worktree: WorktreeState;
}

export function WorktreeDeleteDialog({ isOpen, onClose, worktree }: WorktreeDeleteDialogProps) {
  const [force, setForce] = useState(false);
  const [closeTerminals, setCloseTerminals] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [hasDevPreview, setHasDevPreview] = useState(false);
  // Fresh git-status snapshot fetched when the dialog opens and re-checked on
  // submit (#11343). The prop `worktree.worktreeChanges` can be ~30s stale for
  // a backgrounded worktree, which would let a force-delete skip the D3 gate
  // and silently discard uncommitted work. `null` = not yet fetched / monitor
  // gone (fall back to the prop snapshot); `verifyFailed` = the fresh fetch
  // errored, so we FAIL CLOSED (treat the tree as dirty, escalate the tier).
  const [freshPreview, setFreshPreview] = useState<WorktreeDeletePreview | null>(null);
  const [verifyFailed, setVerifyFailed] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // The open-time fetch has not settled yet. Distinct from `freshPreview ===
  // null`, which is also what a resolved-`null` (monitor gone) preview leaves
  // behind — reading pending off that would disable the primary for good.
  const [previewPending, setPreviewPending] = useState(true);
  // The submodule half of a preview whose parent arm failed. Held separately
  // because `freshPreview` has to stay null on that path: the summary falls
  // back to the prop snapshot through it, and a preview object carrying an
  // empty change list would read as a clean tree.
  const [failedSubmodules, setFailedSubmodules] = useState<WorktreeSubmoduleRiskState | null>(null);
  // Bumped by the blocked banners' recovery action to re-run the open-time
  // fetch. The whole preview rides one call, so a retry re-reads the parent
  // status too — which is right: the two failures share a cause often enough.
  const [retryToken, setRetryToken] = useState(0);
  // Monotonic session token bumped on every open/close/worktree change (in the
  // open effect below). An in-flight submit revalidation captures the token and
  // aborts if it changed while awaiting — so a close→reopen (or worktree swap)
  // during the fetch can't let a stale closure dispatch against the new session
  // (an ABA race a plain boolean flag would miss). `mountedRef` covers unmount.
  const sessionRef = useRef(0);
  const mountedRef = useRef(true);
  const gateRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Set on SETUP as well as clearing on cleanup — under React StrictMode the
    // mount effect runs setup → cleanup → setup, so a setup that only cleared
    // would leave `mountedRef` false after remount and make every force-delete
    // abort at the revalidation guard in dev.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const { counts: terminalCounts, terminals } = useWorktreeTerminals(worktree.id);
  // Surface the risk-relevant subset (agents mid-work) in the D2 preview instead
  // of a bare total — closing an idle shell is cheap, interrupting a running
  // agent is not (#11344, mirrors the tracked/untracked split from #4927).
  const runningAgentCount = collectRunningAgentTerminals(terminals).length;

  // Preview + tier derive from the FRESH fetch when available, else the prop
  // snapshot as an initial seed. A failed fetch fails closed via
  // `hasTrackedChanges` so the D3 typed-name gate is never skipped on stale
  // (or unverifiable) state.
  const seedSummary = summarizeWorktreeChanges(worktree.worktreeChanges?.changes);
  const effectiveSummary = freshPreview ?? seedSummary;
  const trackedChangeCount = effectiveSummary.trackedChangeCount;
  const untrackedFileCount = effectiveSummary.untrackedFileCount;
  const hasTrackedChanges = verifyFailed || effectiveSummary.hasTrackedChanges;
  const hasUntrackedFiles = effectiveSummary.hasUntrackedFiles;
  const hasChanges = hasTrackedChanges || hasUntrackedFiles;
  const hasTerminals = terminalCounts.total > 0;

  // Actual file list a force-delete would discard — a D2 preview must show
  // real content, not just a count (#11343). Prefer the fresh fetch's changes,
  // fall back to the prop snapshot before it resolves. Paths arrive absolute
  // from the producer, so the root is passed to render them worktree-relative:
  // repeating the full path on every row buries the filename past the wrap,
  // which is the one part of a row that distinguishes it (#11977).
  const previewChangeRows = buildWorktreeChangeRows(
    freshPreview?.changes ?? worktree.worktreeChanges?.changes ?? [],
    PREVIEW_FILE_LIMIT,
    freshPreview?.rootPath ?? worktree.worktreeChanges?.rootPath ?? worktree.path
  );

  /**
   * What the delete would destroy INSIDE this worktree's submodules.
   *
   * `null` means the fetch has not landed yet — distinct from "checked, and
   * clean". A failed PARENT fetch no longer takes the submodule half with it:
   * the two arms are independent, and the inventory frequently completes while
   * the parent status is what could not be read. Discarding that answer left
   * the dialog force-gating on nothing over nested files it had already been
   * told about.
   */
  const submodules: WorktreeSubmoduleRiskState | null = verifyFailed
    ? (failedSubmodules ?? { status: "unverified", risk: null })
    : (freshPreview?.submodules ?? null);
  // Real nested paths and real commit subjects. The parent's own status shows
  // every one of these files as a single ` M vendor/lib` row — precise-looking
  // and wrong by an unbounded factor — and shows the commits as nothing at all.
  const submoduleFileRows = buildSubmoduleFileRows(submodules?.risk ?? null);
  const submoduleCommitRows = buildSubmoduleCommitRows(submodules?.risk ?? null);
  const nestedFileCount = submodules ? submoduleFileCount(submodules) : 0;
  const atRiskCommitCount = submodules?.risk?.atRiskCommits.length ?? 0;
  // A capped walk comes back incomplete, so the retained length is a floor. Say
  // "at least" rather than stating a number the host already knows is short.
  const atRiskCommitsCapped = submodules ? submoduleCommitsAreCapped(submodules) : false;
  const atRiskCommitsPlural = atRiskCommitCount !== 1 || atRiskCommitsCapped;
  const atRiskCommitLabel = `${atRiskCommitsCapped ? "At least " : ""}${atRiskCommitCount} commit${atRiskCommitCount === 1 ? "" : "s"} ${atRiskCommitsPlural ? "are" : "is"}`;
  /**
   * The delete the host will refuse outright, whatever the user consents to.
   *
   * Scoped to the submodule inventory's own answer: when the PARENT status
   * fetch is what failed (`verifyFailed`) we know nothing about submodules
   * either, but the host re-reads both for itself at delete time and may well
   * proceed — so refusing on an UNVERIFIED inventory there would strand a
   * delete that can still succeed. That state keeps its existing
   * warn-and-require-force treatment.
   *
   * A VERIFIED inventory is different and does block, parent failure or not:
   * it is a completed answer about the submodules specifically, and the host
   * runs the same one and refuses on it. Suppressing that was how a parent
   * timeout turned an unrecoverable-commit refusal into an offered delete.
   */
  const submoduleBlock =
    submodules && (!verifyFailed || submodules.status === "verified")
      ? submoduleDeleteBlock(submodules)
      : null;
  const isBlocked = submoduleBlock !== null;
  // Nested modified/untracked files: the one submodule state `force` genuinely
  // consents to, so the plain delete is disabled and force enables it. Not
  // `requiresMechanicalForce` — the host adds that `--force` itself, and an
  // old-form embedded submodule never sets it while its files die all the same.
  const forceRequiredBySubmodules = submodules ? submoduleForceRequired(submodules) : false;

  const isProtectedBranch = isProtectedBranchName(worktree.branch?.toLowerCase());
  const isDetachedHead = !worktree.branch;
  const canDeleteBranch =
    !isProtectedBranch && !isDetachedHead && worktree.isMainWorktree === false;

  const confirmTarget = worktree.branch || worktree.name;
  // Names the reason the gate is actually up.
  const highTierPreamble =
    isProtectedBranch || worktree.isMainWorktree === true
      ? "Force-deleting this protected worktree is irreversible."
      : hasTrackedChanges
        ? "Force-deleting this worktree discards uncommitted tracked changes — this is irreversible."
        : "Force-deleting this worktree discards modified and untracked files inside its submodules — this is irreversible.";
  // Never gate a delete that cannot proceed. A typed-name input on a blocked
  // state asks for the most emphatic consent the app has and then refuses
  // anyway; blocked is a different thing from D3, and this is where they part.
  const isHighTier =
    !isBlocked &&
    deriveEffectiveTier("worktree.delete", {
      force,
      isProtectedBranch,
      isMainWorktree: worktree.isMainWorktree === true,
      hasTrackedChanges,
      submoduleFilesAtRisk: forceRequiredBySubmodules,
    }) === "D3";
  const isConfirmMatched = confirmInput === confirmTarget;
  // A standard (non-force) delete on a tree we KNOW is dirty is rejected by
  // the backend, so offering it as the primary action ships a button whose
  // only outcome is a toast and a reopened dialog. Gate it — but only when the
  // dirtiness is verified: after a failed verification the safe non-force
  // attempt is still the right first move, and disabling it would coerce the
  // user into force on the very state we could not check. A worktree that owns
  // submodule module directories is the same situation arriving from git
  // rather than from our own guard.
  const blockedByDirtyTree = (hasChanges || forceRequiredBySubmodules) && !force && !verifyFailed;
  // Nothing is submittable until the open-time fetch has settled. Before it
  // does, `submodules` is null and every submodule input reads false, so a fast
  // click on a worktree holding unpushed submodule commits would dispatch a
  // delete the host refuses with the check having never run. Gating the button
  // (rather than revalidating on the plain path) keeps the immediate dismiss
  // #8417 asks for, and the fetch is deadline-bounded by the port client, so
  // this cannot wedge.
  const canSubmit =
    (!isHighTier || isConfirmMatched) &&
    !isDeleting &&
    !blockedByDirtyTree &&
    !isBlocked &&
    !previewPending;

  useEffect(() => {
    if (isOpen) {
      setForce(false);
      setCloseTerminals(true);
      setDeleteBranch(false);
      setConfirmInput("");
      setHasDevPreview(false);
      setIsDeleting(false);
    }
  }, [isOpen, worktree.id]);

  // Fetch a FRESH git-status snapshot when the dialog opens so the tier + the
  // changed-file preview reflect live changes, not a possibly-stale cache
  // (#11343). Guarded against stale-closure on unmount/worktree change. A
  // failed fetch fails closed (`verifyFailed`) — we never silently fall back to
  // the stale snapshot and offer the lower tier.
  useEffect(() => {
    // Bump the session on every open/close/worktree change so an in-flight
    // submit revalidation can detect it's stale (see `revalidateThenDelete`).
    sessionRef.current += 1;
    if (!isOpen) return;
    let cancelled = false;
    setFreshPreview(null);
    setVerifyFailed(false);
    setFailedSubmodules(null);
    setPreviewPending(true);
    buildWorktreeDeletePreview(worktree.id)
      .then((preview) => {
        if (!cancelled) setFreshPreview(preview);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setVerifyFailed(true);
        setFailedSubmodules(submodulesFromPreviewError(error));
      })
      .finally(() => {
        if (!cancelled) setPreviewPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, worktree.id, retryToken]);

  // Disclose a running dev server in the "What will happen" list so the user
  // isn't surprised when the cascade runs (Tier D2 destructive action rule).
  // Guard against stale-closure on unmount/worktree change (lesson #4754).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    window.electron.devPreview
      .getByWorktree({ worktreeId: worktree.id })
      .then((state) => {
        if (cancelled) return;
        setHasDevPreview(state !== null && state.status !== "stopped");
      })
      .catch(() => {
        // Disclosure is informational; failing to fetch should not block
        // the dialog. The actual stop attempt happens in runDeleteAsync.
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, worktree.id]);

  useEffect(() => {
    if (!force) {
      setConfirmInput("");
    }
  }, [force]);

  // An escalation the user cannot see is not an escalation. On a tall state
  // (long path, many changed files) the D3 gate renders below the body's
  // scroll fold, so the footer would report a disabled action whose cause was
  // off-screen. Bring the gate into view when the tier escalates — the user
  // did not scroll away from it, it appeared somewhere they were not looking.
  useEffect(() => {
    if (!isHighTier) return;
    const node = gateRef.current;
    if (!node) return;
    node.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [isHighTier]);

  useEffect(() => {
    if (!canDeleteBranch && deleteBranch) {
      setDeleteBranch(false);
    }
  }, [canDeleteBranch, deleteBranch]);

  const dispatchDelete = () => {
    const effectiveDeleteBranch = deleteBranch && canDeleteBranch;
    const options = {
      force,
      deleteBranch: effectiveDeleteBranch,
      ...(closeTerminals && hasTerminals ? { closeTerminals: true } : {}),
    };

    // Fire-and-forget — progress and any failure surface on the card, not the
    // modal (#8417). The dialog closes immediately so the user keeps flow.
    getCurrentViewStore().getState().startDelete(worktree.id, options);
    useAnnouncerStore.getState().announce("Deleting worktree");
    onClose();
  };

  // Re-check LIVE changes immediately before a force-delete dispatch (#11343).
  // An agent can write files between open and submit; without this, a delete
  // that looked D2 at open could discard tracked work the typed-name gate was
  // meant to guard. If the fresh check now escalates to D3 and the name isn't
  // matched, we surface the gate instead of dispatching. Fails closed on fetch
  // error.
  //
  // Still only the force path. A plain delete cannot destroy anything the host
  // does not first refuse, so the window it leaves open — a submodule commit
  // landing between the settled preview and the click — costs a truthful toast,
  // never data. Paying for that with a fetch on every plain delete would cost
  // the immediate dismiss #8417 asks for on all of them.
  const revalidateThenDelete = async () => {
    const session = sessionRef.current;
    setIsDeleting(true);
    let preview: WorktreeDeletePreview | null = null;
    let failed = false;
    let failedRisk: WorktreeSubmoduleRiskState | null = null;
    try {
      preview = await buildWorktreeDeletePreview(worktree.id);
    } catch (error) {
      failed = true;
      failedRisk = submodulesFromPreviewError(error);
    }
    // Abort if the dialog closed/reopened/changed worktree or unmounted while
    // the fresh re-check was in flight — never dispatch against a session the
    // user is no longer looking at.
    if (!mountedRef.current || sessionRef.current !== session) return;
    setFreshPreview(preview);
    setVerifyFailed(failed);
    setFailedSubmodules(failedRisk);
    // An agent can commit inside a submodule between open and submit, which
    // turns a delete the dialog was offering into one the host will refuse.
    // Hold the dispatch and let the newly-rendered banner say so, rather than
    // sending a call whose only outcome is a toast. The state updates above
    // have already put the evidence on screen.
    //
    // A parent-status failure does not exempt this: the submodule arm may have
    // completed, and a completed inventory is what the host refuses on.
    const freshRisk = failed ? failedRisk : (preview?.submodules ?? null);
    if (
      freshRisk &&
      (!failed || freshRisk.status === "verified") &&
      submoduleDeleteBlock(freshRisk) !== null
    ) {
      setIsDeleting(false);
      return;
    }
    const freshHasTracked = failed ? true : (preview ?? seedSummary).hasTrackedChanges;
    // Same fail-closed shape as `freshHasTracked`. A resolved-`null` preview
    // means the monitor is gone — the worktree is already removed, so there is
    // no submodule left to lose and escalating would only strand the user.
    // `submoduleForceRequired` answers false for anything unverified, so a
    // surviving inventory from a failed parent fetch escalates on its own
    // merits rather than being discarded with the arm that failed.
    const freshSubmoduleFilesAtRisk = freshRisk ? submoduleForceRequired(freshRisk) : false;
    const freshTier = deriveEffectiveTier("worktree.delete", {
      force: true,
      isProtectedBranch,
      isMainWorktree: worktree.isMainWorktree === true,
      hasTrackedChanges: freshHasTracked,
      submoduleFilesAtRisk: freshSubmoduleFilesAtRisk,
    });
    if (freshTier === "D3" && confirmInput !== confirmTarget) {
      // Escalated on fresh data — show the typed-name gate, do not dispatch.
      setIsDeleting(false);
      return;
    }
    dispatchDelete();
  };

  const handleDelete = () => {
    if (isHighTier && !isConfirmMatched) return;
    // Guards the Enter-to-submit path in the typed-name input, which does not
    // read the footer button's disabled state.
    if (isDeleting || isBlocked || previewPending) return;
    if (!force) {
      dispatchDelete();
      return;
    }
    void revalidateThenDelete();
  };

  // Verb-noun, and deliberately free of the branch name: interpolating an
  // untruncated identifier here overflowed the footer and pushed Cancel out of
  // the dialog entirely on long branches (#11977). The title and the
  // typed-name gate both already name the target.
  const deleteButtonLabel = force ? "Force delete worktree" : "Delete worktree";

  const trackedLabel = `${trackedChangeCount} uncommitted file${trackedChangeCount === 1 ? "" : "s"}`;
  const untrackedLabel = `${untrackedFileCount} untracked file${untrackedFileCount === 1 ? "" : "s"}`;
  /**
   * Never state a count we could not verify.
   *
   * `hasTrackedChanges` is forced true when the fresh status fetch fails, so
   * the tier fails closed — but the counts still come from the (possibly
   * clean, possibly stale) prop seed. Interpolating them anyway produced
   * "0 uncommitted files will be permanently lost" in exactly the state where
   * the dialog knows least, which reads as false precision at the worst
   * possible moment. When unverified, say so instead of inventing a number.
   */
  const changeSummaryLabel = verifyFailed
    ? "unverified uncommitted work"
    : hasTrackedChanges && hasUntrackedFiles
      ? `${trackedLabel} and ${untrackedLabel}`
      : hasTrackedChanges
        ? trackedLabel
        : untrackedLabel;

  /**
   * The consequences that will ACTUALLY occur under the current options.
   *
   * Previously every possible outcome was rendered and the inapplicable ones
   * were dimmed + struck through, so a clean delete showed five rows of which
   * four were non-events and the user had to subtract them at the exact moment
   * the dialog should be minimising interpretation (#11977). Strikethrough was
   * also the ONLY signal — it carries no meaning to assistive tech, and it
   * collapses entirely under forced-colors, where the dim tier disappears.
   * Now a row exists only when it is true.
   */
  const consequences: { key: string; tone: "neutral" | "danger"; content: React.ReactNode }[] = [];
  consequences.push({
    key: "directory",
    tone: "neutral",
    content: "Worktree directory will be deleted from disk",
  });
  if (closeTerminals && hasTerminals) {
    consequences.push({
      key: "terminals",
      tone: "neutral",
      content: (
        <>
          {/* Weight ranks the outcome above the detail that qualifies it, in
              place of the em dash that read as one run of prose. It is also
              the half that holds under `forced-colors: active`, where every
              author colour resolves to the same ink. The danger row below is
              still marked by its glyph and by carrying weight across the whole
              row, so ranking a neutral row's first half does not blunt it.
              Rows with no detail stay unweighted: there is no pair to rank. */}
          <span className={cn(runningAgentCount > 0 && "font-medium")}>
            {terminalCounts.total} terminal{terminalCounts.total === 1 ? "" : "s"} will be closed
          </span>
          {runningAgentCount > 0 && (
            <span className="ml-1 text-text-secondary">
              {" "}
              {terminalCounts.total === 1
                ? "running an agent"
                : `${runningAgentCount} of them running an agent`}
            </span>
          )}
        </>
      ),
    });
  }
  if (hasDevPreview) {
    consequences.push({ key: "dev", tone: "neutral", content: "Dev server will be stopped" });
  }
  if (force && hasChanges) {
    // The one irreversible outcome, stated once and specifically. This row
    // replaces the old generic "Uncommitted changes will be lost" line, the
    // separate red banner that repeated the same counts, and the standalone
    // "This cannot be undone." — three assertions of one fact.
    consequences.push({
      key: "loss",
      tone: "danger",
      // Hedged only when the status fetch failed: that state is the one the
      // dialog knows least about, and the banner above already says the loss
      // is possible rather than certain. Where the changes ARE listed, the
      // outcome is stated flatly.
      content: `${changeSummaryLabel} ${verifyFailed ? "may be" : "will be"} permanently lost`,
    });
  }
  if (force && nestedFileCount > 0) {
    // Stated separately from the parent row above because the parent CANNOT
    // state it: `git status` collapses every one of these files into a single
    // ` M vendor/lib` entry, so the count above is short by however many files
    // are really in there.
    consequences.push({
      key: "submodule-files",
      tone: "danger",
      content: `${nestedFileCount} file${nestedFileCount === 1 ? "" : "s"} inside submodules will be permanently lost`,
    });
  }
  // No row for at-risk submodule commits: the host refuses that delete outright,
  // so "may be lost" was a prediction about something that never runs. The
  // blocked banner and the commit list carry that state now.
  if (deleteBranch && canDeleteBranch) {
    consequences.push({
      key: "branch",
      tone: "neutral",
      content: (
        <>
          <span className="font-medium">
            Branch <span className="font-mono break-all">{worktree.branch}</span> will be deleted if
            Git allows it
          </span>
          {/* Says the outcome, not that "it fails". The branch delete runs
              after the directory is already gone, so a failure here never
              cancels the delete the user is confirming — it leaves the branch
              behind. Force delete does not change this: the two consents are
              separate and nothing in this dialog grants the second one, so a
              branch Git won't delete safely survives. "Fully merged" is Git's
              own test rather than a paraphrase — `branch -d` measures the
              branch against its upstream (or HEAD), not against every ref.
              "if Git allows it" rather than naming the one refusal: a branch
              also survives a lock, a checkout elsewhere, or a permissions
              error, so promising deletion with a single stated exception
              still overpromises on every other path. */}
          <span className="ml-1 text-text-secondary">
            {" "}
            Kept if it isn&apos;t fully merged, or if Git refuses for any other reason
          </span>
        </>
      ),
    });
  }

  // Fail-closed disclosure only. The option-driven consequences live in the
  // list above and announce through a polite live region instead: `role="alert"`
  // is assertive and would re-interrupt the user on every checkbox toggle.
  const verifyFailedBanner = verifyFailed ? (
    <div
      role="alert"
      className="flex items-start gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded-[var(--radius-md)] text-status-error text-xs"
    >
      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
      <p>
        Couldn't check this worktree for uncommitted work. Force delete may discard changes that
        aren't listed here.
      </p>
    </div>
  ) : null;

  /**
   * The delete is refused, not merely dangerous — so the banner states the one
   * thing the user can do about it, and the primary action stays disabled.
   *
   * Separate from `verifyFailedBanner`: that one fires when the PARENT status
   * could not be read at all, and it stays a warning because the host re-reads
   * for itself and may still proceed. Collapsing them would tell a user whose
   * file list is right in front of them that we could not read it.
   *
   * One action apiece, and both do something real: after pushing from inside
   * the submodule, or once whatever broke the inventory is fixed, re-running
   * the same fetch is exactly what clears the block. The commits themselves are
   * listed below — repeating them here would say the same thing twice.
   */
  const submoduleBlockBanner = submoduleBlock ? (
    <div
      role="alert"
      data-testid="delete-worktree-blocked"
      className="flex items-start gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded-[var(--radius-md)] text-status-error text-xs"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">
          {submoduleBlock === "at-risk-commits"
            ? "Push the submodule commits first"
            : "Couldn't finish checking this worktree's submodules"}
        </p>
        <p className="mt-0.5">
          {submoduleBlock === "at-risk-commits"
            ? // "On no remote this clone knows about" and not "exists nowhere
              // else": the inventory can only prove a commit is unreachable
              // from this module repository's own remote-tracking refs, so a
              // fetch is a real remedy alongside a push.
              `${atRiskCommitLabel} on no remote this clone knows about, so deleting this worktree isn't available. Push ${atRiskCommitsPlural ? "them" : "it"} from inside the submodule — or fetch, if ${atRiskCommitsPlural ? "they are" : "it is"} already on the remote — then delete the worktree.`
            : "Deleting it could destroy nested work that isn't listed here, so deletion isn't available until the check finishes."}
        </p>
      </div>
      <Button
        variant="subtle"
        size="xs"
        className="shrink-0"
        disabled={previewPending}
        onClick={() => setRetryToken((token) => token + 1)}
      >
        {submoduleBlock === "at-risk-commits" ? "Recheck" : "Retry"}
      </Button>
    </div>
  ) : null;

  const nestedFileLabel = `${nestedFileCount} file${nestedFileCount === 1 ? "" : "s"}`;
  // Standard (non-force) deletion is rejected by the backend when the tree is
  // dirty, so the primary action would fail. Say so where the decision is made
  // rather than letting the user find out from a toast. A blocked delete comes
  // first: no option on this surface unblocks it, so telling the user to select
  // force would send them somewhere that does not help. The in-flight check
  // comes LAST — it also disables the primary, but it is the least specific
  // thing we can say, and the seed snapshot often already has a better one.
  const blockedHint = isBlocked
    ? submoduleBlock === "at-risk-commits"
      ? // What the check actually measures, so the hint promises exactly what
        // clears it: a push, or a fetch that proves the remote already has it.
        "Delete unavailable until the submodule commits are on a remote"
      : "Delete unavailable until the submodule check finishes"
    : force || (!hasChanges && !forceRequiredBySubmodules)
      ? previewPending
        ? "Checking this worktree for uncommitted work"
        : null
      : verifyFailed
        ? "Couldn't verify this worktree — standard delete may fail"
        : hasChanges
          ? `Select Force delete to continue — ${changeSummaryLabel} present`
          : `Select Force delete to continue — ${nestedFileLabel} inside submodules will be discarded`;

  const changesHeadingId = "worktree-delete-changes-heading";
  const consequencesHeadingId = "worktree-delete-consequences-heading";
  const submodulesHeadingId = "worktree-delete-submodules-heading";
  const submoduleCommitsHeadingId = "worktree-delete-submodule-commits-heading";

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      variant="destructive"
      // The body lists what will happen and, when the worktree is dirty, the
      // files that will be lost — structured evidence, so a dialog rather than
      // an alertdialog, which APG reserves for a brief message read out whole.
      hasPreview
      data-testid="delete-worktree-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<Trash2 className="w-4 h-4 shrink-0 text-status-error" />}>
          <TitleEntity action="Delete" name={confirmTarget} />
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {/* Static, concise, and the target of the dialog's `aria-describedby`.
            Deliberately not the dynamic consequence list: pointing the
            description at live content makes a screen reader read the whole
            payload before the focused control every time it changes. */}
        <AppDialog.Description className="sr-only">
          Deletes this worktree's directory from disk. The options below can also close its
          terminals, discard uncommitted work, and delete its branch.
        </AppDialog.Description>

        <div className="space-y-5">
          {/* 1. WHAT — the entity, named once, concretely. */}
          <dl className="rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas px-3 py-2.5 text-xs">
            {worktree.branch && (
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-text-secondary">Branch</dt>
                <dd className="font-mono text-text-primary [overflow-wrap:anywhere]">
                  {worktree.branch}
                </dd>
              </div>
            )}
            <div className={cn("flex gap-2", worktree.branch && "mt-1.5")}>
              <dt className="w-14 shrink-0 text-text-secondary">Path</dt>
              <dd className="font-mono text-text-secondary [overflow-wrap:anywhere]">
                {worktree.path}
              </dd>
            </div>
          </dl>

          {verifyFailedBanner}
          {submoduleBlockBanner}

          {/* 2. WHAT'S IN THERE — the actual content, shown whenever the tree
              is dirty, not only once force is on. A D2 confirm owes a preview
              of real content; a count alone is insufficient, and the user
              needs the list to decide whether forcing is safe. */}
          {hasChanges && !verifyFailed && previewChangeRows.length > 0 && (
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <span
                  id={changesHeadingId}
                  role="heading"
                  aria-level={3}
                  className="text-2xs font-semibold uppercase tracking-wider text-text-secondary"
                >
                  Uncommitted work
                </span>
                <span className="text-2xs tabular-nums text-text-secondary">
                  {changeSummaryLabel}
                </span>
              </div>
              {/* Rows, not a wrapping <pre> of joined strings. A path longer
                  than the box used to continue at the left edge, under the
                  status column, so two long paths read as four files and the
                  glyph detached from the name it belonged to. The glyph now
                  sits in its own fixed column and the wrap hangs under the
                  path. */}
              <ul
                data-testid="delete-worktree-file-list"
                aria-labelledby={changesHeadingId}
                tabIndex={0}
                className="mt-2 max-h-32 overflow-auto text-xs text-text-secondary bg-surface-canvas p-3 rounded-[var(--radius-md)] border border-border-strong font-mono space-y-0.5"
              >
                {previewChangeRows.map((row) => (
                  <li
                    key={row.isOverflow ? "__overflow" : `${row.glyph}:${row.label}`}
                    className={cn("flex gap-2", row.isOverflow && "text-text-secondary italic")}
                  >
                    {!row.isOverflow && (
                      <>
                        <span aria-hidden="true" className="w-3 shrink-0 text-text-secondary">
                          {row.glyph}
                        </span>
                        {/* The glyph column is right for scanning and useless
                            to a screen reader, which would otherwise hear a
                            list of paths with no way to tell a deletion from
                            an addition. */}
                        <span className="sr-only">{row.statusLabel}: </span>
                      </>
                    )}
                    <span className="[overflow-wrap:anywhere]">{row.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 2b. WHAT'S NESTED IN THERE — the same D2 "actual content" duty,
              for the half the parent's own status cannot express. A submodule
              with two hundred dirty files is ONE ` M vendor/lib` row up there,
              and a commit sitting on its detached HEAD is no row at all. */}
          {(submoduleFileRows.length > 0 || submoduleCommitRows.length > 0) && (
            <div data-testid="delete-worktree-submodules">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  id={submodulesHeadingId}
                  role="heading"
                  aria-level={3}
                  className="text-2xs font-semibold uppercase tracking-wider text-text-secondary"
                >
                  Inside submodules
                </span>
                {nestedFileCount > 0 && (
                  <span className="text-2xs tabular-nums text-text-secondary">
                    {nestedFileLabel}
                  </span>
                )}
              </div>

              {submoduleFileRows.length > 0 && (
                <ul
                  data-testid="delete-worktree-submodule-file-list"
                  aria-labelledby={submodulesHeadingId}
                  tabIndex={0}
                  className="mt-2 max-h-32 overflow-auto text-xs text-text-secondary bg-surface-canvas p-3 rounded-[var(--radius-md)] border border-border-strong font-mono space-y-0.5"
                >
                  {submoduleFileRows.map((row) => (
                    <li
                      key={row.isOverflow ? "__overflow" : `${row.glyph}:${row.label}`}
                      className={cn("flex gap-2", row.isOverflow && "italic")}
                    >
                      {!row.isOverflow && (
                        <>
                          <span aria-hidden="true" className="w-3 shrink-0 text-text-secondary">
                            {row.glyph}
                          </span>
                          <span className="sr-only">{row.statusLabel}: </span>
                        </>
                      )}
                      <span className="[overflow-wrap:anywhere]">{row.label}</span>
                    </li>
                  ))}
                </ul>
              )}

              {submoduleCommitRows.length > 0 && (
                <>
                  {/* Glyph AND weight AND colour, the same three the
                      irreversible consequence row carries — under
                      `forced-colors: active` the colour is the one that goes. */}
                  <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-status-error">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                    <span id={submoduleCommitsHeadingId}>
                      {atRiskCommitLabel} on no remote this clone knows about
                    </span>
                  </p>
                  <ul
                    data-testid="delete-worktree-submodule-commit-list"
                    aria-labelledby={submoduleCommitsHeadingId}
                    tabIndex={0}
                    className="mt-1.5 max-h-24 overflow-auto text-xs text-text-secondary bg-surface-canvas p-3 rounded-[var(--radius-md)] border border-border-strong font-mono space-y-0.5"
                  >
                    {submoduleCommitRows.map((row) => (
                      <li
                        key={row.isOverflow ? "__overflow" : row.oid}
                        className={cn("flex gap-2", row.isOverflow && "italic")}
                      >
                        {!row.isOverflow && (
                          <span className="shrink-0 text-text-secondary">{row.shortOid}</span>
                        )}
                        <span className="text-text-primary [overflow-wrap:anywhere]">
                          {row.subject}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {/* 3. THE CAUSE — every optional operation, grouped, above the
              consequences they rewrite. Checking a box below content it
              changes is the "upstream state mutation" failure: the reader has
              already passed the text that just moved. */}
          {/* `disabled` on the fieldset would also trap focus oddly, so the
              controls carry it individually. Frozen during the submit-time
              revalidation: that await can outlive a toggle, and the closure
              would then dispatch the values the user had BEFORE they changed
              their mind. Cancel and Escape stay live throughout.

              Absent entirely while the delete is blocked: every control here
              only shapes a dispatch that cannot happen, and a "Force delete"
              checkbox reading "required to delete this worktree" would be
              offering a way through that does not exist. */}
          {!isBlocked && (
            <fieldset className="space-y-3">
              <legend className="text-2xs font-semibold uppercase tracking-wider text-text-secondary">
                Options
              </legend>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  disabled={isDeleting}
                  className="checkbox-neutral mt-0.5 rounded border-border-strong bg-surface-canvas disabled:opacity-50"
                />
                <span className="text-sm text-text-primary">
                  {/* Constant by rule — a toggle label never changes with state
                    (house microcopy), and this one used to swap between three
                    wordings. It also has to stay the same verb as the primary
                    button ("Force delete worktree"), so checking the box and
                    reading the button describe one action, not two. What
                    actually varies is the consequence, stated below and in the
                    "What will happen" list. */}
                  Force delete
                  {(hasChanges || forceRequiredBySubmodules) && (
                    <span className="block text-xs text-text-secondary mt-0.5">
                      {verifyFailed
                        ? "Required because this worktree's status couldn't be verified"
                        : hasChanges
                          ? `Required to delete this worktree — ${changeSummaryLabel} present`
                          : `Required to delete this worktree — ${nestedFileLabel} inside submodules will be discarded`}
                    </span>
                  )}
                </span>
              </label>

              {hasTerminals && (
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={closeTerminals}
                    onChange={(e) => setCloseTerminals(e.target.checked)}
                    disabled={isDeleting}
                    className="checkbox-neutral mt-0.5 rounded border-border-strong bg-surface-canvas disabled:opacity-50"
                  />
                  <span className="text-sm text-text-primary">
                    Close all terminals
                    <span className="ml-1 tabular-nums text-text-secondary">
                      ({terminalCounts.total})
                    </span>
                  </span>
                </label>
              )}

              {canDeleteBranch && (
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteBranch}
                    onChange={(e) => setDeleteBranch(e.target.checked)}
                    disabled={isDeleting}
                    className="checkbox-neutral mt-0.5 rounded border-border-strong bg-surface-canvas disabled:opacity-50"
                  />
                  <span className="flex items-center gap-1.5 text-sm text-text-primary">
                    <FolderGit2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    {/* No branch chip: the entity summary directly above names
                      the branch, and so does the title. A third copy bought
                      nothing and, on a long branch, forced this label to wrap
                      while the chip took the whole remaining width. */}
                    Delete branch
                  </span>
                </label>
              )}
            </fieldset>
          )}

          {/* 4. THE EFFECT — computed from the options directly above. Only
              outcomes that will actually occur are listed — which is why a
              blocked delete lists none: the whole set would be a prediction
              about a call the host refuses. */}
          {!isBlocked && (
            <div>
              <span
                id={consequencesHeadingId}
                role="heading"
                aria-level={3}
                className="text-2xs font-semibold uppercase tracking-wider text-text-secondary"
              >
                What will happen
              </span>
              {/* The list IS the live region. Mirroring it into a second sr-only
                node duplicated every string in the DOM, so assistive tech read
                each consequence twice. `polite` (not `alert`) because these
                change on every checkbox toggle and must not interrupt. */}
              <ul
                data-testid="delete-worktree-consequences"
                aria-labelledby={consequencesHeadingId}
                aria-live="polite"
                aria-relevant="all"
                className="mt-2 space-y-1"
              >
                {consequences.map((row) => (
                  <li
                    key={row.key}
                    data-tone={row.tone}
                    className={cn(
                      "text-sm flex items-start gap-1.5",
                      row.tone === "danger" ? "text-status-error font-medium" : "text-text-primary"
                    )}
                  >
                    {row.tone === "danger" && (
                      <>
                        {/* The irreversible row must not be distinguished by
                          colour alone. Under `forced-colors: active` every
                          status colour resolves to the same system ink, so a
                          red row and a neutral row become identical — the glyph
                          and the weight are what survive. */}
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                        <span className="sr-only">Irreversible: </span>
                      </>
                    )}
                    <span>{row.content}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {isHighTier && (
            <div ref={gateRef}>
              <TypedNameConfirmInput
                target={confirmTarget}
                value={confirmInput}
                onChange={setConfirmInput}
                onMatchSubmit={handleDelete}
                preamble={highTierPreamble}
                disabled={isDeleting}
                data-testid="delete-worktree-confirm-input"
              />
            </div>
          )}
        </div>
      </AppDialog.Body>

      <AppDialog.Footer
        hint={
          // No identifier interpolated here. The gate directly above already
          // shows the exact string to type, and putting an untruncated branch
          // name in the footer is what broke this footer in the first place —
          // it just moves the overflow from the button to the hint.
          isHighTier && !isConfirmMatched
            ? "Confirm the name above to enable"
            : (blockedHint ?? undefined)
        }
        secondaryAction={{ label: "Cancel", onClick: onClose }}
        primaryAction={{
          label: deleteButtonLabel,
          onClick: handleDelete,
          disabled: !canSubmit,
          intent: "destructive",
        }}
      />
    </AppDialog>
  );
}
