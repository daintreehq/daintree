import { useMemo, useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clipboard,
  FolderOpen,
  FolderPlus,
  Layers,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ProjectActionRow } from "./ProjectActionRow";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { useModifierKeys } from "@/hooks/useModifierKeys";
import { useOverlayState } from "@/hooks";
import { usePaletteStore } from "@/store/paletteStore";
import type { ProjectSwitcherMode, SearchableProject } from "@/hooks/useProjectSwitcherPalette";
import type { ProjectGroup } from "@/store/projectGroupsStore";
import { buildSwitcherSections, type SwitcherSection } from "./projectGrouping";
import { useUIStore } from "@/store/uiStore";

export interface ProjectSwitcherPaletteProps {
  isOpen: boolean;
  query: string;
  results: SearchableProject[];
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (project: SearchableProject) => void;
  onClose: () => void;
  mode?: ProjectSwitcherMode;
  onAddProject?: () => void;
  onCreateFolder?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectBackground?: (project: SearchableProject) => void;
  onOpenProjectSettings?: () => void;
  dropdownAlign?: "start" | "center" | "end";
  children?: React.ReactNode;
  removeConfirmProject?: SearchableProject | null;
  onRemoveConfirmClose?: () => void;
  onConfirmRemove?: () => void;
  isRemovingProject?: boolean;
  groups?: ProjectGroup[];
  onCreateGroup?: (name: string) => string;
  onAssignProjectToGroup?: (projectId: string, groupId: string) => void;
  onRemoveProjectFromGroup?: (projectId: string) => void;
  onRenameGroup?: (groupId: string, name: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onMoveGroupUp?: (groupId: string) => void;
  onMoveGroupDown?: (groupId: string) => void;
  onHoverProject?: (project: SearchableProject) => void;
}

interface ProjectListItemProps {
  project: SearchableProject;
  index: number;
  selectedIndex: number;
  onSelect: (project: SearchableProject) => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onHoverProject?: (project: SearchableProject) => void;
  onCopyPath?: (path: string) => void;
}

function StatusDot({ project }: { project: SearchableProject }) {
  if (project.isMissing) return <div className="w-1.5 shrink-0" />;

  const hasActive = project.activeAgentCount > 0;
  const hasWaiting = project.waitingAgentCount > 0;
  const hasProcesses = project.processCount > 0;

  if (hasActive) {
    return (
      <div
        className="w-1.5 h-1.5 rounded-full bg-canopy-accent animate-agent-pulse shrink-0"
        aria-label="Agents working"
      />
    );
  }
  if (hasWaiting) {
    return (
      <div
        className="w-1.5 h-1.5 rounded-full bg-status-warning shrink-0"
        aria-label="Agents waiting"
      />
    );
  }
  if (hasProcesses || project.isBackground) {
    return (
      <div
        className="w-1.5 h-1.5 rounded-full bg-status-success shrink-0"
        aria-label="Running in background"
      />
    );
  }
  return <div className="w-1.5 shrink-0" />;
}

function ProjectListItem({
  project,
  index,
  selectedIndex,
  onSelect,
  onStopProject,
  onCloseProject,
  onLocateProject,
  onTogglePinProject,
  onHoverProject,
  onCopyPath,
}: ProjectListItemProps) {
  const showStop = project.processCount > 0 && !project.isMissing;

  const row = (
    <div
      id={`project-option-${project.id}`}
      role="option"
      aria-selected={index === selectedIndex}
      aria-disabled={project.isMissing || undefined}
      onMouseEnter={onHoverProject ? () => onHoverProject(project) : undefined}
      className={cn(
        "group relative w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border border-transparent",
        project.isActive
          ? cn(
              "text-canopy-text",
              index === selectedIndex && "bg-overlay-soft border-border-subtle"
            )
          : project.isMissing
            ? cn(
                "text-canopy-text/50",
                index === selectedIndex
                  ? "bg-overlay-soft border-border-subtle"
                  : "hover:bg-overlay-soft"
              )
            : index === selectedIndex
              ? "bg-overlay-soft border-border-subtle text-canopy-text cursor-pointer"
              : "text-canopy-text/70 hover:bg-overlay-soft hover:text-canopy-text cursor-pointer"
      )}
      onClick={() => !project.isActive && !project.isMissing && onSelect(project)}
    >
      <StatusDot project={project} />

      <div
        className={cn(
          "flex items-center justify-center rounded-[var(--radius-lg)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] shrink-0 transition-all duration-200",
          "h-8 w-8 text-base"
        )}
        style={{
          background: project.color
            ? `linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), ${getProjectGradient(project.color)}`
            : "linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), var(--color-canopy-sidebar)",
        }}
      >
        <span className="leading-none select-none filter drop-shadow-sm">{project.emoji}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "truncate text-sm font-semibold leading-tight",
              project.isActive || index === selectedIndex
                ? "text-canopy-text"
                : "text-canopy-text/85"
            )}
          >
            {project.name}
          </span>

