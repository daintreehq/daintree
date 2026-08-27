import { useState, useEffect, useRef } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { TypedNameConfirmInput } from "@/components/ui/TypedNameConfirmInput";
import { AlertTriangle, Trash2 } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { collectRunningAgentTerminals } from "@/utils/destructiveSessionConfirm";
import { deriveEffectiveTier } from "@/services/actions/deriveEffectiveTier";
import {
  buildWorktreeDeletePreview,
  buildWorktreeChangeRows,
  summarizeWorktreeChanges,
  PREVIEW_FILE_LIMIT,
  type WorktreeDeletePreview,
} from "@/components/Worktree/worktreeDeletePreview";
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

  const isProtectedBranch = isProtectedBranchName(worktree.branch?.toLowerCase());
  const isDetachedHead = !worktree.branch;
  const canDeleteBranch =
    !isProtectedBranch && !isDetachedHead && worktree.isMainWorktree === false;

  const confirmTarget = worktree.branch || worktree.name;
  const highTierPreamble =
    isProtectedBranch || worktree.isMainWorktree === true
      ? "Force-deleting this protected worktree is irreversible."
      : "Force-deleting this worktree discards uncommitted tracked changes — this is irreversible.";
  const isHighTier =
    deriveEffectiveTier("worktree.delete", {
      force,
      isProtectedBranch,
      isMainWorktree: worktree.isMainWorktree === true,
      hasTrackedChanges,
    }) === "D3";
  const isConfirmMatched = confirmInput === confirmTarget;
  // A standard (non-force) delete on a tree we KNOW is dirty is rejected by
  // the backend, so offering it as the primary action ships a button whose
  // only outcome is a toast and a reopened dialog. Gate it — but only when the
  // dirtiness is verified: after a failed verification the safe non-force
  // attempt is still the right first move, and disabling it would coerce the
  // user into force on the very state we could not check.
  const blockedByDirtyTree = hasChanges && !force && !verifyFailed;
  const canSubmit = (!isHighTier || isConfirmMatched) && !isDeleting && !blockedByDirtyTree;

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
    buildWorktreeDeletePreview(worktree.id)
      .then((preview) => {
        if (!cancelled) setFreshPreview(preview);
      })
      .catch(() => {
        if (!cancelled) setVerifyFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, worktree.id]);

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
  // error. Only the force path needs this — a non-force delete can never
  // discard tracked changes (the backend guard rejects a dirty non-force
  // delete), so it dispatches synchronously and keeps its immediate dismiss.
  const revalidateThenDelete = async () => {
    const session = sessionRef.current;
    setIsDeleting(true);
    let preview: WorktreeDeletePreview | null = null;
    let failed = false;
    try {
      preview = await buildWorktreeDeletePreview(worktree.id);
    } catch {
      failed = true;
    }
    // Abort if the dialog closed/reopened/changed worktree or unmounted while
    // the fresh re-check was in flight — never dispatch against a session the
    // user is no longer looking at.
    if (!mountedRef.current || sessionRef.current !== session) return;
    setFreshPreview(preview);
    setVerifyFailed(failed);
    const freshHasTracked = failed ? true : (preview ?? seedSummary).hasTrackedChanges;
    const freshTier = deriveEffectiveTier("worktree.delete", {
      force: true,
      isProtectedBranch,
      isMainWorktree: worktree.isMainWorktree === true,
      hasTrackedChanges: freshHasTracked,
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
    if (isDeleting) return;
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
      content: `${terminalCounts.total} terminal${terminalCounts.total === 1 ? "" : "s"} will be closed${
        runningAgentCount > 0
          ? ` — ${runningAgentCount} running an agent${runningAgentCount === 1 ? "" : "s"}`
          : ""
      }`,
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
      content: `${changeSummaryLabel} will be permanently lost`,
    });
  }
  if (deleteBranch && canDeleteBranch) {
    consequences.push({
      key: "branch",
      tone: "neutral",
      content: (
        <>
          Branch <span className="font-mono break-all">{worktree.branch}</span> will be deleted
          {" — "}
          <span className="text-daintree-text/60">fails if it has unmerged changes</span>
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

  // Standard (non-force) deletion is rejected by the backend when the tree is
  // dirty, so the primary action would fail. Say so where the decision is made
  // rather than letting the user find out from a toast.
  const blockedHint = !hasChanges
    ? null
    : force
      ? null
      : verifyFailed
        ? "Couldn't verify this worktree — force delete to proceed anyway"
        : `Select Force delete to continue — ${changeSummaryLabel} present`;

  const changesHeadingId = "worktree-delete-changes-heading";
  const consequencesHeadingId = "worktree-delete-consequences-heading";

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
        <AppDialog.Title icon={<Trash2 className="w-4 h-4 text-status-error" />}>
          Delete '{confirmTarget}'?
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
          <dl className="rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2.5 text-xs">
            {worktree.branch && (
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-daintree-text/50">Branch</dt>
                <dd className="font-mono text-daintree-text [overflow-wrap:anywhere]">
                  {worktree.branch}
                </dd>
              </div>
            )}
            <div className={cn("flex gap-2", worktree.branch && "mt-1.5")}>
              <dt className="w-14 shrink-0 text-daintree-text/50">Path</dt>
              <dd className="font-mono text-daintree-text/70 [overflow-wrap:anywhere]">
                {worktree.path}
              </dd>
            </div>
          </dl>

          {verifyFailedBanner}

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
                  className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60"
                >
                  Uncommitted work
                </span>
                <span className="text-[11px] tabular-nums text-daintree-text/50">
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
                className="mt-2 max-h-32 overflow-auto text-xs text-daintree-text/70 bg-daintree-bg p-3 rounded-[var(--radius-md)] border border-border-strong font-mono space-y-0.5"
              >
                {previewChangeRows.map((row) => (
                  <li
                    key={row.isOverflow ? "__overflow" : `${row.glyph}:${row.label}`}
                    className={cn("flex gap-2", row.isOverflow && "text-daintree-text/50 italic")}
                  >
                    {!row.isOverflow && (
                      <>
                        <span aria-hidden="true" className="w-3 shrink-0 text-daintree-text/50">
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

          {/* 3. THE CAUSE — every optional operation, grouped, above the
              consequences they rewrite. Checking a box below content it
              changes is the "upstream state mutation" failure: the reader has
              already passed the text that just moved. */}
          {/* `disabled` on the fieldset would also trap focus oddly, so the
              controls carry it individually. Frozen during the submit-time
              revalidation: that await can outlive a toggle, and the closure
              would then dispatch the values the user had BEFORE they changed
              their mind. Cancel and Escape stay live throughout. */}
          <fieldset className="space-y-3">
            <legend className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
              Options
            </legend>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                disabled={isDeleting}
                className="checkbox-neutral mt-0.5 rounded border-border-strong bg-daintree-bg disabled:opacity-50"
              />
              <span className="text-sm text-daintree-text">
                {/* Constant by rule — a toggle label never changes with state
                    (house microcopy), and this one used to swap between three
                    wordings. It also has to stay the same verb as the primary
                    button ("Force delete worktree"), so checking the box and
                    reading the button describe one action, not two. What
                    actually varies is the consequence, stated below and in the
                    "What will happen" list. */}
                Force delete
                {hasChanges && (
                  <span className="block text-xs text-daintree-text/60 mt-0.5">
                    {verifyFailed
                      ? "Required because this worktree's status couldn't be verified"
                      : `Required to delete this worktree — ${changeSummaryLabel} present`}
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
                  className="checkbox-neutral mt-0.5 rounded border-border-strong bg-daintree-bg disabled:opacity-50"
                />
                <span className="text-sm text-daintree-text">
                  Close all terminals
                  <span className="ml-1 tabular-nums text-daintree-text/60">
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
                  className="checkbox-neutral mt-0.5 rounded border-border-strong bg-daintree-bg disabled:opacity-50"
                />
                <span className="flex items-center gap-1.5 text-sm text-daintree-text">
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

          {/* 4. THE EFFECT — computed from the options directly above. Only
              outcomes that will actually occur are listed. */}
          <div>
            <span
              id={consequencesHeadingId}
              role="heading"
              aria-level={3}
              className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60"
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
                    row.tone === "danger" ? "text-status-error font-medium" : "text-daintree-text"
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
