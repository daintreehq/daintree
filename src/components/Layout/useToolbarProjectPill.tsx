import { useCallback, useRef, useState } from "react";
import { ContextMenuTrigger } from "@/components/ui/context-menu";
import { TooltipTrigger } from "@/components/ui/tooltip";
import { useKeepMounted } from "@/hooks";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";
import { actionService } from "@/services/ActionService";
import { LazyProjectIdentityEditor, preloadProjectIdentityEditor } from "@/lazyPanels";
import { branchChipState, type ActiveWorkspaceIdentity } from "@/lib/workspaceIdentity";
import { shortSha } from "@/utils/textParsing";
import { isGitBackedProject } from "@shared/types";
import type { Project, WorktreeSnapshot } from "@shared/types";
import { ToolbarProjectPill } from "./ToolbarProjectPill";
import type { OverflowMenuProps } from "./ToolbarOverflowMenu";

export interface ToolbarProjectPillInput {
  projectSwitcher: UseProjectSwitcherPaletteReturn;
  currentProject: Project | null;
  workspaceIdentity: ActiveWorkspaceIdentity;
  activeWorktree: WorktreeSnapshot | null | undefined;
  branchName: string | undefined;
  branchChipDemoted: boolean;
}

// The project pill's interaction state: the switcher dropdown, its tooltip's
// focus-restore suppression, the context menu's identity-editor handoff, and
// the branch chip it folds into the left `…` while a profile demotes it.
export function useToolbarProjectPill({
  projectSwitcher,
  currentProject,
  workspaceIdentity,
  activeWorktree,
  branchName,
  branchChipDemoted,
}: ToolbarProjectPillInput) {
  const handleOpenProjectSettings = useCallback(() => {
    projectSwitcher.close();
    void actionService.dispatch("project.settings.open", undefined, { source: "user" });
  }, [projectSwitcher]);

  const handleOpenSchedules = useCallback(() => {
    projectSwitcher.close();
    void actionService.dispatch("schedules.open", undefined, { source: "user" });
  }, [projectSwitcher]);

  const handleStopProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.stopProject(projectId);
    },
    [projectSwitcher]
  );

  const handleCloseProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.removeProject(projectId);
    },
    [projectSwitcher]
  );

  const handleSleepProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.sleepProject(projectId);
    },
    [projectSwitcher]
  );

  const handleRestartProject = useCallback(
    (projectId: string) => {
      projectSwitcher.restartProject(projectId);
    },
    [projectSwitcher]
  );

  const handleLocateProject = useCallback(
    (projectId: string) => {
      projectSwitcher.locateProject(projectId);
    },
    [projectSwitcher]
  );

  const handleMoveOrRenameProject = useCallback(
    (projectId: string) => {
      projectSwitcher.moveOrRenameProject(projectId);
    },
    [projectSwitcher]
  );

  const handleRemoveConfirmClose = useCallback(() => {
    projectSwitcher.setRemoveConfirmProject(null);
  }, [projectSwitcher]);

  const handleSelectNewWindow = useCallback(
    (project: SearchableProject) => {
      if (project.isMissing) return;
      projectSwitcher.close();
      void actionService.dispatch(
        "app.newWindow",
        { projectPath: project.path },
        { source: "user" }
      );
    },
    [projectSwitcher]
  );

  const isDropdownOpen = projectSwitcher.isOpen && projectSwitcher.mode === "dropdown";
  const shouldMountProjectSwitcherDropdown = useKeepMounted(isDropdownOpen);
  const handleDropdownClose = useCallback(() => {
    if (projectSwitcher.mode !== "dropdown") return;
    projectSwitcher.close();
  }, [projectSwitcher]);

  // Project pill: Radix Tooltip reopens on focus restoration after the popover
  // or context menu closes. Controlled state + a suppression ref (set in the
  // popover/context-menu close handlers, cleared on the next pointer enter)
  // mirrors the AgentButton pattern so the tooltip doesn't pop on top of a
  // freshly-opened destination surface.
  const [pillTooltipOpen, setPillTooltipOpen] = useState(false);
  const isRestoringFocusPillRef = useRef(false);
  const handlePillTooltipOpenChange = useCallback((open: boolean) => {
    if (open && isRestoringFocusPillRef.current) return;
    setPillTooltipOpen(open);
  }, []);
  const suppressPillTooltipForFocusRestore = useCallback(() => {
    setPillTooltipOpen(false);
    isRestoringFocusPillRef.current = true;
  }, []);
  const handlePillPointerEnter = useCallback(() => {
    isRestoringFocusPillRef.current = false;
    void preloadProjectIdentityEditor().catch(() => {});
  }, []);
  const handlePillDropdownClose = useCallback(() => {
    suppressPillTooltipForFocusRestore();
    handleDropdownClose();
  }, [handleDropdownClose, suppressPillTooltipForFocusRestore]);

  const activeSearchableProject = projectSwitcher.activeProject;
  const headSha = activeWorktree?.isDetached ? activeWorktree.head : undefined;
  const chipState = branchChipState(
    workspaceIdentity.kind,
    branchName,
    isGitBackedProject(currentProject),
    activeWorktree?.isDetached ?? false
  );
  const pillBranchLabel =
    chipState === "visible"
      ? branchName
      : chipState === "detached"
        ? `detached at ${shortSha(headSha) ?? "unknown commit"}`
        : undefined;
  // Beside the pill, in the left `…`, while this project demotes the chip.
  const branchOverflowRow: OverflowMenuProps["branchRow"] = !branchChipDemoted
    ? null
    : chipState === "visible" && branchName
      ? { label: branchName, copyLabel: "Branch name", copyValue: branchName }
      : chipState === "detached" && headSha
        ? { label: pillBranchLabel ?? headSha, copyLabel: "Commit hash", copyValue: headSha }
        : null;
  // Routed through the switcher row's copy so the two "Copy path" rows confirm
  // the same way; the menu closes on select, leaving nothing else to show it.
  const handleCopyProjectPath = useCallback(() => {
    if (!currentProject) return;
    projectSwitcher.copyPath(currentProject.path);
  }, [currentProject, projectSwitcher]);
  const handlePillTogglePin = useCallback(() => {
    if (!currentProject) return;
    void projectSwitcher.togglePinProject(currentProject.id);
  }, [currentProject, projectSwitcher]);

  // Which project's identity editor is open, rather than a bare boolean: a flag
  // would outlive the project it belongs to and reopen the popover over
  // whichever project came next.
  const [identityEditorProjectId, setIdentityEditorProjectId] = useState<string | null>(null);
  // Dropped rather than merely ignored when the project underneath it goes:
  // a controlled Radix popover is not told its `open` prop fell to false, so a
  // stale id would sit here and raise the editor again the next time that
  // project came back. Adjusted during render for the same reason the editor's
  // own draft re-seed is — an effect would opt this component out of the
  // React Compiler.
  if (identityEditorProjectId !== null && identityEditorProjectId !== currentProject?.id) {
    setIdentityEditorProjectId(null);
  }
  const isIdentityEditorOpen = identityEditorProjectId !== null;
  const shouldMountIdentityEditor = useKeepMounted(isIdentityEditorOpen);
  // Selecting the item records the intent; the menu's own close hook spends it.
  // Opening straight from `onSelect` would raise the popover inside the menu's
  // teardown, where Radix still holds the focus trap and the outside-pointer
  // lock — so the release that closed the menu can dismiss the popover it just
  // opened. `onCloseAutoFocus` fires once the menu is actually gone.
  // Carries WHICH project was right-clicked, not just that something was: the
  // intent outlives the menu by an exit animation, and the project can change
  // underneath it in that time.
  const pendingIdentityEditRef = useRef<string | null>(null);
  const handleEditProjectIdentity = useCallback(() => {
    pendingIdentityEditRef.current = currentProject?.id ?? null;
  }, [currentProject?.id]);
  // Radix keeps the content mounted through its 120ms exit, so a menu reopened
  // inside that window never unmounts and never reaches the close hook below.
  // Dropping the intent on every open means the worst case is one edit request
  // the user has visibly superseded, rather than a popover that springs open on
  // some later, unrelated close.
  const handlePillContextMenuOpenChange = useCallback((open: boolean) => {
    if (!open) return;
    pendingIdentityEditRef.current = null;
    // Keyboard-opened menus never see the pill's hover preload.
    void preloadProjectIdentityEditor().catch(() => {});
  }, []);
  const handlePillContextMenuCloseAutoFocus = useCallback(
    (event: Event) => {
      suppressPillTooltipForFocusRestore();
      const pendingProjectId = pendingIdentityEditRef.current;
      pendingIdentityEditRef.current = null;
      // A project swapped in during the exit animation is a different project
      // than the one the user right-clicked; drop the request rather than
      // opening the editor over it. Every other close keeps the shared
      // restore policy, so a keyboard dismissal lands back on the pill.
      if (pendingProjectId === null || pendingProjectId !== currentProject?.id) return;
      if (LazyProjectIdentityEditor.isLoaded()) {
        event.preventDefault();
        setIdentityEditorProjectId(pendingProjectId);
        return;
      }
      // Chunk still in flight: nothing would take focus in the meantime, so let
      // the menu restore it to the pill, and open only if the user hasn't moved
      // on by the time it lands — a late popover must not steal focus.
      void preloadProjectIdentityEditor().then(
        () => {
          const active = document.activeElement;
          const pill = document.querySelector('[data-testid="project-switcher-trigger"]');
          if (active !== pill && active !== document.body) return;
          setIdentityEditorProjectId(pendingProjectId);
        },
        () => {}
      );
    },
    [currentProject?.id, suppressPillTooltipForFocusRestore]
  );
  const handleIdentityEditorOpenChange = useCallback(
    (next: boolean) => {
      setIdentityEditorProjectId(next ? (currentProject?.id ?? null) : null);
    },
    [currentProject?.id]
  );

  const projectSwitcherTrigger = (
    <ContextMenuTrigger asChild>
      <TooltipTrigger asChild>
        <ToolbarProjectPill
          workspaceIdentity={workspaceIdentity}
          emoji={currentProject?.emoji}
          chipState={branchChipDemoted ? "hidden" : chipState}
          branchName={branchName}
          headSha={headSha}
          isDropdownOpen={isDropdownOpen}
          onClick={() => projectSwitcher.open("dropdown")}
          onPointerEnter={handlePillPointerEnter}
        />
      </TooltipTrigger>
    </ContextMenuTrigger>
  );

  return {
    handleOpenProjectSettings,
    handleOpenSchedules,
    handleStopProject,
    handleCloseProject,
    handleSleepProject,
    handleRestartProject,
    handleLocateProject,
    handleMoveOrRenameProject,
    handleRemoveConfirmClose,
    handleSelectNewWindow,
    isDropdownOpen,
    shouldMountProjectSwitcherDropdown,
    pillTooltipOpen,
    handlePillTooltipOpenChange,
    suppressPillTooltipForFocusRestore,
    handlePillDropdownClose,
    activeSearchableProject,
    pillBranchLabel,
    branchOverflowRow,
    handleCopyProjectPath,
    handlePillTogglePin,
    isIdentityEditorOpen,
    shouldMountIdentityEditor,
    handleEditProjectIdentity,
    handlePillContextMenuOpenChange,
    handlePillContextMenuCloseAutoFocus,
    handleIdentityEditorOpenChange,
    projectSwitcherTrigger,
  };
}
