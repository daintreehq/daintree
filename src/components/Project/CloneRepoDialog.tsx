import { useState, useEffect, useRef, useCallback, useMemo, useId } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { Check, AlertCircle, CircleSlash, FolderOpen, LogIn } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { SkeletonHint } from "@/components/ui/Skeleton";
import { FolderGit2 } from "@/components/icons";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { projectClient, systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { useDohertyGate } from "@/hooks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { validateFolderName } from "@shared/utils/folderName";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import { ProjectEmojiButton } from "./ProjectEmojiButton";
import {
  FIELD_LABEL_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_READONLY_INPUT_CLASS,
  FIELD_CHECKBOX_CLASS,
  FIELD_BROWSE_BUTTON_CLASS,
  FIELD_EMOJI_ROW_INDENT,
  PathCaption,
} from "./projectDialogFields";
import { join as joinPath } from "@shared/utils/path";
import { matchProviderForRemoteUrl } from "@shared/utils/forgeHostnames";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import type { CloneRepoProgressEvent } from "@shared/types/ipc/gitClone";
import type { ProjectCreationIdentity } from "@shared/types";
import type { GitOperationReason } from "@shared/types/ipc/errors";
import { isClientGitError } from "@/utils/clientGitError";
import { isClientAppError } from "@/utils/clientAppError";

interface CloneError {
  message: string;
  gitReason?: GitOperationReason;
}

interface CloneForgeProvider {
  providerId: string;
  name: string;
  hostnames: string[];
}

interface CloneRepoDialogProps {
  isOpen: boolean;
  onSuccess: (clonedPath: string, identity?: ProjectCreationIdentity) => void;
  onCancel: () => void;
}

const AUTO_CLOSE_DELAY_MS = 2000;

/**
 * House rule for a wait with nothing to show is reassurance past five seconds;
 * `SkeletonHint`'s own default is eight, which suits a skeleton that at least
 * has shape. Only the first threshold moves — the later escalations keep the
 * shared cadence.
 */
const STILL_WORKING_AFTER_MS = 5000;

/** Stages that end the operation. They are reported by the promise, not as a row. */
const TERMINAL_STAGES = new Set(["complete", "error", "cancelled"]);

/**
 * Git's own stage labels arrive pre-formatted as `"Receiving objects: 64%"`, and
 * the percentage gets its own tabular slot here, so strip it off the label. The
 * trailing-colon trim catches simple-git's `"remote:"` stage key, which the main
 * process capitalises into the doubled `"Remote:: 100%"`.
 */
function stageLabel(event: CloneRepoProgressEvent): string {
  const label = event.message
    .replace(/\s*:\s*\d+%\s*$/, "")
    .replace(/:+$/, "")
    .trim();
  return label || "Working";
}

function stagePercent(event: CloneRepoProgressEvent): number {
  return Math.min(100, Math.max(0, Math.round(event.progress)));
}

function extractFolderName(url: string): string {
  const trimmed = url
    .trim()
    .replace(/[/\\]+$/, "")
    .replace(/\.git$/, "");
  const lastSegment = trimmed.split(/[/\\]/).filter(Boolean).pop() ?? "";
  return lastSegment.replace(/[^\p{L}\p{N}\p{M}_.-]/gu, "");
}

function isOwnerRepoShorthand(input: string): boolean {
  if (/^https?:\/\//i.test(input) || /^git@/i.test(input) || /^ssh:\/\//i.test(input)) {
    return false;
  }
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?\/[a-zA-Z0-9._-]{1,100}$/.test(input);
}

// `owner/repo` shorthand expands against the sole registered forge provider's
// first hostname — unambiguous only when exactly one provider is installed.
// With zero or multiple providers the shorthand has no well-defined host, so
// it stays unexpanded (and fails URL validation) rather than silently
// defaulting to any one forge.
function normalizeCloneUrl(input: string, shorthandHost: string | null): string {
  const trimmed = input.trim();
  if (shorthandHost && isOwnerRepoShorthand(trimmed)) {
    return `https://${shorthandHost}/${trimmed}`;
  }
  return trimmed;
}

function isValidCloneUrl(url: string, shorthandHost: string | null): boolean {
  const normalized = normalizeCloneUrl(url, shorthandHost);
  return /^https?:\/\//i.test(normalized) || /^git@/i.test(normalized);
}

export function CloneRepoDialog({ isOpen, onSuccess, onCancel }: CloneRepoDialogProps) {
  const folderNameErrorId = useId();
  const [url, setUrl] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [folderName, setFolderName] = useState("");
  const [folderNameEdited, setFolderNameEdited] = useState(false);
  // Suggestion follows the folder name (however it got there — URL-derived or
  // typed) until the user picks explicitly; after that the pick sticks.
  const [pickedEmoji, setPickedEmoji] = useState<string | null>(null);
  const [shallowClone, setShallowClone] = useState(false);
  // Stages in first-seen order, plus which one is live. Git's clone phases run
  // strictly in sequence and each one counts 0→100% of *itself*, so a lone bar
  // would fill and reset four times and read as the operation going backwards.
  // Quiet checkmarks for the phases already done explain each reset, and are
  // the same done/current treatment `RebaseSequenceRail` uses.
  const [stages, setStages] = useState<CloneRepoProgressEvent[]>([]);
  const [currentStageKey, setCurrentStageKey] = useState<string | null>(null);
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState<CloneError | null>(null);
  // A user-initiated stop is an outcome, not a failure — it gets a neutral
  // banner over the re-enabled form instead of the error surface.
  const [wasCancelled, setWasCancelled] = useState(false);
  // Git's teardown (killing the child, removing the partial clone) is not
  // instant, so the stop button acknowledges the click instead of sitting
  // there looking unpressed.
  const [isStopping, setIsStopping] = useState(false);
  // Kept separate from `progressEvents` (which dedups by stage) so the
  // cleanup-failure banner isn't swallowed by, or lost among, progress rows.
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [clonedPath, setClonedPath] = useState<string | null>(null);
  // Where the partial clone was left, pinned when the clone was launched. A
  // failure or a stop hands the form back editable with the cleanup banner
  // still up, so deriving this from the live fields would silently repoint the
  // banner — and its "Show in folder" action — at a folder that was never
  // cloned into. This mirrors the `path.join(parentPath, trimmedFolder)` the
  // main process composes and names in its `cleanup-failed` message.
  const [strandedPath, setStrandedPath] = useState<string | null>(null);
  // Registered forge providers — gate the auth-failed recovery banner on the
  // clone URL belonging to a registered provider, and derive that banner's
  // sign-in label/route plus the owner/repo shorthand host.
  const [forgeProviders, setForgeProviders] = useState<CloneForgeProvider[]>([]);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const footerActionRef = useRef<HTMLButtonElement>(null);
  const previousModeRef = useRef<"configure" | "running" | "failed" | "complete">("configure");
  const hasFinalizedRef = useRef(false);

  const suggestedEmoji = useMemo(() => {
    const trimmed = folderName.trim();
    return trimmed ? suggestProjectEmoji(trimmed) : DEFAULT_PROJECT_EMOJI;
  }, [folderName]);
  const effectiveEmoji = pickedEmoji ?? suggestedEmoji;

  const finalizeSuccess = useCallback(() => {
    if (hasFinalizedRef.current || !clonedPath) return;
    hasFinalizedRef.current = true;
    const trimmedName = folderName.trim();
    onSuccess(clonedPath, trimmedName ? { name: trimmedName, emoji: effectiveEmoji } : undefined);
  }, [onSuccess, clonedPath, folderName, effectiveEmoji]);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!isOpen) {
      setUrl("");
      setParentPath("");
      setFolderName("");
      setFolderNameEdited(false);
      setPickedEmoji(null);
      setShallowClone(false);
      setStages([]);
      setCurrentStageKey(null);
      setIsCloning(false);
      setError(null);
      setWasCancelled(false);
      setIsStopping(false);
      setCleanupError(null);
      setIsComplete(false);
      setClonedPath(null);
      setStrandedPath(null);
      hasFinalizedRef.current = false;
      return;
    }

    const cleanup = projectClient.onCloneProgress((event) => {
      if (event.stage === "cleanup-failed") {
        setCleanupError(event.message);
        return;
      }
      // The terminal stages duplicate what the `cloneRepo` promise already
      // reports. Rendering them as well is what put the same failure on screen
      // twice, once as a row and once as a banner.
      if (TERMINAL_STAGES.has(event.stage)) return;
      setStages((prev) => {
        const merged = new Map(prev.map((e) => [e.stage, e]));
        merged.set(event.stage, event);
        return [...merged.values()];
      });
      setCurrentStageKey(event.stage);
    });

    return cleanup;
  }, [isOpen]);

  // Load the registered forge providers per open — best-effort, the recovery
  // banner simply stays generic on failure.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void window.electron.forge
      .getProviders()
      .then((entries) => {
        if (cancelled) return;
        setForgeProviders(
          entries.map((entry) => ({
            providerId: makeForgeProviderId(entry.pluginId, entry.contribution.id),
            name: entry.contribution.name,
            hostnames: entry.contribution.matches,
          }))
        );
      })
      .catch(() => {
        if (!cancelled) setForgeProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const shorthandHost =
    forgeProviders.length === 1 ? (forgeProviders[0]?.hostnames[0] ?? null) : null;

  // Auto-derive folder name from URL
  useEffect(() => {
    if (!folderNameEdited) {
      setFolderName(extractFolderName(normalizeCloneUrl(url, shorthandHost)));
    }
  }, [url, folderNameEdited, shorthandHost]);

  // Auto-close on success
  useEffect(() => {
    if (!isOpen || !isComplete) return;

    const timeoutId = window.setTimeout(() => {
      finalizeSuccess();
    }, AUTO_CLOSE_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen, isComplete, finalizeSuccess]);

  // AppDialog's default `initialFocus="first"` lands on the header close
  // button, which puts the focus ring — this region's one accent — on "get out
  // of here". A form dialog's first stop is its first field.
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => urlInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const pickDirectory = async () => {
    const selected = await projectClient.openDialog();
    if (selected) {
      setParentPath(selected);
    }
  };

  const startClone = async () => {
    const targetFolder = folderName.trim();
    setIsCloning(true);
    setError(null);
    setWasCancelled(false);
    setIsStopping(false);
    setCleanupError(null);
    setIsComplete(false);
    setStages([]);
    setCurrentStageKey(null);
    // Pin the destination this run is launched against, from the very values
    // handed to the main process, before the form becomes editable again.
    setStrandedPath(joinPath(parentPath, targetFolder));
    hasFinalizedRef.current = false;

    try {
      const { clonedPath: resultPath } = await projectClient.cloneRepo({
        url: normalizeCloneUrl(url, shorthandHost),
        parentPath,
        folderName: targetFolder,
        shallowClone,
      });

      setClonedPath(resultPath);
      setIsComplete(true);
    } catch (err) {
      // CANCELLED is the user aborting via the cancel button — not a failure.
      // It has to be decoded, not read off the error: contextBridge strips own
      // properties (including `code`) when the preload's reconstructed error
      // crosses into the renderer, so `err.code` is always undefined here and
      // every stop used to surface as "Clone failed" with the raw
      // `[AppError|CANCELLED]` prefix showing. `isClientAppError` decodes the
      // message prefix the preload injects, exactly as `isClientGitError` does
      // for the git branch below.
      if (isClientAppError(err) && err.code === "CANCELLED") {
        setWasCancelled(true);
      } else {
        // Decode the preload-injected `[GitError|...]` message prefix so we
        // can branch on `gitReason`. contextBridge strips own Error properties
        // when the preload's reconstructed error crosses to the renderer, so
        // the prefix is the only reliable carrier; `isClientGitError` decodes
        // it and reattaches `gitReason` onto the error.
        const gitReason = isClientGitError(err) ? err.gitReason : undefined;
        setError({
          message: formatErrorMessage(err, "Failed to clone repository"),
          gitReason,
        });
      }
    } finally {
      setIsCloning(false);
      setIsStopping(false);
      // Drop the live phase whatever the outcome. Success and failure have
      // modes of their own that don't render it, but a stop returns to the
      // form — and a leftover phase would keep `isRunning` true, leaving the
      // dialog looking like it were still cloning.
      setStages([]);
      setCurrentStageKey(null);
    }
  };

  const stopClone = () => {
    setIsStopping(true);
    void projectClient.cancelClone();
  };

  const handleClose = () => {
    if (isCloning) return;
    if (isComplete) {
      finalizeSuccess();
    } else {
      onCancel();
    }
  };

  // Show validation errors only after the user has touched the field or the
  // URL-derived name is non-empty — keeps the empty-state quiet while ensuring
  // a bad auto-derived name (e.g. URL ending in "con.git") still surfaces.
  const folderNameError =
    folderNameEdited || folderName.trim() !== "" ? validateFolderName(folderName) : null;
  const canClone =
    isValidCloneUrl(url, shorthandHost) &&
    parentPath.trim() !== "" &&
    folderName.trim() !== "" &&
    folderNameError === null;
  // Doherty gate: don't flash the running mode for a sub-400ms gap before the
  // first git progress event — only switch once the wait exceeds the threshold.
  // Once real progress arrives the running mode stays up regardless.
  const currentIndex = stages.findIndex((e) => e.stage === currentStageKey);
  const currentStage = currentIndex === -1 ? null : (stages[currentIndex] ?? null);
  const completedStages = currentIndex === -1 ? [] : stages.slice(0, currentIndex);

  // The gate belongs on the clone itself, not on the absence of events. Gating
  // "no event yet" let a fast clone that reports progress inside 400ms switch
  // modes immediately — the flash the threshold exists to prevent.
  const isRunning = useDohertyGate(isCloning);

  // Four modes of one surface. Configuration stays on screen through the
  // sub-gate window and after a stop, so a fast clone never flashes a mode
  // change and a stopped clone lands back on an editable form.
  const mode: "configure" | "running" | "failed" | "complete" = isComplete
    ? "complete"
    : error
      ? "failed"
      : isRunning
        ? "running"
        : "configure";

  // Each mode replaces the controls the previous one owned, so keyboard focus
  // has to follow or it lands on a node that no longer exists. Running hands it
  // to Stop clone, failure to Retry, success to Open project — the one action
  // each mode is actually about. Configuration is excluded: the open effect
  // already put focus in the URL field, and re-running this on every keystroke
  // would fight it.
  useEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = mode;
    if (!isOpen) return;
    // Returning to the form after a stop unmounts the Stop button that had
    // focus, so without this the focus falls to the document body.
    const target =
      mode === "configure"
        ? previousMode === "running"
          ? urlInputRef.current
          : null
        : footerActionRef.current;
    if (!target) return;
    const frame = requestAnimationFrame(() => target.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen, mode]);

  const trimmedFolderName = folderName.trim();
  const destinationPath =
    parentPath.trim() !== "" && trimmedFolderName !== ""
      ? joinPath(parentPath, trimmedFolderName)
      : null;
  const normalizedUrl = normalizeCloneUrl(url, shorthandHost);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter acts as Retry too — startClone resets `error` internally, so this
    // matches the on-screen Retry button instead of going dead after a failure.
    if (e.key === "Enter" && canClone && !isCloning && !isComplete) {
      e.preventDefault();
      void startClone();
    }
  };

  // The provider sign-in is the banner's action only when the URL actually
  // belongs to a registered forge; otherwise the footer's Retry is the sole
  // recovery, so the two never offer competing answers to the same failure.
  const signInAction: BannerAction | null = useMemo(() => {
    if (error?.gitReason !== "auth-failed") return null;
    const matchedProviderId = matchProviderForRemoteUrl(
      normalizeCloneUrl(url, shorthandHost),
      forgeProviders
    );
    if (matchedProviderId === null) return null;
    const matchedProvider = forgeProviders.find((p) => p.providerId === matchedProviderId);
    if (!matchedProvider) return null;
    return {
      id: "signin-forge-provider",
      label: `Sign in to ${matchedProvider.name}`,
      icon: LogIn,
      // Neutral chip, not the info-tinted `accent`: inside a red banner that
      // variant rendered dimmer than the prose it was meant to resolve.
      variant: "primary",
      onClick: () => {
        void actionService.dispatch(
          "app.settings.openTab",
          { tab: "code-forge", subtab: matchedProvider.providerId },
          { source: "user" }
        );
      },
      title: `Open ${matchedProvider.name} sign-in`,
      ariaLabel: `Sign in to ${matchedProvider.name}`,
    };
  }, [error?.gitReason, url, shorthandHost, forgeProviders]);

  const summary =
    destinationPath !== null ? (
      <div className="space-y-2.5 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg px-3 py-3">
        <div className="space-y-1">
          <span className="text-xs font-medium text-daintree-text/60">Source</span>
          <p className="truncate text-xs font-mono text-daintree-text/80" title={normalizedUrl}>
            {normalizedUrl}
          </p>
        </div>
        <div className="space-y-1">
          <span className="text-xs font-medium text-daintree-text/60">Destination</span>
          <PathCaption path={destinationPath} className="text-daintree-text/80" />
        </div>
      </div>
    ) : null;

  const cleanupBanner = cleanupError ? (
    <InlineStatusBanner
      icon={AlertCircle}
      severity="error"
      title="Partial clone not removed"
      description="Close any Git processes using it, then delete the folder manually."
      {...(strandedPath !== null ? { contextLine: strandedPath } : {})}
      {...(strandedPath !== null
        ? {
            action: {
              id: "reveal-partial-clone",
              label: "Show in folder",
              icon: FolderOpen,
              variant: "primary",
              onClick: () => void systemClient.showItemInFolderUnconfined(strandedPath),
              ariaLabel: "Show the partial clone in the file manager",
            } satisfies BannerAction,
          }
        : {})}
      onClose={() => setCleanupError(null)}
      closeAriaLabel="Dismiss partial-clone warning"
      className="rounded-[var(--radius-md)]"
    />
  ) : null;

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={handleClose}
      size="md"
      dismissible={!isCloning}
      initialFocus="none"
    >
      <AppDialog.Header>
        {/* Neutral, not accent: the header glyph is decoration, and this focus
            region's one load-bearing accent is the keyboard focus ring. */}
        <AppDialog.Title icon={<FolderGit2 className="h-5 w-5 text-text-secondary" />}>
          Clone repository
        </AppDialog.Title>
        {!isCloning && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-5">
        {mode === "complete" ? (
          <div
            className="flex flex-col items-center gap-4 py-6 text-center"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-status-success/15">
              <Check className="h-6 w-6 text-status-success" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-daintree-text">Repository cloned</h3>
              <p className="text-sm text-daintree-text/60">
                <span aria-hidden="true">{effectiveEmoji} </span>
                {trimmedFolderName} is ready to open
              </p>
            </div>
            {clonedPath !== null && <PathCaption path={clonedPath} className="max-w-full" />}
          </div>
        ) : mode === "running" ? (
          <>
            {/* One current phase, the way every other running-operation surface
                in the app reports itself, and first — "what is happening now"
                is the question this mode exists to answer. The percentage rides
                the payload's `progress`, which the transcript this replaced
                threw away. */}
            {/* No `aria-busy` on this wrapper: it would silence mutations
                within its own subtree on modern screen readers (see the note on
                `SkeletonHint` in `@/components/ui/Skeleton`), and the two live
                regions below are exactly the mutations this mode exists to
                announce. Unlike a skeleton — meaningless placeholder shape that
                aria-busy rightly mutes — the progress readout is the content,
                and the `progressbar` already carries the busy semantics. */}
            <div className="space-y-2">
              {/* Carries the phase and nothing else, so stage changes are
                  announced and percentage ticks are not. */}
              <span className="sr-only" role="status" aria-live="polite">
                {currentStage ? stageLabel(currentStage) : "Connecting"}
              </span>
              <div className="flex items-center gap-2">
                <Spinner size="sm" className="shrink-0 text-text-secondary" />
                <span aria-hidden="true" className="text-sm text-daintree-text">
                  {currentStage ? stageLabel(currentStage) : "Connecting…"}
                </span>
                {currentStage && (
                  <span
                    aria-hidden="true"
                    className="ml-auto text-xs tabular-nums text-daintree-text/60"
                  >
                    {stagePercent(currentStage)}%
                  </span>
                )}
              </div>
              {/* The track is rendered in both phases on purpose: a clone starts
                  with no measurable progress and gains it the moment git speaks,
                  and swapping the indicator in would shift everything under it.
                  Indeterminate omits `aria-valuenow` and pulses the empty track. */}
              <div
                role="progressbar"
                aria-label={currentStage ? stageLabel(currentStage) : "Connecting"}
                {...(currentStage ? { "aria-valuenow": stagePercent(currentStage) } : {})}
                aria-valuemin={0}
                aria-valuemax={100}
                className={`h-1 w-full overflow-hidden rounded-full bg-daintree-border/50 ${
                  currentStage ? "" : "animate-pulse-immediate"
                }`}
              >
                {currentStage && (
                  <div
                    className="h-full rounded-full bg-daintree-text/60 transition-[width] duration-150 ease-out"
                    style={{ width: `${stagePercent(currentStage)}%` }}
                  />
                )}
              </div>
              {/* Only while the phase is indeterminate — once a percentage is
                  moving, "Still working…" would be telling the user something
                  the number already says. Five seconds, per the house rule for
                  a wait with nothing to show. */}
              {!currentStage && (
                <SkeletonHint message="Still working…" firstThreshold={STILL_WORKING_AFTER_MS} />
              )}
            </div>

            {/* Phases already finished, quieted to a static check. They are what
                makes the live phase's bar resetting to 0% read as "next step"
                instead of "went backwards". */}
            {completedStages.length > 0 && (
              <ul className="space-y-1">
                {completedStages.map((event) => (
                  <li
                    key={event.stage}
                    className="flex items-center gap-2 text-xs text-daintree-text/45"
                  >
                    <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{stageLabel(event)}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* Subordinate to the live phase: what is being cloned and where,
                kept legible now that the form is gone. */}
            {summary}

            {cleanupBanner}
          </>
        ) : (
          <>
            {/* Outcome first. A failure or a stop returns the user to the form
                with the fields they typed intact, so the explanation belongs
                above the inputs it is about — not below them, where the body
                scrolls it out of sight entirely. */}
            {error && (
              <InlineStatusBanner
                icon={AlertCircle}
                severity="error"
                title="Clone failed"
                description={error.message}
                {...(signInAction ? { action: signInAction } : {})}
                className="rounded-[var(--radius-md)]"
              />
            )}

            {/* A stop is an outcome, not a failure: neutral severity, and the
                form underneath is editable again so Clone can just be pressed. */}
            {wasCancelled && (
              <InlineStatusBanner
                icon={CircleSlash}
                severity="neutral"
                title="Clone stopped"
                description="You stopped the clone before it finished."
                onClose={() => setWasCancelled(false)}
                closeAriaLabel="Dismiss stopped-clone notice"
                role="status"
                className="rounded-[var(--radius-md)]"
              />
            )}

            {/* Orthogonal to the failure above and ordered after it: the clone
                can fail with the partial copy cleanly removed, or be stopped
                with it stranded, and only this one needs action outside the app. */}
            {cleanupBanner}

            {/* URL Input */}
            <div className="space-y-1.5">
              <label className={FIELD_LABEL_CLASS} htmlFor="clone-repo-url">
                Repository URL
              </label>
              <input
                id="clone-repo-url"
                ref={urlInputRef}
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="owner/repo or repository URL"
                disabled={isCloning}
                className={FIELD_INPUT_CLASS}
              />
            </div>

            {/* Parent Directory */}
            <div className="space-y-1.5">
              <label className={FIELD_LABEL_CLASS} htmlFor="clone-parent-dir">
                Parent directory
              </label>
              <div className="flex gap-2">
                <input
                  id="clone-parent-dir"
                  type="text"
                  value={parentPath}
                  readOnly
                  aria-readonly="true"
                  placeholder="Select a directory…"
                  className={`${FIELD_READONLY_INPUT_CLASS} select-all`}
                />
                <Button
                  variant="outline"
                  onClick={() => void pickDirectory()}
                  disabled={isCloning}
                  className={FIELD_BROWSE_BUTTON_CLASS}
                >
                  <FolderOpen className="h-4 w-4" />
                  Browse
                </Button>
              </div>
            </div>

            {/* Folder Name */}
            <div className="space-y-1.5">
              <label className={FIELD_LABEL_CLASS} htmlFor="clone-folder-name">
                Folder name
              </label>
              <div className="flex items-center gap-2">
                <ProjectEmojiButton
                  emoji={effectiveEmoji}
                  onEmojiChange={setPickedEmoji}
                  disabled={isCloning}
                  ariaLabel="Choose project emoji"
                />
                <input
                  id="clone-folder-name"
                  type="text"
                  value={folderName}
                  onChange={(e) => {
                    const next = e.target.value;
                    setFolderName(next);
                    // Clearing the field re-enables URL-derived auto-suggest so the
                    // user can recover after a manual edit they no longer want.
                    setFolderNameEdited(next !== "");
                  }}
                  onKeyDown={handleKeyDown}
                  disabled={isCloning}
                  aria-invalid={folderNameError != null}
                  aria-describedby={folderNameError ? folderNameErrorId : undefined}
                  className={FIELD_INPUT_CLASS}
                  placeholder="my-project"
                />
              </div>
              {folderNameError ? (
                <p
                  id={folderNameErrorId}
                  role="alert"
                  className={`${FIELD_EMOJI_ROW_INDENT} text-xs text-status-error`}
                >
                  {folderNameError}
                </p>
              ) : (
                // Says where the clone will actually land, keeping the leaf
                // folder that the parent-directory field's own truncation eats.
                destinationPath !== null && (
                  <PathCaption path={destinationPath} className={FIELD_EMOJI_ROW_INDENT} />
                )
              )}
            </div>

            {/* Shallow Clone */}
            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={shallowClone}
                  onChange={(e) => setShallowClone(e.target.checked)}
                  disabled={isCloning}
                  className={FIELD_CHECKBOX_CLASS}
                />
                <span className="text-sm text-daintree-text/80">Shallow clone</span>
              </label>
              <p className="ml-6 text-xs text-daintree-text/50">
                Fetches only the latest commit (<code>--depth 1</code>) — faster for large repos,
                but limits history and some push paths.
              </p>
            </div>
          </>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        {mode === "complete" ? (
          <Button ref={footerActionRef} variant="contrast" onClick={handleClose} className="gap-2">
            <Check className="h-4 w-4" />
            Open project
          </Button>
        ) : mode === "running" ? (
          <Button ref={footerActionRef} variant="outline" onClick={stopClone} loading={isStopping}>
            {isStopping ? "Stopping…" : "Stop clone"}
          </Button>
        ) : error ? (
          <>
            <Button variant="outline" onClick={onCancel}>
              Close
            </Button>
            <Button
              ref={footerActionRef}
              variant="contrast"
              onClick={() => void startClone()}
              disabled={isCloning}
            >
              Retry
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={isCloning ? stopClone : onCancel}
              loading={isStopping}
            >
              {isCloning ? (isStopping ? "Stopping…" : "Stop clone") : "Cancel"}
            </Button>
            <Button
              variant="contrast"
              onClick={() => void startClone()}
              disabled={!canClone}
              loading={isCloning}
            >
              Clone
            </Button>
          </>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
