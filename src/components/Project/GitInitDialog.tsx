import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { Check, AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { FolderGit2 } from "@/components/icons";
import { projectClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { GitInitOptions, GitInitProgressEvent } from "@shared/types/ipc/gitInit";

interface GitInitDialogProps {
  isOpen: boolean;
  directoryPath: string;
  onSuccess: () => void;
  onCancel: () => void;
}

const AUTO_CLOSE_DELAY_MS = 2000;

type GitignoreTemplate = NonNullable<GitInitOptions["gitignoreTemplate"]>;

const TEMPLATE_OPTIONS: Array<{ value: GitignoreTemplate; label: string; description: string }> = [
  { value: "node", label: "Node", description: "node_modules, build outputs, .env" },
  { value: "python", label: "Python", description: "__pycache__, venv, .env" },
  { value: "minimal", label: "Minimal", description: "OS files, IDE files, .env" },
  { value: "none", label: "None", description: "Don't create a .gitignore" },
];

export function GitInitDialog({ isOpen, directoryPath, onSuccess, onCancel }: GitInitDialogProps) {
  const [gitignoreTemplate, setGitignoreTemplate] = useState<GitignoreTemplate>("node");
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

  const finalizeSuccess = useCallback(() => {
    if (hasFinalizedSuccessRef.current) {
      return;
    }
    hasFinalizedSuccessRef.current = true;
    onSuccess();
  }, [onSuccess]);

  useEffect(() => {
    if (!isOpen) {
      setGitignoreTemplate("node");
      setCreateInitialCommit(true);
      setInitialCommitMessage("Initial commit");
      setProgressEvents([]);
      setIsInitializing(false);
      setError(null);
      setIsComplete(false);
      hasFinalizedSuccessRef.current = false;
      inFlightRef.current = false;
      sawTerminalEventRef.current = false;
      return;
    }

    const cleanup = projectClient.onInitGitProgress((event) => {
      setProgressEvents((prev) => [...prev, event]);

      if (event.status === "error") {
        sawTerminalEventRef.current = true;
        setError(event.error || event.message || "Unknown error");
        setIsComplete(false);
        setIsInitializing(false);
      } else if (event.step === "complete" && event.status === "success") {
        sawTerminalEventRef.current = true;
        setIsComplete(true);
        setIsInitializing(false);
      }
    });

    return cleanup;
  }, [isOpen]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressEvents]);

  const startInitialization = useCallback(async () => {
    const trimmedMessage = initialCommitMessage.trim();
    if (createInitialCommit && trimmedMessage === "") {
      return;
    }
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    sawTerminalEventRef.current = false;

    setIsInitializing(true);
    setError(null);
    setIsComplete(false);
    setProgressEvents([]);
    hasFinalizedSuccessRef.current = false;

    try {
      await projectClient.initGitGuided({
        directoryPath,
        createInitialCommit,
        initialCommitMessage: trimmedMessage || "Initial commit",
        createGitignore: gitignoreTemplate !== "none",
        gitignoreTemplate,
      });
      if (!sawTerminalEventRef.current) {
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

  const showProgress = isInitializing || progressEvents.length > 0;
  const configDisabled = isInitializing || isComplete;
  const trimmedMessage = initialCommitMessage.trim();
  const canStart = !createInitialCommit || trimmedMessage !== "";

  return (
    <AppDialog isOpen={isOpen} onClose={handleClose} size="md" dismissible={!isInitializing}>
      <AppDialog.Header>
        <AppDialog.Title icon={<FolderGit2 className="h-5 w-5 text-daintree-accent" />}>
          Initialize Git Repository
        </AppDialog.Title>
        {!isInitializing && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="truncate">{directoryPath}</span>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="git-init-template" className="text-sm font-medium text-daintree-text/70">
            Gitignore template
          </label>
          <select
            id="git-init-template"
            value={gitignoreTemplate}
            onChange={(e) => setGitignoreTemplate(e.target.value as GitignoreTemplate)}
            disabled={configDisabled}
            className="w-full rounded-md border border-daintree-border bg-daintree-bg px-3 py-2 text-sm text-daintree-text focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 disabled:opacity-50"
          >
            {TEMPLATE_OPTIONS.map((opt) => (
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
              className="w-full rounded-md border border-daintree-border bg-daintree-bg px-3 py-2 text-sm text-daintree-text placeholder:text-daintree-text/40 focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 disabled:opacity-50"
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
            <Button onClick={() => void startInitialization()} disabled={isInitializing}>
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
              disabled={!canStart}
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
