import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderInput,
  FolderSearch,
  HelpCircle,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { basename, dirname, join, normalize } from "@shared/utils/path";
import { validateFolderName } from "@shared/utils/folderName";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { AgentContinuitySummary, RelocationPreview } from "@shared/types/projectRelocation";
import { AppDialog } from "@/components/ui/AppDialog";
import { Spinner } from "@/components/ui/Spinner";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import {
  FIELD_INPUT,
  FormGrid,
  FormRow,
  FormSection,
} from "@/components/Worktree/views/WorktreeFormLayout";
import { projectClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useDohertyGate } from "@/hooks";
import {
  useProjectRelocationStore,
  type PendingProjectRelocation,
} from "@/store/projectRelocationStore";
import { DirectoryPickerField, PathCaption } from "./projectDialogFields";
import { PathSegments } from "@/components/ui/PathSegments";

/** Typing pause before the preview is requested, so a folder name isn't checked per keystroke. */
const PREVIEW_DEBOUNCE_MS = 250;

/** NFC + separator normalization for comparing two folder paths for equality. */
function normPath(value: string): string {
  return normalize(value).normalize("NFC");
}

/**
 * How each conversation-continuity tier renders in the preview (#11282, phase 5).
 * `label` is the sentence-case headline; `detailFallback` is used when the agent
 * config supplies no provider-specific `detail`. Preserved/project-local read as
 * calm success; provider-migration/unavailable warn the user before the move;
 * unverified stays neutral so we neither alarm nor overclaim.
 */
const CONTINUITY_PRESENTATION: Record<
  AgentContinuitySummary["tier"],
  { icon: LucideIcon; className: string; label: string; detailFallback: string }
> = {
  preserved: {
    icon: CheckCircle2,
    className: "text-status-success",
    // Capability language, not a guarantee: session capture on graceful stop can
    // still miss (timeout / unmatched exit output), so we say "expected", not "will".
    label: "Resume supported",
    detailFallback: "Expected to resume automatically at the new location",
  },
  "project-local": {
    icon: CheckCircle2,
    className: "text-status-success",
    label: "Conversation stays with the folder",
    detailFallback: "Resumes from the project folder, which moves with it",
  },
  "provider-migration": {
    icon: AlertTriangle,
    className: "text-status-warning",
    label: "Provider migration required",
    detailFallback: "The provider can't resume this conversation at the new path",
  },
  unavailable: {
    icon: AlertTriangle,
    className: "text-status-warning",
    label: "Conversation can't be resumed",
    detailFallback: "This agent has no way to resume the conversation after a move",
  },
  unverified: {
    icon: HelpCircle,
    className: "text-text-secondary",
    label: "Resume after move unverified",
    detailFallback: "Resuming this conversation after a move isn't confirmed",
  },
};

/** A full path for the From/To rows, wrapping only between folders. */
function WrappingPath({
  path,
  className,
  testId,
}: {
  path: string;
  className?: string;
  testId?: string;
}) {
  return (
    <p className={cn("text-xs font-mono", className)} title={path} data-testid={testId}>
      <PathSegments path={normalize(path)} />
    </p>
  );
}

/**
 * The preview reads the destination from disk, so its failures arrive as raw
 * filesystem errors. A permission failure is the one a user can act on, and
 * "EACCES" tells them nothing about what to do; the raw text still rides along
 * as the diagnostic line.
 */
function describePreviewFailure(detail: string): string {
  return /\b(EACCES|EPERM)\b|permission denied/i.test(detail)
    ? "Daintree can't read the destination. Check its permissions, then retry."
    : detail;
}

