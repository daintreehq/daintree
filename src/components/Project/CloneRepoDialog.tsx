import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { Check, AlertCircle, FolderOpen } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { WorktreeIcon } from "@/components/icons";
import { projectClient } from "@/clients";
import type { CloneRepoProgressEvent } from "@shared/types/ipc/gitClone";

interface CloneRepoDialogProps {
  isOpen: boolean;
  onSuccess: (clonedPath: string) => void;
  onCancel: () => void;
}

const AUTO_CLOSE_DELAY_MS = 800;

function extractFolderName(url: string): string {
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const lastSegment = trimmed.split("/").pop() || "";
  return lastSegment.replace(/[^\w.-]/g, "") || "";
}

function isOwnerRepoShorthand(input: string): boolean {
  if (/^https?:\/\//i.test(input) || /^git@/i.test(input) || /^ssh:\/\//i.test(input)) {
    return false;
  }
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?\/[a-zA-Z0-9._-]{1,100}$/.test(input);
}

function normalizeCloneUrl(input: string): string {
  const trimmed = input.trim();
  if (isOwnerRepoShorthand(trimmed)) {
    return `https://github.com/${trimmed}`;
  }
  return trimmed;
}

function isValidCloneUrl(url: string): boolean {
  const normalized = normalizeCloneUrl(url);
  return /^https?:\/\//i.test(normalized) || /^git@/i.test(normalized);
}

export function CloneRepoDialog({ isOpen, onSuccess, onCancel }: CloneRepoDialogProps) {
  const [url, setUrl] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [folderName, setFolderName] = useState("");
  const [folderNameEdited, setFolderNameEdited] = useState(false);
  const [shallowClone, setShallowClone] = useState(false);
  const [progressEvents, setProgressEvents] = useState<CloneRepoProgressEvent[]>([]);
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [clonedPath, setClonedPath] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const hasFinalizedRef = useRef(false);

  const finalizeSuccess = useCallback(() => {
    if (hasFinalizedRef.current || !clonedPath) return;
    hasFinalizedRef.current = true;
    onSuccess(clonedPath);
  }, [onSuccess, clonedPath]);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!isOpen) {
      setUrl("");
      setParentPath("");
      setFolderName("");
      setFolderNameEdited(false);
      setShallowClone(false);
      setProgressEvents([]);
      setIsCloning(false);
      setError(null);
      setIsComplete(false);
      setClonedPath(null);
      hasFinalizedRef.current = false;
      return;
    }

    const cleanup = projectClient.onCloneProgress((event) => {
      setProgressEvents((prev) => [...prev, event]);
    });

    return cleanup;
  }, [isOpen]);

  // Auto-scroll progress log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressEvents]);

  // Auto-derive folder name from URL
  useEffect(() => {
    if (!folderNameEdited) {
      setFolderName(extractFolderName(normalizeCloneUrl(url)));
    }
  }, [url, folderNameEdited]);

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
    setIsComplete(false);
    setProgressEvents([]);
    hasFinalizedRef.current = false;

    try {
      const result = await projectClient.cloneRepo({
        url: normalizeCloneUrl(url),
        parentPath,
        folderName: folderName.trim(),
        shallowClone,
      });

      if (result.success && result.clonedPath) {
        setClonedPath(result.clonedPath);
        setIsComplete(true);
      } else {
        setError(result.error || "Clone failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
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

  const canClone = isValidCloneUrl(url) && parentPath.trim() !== "" && folderName.trim() !== "";
  const showProgress = isCloning || progressEvents.length > 0;

  return (
    <AppDialog isOpen={isOpen} onClose={handleClose} size="md" dismissible={!isCloning}>
      <AppDialog.Header>
        <AppDialog.Title icon={<WorktreeIcon className="h-5 w-5 text-canopy-accent" />}>
          Clone Repository
        </AppDialog.Title>
        {!isCloning && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        {/* URL Input */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-canopy-text/70">Repository URL</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="owner/repo or https://github.com/user/repo.git"
            disabled={isCloning || isComplete}
            className="w-full rounded-md border border-canopy-border bg-canopy-bg px-3 py-2 text-sm text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:ring-2 focus:ring-canopy-accent/50 disabled:opacity-50"
          />
        </div>

        {/* Parent Directory */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-canopy-text/70">Parent Directory</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={parentPath}
              readOnly
              placeholder="Select a directory..."
              className="flex-1 rounded-md border border-canopy-border bg-canopy-bg px-3 py-2 text-sm text-canopy-text placeholder:text-canopy-text/40 disabled:opacity-50"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void pickDirectory()}
              disabled={isCloning || isComplete}
            >
              <FolderOpen className="h-4 w-4" />
              Browse
            </Button>
          </div>
        </div>

        {/* Folder Name */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-canopy-text/70">Folder Name</label>
          <input
            type="text"
            value={folderName}
            onChange={(e) => {
              setFolderName(e.target.value);
              setFolderNameEdited(true);
            }}
            disabled={isCloning || isComplete}
            className="w-full rounded-md border border-canopy-border bg-canopy-bg px-3 py-2 text-sm text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:ring-2 focus:ring-canopy-accent/50 disabled:opacity-50"
          />
        </div>

        {/* Shallow Clone */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={shallowClone}
            onChange={(e) => setShallowClone(e.target.checked)}
            disabled={isCloning || isComplete}
            className="rounded border-canopy-border accent-canopy-accent"
          />
          <span className="text-sm text-canopy-text/70">Shallow clone (--depth 1)</span>
        </label>

        {/* Progress Log */}
        {showProgress && (
          <div className="rounded-lg bg-muted/50 p-4 min-h-[120px] max-h-[250px] overflow-y-auto font-mono text-sm">
            {progressEvents.length === 0 && isCloning && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Spinner size="md" />
                <span>Starting clone...</span>
              </div>
            )}

            {progressEvents.map((event, index) => (
              <div key={index} className="flex items-start gap-2 mb-1">
                {event.stage === "complete" ? (
                  <Check className="h-4 w-4 text-status-success shrink-0 mt-0.5" />
                ) : event.stage === "error" ? (
                  <AlertCircle className="h-4 w-4 text-status-error shrink-0 mt-0.5" />
                ) : (
                  <Spinner size="md" className="text-status-info shrink-0" />
                )}
                <span
                  className={
                    event.stage === "error"
                      ? "text-status-error"
                      : event.stage === "complete"
                        ? "text-status-success"
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

        {/* Error (not from progress events) */}
        {error && !progressEvents.some((e) => e.stage === "error") && (
          <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium">Clone Failed</div>
              <div className="text-xs mt-1">{error}</div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
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
              <Button variant="outline" onClick={onCancel} disabled={isCloning}>
                Cancel
              </Button>
              <Button onClick={() => void startClone()} disabled={!canClone || isCloning}>
                {isCloning ? (
                  <>
                    <Spinner size="md" />
                    Cloning...
                  </>
                ) : (
                  "Clone"
                )}
              </Button>
            </>
          )}
        </div>
      </AppDialog.Body>
    </AppDialog>
  );
}
