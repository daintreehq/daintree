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
import {
  FIELD_LABEL_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_READONLY_INPUT_CLASS,
  FIELD_BROWSE_BUTTON_CLASS,
  FIELD_EMOJI_ROW_INDENT,
  PathCaption,
} from "./projectDialogFields";

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
        {/* Neutral, not accent: the header glyph is decoration, and this focus
            region's one load-bearing accent is the keyboard focus ring. */}
        <AppDialog.Title icon={<FolderPlus className="h-5 w-5 text-text-secondary" />}>
          Create project folder
        </AppDialog.Title>
        {!isCreating && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-5">
        <div className="space-y-1.5">
          <label className={FIELD_LABEL_CLASS} htmlFor="create-folder-parent">
            Parent directory
          </label>
          <div className="flex gap-2">
            <input
              id="create-folder-parent"
              type="text"
              readOnly
              aria-readonly="true"
              value={parentPath}
              className={FIELD_READONLY_INPUT_CLASS}
              placeholder="Select a directory…"
            />
            <Button
              variant="outline"
              onClick={handleBrowseParent}
              disabled={isCreating}
              className={FIELD_BROWSE_BUTTON_CLASS}
            >
              <FolderOpen className="h-4 w-4" />
              Browse
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className={FIELD_LABEL_CLASS} htmlFor="create-folder-name">
            Folder name
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
              className={FIELD_INPUT_CLASS}
              placeholder="my-project"
              disabled={isCreating}
            />
          </div>
          {error && (
            <p
              id={errorId}
              role="alert"
              className={`${FIELD_EMOJI_ROW_INDENT} text-xs text-status-error`}
            >
              {error}
            </p>
          )}
          {!error && previewPath && (
            <PathCaption path={previewPath} className={FIELD_EMOJI_ROW_INDENT} />
          )}
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="outline" onClick={onClose} disabled={isCreating}>
          Cancel
        </Button>
        <Button
          variant="contrast"
          onClick={handleCreate}
          disabled={isCreating || !parentPath || !folderName.trim()}
        >
          {isCreating ? "Creating…" : "Create folder"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