          {project.isPinned && (
            <Pin className="w-3 h-3 text-canopy-accent/60 shrink-0" aria-label="Pinned" />
          )}

          {project.isMissing && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertTriangle
                    className="h-3 w-3 text-status-warning shrink-0"
                    aria-label="Directory not found"
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">Directory not found</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {project.isMissing ? (
              <div
                className={cn(
                  "flex items-center gap-1.5 transition-opacity",
                  index === selectedIndex ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}
              >
                {onLocateProject && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            onLocateProject(project.id);
                          }}
                          className={cn(
                            "p-0.5 rounded transition-colors cursor-pointer",
                            "text-canopy-text/50 hover:bg-tint/[0.06] hover:text-canopy-text/80",
                            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                          )}
                          aria-label="Locate project folder"
                        >
                          <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Locate folder</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                {onCloseProject && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            onCloseProject(project.id);
                          }}
                          className={cn(
                            "p-0.5 rounded transition-colors cursor-pointer",
                            "text-canopy-text/50 hover:bg-tint/[0.06] hover:text-canopy-text/80",
                            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                          )}
                          aria-label="Remove project"
                        >
                          <X className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Remove project</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            ) : (
              (showStop || onCloseProject) && (
                <div
                  className={cn(
                    "flex items-center gap-1.5 transition-opacity",
                    index === selectedIndex ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                >
                  {showStop && onStopProject && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={(e) => {
                              e.stopPropagation();
                              onStopProject(project.id);
                            }}
                            className={cn(
                              "p-0.5 rounded transition-colors cursor-pointer",
                              "text-status-error hover:bg-status-error/10",
                              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                            )}
                            aria-label="Stop project"
                          >
                            <Square className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Stop project</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {onCloseProject && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={(e) => {
                              e.stopPropagation();
                              onCloseProject(project.id);
                            }}
                            className={cn(
                              "p-0.5 rounded transition-colors cursor-pointer",
                              "text-canopy-text/50 hover:bg-tint/[0.06] hover:text-canopy-text/80",
                              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                            )}
                            aria-label="Close project"
                          >
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Close project</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              )
            )}

            {!project.isMissing && (
              <ProjectActionRow
                activeAgentCount={project.activeAgentCount}
                waitingAgentCount={project.waitingAgentCount}
              />
            )}
          </div>
        </div>

        <div className="flex items-center min-w-0 mt-0.5">
          <span
            className={cn(
              "truncate text-[11px] leading-none font-mono",
              project.isMissing ? "text-status-warning/70" : "text-canopy-text/50"
            )}
          >
            {project.isMissing ? "Directory not found" : project.path.split(/[/\\]/).pop()}
          </span>
        </div>
      </div>
    </div>
  );

  const hasContextActions = onTogglePinProject || onStopProject || onCloseProject || onCopyPath;
  if (!hasContextActions) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {onTogglePinProject && (
          <ContextMenuItem onClick={() => onTogglePinProject(project.id)}>
            {project.isPinned ? (
              <>
                <PinOff className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Unpin project
              </>
            ) : (
              <>
                <Pin className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Pin project
              </>
            )}
          </ContextMenuItem>
        )}
        {onCopyPath && (
          <ContextMenuItem onClick={() => onCopyPath(project.path)}>
            <Clipboard className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Copy path
          </ContextMenuItem>
        )}
        {(onTogglePinProject || onCopyPath) && (onStopProject || onCloseProject) && (
          <ContextMenuSeparator />
        )}
        {showStop && onStopProject && (
          <ContextMenuItem destructive onClick={() => onStopProject(project.id)}>
            <Square className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Stop all agents
          </ContextMenuItem>
        )}
        {onCloseProject && !project.isActive && (
          <ContextMenuItem destructive onClick={() => onCloseProject(project.id)}>
            <X className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Remove project
          </ContextMenuItem>
        )}
        {project.isMissing && onLocateProject && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onLocateProject(project.id)}>
              <FolderOpen className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              Locate folder
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface GroupAssignmentPanelProps {
  projectId: string;
  groups: ProjectGroup[];
  onAssign: (projectId: string, groupId: string) => void;
  onRemoveFromGroup: (projectId: string) => void;
  onCreate: (name: string) => string;
  onClose: () => void;
}

function GroupAssignmentPanel({
  projectId,
  groups,
  onAssign,
  onRemoveFromGroup,
  onCreate,
  onClose,
}: GroupAssignmentPanelProps) {
  const [newGroupName, setNewGroupName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const currentGroup = groups.find((g) => g.projectIds.includes(projectId));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleCreate = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const groupId = onCreate(name);
    onAssign(projectId, groupId);
    onClose();
  };

  return (
    <div className="p-2 space-y-1">
      <div className="px-2 py-1 text-[10px] font-medium tracking-wider uppercase text-canopy-text/40 select-none flex items-center justify-between">
        <span>Assign to Group</span>
        <button
          type="button"
          onClick={onClose}
          className="p-0.5 rounded hover:bg-tint/[0.06] text-canopy-text/50 hover:text-canopy-text/80 cursor-pointer"
          aria-label="Close group assignment"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          onClick={() => {
            if (currentGroup?.id === group.id) {
              onRemoveFromGroup(projectId);
            } else {
              onAssign(projectId, group.id);
            }
            onClose();
          }}
          className={cn(
            "w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-md)] text-left text-sm transition-colors cursor-pointer",
            currentGroup?.id === group.id
              ? "bg-canopy-accent/10 text-canopy-accent"
              : "text-canopy-text/70 hover:bg-overlay-soft hover:text-canopy-text"
          )}
        >
          {currentGroup?.id === group.id ? (
            <Check className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <Layers className="w-3.5 h-3.5 shrink-0 opacity-50" />
          )}
          <span className="truncate">{group.name}</span>
          <span className="ml-auto text-[10px] text-canopy-text/40">{group.projectIds.length}</span>
        </button>
      ))}

      {currentGroup && (
        <button
          type="button"
          onClick={() => {
            onRemoveFromGroup(projectId);
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-md)] text-left text-sm text-canopy-text/50 hover:bg-overlay-soft hover:text-canopy-text transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5 shrink-0" />
          <span>Remove from group</span>
        </button>
      )}

      <div className="pt-1 border-t border-tint/[0.08]">
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCreate();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
              e.stopPropagation();
            }}
            placeholder="New group name..."
            className="flex-1 px-2 py-1.5 text-sm bg-transparent border border-border-subtle rounded-[var(--radius-md)] text-canopy-text placeholder:text-canopy-text/30 focus:outline-none focus:border-canopy-accent"
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={!newGroupName.trim()}
            className="p-1.5 rounded-[var(--radius-md)] text-canopy-text/50 hover:bg-overlay-soft hover:text-canopy-text disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
            aria-label="Create group"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface GroupHeaderProps {
  section: SwitcherSection;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRename?: (name: string) => void;
  onDelete?: () => void;
  isFirst: boolean;
  isLast: boolean;
}

