import { useState, useCallback, useEffect, useRef, useId, useMemo } from "react";
import { Callout } from "@/components/ui/Callout";
import { InlineError } from "@/components/ui/field";
import { join } from "@shared/utils/path";
import { AppDialog } from "@/components/ui/AppDialog";
import { FolderPlus } from "lucide-react";
import { pluginClient, projectClient } from "@/clients";
import type { ProjectTemplateDescriptor, ProjectTemplatePreview } from "@shared/types/plugin";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolvePluginIcon } from "@/components/icons/pluginIconRegistry";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { ProjectTemplateFileList } from "./ProjectTemplateFileList";
import { useProjectStore } from "@/store/projectStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { validateFolderName } from "@shared/utils/folderName";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import { ProjectEmojiButton } from "./ProjectEmojiButton";
import {
  FIELD_CONTROL_SIZE,
  FormGrid,
  FormRow,
} from "@/components/Worktree/views/WorktreeFormLayout";
import {
  DirectoryPickerField,
  SlottedInputField,
  EMOJI_SLOT_CLASS,
  OpenDestinationControl,
  PathCaption,
  ProjectGroupField,
  type ProjectOpenDestination,
} from "./projectDialogFields";
import { isEnterToSubmit } from "@/lib/enterToSubmit";
import { useProjectCreationGroup } from "@/hooks/useProjectCreationGroup";

/**
 * The template picker's value for no template, which stays first and the
 * default. Radix refuses an empty-string item value, and a template's key is a
 * JSON array, so the two can't collide.
 */
const EMPTY_FOLDER = "empty-folder";

