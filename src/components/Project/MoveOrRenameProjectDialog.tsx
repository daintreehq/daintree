import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, AlertTriangle, CheckCircle2, HelpCircle, type LucideIcon } from "lucide-react";
import { basename, dirname, join, normalize } from "@shared/utils/path";
import { validateFolderName } from "@shared/utils/folderName";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { AgentContinuitySummary, RelocationPreview } from "@shared/types/projectRelocation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { projectClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { notify } from "@/lib/notify";
import { useDohertyGate } from "@/hooks";
import {
  useProjectRelocationStore,
  type PendingProjectRelocation,
} from "@/store/projectRelocationStore";

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
    className: "text-daintree-text/50",
    label: "Resume after move unverified",
    detailFallback: "Resuming this conversation after a move isn't confirmed",
  },
};

const INPUT_CLASS =
  "w-full rounded-[var(--radius-md)] border border-daintree-border bg-muted/50 px-3 py-1.5 text-sm text-daintree-text focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 focus:border-daintree-accent aria-invalid:border-status-error";
const READONLY_INPUT_CLASS =
  "flex-1 rounded-[var(--radius-md)] border border-daintree-border bg-muted/50 px-3 py-1.5 text-sm font-mono text-daintree-text/70 truncate";

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
  // Bumped on every fetch so a superseded response (folder edited again mid-flight)
  // can't replace a newer preview — the #9575 stale-request guard.
  const previewReqId = useRef(0);

  const trimmedName = displayName.trim();
  const displayNameChanged = trimmedName !== "" && trimmedName !== pending.name;

  const folderNameError = isReattach || !folderName.trim() ? null : validateFolderName(folderName);
  const destinationPath = isReattach
    ? reattachPath
    : parentPath && folderName.trim() && !folderNameError
      ? join(parentPath, folderName.trim())
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
  // comparison after NFC normalization).
  const isMetadataOnly = !isReattach && !destinationChanged && displayNameChanged;

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
    }, 250);
    return () => clearTimeout(timer);
  }, [destinationChanged, destinationPath, pending.projectId, pending.mode]);

  const handleBrowseParent = useCallback(async () => {
    try {
      const selected = await projectClient.openDialog();
      if (selected) setParentPath(selected);
    } catch {
      setApplyError("Could not open the folder picker");
    }
  }, []);

  const handleBrowseReattach = useCallback(async () => {
    try {
      const selected = await projectClient.openDialog();
      if (selected) setReattachPath(selected);
    } catch {
      setApplyError("Could not open the folder picker");
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
  const confirmDisabled =
    isApplying ||
    nothingToDo ||
    (isMetadataOnly
      ? trimmedName === ""
      : !destinationChanged ||
        Boolean(folderNameError) ||
        preview === null ||
        Boolean(loadError) ||
        hasBlockers);

  const title = isReattach ? "Locate moved project" : "Move or rename project";
  const confirmLabel = isMetadataOnly
    ? "Rename project"
    : isReattach
      ? "Reattach project"
      : "Move project";

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={isApplying ? undefined : onClose}
      title={title}
      confirmLabel={confirmLabel}
      cancelLabel="Cancel"
      onConfirm={handleConfirm}
      confirmDisabled={confirmDisabled}
      isConfirmLoading={isApplying}
      variant="default"
      hasPreview={true}
      zIndex="nested"
    >
      <div className="space-y-4" data-testid="move-or-rename-project-dialog">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-daintree-text/80" htmlFor="relocate-name">
            Display name
          </label>
          <input
            id="relocate-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={INPUT_CLASS}
            placeholder="My Awesome Project"
            data-testid="relocate-name-input"
          />
        </div>

        {isReattach ? (
          <>
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-daintree-text/80">Original location</span>
              <p
                className="text-xs font-mono text-daintree-text/50 break-all"
                title={pending.oldPath}
              >
                {pending.oldPath}
              </p>
            </div>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-daintree-text/80"
                htmlFor="relocate-existing"
              >
                Where is the folder now?
              </label>
              <div className="flex gap-2">
                <input
                  id="relocate-existing"
                  type="text"
                  readOnly
                  aria-readonly="true"
                  value={reattachPath}
                  className={READONLY_INPUT_CLASS}
                  placeholder="Select the project's folder…"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBrowseReattach}
                  disabled={isApplying}
                  className="shrink-0 gap-1.5"
                  data-testid="relocate-browse-existing"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Browse
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-daintree-text/80"
                htmlFor="relocate-parent"
              >
                Parent folder
              </label>
              <div className="flex gap-2">
                <input
                  id="relocate-parent"
                  type="text"
                  readOnly
                  aria-readonly="true"
                  value={parentPath}
                  className={READONLY_INPUT_CLASS}
                  placeholder="Select a parent folder…"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBrowseParent}
                  disabled={isApplying}
                  className="shrink-0 gap-1.5"
                  data-testid="relocate-browse-parent"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Browse
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-daintree-text/80"
                htmlFor="relocate-folder"
              >
                Folder name
              </label>
              <input
                id="relocate-folder"
                type="text"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                aria-invalid={folderNameError != null}
                className={INPUT_CLASS}
                placeholder="my-project"
                data-testid="relocate-folder-input"
              />
              {folderNameError && (
                <p role="alert" className="text-xs text-status-error">
                  {folderNameError}
                </p>
              )}
            </div>
          </>
        )}

        {destinationChanged && (
          <RelocationPreviewSection
            preview={preview}
            showLoading={showLoading}
            loadError={loadError}
            oldPath={pending.oldPath}
          />
        )}

        {applyError && (
          <p role="alert" className="text-xs text-status-error" data-testid="relocate-apply-error">
            {applyError}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

function RelocationPreviewSection({
  preview,
  showLoading,
  loadError,
  oldPath,
}: {
  preview: RelocationPreview | null;
  showLoading: boolean;
  loadError: string | null;
  oldPath: string;
}) {
  if (loadError) {
    return (
      <div
        className="rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/10 px-3 py-2 text-xs text-status-error"
        data-testid="relocate-preview-error"
      >
        {loadError}
      </div>
    );
  }

  if (preview === null) {
    return showLoading ? (
      <div
        className="flex items-center gap-2 text-xs text-daintree-text/60"
        data-testid="relocate-preview-loading"
      >
        <Spinner className="h-3.5 w-3.5" />
        Checking what will change…
      </div>
    ) : null;
  }

  return (
    <div
      className="space-y-3 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg px-3 py-3"
      data-testid="relocate-preview"
    >
      <div className="space-y-1">
        <span className="text-xs font-medium text-daintree-text/60">Folder</span>
        <p className="text-xs font-mono text-daintree-text/50 break-all">{oldPath}</p>
        <p className="text-xs font-mono text-daintree-text break-all">→ {preview.newPath}</p>
      </div>

      {preview.blockers.length > 0 ? (
        <div className="space-y-1.5" data-testid="relocate-blockers">
          {preview.blockers.map((blocker, i) => (
            <div
              key={`${blocker.reason}-${i}`}
              className="flex items-start gap-2 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20 px-2.5 py-2 text-xs text-status-error"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{blocker.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <ul className="space-y-1 text-xs text-daintree-text/70">
          {preview.runningTerminalCount > 0 && (
            <li>
              {preview.runningTerminalCount === 1
                ? "1 terminal will be gracefully stopped"
                : `${preview.runningTerminalCount} terminals will be gracefully stopped`}{" "}
              <span className="text-daintree-text/40">— they restart at the new location</span>
            </li>
          )}
          {preview.agentContinuity.length > 0 && (
            <li data-testid="relocate-continuity">
              <span className="text-daintree-text/70">Agent conversations</span>
              <ul className="mt-1 space-y-1.5 pl-3">
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
                        className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${p.className}`}
                        aria-hidden="true"
                      />
                      <div className="space-y-0.5">
                        <div>
                          {agent.count === 1
                            ? agent.agentName
                            : `${agent.agentName} (${agent.count})`}{" "}
                          <span className="text-daintree-text/40">—</span>{" "}
                          <span className={p.className}>{p.label}</span>
                        </div>
                        <div className="text-daintree-text/40">
                          {agent.detail ?? p.detailFallback}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          )}
          {preview.linkedWorktrees.length > 0 && (
            <li>
              <span>
                {preview.linkedWorktrees.length === 1
                  ? "1 linked worktree will be repaired:"
                  : `${preview.linkedWorktrees.length} linked worktrees will be repaired:`}
              </span>
              <ul className="mt-1 space-y-0.5 pl-3">
                {preview.linkedWorktrees.map((wt) => (
                  <li key={wt} className="font-mono text-daintree-text/50 break-all">
                    {wt}
                  </li>
                ))}
              </ul>
            </li>
          )}
          {preview.affectedPanelCount > 0 && (
            <li>
              {preview.affectedPanelCount === 1
                ? "1 panel will have its paths updated"
                : `${preview.affectedPanelCount} panels will have their paths updated`}
            </li>
          )}
          {preview.runningTerminalCount === 0 &&
            preview.linkedWorktrees.length === 0 &&
            preview.affectedPanelCount === 0 && (
              <li className="text-daintree-text/40">
                No running terminals, worktrees, or panels affected
              </li>
            )}
        </ul>
      )}
    </div>
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