function GroupHeader({
  section,
  isCollapsed,
  onToggleCollapse,
  onMoveUp,
  onMoveDown,
  onRename,
  onDelete,
  isFirst,
  isLast,
}: GroupHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(section.label ?? "");
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) editRef.current?.focus();
  }, [isEditing]);

  const handleSaveEdit = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== section.label && onRename) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  return (
    <div className="group/header flex items-center gap-1 px-3 py-1">
      <button
        type="button"
        tabIndex={-1}
        onClick={onToggleCollapse}
        className="p-0.5 rounded text-canopy-text/40 hover:text-canopy-text/70 transition-colors cursor-pointer"
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? "Expand group" : "Collapse group"}
      >
        {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>

      {isEditing ? (
        <input
          ref={editRef}
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSaveEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setIsEditing(false);
              setEditName(section.label ?? "");
            }
            e.stopPropagation();
          }}
          onBlur={handleSaveEdit}
          className="flex-1 min-w-0 px-1 py-0 text-[10px] font-medium tracking-wider uppercase bg-transparent text-canopy-text/60 border-b border-canopy-accent focus:outline-none"
        />
      ) : (
        <span className="text-[10px] font-medium tracking-wider uppercase text-canopy-text/40 select-none truncate">
          {section.label}
        </span>
      )}

      <span className="text-[9px] text-canopy-text/30 select-none ml-0.5">
        {section.items.length}
      </span>

      <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity">
        {onMoveUp && !isFirst && (
          <button
            type="button"
            tabIndex={-1}
            onClick={onMoveUp}
            className="p-0.5 rounded text-canopy-text/40 hover:text-canopy-text/70 hover:bg-tint/[0.06] transition-colors cursor-pointer"
            aria-label="Move group up"
          >
            <ChevronUp className="w-3 h-3" />
          </button>
        )}
        {onMoveDown && !isLast && (
          <button
            type="button"
            tabIndex={-1}
            onClick={onMoveDown}
            className="p-0.5 rounded text-canopy-text/40 hover:text-canopy-text/70 hover:bg-tint/[0.06] transition-colors cursor-pointer"
            aria-label="Move group down"
          >
            <ChevronDown className="w-3 h-3" />
          </button>
        )}
        {onRename && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => {
              setEditName(section.label ?? "");
              setIsEditing(true);
            }}
            className="p-0.5 rounded text-canopy-text/40 hover:text-canopy-text/70 hover:bg-tint/[0.06] transition-colors cursor-pointer"
            aria-label="Rename group"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            tabIndex={-1}
            onClick={onDelete}
            className="p-0.5 rounded text-canopy-text/40 hover:text-status-error hover:bg-status-error/10 transition-colors cursor-pointer"
            aria-label="Delete group"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

