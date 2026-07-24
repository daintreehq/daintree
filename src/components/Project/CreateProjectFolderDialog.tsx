import { useState, useCallback, useEffect, useRef, useId, useMemo } from "react";
import { join } from "@shared/utils/path";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { FolderPlus, FolderOpen } from "lucide-react";
import { projectClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { validateFolderName } from "@shared/utils/folderName";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import { ProjectEmojiButton } from "./ProjectEmojiButton";

interface CreateProjectFolderDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateProjectFolderDialog({ isOpen, onClose }: CreateProjectFolderDialogProps) {
  const [parentPath, setParentPath] = useState("");
  const [folderName, setFolderName] = useState("");
  // Until the user opens the picker, the emoji tracks the folder name. After an
  // explicit pick it stops moving — typing shouldn't undo a deliberate choice.
  const [pickedEmoji, setPickedEmoji] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const folderNameInputRef = useRef<HTMLInputElement>(null);
  const homeDirFetchedRef = useRef(false);
  const errorId = useId();

  const createProjectFolder = useProjectStore((state) => state.createProjectFolder);

  useEffect(() => {
    if (!isOpen) {
      setFolderName("");
      setPickedEmoji(null);
      setParentPath("");
      setError(null);
      setIsCreating(false);
      homeDirFetchedRef.current = false;
      return;
    }

    // Focus the folder name input immediately on open
    requestAnimationFrame(() => {
      folderNameInputRef.current?.focus();
    });

    // Pre-fill parent path with home directory, guarding against stale completion
    homeDirFetchedRef.current = false;
    window.electron.system
      .getHomeDir()
      .then((homeDir) => {
        // Only apply if user hasn't already picked a path via Browse
        if (!homeDirFetchedRef.current) {
          homeDirFetchedRef.current = true;
          setParentPath((prev) => prev || homeDir);
        }
      })
      .catch(() => {
        // Silently ignore; user can still Browse
      });
  }, [isOpen]);

  const handleBrowseParent = useCallback(async () => {
    try {
      const selected = await projectClient.openDialog();
      if (selected) {
        homeDirFetchedRef.current = true; // Prevent homeDir overwriting user's pick
        setParentPath(selected);
        setError(null);
        folderNameInputRef.current?.focus();
      }
    } catch {
      setError("Could not open directory picker");
    }
  }, []);

  const suggestedEmoji = useMemo(() => {
    const trimmed = folderName.trim();
    return trimmed ? suggestProjectEmoji(trimmed) : DEFAULT_PROJECT_EMOJI;
  }, [folderName]);
  const effectiveEmoji = pickedEmoji ?? suggestedEmoji;

  const handleCreate = useCallback(async () => {
    const validationError = validateFolderName(folderName);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!parentPath.trim()) {
      setError("Please select a parent directory");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      await createProjectFolder(parentPath, folderName.trim(), effectiveEmoji);
      // Close only after the folder is created (but addProjectByPath runs in the background)
      onClose();
    } catch (err) {
      // Show error inline — keep dialog open so user can retry or correct input
      setError(formatErrorMessage(err, "Failed to create folder"));
    } finally {
      setIsCreating(false);
    }
  }, [parentPath, folderName, effectiveEmoji, createProjectFolder, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !isCreating) {
        e.preventDefault();
        void handleCreate();
      }
    },
    [handleCreate, isCreating]
  );

  const previewPath = useMemo(() => {
    const trimmed = folderName.trim();
    if (!parentPath || !trimmed) return null;
    return join(parentPath, trimmed);
  }, [parentPath, folderName]);

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" dismissible={!isCreating}>
      <AppDialog.Header>
        <AppDialog.Title icon={<FolderPlus className="h-5 w-5 text-daintree-accent" />}>
          Create New Project Folder
        </AppDialog.Title>
        {!isCreating && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-daintree-text/80"
            htmlFor="create-folder-parent"
          >
            Location
          </label>
          <div className="flex gap-2">
            <input
              id="create-folder-parent"
              type="text"
              readOnly
              aria-readonly="true"
              value={parentPath}
              className="flex-1 rounded-[var(--radius-md)] border border-daintree-border bg-muted/50 px-3 py-1.5 text-sm font-mono text-daintree-text/70 truncate"
              placeholder="Select parent directory..."
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleBrowseParent}
              disabled={isCreating}
              className="shrink-0 gap-1.5"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Browse
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-daintree-text/80" htmlFor="create-folder-name">
            Folder Name
          </label>
          <div className="flex items-center gap-2">
            <ProjectEmojiButton
              emoji={effectiveEmoji}
              onEmojiChange={setPickedEmoji}
              disabled={isCreating}
              ariaLabel="Choose project emoji"
            />
            <input
              ref={folderNameInputRef}
              id="create-folder-name"
              type="text"
              value={folderName}
              onChange={(e) => {
                setFolderName(e.target.value);
                setError(null);
              }}
              onKeyDown={handleKeyDown}
              aria-invalid={error != null}
              aria-describedby={error ? errorId : undefined}
              className="w-full rounded-[var(--radius-md)] border border-daintree-border bg-muted/50 px-3 py-1.5 text-sm text-daintree-text focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 focus:border-daintree-accent aria-invalid:border-status-error"
              placeholder="my-project"
              disabled={isCreating}
            />
          </div>
          {error && (
            <p id={errorId} role="alert" className="text-xs text-status-error">
              {error}
            </p>
          )}
          {!error && previewPath && (
            <p className="text-xs font-mono text-daintree-text/40 truncate" title={previewPath}>
              {previewPath}
            </p>
          )}
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="outline" onClick={onClose} disabled={isCreating}>
          Cancel
        </Button>
        <Button onClick={handleCreate} disabled={isCreating || !parentPath || !folderName.trim()}>
          {isCreating ? "Creating…" : "Create"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
