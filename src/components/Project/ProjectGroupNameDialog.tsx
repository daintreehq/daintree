import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { InlineError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { PROJECT_GROUP_NAME_MAX_LENGTH, type ProjectGroup } from "@shared/types/project";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import { useProjectStore } from "@/store/projectStore";

/**
 * Naming a group: a new one, or `group` renamed. Shared by the switcher's
 * dialogs and the project-creation dialogs' Group field, so a name the host
 * refuses reads the same wherever it was typed.
 */
export function ProjectGroupNameDialog({
  isOpen = true,
  group,
  projectId,
  create,
  onClose,
  restoreFocusTo,
}: {
  isOpen?: boolean;
  /** Set to rename this group; absent to create one. */
  group?: ProjectGroup;
  /** On create, the project to file under the new group. */
  projectId?: string;
  /**
   * On create, saves the group in place of the store's `createGroup`, for a
   * caller with something to do with the answer. Rejects with the host's
   * message, which is shown inline.
   */
  create?: (name: string) => Promise<unknown>;
  onClose: () => void;
  /** Where focus goes when this closes, ahead of the control that opened it. */
  restoreFocusTo?: RestoreFocusTarget;
}) {
  const createGroup = useProjectGroupsStore((state) => state.createGroup);
  const renameGroup = useProjectGroupsStore((state) => state.renameGroup);
  const projectName = useProjectStore((state) =>
    projectId ? state.projects.find((p) => p.id === projectId)?.name : undefined
  );
  const [name, setName] = useState(group?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // A caller that keeps this mounted across openings gets an untouched box on
  // each one. Reset while rendering the opening rather than by remounting: a
  // dialog that mounts already open loses its opener to StrictMode's replayed
  // cleanup, and focus has nowhere to go back to when it closes.
  const [openedAs, setOpenedAs] = useState(isOpen);
  if (openedAs !== isOpen) {
    setOpenedAs(isOpen);
    if (isOpen) {
      setName(group?.name ?? "");
      setError(null);
    }
  }

  // A new attempt clears the last refusal: the message was about a name that
  // is no longer in the box.
  useEffect(() => setError(null), [name]);

  const trimmed = name.trim();
  const unchanged = group !== undefined && trimmed === group.name;

  const submit = async () => {
    // The box keeps focus while the dialog animates out, so an Enter just after
    // Cancel or Escape still reaches here.
    if (!isOpen || !trimmed || isSaving) return;
    if (unchanged) {
      onClose();
      return;
    }
    setIsSaving(true);
    try {
      if (group) await renameGroup(group.id, trimmed);
      else if (create) await create(trimmed);
      else await createGroup(trimmed, projectId);
      onClose();
    } catch (cause) {
      setError(
        formatErrorMessage(cause, group ? "Couldn't rename group" : "Couldn't create group")
      );
    } finally {
      setIsSaving(false);
    }
  };

  const isCreate = group === undefined;
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      title={isCreate ? "New group" : "Rename group"}
      description={isCreate && projectName ? `${projectName} moves into the new group.` : undefined}
      zIndex="nested"
      confirmLabel={isCreate ? "Create group" : "Rename group"}
      cancelLabel="Cancel"
      onConfirm={submit}
      isConfirmLoading={isSaving}
      confirmDisabled={trimmed.length === 0}
      restoreFocusTo={restoreFocusTo}
      preferRestoreFocusTo={restoreFocusTo !== undefined}
      variant="default"
    >
      <div className="space-y-2">
        <Input
          autoFocus
          aria-label="Group name"
          placeholder="Group name"
          value={name}
          maxLength={PROJECT_GROUP_NAME_MAX_LENGTH}
          aria-invalid={error !== null}
          data-testid="project-group-name-input"
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            // Enter that commits an IME candidate belongs to the composition,
            // not to the dialog — submitting on it would create the group with
            // half a name.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {error && <InlineError role="alert">{error}</InlineError>}
      </div>
    </ConfirmDialog>
  );
}