interface ProjectListContentProps {
  results: SearchableProject[];
  selectedIndex: number;
  query: string;
  onSelect: (project: SearchableProject) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  groups?: ProjectGroup[];
  onAssignProjectToGroup?: (projectId: string, groupId: string) => void;
  onRemoveProjectFromGroup?: (projectId: string) => void;
  onCreateGroup?: (name: string) => string;
  onRenameGroup?: (groupId: string, name: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onMoveGroupUp?: (groupId: string) => void;
  onMoveGroupDown?: (groupId: string) => void;
  onHoverProject?: (project: SearchableProject) => void;
}

function ProjectListContent({
  results,
  selectedIndex,
  query,
  onSelect,
  listRef,
  onStopProject,
  onCloseProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
  groups,
  onAssignProjectToGroup,
  onRemoveProjectFromGroup,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveGroupUp,
  onMoveGroupDown,
  onHoverProject,
}: ProjectListContentProps) {
  const isSearching = query.trim().length > 0;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [assigningProjectId, setAssigningProjectId] = useState<string | null>(null);
  const hasGroups = groups && groups.length > 0;

  const sections = useMemo(() => {
    if (isSearching || results.length === 0) return null;
    if (hasGroups) {
      return buildSwitcherSections(results, groups);
    }
    const pinned = results.filter((p) => p.isPinned && !p.isActive);
    const current = results.filter((p) => p.isActive);
    const remaining = results.filter((p) => !p.isActive && !p.isPinned);
    const isRunning = (p: SearchableProject) =>
      p.activeAgentCount > 0 || p.waitingAgentCount > 0 || p.processCount > 0 || p.isBackground;
    const running = remaining.filter(isRunning);
    const recent = remaining.filter((p) => !isRunning(p));
    return [
      { key: "pinned", label: "Pinned", isUserGroup: false, items: pinned },
      { key: "current", label: null, isUserGroup: false, items: current },
      { key: "running", label: "Running", isUserGroup: false, items: running },
      { key: "recent", label: "Recent", isUserGroup: false, items: recent },
    ].filter((s) => s.items.length > 0) as SwitcherSection[];
  }, [results, isSearching, hasGroups, groups]);

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const userGroupSections = useMemo(() => {
    if (!sections) return [];
    return sections.filter((s) => s.isUserGroup);
  }, [sections]);
  const userGroupCount = userGroupSections.length;

  const renderItem = (project: SearchableProject) => {
    const index = results.indexOf(project);
    return (
      <div key={project.id} role="presentation" className="flex items-center">
        <div className="flex-1 min-w-0">
          <ProjectListItem
            project={project}
            index={index}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
            onStopProject={onStopProject}
            onCloseProject={onCloseProject}
            onLocateProject={onLocateProject}
            onTogglePinProject={onTogglePinProject}
            onCopyPath={onCopyPath}
            onHoverProject={onHoverProject}
          />
        </div>
        {onAssignProjectToGroup && onCreateGroup && onRemoveProjectFromGroup && (
          <div
            className={cn(
              "shrink-0 transition-opacity",
              index === selectedIndex ? "opacity-100" : "opacity-0 hover:opacity-100"
            )}
          >
            <Popover
              open={assigningProjectId === project.id}
              onOpenChange={(open) => setAssigningProjectId(open ? project.id : null)}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAssigningProjectId(assigningProjectId === project.id ? null : project.id);
                  }}
                  className={cn(
                    "p-0.5 mr-2 rounded transition-colors cursor-pointer",
                    "text-canopy-text/50 hover:bg-tint/[0.06] hover:text-canopy-text/80",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                  )}
                  aria-label="Assign to group"
                >
                  <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-56 p-0"
                align="end"
                side="right"
                sideOffset={4}
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                <GroupAssignmentPanel
                  projectId={project.id}
                  groups={groups ?? []}
                  onAssign={onAssignProjectToGroup}
                  onRemoveFromGroup={onRemoveProjectFromGroup}
                  onCreate={onCreateGroup}
                  onClose={() => setAssigningProjectId(null)}
                />
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div ref={listRef} id="project-list" role="listbox" aria-label="Projects">
        {results.length === 0 ? (
          <div className="p-2">
            <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
              {query.trim() ? <div>{`No projects match "${query}"`}</div> : "No projects available"}
            </div>
          </div>
        ) : sections ? (
          sections.map((section, sectionIdx) => {
            const isActiveSection = !section.isUserGroup && section.items[0]?.isActive;
            const isLast = sectionIdx === sections.length - 1;
            const isSectionCollapsed = collapsed.has(section.key);
            const userGroupIdx = section.isUserGroup ? userGroupSections.indexOf(section) : -1;

            return (
              <div key={section.key}>
                {sectionIdx > 0 && <div className="h-[3px] bg-tint/[0.08]" />}
                <div
                  className={cn(
                    "px-2 py-1.5",
                    sectionIdx === 0 && "pt-2",
                    isLast && "pb-2",
                    isActiveSection && "bg-overlay-subtle"
                  )}
                >
                  {section.isUserGroup && section.label ? (
                    <GroupHeader
                      section={section}
                      isCollapsed={isSectionCollapsed}
                      onToggleCollapse={() => toggleCollapse(section.key)}
                      onMoveUp={onMoveGroupUp ? () => onMoveGroupUp(section.key) : undefined}
                      onMoveDown={onMoveGroupDown ? () => onMoveGroupDown(section.key) : undefined}
                      onRename={
                        onRenameGroup
                          ? (name: string) => onRenameGroup(section.key, name)
                          : undefined
                      }
                      onDelete={onDeleteGroup ? () => onDeleteGroup(section.key) : undefined}
                      isFirst={userGroupIdx === 0}
                      isLast={userGroupIdx === userGroupCount - 1}
                    />
                  ) : (
                    section.label && (
                      <div className="px-3 py-1 text-[10px] font-medium tracking-wider uppercase text-canopy-text/40 select-none">
                        {section.label}
                      </div>
                    )
                  )}
                  {!isSectionCollapsed && section.items.map(renderItem)}
                </div>
              </div>
            );
          })
        ) : (
          <div className="p-2">
            {results.map((project, index) => (
              <div key={project.id} role="presentation">
                <ProjectListItem
                  project={project}
                  index={index}
                  selectedIndex={selectedIndex}
                  onSelect={onSelect}
                  onStopProject={onStopProject}
                  onCloseProject={onCloseProject}
                  onLocateProject={onLocateProject}
                  onTogglePinProject={onTogglePinProject}
                  onCopyPath={onCopyPath}
                  onHoverProject={onHoverProject}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const KBD_CLASS = "px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60";

function ProjectSwitcherFooter() {
  const modifiers = useModifierKeys();

  const hint = modifiers.alt
    ? { keys: "⌥↵", label: "Background" }
    : modifiers.meta
      ? { keys: "⌘↵", label: "New window" }
      : { keys: "↵", label: "Switch" };

  return (
    <div className="w-full flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span>
          <kbd className={KBD_CLASS}>{hint.keys}</kbd>
          <span className="ml-1.5">{hint.label}</span>
        </span>
        <span className="text-canopy-text/30">
          <kbd className={KBD_CLASS}>⌘⌫</kbd>
          <span className="ml-1.5">Remove</span>
        </span>
      </div>
      <span className="text-canopy-text/30">
        <span>Right-click for more</span>
      </span>
    </div>
  );
}

const PALETTE_WIDTH = "w-[484px] max-w-[calc(100vw-2rem)]";
const PALETTE_MAX_HEIGHT = "max-h-[60vh]";

interface ProjectPaletteInnerProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  results: SearchableProject[];
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onSelect: (project: SearchableProject) => void;
  onSelectBackground?: (project: SearchableProject) => void;
  onClose: () => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onAddProject?: () => void;
  onCreateFolder?: () => void;
  onOpenProjectSettings?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  groups?: ProjectGroup[];
  onAssignProjectToGroup?: (projectId: string, groupId: string) => void;
  onRemoveProjectFromGroup?: (projectId: string) => void;
  onCreateGroup?: (name: string) => string;
  onRenameGroup?: (groupId: string, name: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onMoveGroupUp?: (groupId: string) => void;
  onMoveGroupDown?: (groupId: string) => void;
  onHoverProject?: (project: SearchableProject) => void;
}

function ProjectPaletteInner({
  inputRef,
  listRef,
  query,
  results,
  selectedIndex,
  onQueryChange,
  onSelect,
  onSelectBackground,
  onClose,
  onSelectPrevious,
  onSelectNext,
  onAddProject,
  onCreateFolder,
  onOpenProjectSettings,
  onStopProject,
  onCloseProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
  groups,
  onAssignProjectToGroup,
  onRemoveProjectFromGroup,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveGroupUp,
  onMoveGroupDown,
  onHoverProject,
}: ProjectPaletteInnerProps) {
  const projectSwitcherShortcut = useKeybindingDisplay("project.switcherPalette");

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && selectedIndex < results.length) {
      const selectedItem = listRef.current.querySelector(
        `#project-option-${results[selectedIndex].id}`
      );
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: "nearest" });
      }
    }
  }, [listRef, selectedIndex, results]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          onSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          onSelectNext();
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
            const selected = results[selectedIndex];
            if (e.altKey && onSelectBackground) {
              onSelectBackground(selected);
            } else {
              onSelect(selected);
            }
          }
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        case "Backspace":
          if (
            (e.metaKey || e.ctrlKey) &&
            onCloseProject &&
            results.length > 0 &&
            selectedIndex >= 0 &&
            selectedIndex < results.length
          ) {
            e.preventDefault();
            e.stopPropagation();
            onCloseProject(results[selectedIndex].id);
          }
          break;
      }
    },
    [
      results,
      selectedIndex,
      onSelectPrevious,
      onSelectNext,
      onSelect,
      onSelectBackground,
      onClose,
      onCloseProject,
    ]
  );

