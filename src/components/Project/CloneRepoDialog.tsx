import { useState, useEffect, useRef, useCallback, useMemo, useId } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { Check, AlertCircle, FolderOpen, LogIn, X } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { FolderGit2 } from "@/components/icons";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { projectClient } from "@/clients";
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
} from "./projectDialogFields";
import { matchProviderForRemoteUrl } from "@shared/utils/forgeHostnames";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import type { CloneRepoProgressEvent } from "@shared/types/ipc/gitClone";
import type { ProjectCreationIdentity } from "@shared/types";
import type { GitOperationReason } from "@shared/types/ipc/errors";
import { isClientGitError } from "@/utils/clientGitError";

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
  const [progressEvents, setProgressEvents] = useState<CloneRepoProgressEvent[]>([]);
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState<CloneError | null>(null);
  // Kept separate from `progressEvents` (which dedups by stage) so the
  // cleanup-failure banner isn't swallowed by, or lost among, progress rows.
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [clonedPath, setClonedPath] = useState<string | null>(null);
  // Registered forge providers — gate the auth-failed recovery banner on the
  // clone URL belonging to a registered provider, and derive that banner's
  // sign-in label/route plus the owner/repo shorthand host.
  const [forgeProviders, setForgeProviders] = useState<CloneForgeProvider[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
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
      setProgressEvents([]);
      setIsCloning(false);
      setError(null);
      setCleanupError(null);
      setIsComplete(false);
      setClonedPath(null);
      hasFinalizedRef.current = false;
      return;
    }

    const cleanup = projectClient.onCloneProgress((event) => {
      if (event.stage === "cleanup-failed") {
        setCleanupError(event.message);
        return;
      }
      setProgressEvents((prev) => {
        // Dedup by stage so a long clone (hundreds of byte-count updates per
        // stage) shows one live-updating row per stage instead of an unbounded
        // log. Final `complete`/`error`/`cancelled` events also dedup.
        const merged = new Map(prev.map((e) => [e.stage, e]));
        merged.set(event.stage, event);
        return [...merged.values()];
      });
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

  // Auto-scroll progress log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressEvents]);

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

  const pickDirectory = async () => {
    const selected = await projectClient.openDialog();
    if (selected) {
      setParentPath(selected);
    }
  };

  const startClone = async () => {
    setIsCloning(true);
    setError(null);
    setCleanupError(null);
    setIsComplete(false);
    setProgressEvents([]);
    hasFinalizedRef.current = false;

    try {
      const { clonedPath: resultPath } = await projectClient.cloneRepo({
        url: normalizeCloneUrl(url, shorthandHost),
        parentPath,
        folderName: folderName.trim(),
        shallowClone,
      });

      setClonedPath(resultPath);
      setIsComplete(true);
    } catch (err) {
      // CANCELLED is the user aborting via the cancel button — not a failure.
      const code = (err as { code?: string })?.code;
      if (code !== "CANCELLED") {
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
    }
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
  // Doherty gate: don't flash the progress box / spinner for a sub-400ms gap
  // before the first git progress event — only reveal it if the wait exceeds
  // the threshold. Once real progress arrives the box stays up regardless.
  const showConnecting = useDohertyGate(isCloning && progressEvents.length === 0);
  const showProgress = showConnecting || progressEvents.length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter acts as Retry too — startClone resets `error` internally, so this
    // matches the on-screen Retry button instead of going dead after a failure.
    if (e.key === "Enter" && canClone && !isCloning && !isComplete) {
      e.preventDefault();
      void startClone();
    }
  };

  return (
    <AppDialog isOpen={isOpen} onClose={handleClose} size="md" dismissible={!isCloning}>
      <AppDialog.Header>
        <AppDialog.Title icon={<FolderGit2 className="h-5 w-5 text-daintree-accent" />}>
          Clone repository
        </AppDialog.Title>
        {!isCloning && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-5">
        {/* URL Input */}
        <div className="space-y-1.5">
          <label className={FIELD_LABEL_CLASS} htmlFor="clone-repo-url">
            Repository URL
          </label>
          <input
            id="clone-repo-url"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="owner/repo or repository URL"
            disabled={isCloning || isComplete}
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
              disabled={isCloning || isComplete}
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
              disabled={isCloning || isComplete}
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
              disabled={isCloning || isComplete}
              aria-invalid={folderNameError != null}
              aria-describedby={folderNameError ? folderNameErrorId : undefined}
              className={FIELD_INPUT_CLASS}
              placeholder="my-project"
            />
          </div>
          {folderNameError && (
            <p
              id={folderNameErrorId}
              role="alert"
              className={`${FIELD_EMOJI_ROW_INDENT} text-xs text-status-error`}
            >
              {folderNameError}
            </p>
          )}
        </div>

        {/* Shallow Clone */}
        <div className="space-y-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={shallowClone}
              onChange={(e) => setShallowClone(e.target.checked)}
              disabled={isCloning || isComplete}
              className={FIELD_CHECKBOX_CLASS}
            />
            <span className="text-sm text-daintree-text/80">Shallow clone (--depth 1)</span>
          </label>
          <p className="ml-6 text-xs text-daintree-text/50">
            Only fetches the latest commit — faster for large repos, but limits history and some
            push paths.
          </p>
        </div>

        {/* Progress Log */}
        {showProgress && (
          <div className="rounded-lg bg-muted/50 p-4 min-h-[120px] max-h-[250px] overflow-y-auto font-mono text-sm">
            {showConnecting && <div className="text-muted-foreground">Connecting…</div>}

            {progressEvents.map((event, index) => (
              <div key={index} className="flex items-start gap-2 mb-1">
                {event.stage === "complete" ? (
                  <Check className="h-4 w-4 text-status-success shrink-0 mt-0.5" />
                ) : event.stage === "error" ? (
                  <AlertCircle className="h-4 w-4 text-status-error shrink-0 mt-0.5" />
                ) : event.stage === "cancelled" ? (
                  <X className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                ) : (
                  <Spinner size="md" className="text-status-info shrink-0" />
                )}
                <span
                  className={
                    event.stage === "error"
                      ? "text-status-error"
                      : event.stage === "complete"
                        ? "text-status-success"
                        : event.stage === "cancelled"
                          ? "text-muted-foreground"
                          : "text-foreground"
                  }
                >
                  {event.message}
                </span>
              </div>
            ))}

            <div ref={logEndRef} />
          </div>
        )}

        {/* Cleanup failure — the partial clone couldn't be removed and needs
            manual deletion, so it gets its own persistent Tier 3 banner.
            Kept separate from the recovery error block below because the two
            failures are orthogonal (cleanup can fail whether or not the clone
            itself recovered) and the user may need to act on both. */}
        {cleanupError && (
          <InlineStatusBanner
            icon={AlertCircle}
            severity="error"
            title="Partial clone not removed"
            description={cleanupError}
            onClose={() => setCleanupError(null)}
            className="rounded-lg"
          />
        )}

        {/* Error block — rendered alongside the progress log so the recovery
            banner is reachable even when emitProgress("error") has already
            queued an "error" row in the log. */}
        {error &&
          (() => {
            const matchedProviderId =
              error.gitReason === "auth-failed"
                ? matchProviderForRemoteUrl(normalizeCloneUrl(url, shorthandHost), forgeProviders)
                : null;
            const matchedProvider =
              matchedProviderId !== null
                ? forgeProviders.find((p) => p.providerId === matchedProviderId)
                : undefined;
            if (matchedProvider) {
              const signInAction: BannerAction = {
                id: "signin-forge-provider",
                label: `Sign in to ${matchedProvider.name}`,
                icon: LogIn,
                variant: "accent",
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
              return (
                <InlineStatusBanner
                  icon={AlertCircle}
                  title="Clone Failed"
                  description={error.message}
                  severity="error"
                  action={signInAction}
                />
              );
            }
            return (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">Clone Failed</div>
                  <div className="text-xs mt-1">{error.message}</div>
                </div>
              </div>
            );
          })()}
      </AppDialog.Body>

      <AppDialog.Footer>
        {isComplete ? (
          <Button onClick={handleClose} className="gap-2">
            <Check className="h-4 w-4" />
            Open Project
          </Button>
        ) : error ? (
          <>
            <Button variant="outline" onClick={onCancel}>
              Close
            </Button>
            <Button onClick={() => void startClone()} disabled={isCloning}>
              Retry
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={isCloning ? () => void projectClient.cancelClone() : onCancel}
            >
              {isCloning ? "Stop clone" : "Cancel"}
            </Button>
            <Button onClick={() => void startClone()} disabled={!canClone} loading={isCloning}>
              Clone
            </Button>
          </>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
