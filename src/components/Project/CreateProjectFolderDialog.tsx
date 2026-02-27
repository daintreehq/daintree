import { useState, useCallback, useEffect, useRef, useId } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { FolderPlus, FolderOpen } from "lucide-react";
import { projectClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";

interface CreateProjectFolderDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function validateFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Folder name is required";
  if (trimmed === ".." || trimmed === ".") return "Invalid folder name";
  if (trimmed.includes("/") || trimmed.includes("\\"))
    return "Folder name must not contain path separators";
  return null;
}

export function CreateProjectFolderDialog({ isOpen, onClose }: CreateProjectFolderDialogProps) {
  const [parentPath, setParentPath] = useState("");
  const [folderName, setFolderName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const folderNameInputRef = useRef<HTMLInputElement>(null);
  const homeDirFetchedRef = useRef(false);
  const errorId = useId();

  const createProjectFolder = useProjectStore((state) => state.createProjectFolder);

  useEffect(() => {
    if (!isOpen) {
      setFolderName("");
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
      await createProjectFolder(parentPath, folderName.trim());
      // Close only after the folder is created (but addProjectByPath runs in the background)
      onClose();
    } catch (err) {
      // Show error inline — keep dialog open so user can retry or correct input
      setError(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setIsCreating(false);
    }
  }, [parentPath, folderName, createProjectFolder, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !isCreating) {
        e.preventDefault();
        void handleCreate();
      }
    },
    [handleCreate, isCreating]
  );

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" dismissible={!isCreating}>
      <AppDialog.Header>
        <AppDialog.Title icon={<FolderPlus className="h-5 w-5 text-canopy-accent" />}>
          Create New Project Folder
        </AppDialog.Title>
        {!isCreating && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-canopy-text/80" htmlFor="create-folder-parent">
            Location
          </label>
          <div className="flex gap-2">
            <input
              id="create-folder-parent"
              type="text"
              readOnly
              value={parentPath}
              className="flex-1 rounded-[var(--radius-md)] border border-canopy-border bg-muted/50 px-3 py-2 text-sm font-mono text-canopy-text/70 truncate"
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
          <label className="text-sm font-medium text-canopy-text/80" htmlFor="create-folder-name">
            Folder Name
          </label>
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
            className="w-full rounded-[var(--radius-md)] border border-canopy-border bg-muted/50 px-3 py-2 text-sm text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent/50 focus:border-canopy-accent aria-invalid:border-[var(--color-status-error)]"
            placeholder="my-project"
            disabled={isCreating}
          />
          {error && (
            <p id={errorId} role="alert" className="text-xs text-[var(--color-status-error)]">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={isCreating || !parentPath || !folderName.trim()}>
            {isCreating ? "Creating…" : "Create"}
          </Button>
        </div>
      </AppDialog.Body>
    </AppDialog>
  );
}