function MoveOrRenameProjectDialogInner({
  pending,
  onClose,
}: {
  pending: PendingProjectRelocation;
  onClose: () => void;
}) {
  const isReattach = pending.mode === "reattach";
  const updateProject = useProjectStore((s) => s.updateProject);

  const [displayName, setDisplayName] = useState(pending.name);
  const [parentPath, setParentPath] = useState(isReattach ? "" : dirname(pending.oldPath));
  const [folderName, setFolderName] = useState(isReattach ? "" : basename(pending.oldPath));
  const [reattachPath, setReattachPath] = useState("");

  const [preview, setPreview] = useState<RelocationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  // Bumped by Retry, so a failed preview can be re-run for the same destination
  // without the user editing a field to provoke one.
  const [previewAttempt, setPreviewAttempt] = useState(0);
  // Bumped on every fetch so a superseded response (folder edited again mid-flight)
  // can't replace a newer preview — the #9575 stale-request guard.
  const previewReqId = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const folderErrorId = useId();

  const trimmedName = displayName.trim();
  const displayNameChanged = trimmedName !== "" && trimmedName !== pending.name;

  const trimmedFolder = folderName.trim();
  const folderNameError = isReattach || !trimmedFolder ? null : validateFolderName(folderName);
  const destinationPath = isReattach
    ? reattachPath
    : parentPath && trimmedFolder && !folderNameError
      ? join(parentPath, trimmedFolder)
      : "";
  // A reattach commits ANY selected folder — even the original path, e.g. a
  // removable volume that reappeared — so it gates on "a target was picked", not
  // "the path changed". A managed move requires a genuinely different path.
  const destinationChanged = isReattach
    ? reattachPath !== ""
    : destinationPath !== "" && normPath(destinationPath) !== normPath(pending.oldPath);

  // A pure display-name edit stays a lightweight metadata write — no filesystem
  // op, no preview, no coordinator. Reattach never qualifies (the folder move is
  // mandatory), and a case-only folder rename stays a real move (case-sensitive
  // comparison after NFC normalization). The folder fields must resolve to the
  // CURRENT location, not merely fail to resolve: an invalid or emptied folder
  // name would otherwise read as "unchanged" and quietly commit only the rename.
  const folderUnchanged = !isReattach && destinationPath !== "" && !destinationChanged;
  const isMetadataOnly = folderUnchanged && displayNameChanged;

  const showLoading = useDohertyGate(isPreviewLoading);

  // Fetch the preview whenever there's a genuine folder change to describe. Sets
  // `preview = null` (the "not loaded" sentinel) before every request so confirm
  // stays gated; an empty preview array means "loaded, nothing affected".
  useEffect(() => {
    // Invalidate any in-flight fetch on EVERY run — including this early return —
    // so a response for an older destination can't repopulate state after the
    // user reverts to an unchanged/empty folder.
    const reqId = ++previewReqId.current;
    if (!destinationChanged || !destinationPath) {
      setPreview(null);
      setLoadError(null);
      setIsPreviewLoading(false);
      return;
    }
    setPreview(null);
    setLoadError(null);
    setIsPreviewLoading(true);
    const timer = setTimeout(() => {
      void projectClient
        .previewRelocation({
          projectId: pending.projectId,
          mode: pending.mode,
          newPath: destinationPath,
        })
        .then((result) => {
          if (previewReqId.current !== reqId) return;
          setPreview(result);
          setIsPreviewLoading(false);
        })
        .catch((err) => {
          if (previewReqId.current !== reqId) return;
          setLoadError(formatErrorMessage(err, "Couldn't preview the changes"));
          setIsPreviewLoading(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [destinationChanged, destinationPath, pending.projectId, pending.mode, previewAttempt]);

  // Focus the name rather than the dialog's first tabbable, which is the header
  // close button: opening a form on its dismissal is backwards.
  useEffect(() => {
    const frame = requestAnimationFrame(() => nameInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const handleBrowseParent = useCallback(async () => {
    try {
      const selected = await projectClient.openDialog();
      if (selected) {
        setParentPath(selected);
        setApplyError(null);
      }
    } catch {
      setApplyError("Couldn't open the folder picker");
    }
  }, []);

  const handleBrowseReattach = useCallback(async () => {
    try {
      const selected = await projectClient.openDialog();
      if (selected) {
        setReattachPath(selected);
        setApplyError(null);
      }
    } catch {
      setApplyError("Couldn't open the folder picker");
    }
  }, []);

  const handleConfirm = useCallback(async () => {
    setApplyError(null);
    setIsApplying(true);
    try {
      if (isMetadataOnly) {
        await updateProject(pending.projectId, { name: trimmedName });
        pending.onDisplayNameCommitted?.(trimmedName);
      } else {
        await projectClient.applyRelocation({
          projectId: pending.projectId,
          mode: pending.mode,
          newPath: destinationPath,
        });
        // The folder op is the committed, irreversible part. Apply the display
        // name only AFTER it succeeds (never a half-applied rename on failure) —
        // but in its OWN guard: a failure of this best-effort follow-up must not
        // report the successful move as failed or strand an unretryable dialog
        // (retrying the move would hit `same-path`).
        if (displayNameChanged) {
          try {
            await updateProject(pending.projectId, { name: trimmedName });
            pending.onDisplayNameCommitted?.(trimmedName);
          } catch (nameErr) {
            console.warn("[relocate] folder moved but display-name update failed:", nameErr);
            // The move (the irreversible part) succeeded, so we still close — but
            // the user couldn't otherwise observe that the rename half didn't
            // land, so surface it with a manual-recovery hint.
            // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
            notify({
              type: "warning",
              title: "Name not updated",
              message:
                "The project moved, but its display name couldn't be updated. Rename it from Project Settings.",
              context: { eventKind: "settings", projectId: pending.projectId },
            });
          }
        }
      }
      onClose();
    } catch (err) {
      setApplyError(
        formatErrorMessage(
          err,
          isReattach ? "Couldn't reattach the project" : "Couldn't move the project"
        )
      );
      setIsApplying(false);
    }
  }, [
    isMetadataOnly,
    isReattach,
    updateProject,
    pending,
    trimmedName,
    displayNameChanged,
    destinationPath,
    onClose,
  ]);

  const hasBlockers = (preview?.blockers.length ?? 0) > 0;
  const nothingToDo = !destinationChanged && !displayNameChanged;
  // `isApplying` is deliberately absent: the in-flight button is `loading`,
  // which already blocks activation, and stacking the disabled styling on top
  // greyed out the one control that says the move is running.
  const confirmDisabled =
    nothingToDo ||
    Boolean(folderNameError) ||
    (!isReattach && !trimmedFolder) ||
    (isMetadataOnly
      ? false
      : !destinationChanged || preview === null || Boolean(loadError) || hasBlockers);

  // Enter commits from any field, but only through the same gate as the button
  // — never a preview-less, blocked or doubled commit. Focus moves to the
  // primary first: committing freezes the field it was typed in, and a focused
  // element that becomes disabled drops focus out of the dialog altogether.
  const commitFromKeyboard = () => {
    if (confirmDisabled || isApplying) return;
    nameInputRef.current
      ?.closest<HTMLElement>('[aria-modal="true"]')
      ?.querySelector<HTMLElement>('[data-confirm-role="confirm"]')
      ?.focus({ preventScroll: true });
    void handleConfirm();
  };

  const handleFieldKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter that confirms an IME candidate is composition, not submission.
    if (e.nativeEvent.isComposing || e.key !== "Enter") return;
    e.preventDefault();
    commitFromKeyboard();
  };

  // Retry unmounts the banner holding the focused button, so hand focus to the
  // control that decides what gets checked.
  const handleRetryPreview = () => {
    setPreviewAttempt((n) => n + 1);
    document.getElementById(isReattach ? "relocate-existing" : "relocate-folder")?.focus();
  };

  const title = isReattach ? "Locate moved project" : "Move or rename project";
  const confirmLabel = isMetadataOnly
    ? "Rename project"
    : isReattach
      ? "Reattach project"
      : "Move project";
  const failureTitle = isMetadataOnly
    ? "Rename failed"
    : isReattach
      ? "Reattach failed"
      : "Move failed";

  // One line beside the actions that answers "what will pressing it do?" or,
  // while it can't be pressed, "why not?". It is also the dialog's polite
  // status region, so a screen reader hears the check finish, block or fail
  // without the whole preview being re-announced after every keystroke.
  const hint: ReactNode = isApplying ? (
    isMetadataOnly ? (
      "Renaming the project…"
    ) : isReattach ? (
      "Reattaching the project…"
    ) : (
      "Moving the project…"
    )
  ) : applyError ? (
    `${failureTitle} — details above`
  ) : folderNameError ? (
    "Fix the folder name to continue"
  ) : !isReattach && !trimmedFolder ? (
    "Name the folder to continue"
  ) : isReattach && !reattachPath ? (
    // Ahead of any name change: a reattach can't commit without a folder, and
    // a name edit alone would otherwise read as a check that never starts.
    "Choose where the folder is now to continue"
  ) : nothingToDo ? (
    "Change the name or location to continue"
  ) : isMetadataOnly ? (
    "Updates the display name only"
  ) : loadError ? (
    "Retry the check to continue"
  ) : preview === null ? (
    <>
      {showLoading && <Spinner className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">Checking what will change…</span>
    </>
  ) : hasBlockers ? (
    isReattach ? (
      "This folder can't be reattached"
    ) : (
      "This move can't go ahead"
    )
  ) : (
    <>
      <span className="shrink-0">{isReattach ? "Reattaches at" : "Moves to"}</span>
      <PathCaption path={preview.newPath} className="min-w-0 text-text-primary" />
    </>
  );

  return (
    <AppDialog
      isOpen={true}
      onClose={onClose}
      size="md"
      dismissible={!isApplying}
      initialFocus="none"
      hasPreview={true}
      zIndex="nested"
    >
      <AppDialog.Header className="py-3">
        {/* Neutral, not accent: the header glyph is decoration, and this focus
            region's one load-bearing accent is the keyboard focus ring. */}
        <AppDialog.Title
          icon={
            isReattach ? (
              <FolderSearch className="h-4 w-4 text-text-secondary" />
            ) : (
              <FolderInput className="h-4 w-4 text-text-secondary" />
            )
          }
        >
          {title}
        </AppDialog.Title>
        {!isApplying && <AppDialog.CloseButton />}
      </AppDialog.Header>

      {/* A failure lands as a banner at the top of the body; after a long
          preview the body is scrolled well past it, so bring it into view. */}
      <AppDialog.Body className="space-y-5" resetScrollKey={applyError ?? undefined}>
        <div className="space-y-5" data-testid="move-or-rename-project-dialog">
          {/* Outcome first, above the fields it is about: a failed commit
              returns the user to the form with everything intact, and at the
              foot of a long preview it would scroll out of sight. */}
          {applyError && (
            <div data-testid="relocate-apply-error">
              <InlineStatusBanner
                severity="error"
                title={failureTitle}
                description={applyError}
                className="rounded-[var(--radius-md)]"
              />
            </div>
          )}

          <FormGrid>
            <FormRow label="Display name" htmlFor="relocate-name">
              <input
                ref={nameInputRef}
                id="relocate-name"
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setApplyError(null);
                }}
                // Frozen for the length of the commit: an edit made now would
                // describe an operation other than the one already running.
                onKeyDown={handleFieldKeyDown}
                disabled={isApplying}
                spellCheck={false}
                autoComplete="off"
                className={FIELD_INPUT}
                // An emptied field keeps the current name; saying so beats a
                // blank box that silently commits nothing.
                placeholder={pending.name}
                data-testid="relocate-name-input"
              />
            </FormRow>

            {isReattach ? (
              <>
                <FormRow label="Last seen at">
                  {/* Inset to the fields' text, so the old and new paths share a column. */}
                  <PathCaption path={pending.oldPath} className="min-w-0 px-2.5" />
                </FormRow>
                <FormRow label="Now at" htmlFor="relocate-existing">
                  <DirectoryPickerField
                    id="relocate-existing"
                    value={reattachPath}
                    onBrowse={() => void handleBrowseReattach()}
                    disabled={isApplying}
                    placeholder="Choose where the folder is now…"
                    browseLabel="Browse for the project folder"
                    onEnter={commitFromKeyboard}
                  />
                </FormRow>
              </>
            ) : (
              <>
                <FormRow label="Location" htmlFor="relocate-parent">
                  <DirectoryPickerField
                    id="relocate-parent"
                    value={parentPath}
                    onBrowse={() => void handleBrowseParent()}
                    disabled={isApplying}
                    browseLabel="Browse for a new location"
                    onEnter={commitFromKeyboard}
                  />
                </FormRow>
                <FormRow
                  label="Folder name"
                  htmlFor="relocate-folder"
                  hint={
                    // No live role, as with the shared `FieldError`: it would
                    // speak on every keystroke. aria-invalid plus the
                    // described-by association announce it on focus, and the
                    // footer status says once that the name needs fixing.
                    folderNameError && (
                      <p id={folderErrorId} className="text-xs text-status-error">
                        {folderNameError}
                      </p>
                    )
                  }
                >
                  <input
                    id="relocate-folder"
                    type="text"
                    value={folderName}
                    onChange={(e) => {
                      setFolderName(e.target.value);
                      setApplyError(null);
                    }}
                    onKeyDown={handleFieldKeyDown}
                    disabled={isApplying}
                    aria-invalid={folderNameError != null || undefined}
                    aria-describedby={folderNameError ? folderErrorId : undefined}
                    spellCheck={false}
                    autoComplete="off"
                    className={cn(
                      FIELD_INPUT,
                      folderNameError && "border-status-error focus-visible:outline-status-error"
                    )}
                    placeholder="my-project"
                    data-testid="relocate-folder-input"
                  />
                </FormRow>
              </>
            )}

            {destinationChanged && (
              <RelocationPreviewSection
                preview={preview}
                loadError={loadError}
                oldPath={pending.oldPath}
                onRetry={handleRetryPreview}
              />
            )}
          </FormGrid>
        </div>
      </AppDialog.Body>

      <AppDialog.Footer
        hint={
          <span
            role="status"
            aria-live="polite"
            className="flex min-w-0 items-center gap-1.5 truncate"
            data-testid="relocate-status"
          >
            {hint}
          </span>
        }
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: isApplying }}
        primaryAction={{
          label: confirmLabel,
          onClick: () => void handleConfirm(),
          loading: isApplying,
          disabled: confirmDisabled,
        }}
      />
    </AppDialog>
  );
}

function RelocationPreviewSection({
  preview,
  loadError,
  oldPath,
  onRetry,
}: {
  preview: RelocationPreview | null;
  loadError: string | null;
  oldPath: string;
  onRetry: () => void;
}) {
  if (loadError) {
    return (
      <div className="col-span-2 mt-4" data-testid="relocate-preview-error">
        <InlineStatusBanner
          severity="error"
          title="Couldn't check what will change"
          description={describePreviewFailure(loadError)}
          {...(describePreviewFailure(loadError) !== loadError ? { contextLine: loadError } : {})}
          action={{ id: "retry", label: "Retry", icon: RotateCcw, onClick: onRetry }}
          className="rounded-[var(--radius-md)]"
        />
      </div>
    );
  }

  // The wait is reported once, in the footer status beside the button it is
  // holding back; a second copy here only repeated it.
  if (preview === null) return null;

  const nothingAffected =
    preview.runningTerminalCount === 0 &&
    preview.linkedWorktrees.length === 0 &&
    preview.affectedPanelCount === 0;

  return (
    <FormSection title="What changes">
      <FormRow label="From" labelClassName="self-start">
        <WrappingPath path={oldPath} className="text-text-secondary" />
      </FormRow>
      <FormRow label="To" labelClassName="self-start">
        <WrappingPath
          path={preview.newPath}
          className="text-text-primary"
          testId="relocate-preview"
        />
      </FormRow>

      {preview.blockers.length > 0 ? (
        <ul className="col-start-2 space-y-2" data-testid="relocate-blockers">
          {preview.blockers.map((blocker, i) => (
            <li
              key={`${blocker.reason}-${i}`}
              className="flex items-start gap-2 text-xs text-status-error"
            >
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{blocker.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          {preview.runningTerminalCount > 0 && (
            <FormRow label="Terminals" labelClassName="self-start">
              <p className="text-xs">
                <span className="font-medium text-text-primary">
                  {preview.runningTerminalCount === 1
                    ? "1 terminal will be gracefully stopped"
                    : `${preview.runningTerminalCount} terminals will be gracefully stopped`}
                </span>
                <span className="block text-text-secondary"> They restart at the new location</span>
              </p>
            </FormRow>
          )}
          {preview.agentContinuity.length > 0 && (
            <FormRow label="Agents" labelClassName="self-start">
              <ul className="space-y-2 text-xs" data-testid="relocate-continuity">
                {preview.agentContinuity.map((agent) => {
                  // Defense in depth: no plugin or user-registry agent can carry
                  // a `continuity` block today, but an unknown tier arriving from
                  // a future source must degrade to the honest neutral row rather
                  // than crash on an undefined presentation.
                  const p =
                    CONTINUITY_PRESENTATION[agent.tier] ?? CONTINUITY_PRESENTATION.unverified;
                  const Icon = p.icon;
                  return (
                    <li
                      key={agent.agentId}
                      className="flex items-start gap-2"
                      data-testid={`relocate-continuity-${agent.agentId}`}
                    >
                      <Icon
                        className={`mt-px h-3.5 w-3.5 shrink-0 ${p.className}`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 space-y-0.5">
                        <div>
                          <span className="font-medium text-text-primary">
                            {agent.count === 1
                              ? agent.agentName
                              : `${agent.agentName} (${agent.count})`}
                          </span>
                          <span className={`ml-1 ${p.className}`}> {p.label}</span>
                        </div>
                        <div className="text-text-secondary">
                          {agent.detail ?? p.detailFallback}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </FormRow>
          )}
          {preview.linkedWorktrees.length > 0 && (
            <FormRow label="Worktrees" labelClassName="self-start">
              <div className="space-y-1 text-xs">
                <p className="text-text-primary">
                  {preview.linkedWorktrees.length === 1
                    ? "1 linked worktree will be repaired"
                    : `${preview.linkedWorktrees.length} linked worktrees will be repaired`}
                </p>
                {preview.linkedWorktrees.map((wt) => (
                  <WrappingPath key={wt} path={wt} className="text-text-secondary" />
                ))}
              </div>
            </FormRow>
          )}
          {preview.affectedPanelCount > 0 && (
            <FormRow label="Panels">
              <p className="text-xs text-text-primary">
                {preview.affectedPanelCount === 1
                  ? "1 panel will have its paths updated"
                  : `${preview.affectedPanelCount} panels will have their paths updated`}
              </p>
            </FormRow>
          )}
          {nothingAffected && (
            <p className="col-start-2 text-xs text-text-secondary">
              No running terminals, worktrees, or panels affected
            </p>
          )}
        </>
      )}
    </FormSection>
  );
}

/**
 * Host-mounted singleton for the "Move or rename project" workflow (#11282,
 * phase 4). Opened from Project Settings, the healthy-project context menu, and
 * the missing-project recovery flow via {@link useProjectRelocationStore}.
 * Remounts on each `open()` (keyed by `requestSeq`) so its form reseeds cleanly.
 */
export function MoveOrRenameProjectDialog() {
  const pending = useProjectRelocationStore((s) => s.pending);
  const requestSeq = useProjectRelocationStore((s) => s.requestSeq);
  const close = useProjectRelocationStore((s) => s.close);

  if (!pending) return null;
  return <MoveOrRenameProjectDialogInner key={requestSeq} pending={pending} onClose={close} />;
}
