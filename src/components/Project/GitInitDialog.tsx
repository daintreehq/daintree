import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { Check, AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { FolderGit2 } from "@/components/icons";
import { projectClient } from "@/clients";
import { useDohertyGate } from "@/hooks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { basename } from "@shared/utils/path";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import { ProjectEmojiButton } from "./ProjectEmojiButton";
import {
  GITIGNORE_TEMPLATE_OPTIONS,
  DEFAULT_GITIGNORE_TEMPLATE_ID,
  isGitignoreTemplateId,
} from "@shared/config/gitignoreTemplates";
import type { GitInitProgressEvent } from "@shared/types/ipc/gitInit";
import type { ProjectCreationIdentity } from "@shared/types";

interface GitInitDialogProps {
  isOpen: boolean;
  directoryPath: string;
  /**
   * Identity chosen one dialog earlier in the create-project flow. Present
   * means "don't ask again, just show what they picked"; absent means this
   * dialog was reached directly by opening a non-repo folder, so it derives a
   * fresh suggestion from the folder name.
   */
  initialIdentity?: ProjectCreationIdentity | null;
  onSuccess: (identity: ProjectCreationIdentity) => void;
  onCancel: () => void;
}

const AUTO_CLOSE_DELAY_MS = 2000;

export function GitInitDialog({
  isOpen,
  directoryPath,
  initialIdentity,
  onSuccess,
  onCancel,
}: GitInitDialogProps) {
  const [projectName, setProjectName] = useState("");
  const [emoji, setEmoji] = useState(DEFAULT_PROJECT_EMOJI);
  const [gitignoreTemplate, setGitignoreTemplate] = useState(DEFAULT_GITIGNORE_TEMPLATE_ID);
  const [createInitialCommit, setCreateInitialCommit] = useState(true);
  const [initialCommitMessage, setInitialCommitMessage] = useState("Initial commit");
  const [progressEvents, setProgressEvents] = useState<GitInitProgressEvent[]>([]);
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const hasFinalizedSuccessRef = useRef(false);
  const inFlightRef = useRef(false);
  const sawTerminalEventRef = useRef(false);
  const sawErrorEventRef = useRef(false);

  const trimmedProjectName = projectName.trim();

  const finalizeSuccess = useCallback(() => {
    if (hasFinalizedSuccessRef.current) {
      return;
    }
    hasFinalizedSuccessRef.current = true;
    onSuccess({ name: trimmedProjectName, emoji });
  }, [onSuccess, trimmedProjectName, emoji]);

  // Seed the identity row on open: the create-project flow already asked, so
  // reuse what it carried; reaching this dialog directly (opening a non-repo
  // folder) derives a fresh suggestion from the folder name instead.
  const seededName = initialIdentity?.name ?? basename(directoryPath);
  const seededEmoji = initialIdentity?.emoji ?? suggestProjectEmoji(basename(directoryPath));
  useEffect(() => {
    if (!isOpen) return;
    setProjectName(seededName);
    setEmoji(seededEmoji);
    // Keyed on the folder as well as the open transition: a second git-init
    // request arriving while this one is open swaps `directoryPath` under us,
    // and leaving the identity behind would save folder B under folder A's
    // name. Not keyed on the seed values themselves — that would re-seed on
    // every render and discard edits in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, directoryPath]);

  useEffect(() => {
    if (!isOpen) {
      setGitignoreTemplate(DEFAULT_GITIGNORE_TEMPLATE_ID);
      setCreateInitialCommit(true);
      setInitialCommitMessage("Initial commit");
      setProgressEvents([]);
      setIsInitializing(false);
      setError(null);
      setIsComplete(false);
      hasFinalizedSuccessRef.current = false;
      inFlightRef.current = false;
      sawTerminalEventRef.current = false;
      sawErrorEventRef.current = false;
      return;
    }

    const cleanup = projectClient.onInitGitProgress((event) => {
      setProgressEvents((prev) => [...prev, event]);

      if (event.status === "error") {
        sawTerminalEventRef.current = true;
        sawErrorEventRef.current = true;
        setError(event.error || event.message || "Unknown error");
        setIsComplete(false);
        setIsInitializing(false);
      } else if (event.step === "complete" && event.status === "success") {
        sawTerminalEventRef.current = true;
        // A success event never follows an error event within one run — treat it as stale/foreign
        if (!sawErrorEventRef.current) {
          setError(null);
          setIsComplete(true);
          setIsInitializing(false);
        }
      }
    });

    return cleanup;
  }, [isOpen]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressEvents]);

  const startInitialization = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    sawTerminalEventRef.current = false;
    sawErrorEventRef.current = false;

    setIsInitializing(true);
    setError(null);
    setIsComplete(false);
    setProgressEvents([]);
    hasFinalizedSuccessRef.current = false;

    try {
      const result = await projectClient.initGitGuided({
        directoryPath,
        createInitialCommit,
        initialCommitMessage: initialCommitMessage.trim(),
        createGitignore: gitignoreTemplate !== "none",
        gitignoreTemplate,
      });
      if (result.outcome === "success") {
        setError(null);
        setIsComplete(true);
      } else if (!sawTerminalEventRef.current) {
        setError(
          "Initialization finished without a status update — check the repository to confirm the result."
        );
      }
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to initialize git repository"));
    } finally {
      inFlightRef.current = false;
      setIsInitializing(false);
    }
  }, [directoryPath, gitignoreTemplate, initialCommitMessage, createInitialCommit]);

  useEffect(() => {
    if (!isOpen || !isComplete) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      finalizeSuccess();
    }, AUTO_CLOSE_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen, isComplete, finalizeSuccess]);

  const handleClose = () => {
    if (isInitializing) {
      return;
    }

    if (isComplete) {
      finalizeSuccess();
    } else {
      onCancel();
    }
  };

  const getStepIcon = (event: GitInitProgressEvent) => {
    if (event.status === "start") {
      return <Spinner size="md" className="text-status-info" />;
    } else if (event.status === "success") {
      return <Check className="h-4 w-4 text-status-success" />;
    } else if (event.status === "error") {
      return <AlertCircle className="h-4 w-4 text-status-error" />;
    }
    return null;
  };

  const showConnecting = useDohertyGate(isInitializing && progressEvents.length === 0);
  const showProgress = showConnecting || progressEvents.length > 0;
  const configDisabled = isInitializing || isComplete;
  const canStart =
    trimmedProjectName !== "" && (!createInitialCommit || initialCommitMessage.trim() !== "");

  return (
    <AppDialog isOpen={isOpen} onClose={handleClose} size="md" dismissible={!isInitializing}>
      <AppDialog.Header>
        <AppDialog.Title icon={<FolderGit2 className="h-5 w-5 text-daintree-accent" />}>
          Set up project
        </AppDialog.Title>
        {!isInitializing && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        <div className="space-y-1.5">
          <label
            htmlFor="git-init-project-name"
            className="text-sm font-medium text-daintree-text/70"
          >
            Project name
          </label>
          <div className="flex items-center gap-2">
            <ProjectEmojiButton
              emoji={emoji}
              onEmojiChange={setEmoji}
              disabled={configDisabled}
              ariaLabel="Choose project emoji"
            />
            <input
              id="git-init-project-name"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              disabled={configDisabled}
              aria-invalid={trimmedProjectName === ""}
              className="w-full rounded-md border border-daintree-border bg-daintree-bg px-3 py-1.5 text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 disabled:opacity-50 aria-invalid:border-status-error"
              placeholder="My project"
            />
          </div>
          <p className="truncate text-xs font-mono text-daintree-text/40" title={directoryPath}>
            {directoryPath}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="git-init-template" className="text-sm font-medium text-daintree-text/70">
            Gitignore template
          </label>
          <select
            id="git-init-template"
            value={gitignoreTemplate}
            onChange={(e) => {
              if (isGitignoreTemplateId(e.target.value)) setGitignoreTemplate(e.target.value);
            }}
            disabled={configDisabled}
            className="w-full rounded-md border border-daintree-border bg-daintree-bg px-3 py-1.5 text-sm text-daintree-text focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 disabled:opacity-50"
          >
            {GITIGNORE_TEMPLATE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label} — {opt.description}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={createInitialCommit}
              onChange={(e) => setCreateInitialCommit(e.target.checked)}
              disabled={configDisabled}
              className="rounded border-daintree-border accent-daintree-accent"
            />
            <span className="text-sm text-daintree-text/70">Create initial commit</span>
          </label>
        </div>

        {createInitialCommit && (
          <div className="space-y-1.5">
            <label
              htmlFor="git-init-commit-message"
              className="text-sm font-medium text-daintree-text/70"
            >
              Initial commit message
            </label>
            <input
              id="git-init-commit-message"
              type="text"
              value={initialCommitMessage}
              onChange={(e) => setInitialCommitMessage(e.target.value)}
              disabled={configDisabled}
              placeholder="Initial commit"
              className="w-full rounded-md border border-daintree-border bg-daintree-bg px-3 py-1.5 text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 disabled:opacity-50"
            />
          </div>
        )}

        {showProgress && (
          <div className="rounded-lg bg-muted/50 p-4 min-h-[120px] max-h-[300px] overflow-y-auto font-mono text-sm">
            {progressEvents.length === 0 && isInitializing && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Spinner size="md" />
                <span>Starting initialization...</span>
              </div>
            )}

            {progressEvents.map((event, index) => {
              const showCommands = !!event.error?.includes("git config --global");
              return (
                <div key={index} className="flex items-start gap-2 mb-2">
                  {getStepIcon(event)}
                  <div className="flex-1 min-w-0">
                    <div
                      className={
                        event.status === "error"
                          ? "text-status-error"
                          : event.status === "success"
                            ? "text-status-success"
                            : "text-foreground"
                      }
                    >
                      {event.message}
                    </div>
                    {event.error && !showCommands && (
                      <div className="text-xs text-status-error mt-1">{event.error}</div>
                    )}
                    {event.error && showCommands && (
                      <pre className="text-xs text-status-error mt-1 whitespace-pre-wrap font-mono">
                        {event.error}
                      </pre>
                    )}
                  </div>
                </div>
              );
            })}

            <div ref={logEndRef} />
          </div>
        )}

        {error && !progressEvents.some((e) => e.status === "error") && (
          <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium">Initialization failed</div>
              <div className="text-xs mt-1">{error}</div>
            </div>
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        {isComplete ? (
          <Button onClick={handleClose} className="gap-2">
            <Check className="h-4 w-4" />
            Continue
          </Button>
        ) : error ? (
          <>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              onClick={() => void startInitialization()}
              disabled={isInitializing || !canStart}
            >
              Try again
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onCancel} disabled={isInitializing}>
              Cancel
            </Button>
            <Button
              onClick={() => void startInitialization()}
              disabled={isInitializing || !canStart}
              loading={isInitializing}
            >
              Initialize repository
            </Button>
          </>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