function templateKey(template: ProjectTemplateDescriptor): string {
  return JSON.stringify([template.pluginId, template.templateId]);
}

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
  // A failure that isn't the name's fault — the picker, the location, the create
  // itself — so it isn't stated under the name, and the name isn't marked invalid.
  const [failure, setFailure] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  // Plugin project templates (#13825). The list is read once per opening; the
  // preview is whatever the current choice's files are, keyed so a slow read
  // for a choice the user has since left can never be shown or submitted.
  const [templates, setTemplates] = useState<ProjectTemplateDescriptor[]>([]);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState(EMPTY_FOLDER);
  const [templatePreview, setTemplatePreview] = useState<{
    key: string;
    preview: ProjectTemplatePreview;
  } | null>(null);
  // Bumped to read the chosen template's files again, after a create that
  // failed — most often because they changed since the list was shown.
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const folderNameInputRef = useRef<HTMLInputElement>(null);
  const homeDirFetchedRef = useRef(false);
  const errorId = useId();
  const templateHintId = useId();

  const createProjectFolder = useProjectStore((state) => state.createProjectFolder);
  const { groups, groupId, setGroupId } = useProjectCreationGroup(isOpen);

  useEffect(() => {
    if (!isOpen) {
      setFolderName("");
      setPickedEmoji(null);
      setDestination("current");
      setParentPath("");
      setError(null);
      setFailure(null);
      setIsCreating(false);
      setTemplates([]);
      setSelectedTemplateKey(EMPTY_FOLDER);
      setTemplatePreview(null);
      homeDirFetchedRef.current = false;
      return;
    }

    let cancelled = false;
    pluginClient
      .getProjectTemplates()
      .then((available) => {
        if (!cancelled) setTemplates(available);
      })
      .catch(() => {
        // No templates is the dialog as it always was; an empty folder still works.
      });

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
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const selectedTemplate = useMemo(
    () =>
      selectedTemplateKey === EMPTY_FOLDER
        ? null
        : (templates.find((template) => templateKey(template) === selectedTemplateKey) ?? null),
    [templates, selectedTemplateKey]
  );

  useEffect(() => {
    if (!selectedTemplate) return;
    const key = templateKey(selectedTemplate);
    let cancelled = false;
    void pluginClient
      .previewProjectTemplate(selectedTemplate.pluginId, selectedTemplate.templateId)
      .catch((err: unknown): ProjectTemplatePreview => {
        // The raw message can carry a path or errno; the log keeps it (#15232).
        logError("Couldn't preview a project template", err);
        return {
          status: "unusable",
          reason: "Couldn't read this template's files.",
          retryable: true,
        };
      })
      .then((preview) => {
        if (!cancelled) setTemplatePreview({ key, preview });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTemplate, previewGeneration]);

  const currentPreview =
    selectedTemplate && templatePreview?.key === templateKey(selectedTemplate)
      ? templatePreview.preview
      : null;
  const templateBlocked = selectedTemplate !== null && currentPreview?.status !== "ready";
  const showTemplateLoading = useDeferredLoading(
    selectedTemplate !== null && currentPreview === null,
    UI_DOHERTY_THRESHOLD
  );

  const retryTemplatePreview = () => {
    setTemplatePreview(null);
    setPreviewGeneration((generation) => generation + 1);
  };

  const handleBrowseParent = useCallback(async () => {
    try {
      const selected = await projectClient.openDialog();
      if (selected) {
        homeDirFetchedRef.current = true; // Prevent homeDir overwriting user's pick
        setParentPath(selected);
        setError(null);
        setFailure(null);
        folderNameInputRef.current?.focus();
      }
    } catch {
      setFailure("Could not open directory picker");
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
      setFailure("Please select a parent directory");
      return;
    }
    // Never falls back to an empty folder: a chosen template is created as
    // previewed or not at all.
    if (selectedTemplate && currentPreview?.status !== "ready") return;
    const template =
      selectedTemplate && currentPreview?.status === "ready"
        ? {
            pluginId: selectedTemplate.pluginId,
            templateId: selectedTemplate.templateId,
            digest: currentPreview.digest,
          }
        : undefined;

    setIsCreating(true);
    setError(null);
    setFailure(null);

    try {
      await createProjectFolder(parentPath, folderName.trim(), effectiveEmoji, {
        disposition: destination,
        ...(template ? { template } : {}),
        ...(groupId ? { groupId } : {}),
      });
      // Close only after the folder is created (but addProjectByPath runs in the background)
      onClose();
    } catch (err) {
      // Show error inline — keep dialog open so user can retry or correct input
      setFailure(formatErrorMessage(err, "Failed to create folder"));
      if (template) {
        // The list on screen may no longer be what would be written; read it
        // again so a retry is never made against a list the user didn't see.
        setTemplatePreview(null);
        setPreviewGeneration((generation) => generation + 1);
      }
    } finally {
      setIsCreating(false);
    }
  }, [
    parentPath,
    folderName,
    effectiveEmoji,
    destination,
    groupId,
    selectedTemplate,
    currentPreview,
    createProjectFolder,
    onClose,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isEnterToSubmit(e) && !isCreating) {
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
      <AppDialog.Header>
        {/* Neutral, not accent: the header glyph is decoration, and this focus
            region's one load-bearing accent is the keyboard focus ring. */}
        <AppDialog.Title icon={<FolderPlus className="h-4 w-4 text-text-secondary" />}>
          Create project folder
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-5">
        <FormGrid>
          <FormRow label="Location" htmlFor="create-folder-parent">
            <DirectoryPickerField
              id="create-folder-parent"
              value={parentPath}
              onBrowse={() => void handleBrowseParent()}
              // Enter here answers like the folder name field does.
              onEnter={() => {
                if (!isCreating) void handleCreate();
              }}
              disabled={isCreating}
              browseLabel="Browse for a location"
            />
          </FormRow>
          <FormRow
            label="Name"
            htmlFor="create-folder-name"
            hint={
              // Only a refused submit interrupts. The live name check stays
              // silent, like `FieldError`: an alert would speak mid-word.
              shownError && (
                <InlineError id={errorId} role={error ? "alert" : undefined}>
                  {shownError}
                </InlineError>
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
                setFailure(null);
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
          <ProjectGroupField
            id="create-folder-group"
            groups={groups}
            value={groupId}
            onChange={setGroupId}
            disabled={isCreating}
          />
          {templates.length > 0 && (
            <FormRow
              label="Template"
              htmlFor="create-folder-template"
              hint={
                selectedTemplate && (
                  <p id={templateHintId} className="text-xs text-text-secondary">
                    {selectedTemplate.description}
                  </p>
                )
              }
            >
              <Select
                value={selectedTemplateKey}
                onValueChange={(value) => {
                  setSelectedTemplateKey(value);
                  // A list read for an earlier choice of this same template
                  // may be out of date; it is read again on every choice.
                  setTemplatePreview(null);
                  setFailure(null);
                }}
                disabled={isCreating}
              >
                <SelectTrigger
                  id="create-folder-template"
                  aria-describedby={selectedTemplate ? templateHintId : undefined}
                  className={FIELD_CONTROL_SIZE}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EMPTY_FOLDER}>Empty folder</SelectItem>
                  {templates.map((template) => {
                    const Icon = resolvePluginIcon(template.iconId);
                    return (
                      <SelectItem
                        key={templateKey(template)}
                        value={templateKey(template)}
                        description={template.pluginName}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Icon className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden />
                          <span className="truncate">{template.title}</span>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </FormRow>
          )}
          <FormRow label="Open in" selfLabelled>
            <OpenDestinationControl
              value={destination}
              onChange={setDestination}
              disabled={isCreating}
            />
          </FormRow>
        </FormGrid>
        {selectedTemplate && (
          <ProjectTemplateFileList
            preview={currentPreview}
            showLoading={showTemplateLoading}
            onRetry={retryTemplatePreview}
          />
        )}
        {failure && (
          <Callout severity="error" role="alert">
            <p>{failure}</p>
          </Callout>
        )}
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
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: isCreating }}
        primaryAction={{
          label: "Create folder",
          onClick: () => void handleCreate(),
          loading: isCreating,
          disabled: !parentPath || !folderName.trim() || nameError !== null || templateBlocked,
        }}
      />
    </AppDialog>
  );
}
