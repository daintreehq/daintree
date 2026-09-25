import { useState, useCallback, useEffect, useRef, useId, useMemo } from "react";
import { join } from "@shared/utils/path";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { FolderPlus } from "lucide-react";
import { projectClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { validateFolderName } from "@shared/utils/folderName";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import { ProjectEmojiButton } from "./ProjectEmojiButton";
import { FormGrid, FormRow } from "@/components/Worktree/views/WorktreeFormLayout";
import {
  DirectoryPickerField,
  SlottedInputField,
  EMOJI_SLOT_CLASS,
  OpenDestinationControl,
  PathCaption,
  type ProjectOpenDestination,
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
  const [destination, setDestination] = useState<ProjectOpenDestination>("current");
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
      setDestination("current");
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
      await createProjectFolder(parentPath, folderName.trim(), effectiveEmoji, {
        disposition: destination,
      });
      // Close only after the folder is created (but addProjectByPath runs in the background)
      onClose();
    } catch (err) {
      // Show error inline — keep dialog open so user can retry or correct input
      setError(formatErrorMessage(err, "Failed to create folder"));
    } finally {
      setIsCreating(false);
    }
  }, [parentPath, folderName, effectiveEmoji, destination, createProjectFolder, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !isCreating) {
        e.preventDefault();
        void handleCreate();
      }
    },
    [handleCreate, isCreating]
  );

  // Validated as it is typed, not only on submit, so the footer never promises
  // a path that Create would then refuse.
  const nameError = folderName.trim() ? validateFolderName(folderName) : null;
  const shownError = error ?? nameError;

  const previewPath = useMemo(() => {
    const trimmed = folderName.trim();
    if (!parentPath || !trimmed || nameError) return null;
    return join(parentPath, trimmed);
  }, [parentPath, folderName, nameError]);

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" dismissible={!isCreating}>
      <AppDialog.Header className="py-3">
        {/* Neutral, not accent: the header glyph is decoration, and this focus
            region's one load-bearing accent is the keyboard focus ring. */}
        <AppDialog.Title icon={<FolderPlus className="h-4 w-4 text-text-secondary" />}>
          Create project folder
        </AppDialog.Title>
        {!isCreating && <AppDialog.CloseButton />}
      </AppDialog.Header>

      <AppDialog.Body className="space-y-5">
        <FormGrid>
          <FormRow label="Location" htmlFor="create-folder-parent">
            <DirectoryPickerField
              id="create-folder-parent"
              value={parentPath}
              onBrowse={() => void handleBrowseParent()}
              disabled={isCreating}
              browseLabel="Browse for a location"
            />
          </FormRow>
          <FormRow
            label="Name"
            htmlFor="create-folder-name"
            hint={
              // Only a failed create interrupts. The live name check stays
              // silent, like `FieldError`: an alert would speak mid-word.
              shownError && (
                <p
                  id={errorId}
                  role={error ? "alert" : undefined}
                  className="text-xs text-status-error"
                >
                  {shownError}
                </p>
              )
            }
          >
            <SlottedInputField
              ref={folderNameInputRef}
              id="create-folder-name"
              value={folderName}
              onChange={(e) => {
                setFolderName(e.target.value);
                setError(null);
              }}
              onKeyDown={handleKeyDown}
              invalid={shownError != null}
              aria-describedby={shownError ? errorId : undefined}
              spellCheck={false}
              autoComplete="off"
              placeholder="my-project"
              disabled={isCreating}
              leading={
                <ProjectEmojiButton
                  emoji={effectiveEmoji}
                  onEmojiChange={setPickedEmoji}
                  disabled={isCreating}
                  ariaLabel="Choose project emoji"
                  className={EMOJI_SLOT_CLASS}
                />
              }
            />
          </FormRow>
          <FormRow label="Open in" selfLabelled>
            <OpenDestinationControl
              value={destination}
              onChange={setDestination}
              disabled={isCreating}
            />
          </FormRow>
        </FormGrid>
      </AppDialog.Body>

      <AppDialog.Footer
        hint={
          previewPath ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0">Creates</span>
              <PathCaption path={previewPath} className="min-w-0 text-text-primary" />
            </span>
          ) : (
            <span className="truncate">
              {!parentPath
                ? "Choose a location to continue"
                : nameError
                  ? "Fix the folder name to continue"
                  : "Name the folder to continue"}
            </span>
          )
        }
      >
        <div className="flex shrink-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button
            variant="contrast"
            size="sm"
            onClick={handleCreate}
            disabled={isCreating || !parentPath || !folderName.trim() || nameError !== null}
          >
            {isCreating ? "Creating…" : "Create folder"}
          </Button>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}