  const activeResult = results[selectedIndex];

  return (
    <>
      <AppPaletteDialog.Header
        label="Switch Project"
        keyHint={projectSwitcherShortcut}
        className="pb-2"
      >
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search projects..."
          role="combobox"
          aria-expanded={true}
          aria-haspopup="listbox"
          aria-label="Search projects"
          aria-controls="project-list"
          aria-activedescendant={activeResult ? `project-option-${activeResult.id}` : undefined}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body maxHeight={PALETTE_MAX_HEIGHT} className="p-0">
        <ProjectListContent
          results={results}
          selectedIndex={selectedIndex}
          query={query}
          onSelect={onSelect}
          listRef={listRef}
          onStopProject={onStopProject}
          onCloseProject={onCloseProject}
          onLocateProject={onLocateProject}
          onTogglePinProject={onTogglePinProject}
          onCopyPath={onCopyPath}
          groups={groups}
          onAssignProjectToGroup={onAssignProjectToGroup}
          onRemoveProjectFromGroup={onRemoveProjectFromGroup}
          onCreateGroup={onCreateGroup}
          onRenameGroup={onRenameGroup}
          onDeleteGroup={onDeleteGroup}
          onMoveGroupUp={onMoveGroupUp}
          onMoveGroupDown={onMoveGroupDown}
          onHoverProject={onHoverProject}
        />
      </AppPaletteDialog.Body>

      {(onOpenProjectSettings || onAddProject || onCreateFolder) && (
        <>
          <div className="h-[3px] bg-tint/[0.08]" />
          <div className="px-2 pt-1 pb-2">
            {onOpenProjectSettings && (
              <button
                type="button"
                onClick={() => onOpenProjectSettings()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] bg-tint/[0.04] text-muted-foreground">
                  <Settings2 className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">
                  Project Settings...
                </span>
              </button>
            )}
            {onAddProject && (
              <button
                type="button"
                onClick={() => onAddProject()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
                data-testid="project-add-button"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <Plus className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">Add Project...</span>
              </button>
            )}
            {onCreateFolder && (
              <button
                type="button"
                onClick={() => onCreateFolder()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <FolderPlus className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">
                  Create New Folder...
                </span>
              </button>
            )}
          </div>
        </>
      )}

      <AppPaletteDialog.Footer>
        <ProjectSwitcherFooter />
      </AppPaletteDialog.Footer>
    </>
  );
}

function ModalContent({
  isOpen,
  onClose,
  ...innerProps
}: Omit<ProjectSwitcherPaletteProps, "mode" | "children" | "dropdownAlign">) {
  useOverlayState(isOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (previousFocusRef.current) {
      if (!usePaletteStore.getState().activePaletteId) {
        previousFocusRef.current.focus();
      }
      previousFocusRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusableElements = dialogRef.current.querySelectorAll<HTMLElement>(
          'input, button, [tabindex]:not([tabindex="-1"])'
        );
        const firstEl = focusableElements[0];
        const lastEl = focusableElements[focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl?.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl?.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[15vh] bg-scrim-medium backdrop-blur-sm backdrop-saturate-[var(--theme-material-saturation)]"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Project switcher"
    >
      <div
        ref={dialogRef}
        className={cn(
          PALETTE_WIDTH,
          "mx-4 surface-overlay shadow-overlay rounded-[var(--radius-lg)] overflow-hidden",
          "animate-in fade-in slide-in-from-top-4 duration-150"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <ProjectPaletteInner
          inputRef={inputRef}
          listRef={listRef}
          query={innerProps.query}
          results={innerProps.results}
          selectedIndex={innerProps.selectedIndex}
          onQueryChange={innerProps.onQueryChange}
          onSelect={innerProps.onSelect}
          onClose={onClose}
          onSelectPrevious={innerProps.onSelectPrevious}
          onSelectNext={innerProps.onSelectNext}
          onAddProject={innerProps.onAddProject}
          onCreateFolder={innerProps.onCreateFolder}
          onOpenProjectSettings={innerProps.onOpenProjectSettings}
          onStopProject={innerProps.onStopProject}
          onCloseProject={innerProps.onCloseProject}
          onLocateProject={innerProps.onLocateProject}
          onTogglePinProject={innerProps.onTogglePinProject}
          onCopyPath={innerProps.onCopyPath}
          onSelectBackground={innerProps.onSelectBackground}
          groups={innerProps.groups}
          onAssignProjectToGroup={innerProps.onAssignProjectToGroup}
          onRemoveProjectFromGroup={innerProps.onRemoveProjectFromGroup}
          onCreateGroup={innerProps.onCreateGroup}
          onRenameGroup={innerProps.onRenameGroup}
          onDeleteGroup={innerProps.onDeleteGroup}
          onMoveGroupUp={innerProps.onMoveGroupUp}
          onMoveGroupDown={innerProps.onMoveGroupDown}
          onHoverProject={innerProps.onHoverProject}
        />
      </div>
    </div>,
    document.body
  );
}

function DropdownContent({
  isOpen,
  onClose,
  dropdownAlign = "start",
  children,
  ...innerProps
}: Omit<ProjectSwitcherPaletteProps, "mode">) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const overlayCount = useUIStore((state) => state.overlayCount);
  const prevOverlayCountRef = useRef<number>(overlayCount);
  const focusRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    focusRafRef.current = requestAnimationFrame(() => {
      inputRef.current?.focus();
      focusRafRef.current = null;
    });
    return () => {
      if (focusRafRef.current !== null) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = null;
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && overlayCount > prevOverlayCountRef.current && overlayCount > 0) {
      onClose();
    }
    prevOverlayCountRef.current = overlayCount;
  }, [isOpen, overlayCount, onClose]);

  return (
    <Popover open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className={cn(PALETTE_WIDTH, "p-0")}
        data-testid="project-switcher-palette"
        align={dropdownAlign}
        sideOffset={8}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <ProjectPaletteInner
          inputRef={inputRef}
          listRef={listRef}
          query={innerProps.query}
          results={innerProps.results}
          selectedIndex={innerProps.selectedIndex}
          onQueryChange={innerProps.onQueryChange}
          onSelect={innerProps.onSelect}
          onClose={onClose}
          onSelectPrevious={innerProps.onSelectPrevious}
          onSelectNext={innerProps.onSelectNext}
          onAddProject={innerProps.onAddProject}
          onCreateFolder={innerProps.onCreateFolder}
          onOpenProjectSettings={innerProps.onOpenProjectSettings}
          onStopProject={innerProps.onStopProject}
          onCloseProject={innerProps.onCloseProject}
          onLocateProject={innerProps.onLocateProject}
          onTogglePinProject={innerProps.onTogglePinProject}
          onCopyPath={innerProps.onCopyPath}
          onSelectBackground={innerProps.onSelectBackground}
          groups={innerProps.groups}
          onAssignProjectToGroup={innerProps.onAssignProjectToGroup}
          onRemoveProjectFromGroup={innerProps.onRemoveProjectFromGroup}
          onCreateGroup={innerProps.onCreateGroup}
          onRenameGroup={innerProps.onRenameGroup}
          onDeleteGroup={innerProps.onDeleteGroup}
          onMoveGroupUp={innerProps.onMoveGroupUp}
          onMoveGroupDown={innerProps.onMoveGroupDown}
          onHoverProject={innerProps.onHoverProject}
        />
      </PopoverContent>
    </Popover>
  );
}

export function ProjectSwitcherPalette({
  isOpen,
  query,
  results,
  selectedIndex,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onClose,
  mode = "modal",
  onAddProject,
  onCreateFolder,
  onStopProject,
  onCloseProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
  onSelectBackground,
  onOpenProjectSettings,
  dropdownAlign,
  children,
  removeConfirmProject,
  onRemoveConfirmClose,
  onConfirmRemove,
  isRemovingProject = false,
  groups,
  onCreateGroup,
  onAssignProjectToGroup,
  onRemoveProjectFromGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveGroupUp,
  onMoveGroupDown,
  onHoverProject,
}: ProjectSwitcherPaletteProps) {
  const hasRunningProcesses = removeConfirmProject
    ? removeConfirmProject.processCount > 0 ||
      removeConfirmProject.activeAgentCount > 0 ||
      removeConfirmProject.waitingAgentCount > 0
    : false;

  const content =
    mode === "dropdown" ? (
      <DropdownContent
        isOpen={isOpen}
        query={query}
        results={results}
        selectedIndex={selectedIndex}
        onQueryChange={onQueryChange}
        onSelectPrevious={onSelectPrevious}
        onSelectNext={onSelectNext}
        onSelect={onSelect}
        onClose={onClose}
        onAddProject={onAddProject}
        onCreateFolder={onCreateFolder}
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
        onLocateProject={onLocateProject}
        onTogglePinProject={onTogglePinProject}
        onCopyPath={onCopyPath}
        onSelectBackground={onSelectBackground}
        onOpenProjectSettings={onOpenProjectSettings}
        dropdownAlign={dropdownAlign}
        groups={groups}
        onCreateGroup={onCreateGroup}
        onAssignProjectToGroup={onAssignProjectToGroup}
        onRemoveProjectFromGroup={onRemoveProjectFromGroup}
        onRenameGroup={onRenameGroup}
        onDeleteGroup={onDeleteGroup}
        onMoveGroupUp={onMoveGroupUp}
        onMoveGroupDown={onMoveGroupDown}
        onHoverProject={onHoverProject}
      >
        {children}
      </DropdownContent>
    ) : (
      <ModalContent
        isOpen={isOpen}
        query={query}
        results={results}
        selectedIndex={selectedIndex}
        onQueryChange={onQueryChange}
        onSelectPrevious={onSelectPrevious}
        onSelectNext={onSelectNext}
        onSelect={onSelect}
        onClose={onClose}
        onAddProject={onAddProject}
        onCreateFolder={onCreateFolder}
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
        onLocateProject={onLocateProject}
        onTogglePinProject={onTogglePinProject}
        onCopyPath={onCopyPath}
        onSelectBackground={onSelectBackground}
        onOpenProjectSettings={onOpenProjectSettings}
        groups={groups}
        onCreateGroup={onCreateGroup}
        onAssignProjectToGroup={onAssignProjectToGroup}
        onRemoveProjectFromGroup={onRemoveProjectFromGroup}
        onRenameGroup={onRenameGroup}
        onDeleteGroup={onDeleteGroup}
        onMoveGroupUp={onMoveGroupUp}
        onMoveGroupDown={onMoveGroupDown}
        onHoverProject={onHoverProject}
      />
    );

  return (
    <>
      {content}
      {removeConfirmProject && onRemoveConfirmClose && onConfirmRemove && (
        <ConfirmDialog
          isOpen={true}
          onClose={isRemovingProject ? undefined : onRemoveConfirmClose}
          title={removeConfirmProject.isActive ? "Close Project?" : "Remove Project from List?"}
          zIndex="nested"
          confirmLabel={removeConfirmProject.isActive ? "Close Project" : "Remove Project"}
          cancelLabel="Cancel"
          onConfirm={onConfirmRemove}
          isConfirmLoading={isRemovingProject}
          variant="destructive"
        >
          <div className="space-y-3">
            <div>
              <div className="font-medium text-sm">{removeConfirmProject.name}</div>
              <div className="text-xs text-canopy-text/50 font-mono mt-1">
                {removeConfirmProject.path}
              </div>
            </div>
            {removeConfirmProject.isActive
              ? hasRunningProcesses && (
                  <div className="rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20 px-3 py-2 text-xs text-status-warning">
                    <div className="font-medium">
                      Warning: All running processes will be terminated
                    </div>
                    <div className="mt-1 text-status-warning/80">
                      {removeConfirmProject.processCount > 0 && (
                        <div>• {removeConfirmProject.processCount} running process(es)</div>
                      )}
                      {removeConfirmProject.activeAgentCount > 0 && (
                        <div>• {removeConfirmProject.activeAgentCount} active agent(s)</div>
                      )}
                      {removeConfirmProject.waitingAgentCount > 0 && (
                        <div>• {removeConfirmProject.waitingAgentCount} waiting agent(s)</div>
                      )}
                    </div>
                  </div>
                )
              : hasRunningProcesses && (
                  <div className="rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20 px-3 py-2 text-xs text-status-warning">
                    <div className="font-medium">Warning: Active sessions detected</div>
                    <div className="mt-1 text-status-warning/80">
                      {removeConfirmProject.processCount > 0 && (
                        <div>• {removeConfirmProject.processCount} running process(es)</div>
                      )}
                      {removeConfirmProject.activeAgentCount > 0 && (
                        <div>• {removeConfirmProject.activeAgentCount} active agent(s)</div>
                      )}
                      {removeConfirmProject.waitingAgentCount > 0 && (
                        <div>• {removeConfirmProject.waitingAgentCount} waiting agent(s)</div>
                      )}
                    </div>
                  </div>
                )}
            <div className="text-xs text-canopy-text/60">
              {removeConfirmProject.isActive
                ? "The project will remain in your list and can be reopened at any time."
                : "This project will be removed from your list. You can add it back later, but any running terminals or processes will need to be restarted."}
            </div>
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
