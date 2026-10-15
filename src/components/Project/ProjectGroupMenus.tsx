import { useEffect, useRef, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  FolderClosed,
  FolderMinus,
  Settings2,
} from "@/components/icons";
import {
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pluralize } from "@/lib/pluralize";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { PROJECT_GROUP_NAME_MAX_LENGTH, type ProjectGroup } from "@shared/types/project";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import { useProjectStore } from "@/store/projectStore";

const ICON_CLASS = "w-3.5 h-3.5 mr-2";

/**
 * Where a group dialog hands focus back. These open from menus whose triggers
 * can't take focus usefully — a row is not focusable, and a header's ⋯ button
 * would swallow the arrow keys — so the switcher's search box is the successor,
 * the same place every other switcher menu returns to. Absent when the
 * switcher has closed, which leaves the dialog's own fallback.
 */
const switcherSearchInput = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('input[aria-controls~="project-list"]');

/**
 * A row's filing actions: which group it is in, and whether it is archived.
 *
 * Membership is a radio group because a project sits in at most one group —
 * the menu draws that rule instead of leaving it to be discovered. "New group…"
 * lives in the same submenu so the first group is made from the project that
 * prompted it, in one step.
 */
export function ProjectFilingMenuItems({
  projectId,
  groupId,
  isArchived,
}: {
  projectId: string;
  groupId?: string;
  isArchived?: boolean;
}) {
  const groups = useProjectGroupsStore((state) => state.groups);
  const setProjectGroup = useProjectGroupsStore((state) => state.setProjectGroup);
  const setProjectArchived = useProjectGroupsStore((state) => state.setProjectArchived);
  const openDialog = useProjectGroupsStore((state) => state.openDialog);

  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="project-move-to-group">
          <FolderClosed className={ICON_CLASS} aria-hidden="true" />
          Move to group
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-48">
          {groups.length > 0 && (
            <>
              <ContextMenuRadioGroup
                value={groupId ?? ""}
                onValueChange={(next) => {
                  if (next && next !== groupId) void setProjectGroup(projectId, next);
                }}
              >
                {groups.map((group) => (
                  <ContextMenuRadioItem key={group.id} value={group.id}>
                    <span className="truncate">{group.name}</span>
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => openDialog({ kind: "create", projectId })}>
            <Plus className={ICON_CLASS} aria-hidden="true" />
            New group…
          </ContextMenuItem>
          {groupId && (
            <ContextMenuItem onSelect={() => void setProjectGroup(projectId, null)}>
              <FolderMinus className={ICON_CLASS} aria-hidden="true" />
              Remove from group
            </ContextMenuItem>
          )}
          {groups.length > 0 && (
            <>
              <ContextMenuSeparator />
              {/*
                The keyboard's way to every group, empty ones included: group
                headers sit inside the listbox, where nothing but rows can take
                focus, and this menu is reachable from any row with Shift+F10.
              */}
              <ContextMenuItem onSelect={() => openDialog({ kind: "manage" })}>
                <Settings2 className={ICON_CLASS} aria-hidden="true" />
                Manage groups…
              </ContextMenuItem>
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {isArchived ? (
        <ContextMenuItem onSelect={() => void setProjectArchived(projectId, false)}>
          <ArchiveRestore className={ICON_CLASS} aria-hidden="true" />
          Unarchive project
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onSelect={() => void setProjectArchived(projectId, true)}>
          <Archive className={ICON_CLASS} aria-hidden="true" />
          Archive project
        </ContextMenuItem>
      )}
    </>
  );
}

interface GroupAction {
  key: string;
  label: string;
  Icon: typeof Pencil;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
}

function useGroupActions(group: ProjectGroup): GroupAction[] {
  const groups = useProjectGroupsStore((state) => state.groups);
  const moveGroup = useProjectGroupsStore((state) => state.moveGroup);
  const openDialog = useProjectGroupsStore((state) => state.openDialog);
  const index = groups.findIndex((g) => g.id === group.id);
  return [
    {
      key: "rename",
      label: "Rename group…",
      Icon: Pencil,
      onSelect: () => openDialog({ kind: "rename", groupId: group.id }),
    },
    {
      key: "up",
      label: "Move up",
      Icon: ArrowUp,
      onSelect: () => void moveGroup(group.id, -1),
      disabled: index <= 0,
    },
    {
      key: "down",
      label: "Move down",
      Icon: ArrowDown,
      onSelect: () => void moveGroup(group.id, 1),
      disabled: index === -1 || index >= groups.length - 1,
    },
    {
      key: "manage",
      label: "Manage groups…",
      Icon: Settings2,
      onSelect: () => openDialog({ kind: "manage" }),
    },
    {
      key: "delete",
      label: "Delete group…",
      Icon: Trash2,
      onSelect: () => openDialog({ kind: "delete", groupId: group.id }),
      destructive: true,
      separatorBefore: true,
    },
  ];
}

/** A group header's actions, for its right-click menu. */
export function ProjectGroupContextMenuItems({ group }: { group: ProjectGroup }) {
  const actions = useGroupActions(group);
  return (
    <>
      {actions.map(({ key, label, Icon, onSelect, disabled, destructive, separatorBefore }) => (
        <GroupActionFragment key={key} separatorBefore={separatorBefore} kind="context">
          <ContextMenuItem disabled={disabled} destructive={destructive} onSelect={onSelect}>
            <Icon className={ICON_CLASS} aria-hidden="true" />
            {label}
          </ContextMenuItem>
        </GroupActionFragment>
      ))}
    </>
  );
}

/** The same actions for the header's ⋯ button. */
export function ProjectGroupDropdownMenuItems({ group }: { group: ProjectGroup }) {
  const actions = useGroupActions(group);
  return (
    <>
      {actions.map(({ key, label, Icon, onSelect, disabled, destructive, separatorBefore }) => (
        <GroupActionFragment key={key} separatorBefore={separatorBefore} kind="dropdown">
          <DropdownMenuItem disabled={disabled} destructive={destructive} onSelect={onSelect}>
            <Icon className={ICON_CLASS} aria-hidden="true" />
            {label}
          </DropdownMenuItem>
        </GroupActionFragment>
      ))}
    </>
  );
}

function GroupActionFragment({
  separatorBefore,
  kind,
  children,
}: {
  separatorBefore?: boolean;
  kind: "context" | "dropdown";
  children: React.ReactNode;
}) {
  return (
    <>
      {separatorBefore &&
        (kind === "context" ? <ContextMenuSeparator /> : <DropdownMenuSeparator />)}
      {children}
    </>
  );
}

/**
 * Naming and deleting groups. Mounted once beside the switcher's other
 * confirms, and driven by the groups store, so any menu that can reach a group
 * can open one.
 */
export function ProjectGroupDialogs() {
  const dialog = useProjectGroupsStore((state) => state.dialog);
  const groups = useProjectGroupsStore((state) => state.groups);
  const closeDialog = useProjectGroupsStore((state) => state.closeDialog);

  // A rename or delete whose group another window just deleted has nothing
  // left to act on. It closes through `closeDialog`, so one opened from Manage
  // groups still goes back there instead of leaving a dialog that draws nothing.
  const targetMissing =
    dialog !== null &&
    (dialog.kind === "rename" || dialog.kind === "delete") &&
    !groups.some((g) => g.id === dialog.groupId);
  useEffect(() => {
    if (targetMissing) closeDialog();
  }, [targetMissing, closeDialog]);

  if (!dialog) return null;
  if (dialog.kind === "manage") {
    return (
      <ManageGroupsDialog
        focusGroupId={dialog.focusGroupId}
        focusIndex={dialog.focusIndex}
        onClose={closeDialog}
      />
    );
  }
  if (dialog.kind === "delete") {
    const group = groups.find((g) => g.id === dialog.groupId);
    if (!group) return null;
    return <DeleteGroupDialog group={group} onClose={closeDialog} />;
  }
  if (dialog.kind === "rename") {
    const group = groups.find((g) => g.id === dialog.groupId);
    if (!group) return null;
    return <GroupNameDialog key={`rename-${group.id}`} group={group} onClose={closeDialog} />;
  }
  return (
    <GroupNameDialog
      key={`create-${dialog.projectId ?? ""}`}
      projectId={dialog.projectId}
      onClose={closeDialog}
    />
  );
}

function GroupNameDialog({
  group,
  projectId,
  onClose,
}: {
  /** Set to rename this group; absent to create one. */
  group?: ProjectGroup;
  /** On create, the project to file under the new group. */
  projectId?: string;
  onClose: () => void;
}) {
  const createGroup = useProjectGroupsStore((state) => state.createGroup);
  const renameGroup = useProjectGroupsStore((state) => state.renameGroup);
  const projectName = useProjectStore((state) =>
    projectId ? state.projects.find((p) => p.id === projectId)?.name : undefined
  );
  const [name, setName] = useState(group?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // A new attempt clears the last refusal: the message was about a name that
  // is no longer in the box.
  useEffect(() => setError(null), [name]);

  const trimmed = name.trim();
  const unchanged = group !== undefined && trimmed === group.name;

  const submit = async () => {
    if (!trimmed || isSaving) return;
    if (unchanged) {
      onClose();
      return;
    }
    setIsSaving(true);
    try {
      if (group) await renameGroup(group.id, trimmed);
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
      isOpen={true}
      onClose={onClose}
      title={isCreate ? "New group" : "Rename group"}
      description={isCreate && projectName ? `${projectName} moves into the new group.` : undefined}
      zIndex="nested"
      confirmLabel={isCreate ? "Create group" : "Rename group"}
      cancelLabel="Cancel"
      onConfirm={submit}
      isConfirmLoading={isSaving}
      confirmDisabled={trimmed.length === 0}
      restoreFocusTo={switcherSearchInput}
      preferRestoreFocusTo
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
        {error && (
          <div role="alert" className="text-xs text-status-danger">
            {error}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

function DeleteGroupDialog({ group, onClose }: { group: ProjectGroup; onClose: () => void }) {
  const deleteGroup = useProjectGroupsStore((state) => state.deleteGroup);
  const memberCount = useProjectStore(
    (state) => state.projects.filter((p) => p.groupId === group.id).length
  );
  const [isDeleting, setIsDeleting] = useState(false);
  return (
    <ConfirmDialog
      isOpen={true}
      onClose={onClose}
      title={`Delete '${group.name}'?`}
      zIndex="nested"
      restoreFocusTo={switcherSearchInput}
      preferRestoreFocusTo
      confirmLabel="Delete group"
      cancelLabel="Cancel"
      isConfirmLoading={isDeleting}
      onConfirm={async () => {
        setIsDeleting(true);
        try {
          await deleteGroup(group.id);
        } finally {
          setIsDeleting(false);
          onClose();
        }
      }}
      variant="destructive"
    >
      <div className="text-sm text-text-secondary">
        {/*
          The one consequence that holds for every member: it leaves the group.
          Where it then shows depends on what it is doing — archived, pinned or
          asking for input — so naming a destination would be a promise the
          switcher doesn't keep for all of them.
        */}
        {memberCount === 0
          ? "It has no projects in it."
          : memberCount === 1
            ? "Its project becomes ungrouped. Nothing is removed from disk."
            : `Its ${pluralize(memberCount, "project")} become ungrouped. Nothing is removed from disk.`}
      </div>
    </ConfirmDialog>
  );
}

/**
 * Every group in one list, each with its actions as real buttons — the
 * keyboard path to renaming, reordering and deleting groups, which the group
 * headers can't offer from inside the listbox. Rename and Delete open their
 * own dialog and come back here when it closes.
 */
function ManageGroupsDialog({
  focusGroupId,
  focusIndex,
  onClose,
}: {
  /** The row to land on when coming back from one of its own dialogs. */
  focusGroupId?: string;
  /** Where that row stood, for when it no longer exists (it was deleted). */
  focusIndex?: number;
  onClose: () => void;
}) {
  const groups = useProjectGroupsStore((state) => state.groups);
  const moveGroup = useProjectGroupsStore((state) => state.moveGroup);
  const openDialog = useProjectGroupsStore((state) => state.openDialog);
  const projects = useProjectStore((state) => state.projects);
  const memberCount = (groupId: string) => projects.filter((p) => p.groupId === groupId).length;
  const listRef = useRef<HTMLUListElement>(null);

  // Back from Rename or Delete, focus returns to that group's row — or, when it
  // was deleted, to the row now in its place — instead of the top of the list.
  // Placed before the dialog's own first-field pass, which yields to it.
  const focusTarget = useRef(focusGroupId);
  useEffect(() => {
    const groupId = focusTarget.current;
    focusTarget.current = undefined;
    if (!groupId) return;
    const list = listRef.current;
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-group-row]")];
    // A deleted group's slot now holds the group after it; deleting the last
    // one leaves the one before it.
    const fallback =
      focusIndex !== undefined ? rows[Math.min(focusIndex, rows.length - 1)] : rows[0];
    const row =
      rows.find((candidate) => candidate.dataset.groupRow === groupId) ?? fallback ?? null;
    row?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  // Moving a group to either end disables the button that moved it, and a
  // disabled button drops focus. Keyboard users then keep their place on the
  // same group's other move button instead of being sent back to the top.
  // Checked after the reorder commits, which is when the button turns disabled.
  const movedGroupRef = useRef<string | null>(null);
  useEffect(() => {
    const groupId = movedGroupRef.current;
    if (!groupId) return;
    movedGroupRef.current = null;
    const active = document.activeElement;
    const stranded =
      active === null ||
      active === document.body ||
      (active instanceof HTMLButtonElement && active.disabled);
    if (!stranded) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-group-row="${CSS.escape(groupId)}"]`
    );
    row?.querySelector<HTMLButtonElement>("button[data-group-move]:not(:disabled)")?.focus();
  }, [groups]);

  const move = (groupId: string, delta: -1 | 1) => {
    movedGroupRef.current = groupId;
    void moveGroup(groupId, delta);
  };

  return (
    <AppDialog
      isOpen={true}
      onClose={onClose}
      size="sm"
      zIndex="nested"
      restoreFocusTo={switcherSearchInput}
      preferRestoreFocusTo
    >
      <AppDialog.Header>
        <AppDialog.Title>Manage groups</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        {groups.length === 0 ? (
          <p className="text-sm text-text-secondary">
            Make one with New group, or from a project&apos;s Move to group menu.
          </p>
        ) : (
          <ul ref={listRef} className="space-y-1" data-testid="manage-groups-list">
            {groups.map((group, index) => (
              <li key={group.id} data-group-row={group.id} className="flex items-center gap-2 py-1">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-primary">{group.name}</div>
                  <div className="text-xs text-text-secondary">
                    {pluralize(memberCount(group.id), "project")}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Rename ${group.name}`}
                  onClick={() =>
                    openDialog({
                      kind: "rename",
                      groupId: group.id,
                      returnTo: "manage",
                      returnIndex: index,
                    })
                  }
                >
                  <Pencil aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${group.name} up`}
                  data-group-move
                  disabled={index === 0}
                  onClick={() => move(group.id, -1)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${group.name} down`}
                  data-group-move
                  disabled={index === groups.length - 1}
                  onClick={() => move(group.id, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost-danger"
                  size="icon-sm"
                  aria-label={`Delete ${group.name}`}
                  onClick={() =>
                    openDialog({
                      kind: "delete",
                      groupId: group.id,
                      returnTo: "manage",
                      returnIndex: index,
                    })
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </AppDialog.Body>
      <AppDialog.Footer
        leadingAction={{
          label: "New group…",
          onClick: () => openDialog({ kind: "create", returnTo: "manage" }),
        }}
        primaryAction={{ label: "Done", onClick: onClose }}
      />
    </AppDialog>
  );
}
