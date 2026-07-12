import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import {
  ArchiveX,
  BellOff,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Square,
  Trash2,
  X,
  AppWindow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formatTimeAgo } from "@/utils/timeAgo";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useModifierKeys } from "@/hooks/useModifierKeys";
import { useOverlayClaim } from "@/hooks";
// Leaf import, not the `@/hooks` barrel: several palette suites mock that barrel
// and would throw on an export they don't list.
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { defaultScratchName } from "@shared/utils/scratchName";
import type {
  ProjectSwitcherMode,
  SearchableProject,
  SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";
import { useUIStore } from "@/store/uiStore";
import {
  useProjectSettingsStore,
  areProjectNotificationsMuted,
} from "@/store/projectSettingsStore";
import {
  SCRATCH_CLEANUP_TTL_MS,
  SCRATCH_CLEANUP_COUNTDOWN_VISIBLE_DAYS,
} from "@shared/config/scratchCleanup";

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
  onCloneRepo?: () => void;
  onCreateFolder?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onFreeMemoryProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  /** Pointer-enter callback used to schedule a hover prefetch of the project's hydrate payload. */
  onHoverProject?: (projectId: string, pointerType: string) => void;
  /** Pointer-leave callback used to cancel a pending hover prefetch. */
  onHoverProjectEnd?: (pointerType: string) => void;
  onOpenProjectSettings?: () => void;
  dropdownAlign?: "start" | "center" | "end";
  /**
   * Fired when the dropdown's Popover restores focus to its trigger on close.
   * Lets the trigger (e.g. ProjectSwitcher) suppress a Radix Tooltip from
   * reopening on the refocused trigger after a project switch. Dropdown-only.
   */
  onDropdownCloseAutoFocus?: () => void;
  children?: React.ReactNode;
  removeConfirmProject?: SearchableProject | null;
  onRemoveConfirmClose?: () => void;
  onConfirmRemove?: () => void;
  isRemovingProject?: boolean;
  /** Frozen snapshot of the project pending a "Free memory" confirm, or null. */
  freeMemoryConfirmProject?: SearchableProject | null;
  onFreeMemoryConfirmClose?: () => void;
  onConfirmFreeMemory?: () => void;
  isFreeingMemory?: boolean;
  /** Scratch (one-off agent workspace) results — rendered in their own collapsible section. */
  scratchResults?: SearchableScratch[];
  /** Callback to create and switch to a new scratch. A blank name takes the default. */
  onCreateScratch?: (name?: string) => void;
  /** Callback to switch to an existing scratch. */
  onSelectScratch?: (scratch: SearchableScratch) => void;
  /** Callback to remove a scratch. */
  onRemoveScratch?: (scratchId: string) => void;
  /** Callback to rename a scratch in place. */
  onRenameScratch?: (scratchId: string, name: string) => void;
  /** Callback to save a scratch as a regular project (copy + register). */
  onSaveAsProject?: (scratchId: string) => void;
  /**
   * "Delete original?" follow-up after a successful Save-as-Project copy.
   * Surfaced as a top-level ConfirmDialog above the palette.
   */
  saveAsProjectConfirm?: {
    scratch: SearchableScratch;
    project: { name: string; path: string };
  } | null;
  onDismissSaveAsProjectConfirm?: () => void;
  onConfirmDeleteOriginalScratch?: () => void;
  isDeletingOriginalScratch?: boolean;
}

interface ProjectListItemProps {
  project: SearchableProject;
  isSelected: boolean;
  onSelect: (project: SearchableProject) => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onFreeMemoryProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  onHoverProject?: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd?: (pointerType: string) => void;
}

function StatusDot({ project }: { project: SearchableProject }) {
  const hasActive = project.activeAgentCount > 0;
  const hasWaiting = project.waitingAgentCount > 0;
  const hasProcesses = project.processCount > 0;

  if (hasActive) {
    return (
      <div
        className="w-1.5 h-1.5 rounded-full bg-activity-active animate-activity-pulse shrink-0"
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
  return (
    <div
      className="w-1.5 h-1.5 rounded-full border border-daintree-text/20 shrink-0"
      aria-label="Idle"
    />
  );
}

function ProjectListItem({
  project,
  isSelected,
  onSelect,
  onStopProject,
  onCloseProject,
  onFreeMemoryProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
  onHoverProject,
  onHoverProjectEnd,
}: ProjectListItemProps) {
  const showStop = project.processCount > 0 && !project.isMissing;
  // "Free memory" reclaims a backgrounded project's resident RAM. Only
  // meaningful for non-active, non-missing projects that still hold resources
  // (the active project owns the live renderer; a missing one has nothing
  // loaded; an already-closed one was reclaimed, so the action would no-op).
  const showFreeMemory = !project.isActive && !project.isMissing && project.status !== "closed";

  const notificationOverrides = useProjectSettingsStore(
    (state) => state.notificationOverridesByProjectId[project.id]
  );
  const isProjectNotificationsMuted = areProjectNotificationsMuted(notificationOverrides);

  const { secondaryText, secondaryClass } = (() => {
    if (project.isMissing)
      return { secondaryText: "Directory not found", secondaryClass: "text-status-warning/70" };
    if (project.activeAgentCount > 0)
      return { secondaryText: "Agent working\u2026", secondaryClass: "text-activity-working" };
    if (project.waitingAgentCount > 0)
      return { secondaryText: "Agent waiting…", secondaryClass: "text-activity-waiting" };
    // Auto-closed by the background-idle sweep (#10830) — surface the distinct
    // "parked" label instead of a plain time-ago so the user understands why the
    // project left active state and that reopening restores it.
    if (project.status === "closed" && project.autoParkedAt)
      return {
        secondaryText: "Suspended to free memory",
        secondaryClass: "text-daintree-text/50",
      };
    if (project.lastOpened > 0)
      return {
        secondaryText: formatTimeAgo(project.lastOpened),
        secondaryClass: "text-daintree-text/50",
      };
    return { secondaryText: project.displayPath, secondaryClass: "text-daintree-text/50" };
  })();

  const row = (
    <div
      id={`project-option-${project.id}`}
      role="option"
      aria-selected={isSelected}
      aria-disabled={project.isMissing || undefined}
      className={cn(
        "group relative w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border border-transparent",
        "aria-selected:before:absolute aria-selected:before:left-0 aria-selected:before:top-2 aria-selected:before:bottom-2 aria-selected:before:w-[2px] aria-selected:before:rounded-r aria-selected:before:bg-daintree-accent aria-selected:before:content-['']",
        project.isActive
          ? cn("text-daintree-text", isSelected && "bg-overlay-raised border-overlay")
          : project.isMissing
            ? cn(
                "text-daintree-text/50",
                isSelected ? "bg-overlay-raised border-overlay" : "hover:bg-overlay-subtle"
              )
            : isSelected
              ? "bg-overlay-raised border-overlay text-daintree-text cursor-pointer"
              : "text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text cursor-pointer"
      )}
      onClick={() => !project.isActive && !project.isMissing && onSelect(project)}
      onPointerEnter={onHoverProject ? (e) => onHoverProject(project.id, e.pointerType) : undefined}
      onPointerLeave={onHoverProjectEnd ? (e) => onHoverProjectEnd(e.pointerType) : undefined}
    >
      <StatusDot project={project} />

      <div
        className={cn(
          // Wash/shadow var fallbacks keep themes without the overrides byte-identical.
          "flex items-center justify-center rounded-[var(--radius-lg)] shadow-[var(--project-tile-shadow,inset_0_1px_2px_rgba(0,0,0,0.3))] shrink-0 transition duration-150",
          "h-8 w-8 text-base"
        )}
        style={{
          background: project.color
            ? `var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), ${getProjectGradient(project.color)}`
            : "var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), var(--color-daintree-sidebar)",
        }}
      >
        <span className="leading-none select-none filter drop-shadow-sm">{project.emoji}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center min-w-0">
          <span
            className={cn(
              "truncate text-sm font-semibold leading-tight",
              project.isActive || isSelected ? "text-daintree-text" : "text-daintree-text/85"
            )}
          >
            {project.name}
          </span>
          {isProjectNotificationsMuted && (
            <BellOff
              className="w-3.5 h-3.5 text-daintree-text/40 shrink-0 ml-1"
              aria-label="Notifications muted for this project"
            />
          )}
        </div>

        <div className="flex items-center min-w-0 mt-0.5">
          <span className={cn("truncate text-[11px] leading-none", secondaryClass)}>
            {secondaryText}
          </span>
        </div>
      </div>
    </div>
  );

  const hasContextActions =
    onTogglePinProject ||
    onStopProject ||
    onCloseProject ||
    onFreeMemoryProject ||
    onCopyPath ||
    onSelectNewWindow;
  if (!hasContextActions) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {onSelectNewWindow && !project.isActive && !project.isMissing && (
          <ContextMenuItem onSelect={() => onSelectNewWindow(project)}>
            <AppWindow className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Open in new window
          </ContextMenuItem>
        )}
        {onTogglePinProject && (
          <ContextMenuItem onSelect={() => onTogglePinProject(project.id)}>
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
          <ContextMenuItem onSelect={() => onCopyPath(project.path)}>
            <Clipboard className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Copy path
          </ContextMenuItem>
        )}
        {(onTogglePinProject || onCopyPath) &&
          (onStopProject || onFreeMemoryProject || onCloseProject) && <ContextMenuSeparator />}
        {showStop && onStopProject && (
          <ContextMenuItem destructive onSelect={() => onStopProject(project.id)}>
            <Square className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Stop all agents
          </ContextMenuItem>
        )}
        {showFreeMemory && onFreeMemoryProject && (
          <ContextMenuItem onSelect={() => onFreeMemoryProject(project.id)}>
            <ArchiveX className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Free memory
          </ContextMenuItem>
        )}
        {onCloseProject && project.isActive && (
          <ContextMenuItem destructive onSelect={() => onCloseProject(project.id)}>
            <X className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Close project
          </ContextMenuItem>
        )}
        {onCloseProject && !project.isActive && (
          <ContextMenuItem destructive onSelect={() => onCloseProject(project.id)}>
            <X className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Remove project
          </ContextMenuItem>
        )}
        {project.isMissing && onLocateProject && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onLocateProject(project.id)}>
              <FolderOpen className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              Locate folder
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface TemporalSection {
  key: string;
  label: string | null;
  items: SearchableProject[];
}

function getTemporalBucket(timestamp: number, todayStart: number, weekStart: number): string {
  if (timestamp >= todayStart) return "today";
  if (timestamp >= weekStart) return "this-week";
  return "older";
}

interface ProjectListContentProps {
  results: SearchableProject[];
  selectedIndex: number;
  query: string;
  onSelect: (project: SearchableProject) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  mode?: ProjectSwitcherMode;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onFreeMemoryProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  onHoverProject?: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd?: (pointerType: string) => void;
}

function ProjectListContent({
  results,
  selectedIndex,
  query,
  onSelect,
  listRef,
  mode,
  onStopProject,
  onCloseProject,
  onFreeMemoryProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
  onHoverProject,
  onHoverProjectEnd,
}: ProjectListContentProps) {
  const isSearching = query.trim().length > 0;

  const sections = useMemo<TemporalSection[] | null>(() => {
    if (isSearching || results.length === 0 || mode === "modal") return null;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - mondayOffset
    ).getTime();

    const current = results.filter((p) => p.isActive);
    const pinned = results.filter((p) => p.isPinned && !p.isActive);
    const remaining = results.filter((p) => !p.isActive && !p.isPinned);

    const buckets: Record<string, SearchableProject[]> = {
      today: [],
      "this-week": [],
      older: [],
    };
    for (const p of remaining) {
      buckets[getTemporalBucket(p.lastOpened, todayStart, weekStart)]!.push(p);
    }

    return [
      current.length > 0 ? { key: "current", label: null, items: current } : null,
      pinned.length > 0 ? { key: "pinned", label: "Pinned", items: pinned } : null,
      buckets.today!.length > 0 ? { key: "today", label: "Today", items: buckets.today! } : null,
      buckets["this-week"]!.length > 0
        ? { key: "this-week", label: "This Week", items: buckets["this-week"]! }
        : null,
      buckets.older!.length > 0 ? { key: "older", label: "Older", items: buckets.older! } : null,
    ].filter((s): s is TemporalSection => s !== null);
  }, [results, isSearching, mode]);

  // `results` is already scoped by the hook to exactly the rows this mode
  // renders, so it doubles as the arrow-key domain. Never re-filter it here:
  // a second, narrower array is what stranded the highlight and let Enter
  // commit an off-screen project (#11071).
  const selectedProjectId = results[selectedIndex]?.id;

  const renderItem = (project: SearchableProject) => {
    return (
      <div key={project.id} role="presentation">
        <ProjectListItem
          project={project}
          isSelected={project.id === selectedProjectId}
          onSelect={onSelect}
          onStopProject={onStopProject}
          onCloseProject={onCloseProject}
          onFreeMemoryProject={onFreeMemoryProject}
          onLocateProject={onLocateProject}
          onTogglePinProject={onTogglePinProject}
          onCopyPath={onCopyPath}
          onSelectNewWindow={onSelectNewWindow}
          onHoverProject={onHoverProject}
          onHoverProjectEnd={onHoverProjectEnd}
        />
      </div>
    );
  };

  return (
    <>
      <div ref={listRef} id="project-list" role="listbox" aria-label="Projects">
        {results.length === 0 ? (
          <div className="p-2">
            <div className="px-3 py-8 text-center text-daintree-text/50 text-sm">
              {query.trim() ? (
                <div>{`No projects match "${query}"`}</div>
              ) : mode === "modal" ? (
                "No active projects"
              ) : (
                "No projects available — add one below"
              )}
            </div>
          </div>
        ) : sections ? (
          sections.map((section, sectionIdx) => {
            const isActiveSection = section.items[0]?.isActive;
            const isLast = sectionIdx === sections.length - 1;

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
                  {section.label && (
                    <div className="px-3 py-1 text-[10px] font-medium tracking-wider uppercase text-daintree-text/40 select-none">
                      {section.label}
                    </div>
                  )}
                  {section.items.map(renderItem)}
                </div>
              </div>
            );
          })
        ) : (
          <div className="p-2">{results.map((project) => renderItem(project))}</div>
        )}
      </div>
    </>
  );
}

/**
 * Returns the cleanup-countdown microcopy when a scratch is within the
 * visibility window, otherwise null. Strings are hardcoded English (sentence
 * case, no period) per the project microcopy convention. The TTL constant is
 * imported from `shared/config/scratchCleanup` so the user-visible countdown
 * never drifts from the actual deletion threshold in `ScratchCleanupService`.
 */
export function formatScratchCleanupCountdown(lastOpened: number, now: number): string | null {
  if (!lastOpened) return null;
  const expiresAt = lastOpened + SCRATCH_CLEANUP_TTL_MS;
  const daysLeft = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
  if (daysLeft > SCRATCH_CLEANUP_COUNTDOWN_VISIBLE_DAYS) return null;
  if (daysLeft <= 0) return "Auto-cleanup today";
  if (daysLeft === 1) return "Auto-cleanup tomorrow";
  return `Auto-cleanup in ${daysLeft} days`;
}

interface ScratchNameEditorProps {
  initialValue: string;
  ariaLabel: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  testId: string;
}

/**
 * Inline name field for creating or renaming a scratch. Lives inside
 * `AppPaletteDialog`, whose document-level Escape backstop would otherwise close
 * the whole switcher — so Escape is both consumed here and claimed on the escape
 * stack. Enter is stopped for the same reason: the palette's own Enter handler
 * lives on the search input, but the backstop listens on document.
 */
function ScratchNameEditor({
  initialValue,
  ariaLabel,
  onCommit,
  onCancel,
  testId,
}: ScratchNameEditorProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Committing on blur would fire on Escape's focus restore too, resurrecting the
  // cancelled edit; explicit Enter is the only commit path.
  const committedRef = useRef(false);

  useEscapeStack(true, () => {
    if (committedRef.current) return;
    onCancel();
  });

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = useCallback(() => {
    committedRef.current = true;
    onCommit(value);
  }, [onCommit, value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    },
    [commit, onCancel]
  );

  return (
    <div className="w-full flex items-center gap-3 px-3 py-2 mt-1 rounded-[var(--radius-md)]">
      <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] bg-tint/[0.04] text-muted-foreground shrink-0">
        <FileText className="h-4 w-4" />
      </div>
      <input
        ref={inputRef}
        data-scratch-name-input=""
        data-testid={testId}
        type="text"
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        className="flex-1 min-w-0 bg-overlay-soft border border-[var(--border-overlay)] rounded-[var(--radius-md)] px-2 py-1 text-sm text-daintree-text outline-hidden focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
      />
    </div>
  );
}

type ScratchEditorState =
  | { kind: "create" }
  | { kind: "rename"; scratchId: string; name: string }
  | null;

interface ScratchSectionProps {
  scratches: SearchableScratch[];
  onCreate?: (name?: string) => void;
  onSelect?: (scratch: SearchableScratch) => void;
  onRemove?: (scratchId: string) => void;
  onRename?: (scratchId: string, name: string) => void;
  onSaveAsProject?: (scratchId: string) => void;
}

/**
 * Collapsible "Scratch" section. Defaults to collapsed when there are no
 * scratches yet — discoverable but quiet. Once the user has scratches,
 * defaults to expanded.
 *
 * Sort order is purely by `lastOpened` desc (the hook already does this).
 * Scratches deliberately do NOT participate in the project frecency ranking.
 */
function ScratchSection({
  scratches,
  onCreate,
  onSelect,
  onRemove,
  onRename,
  onSaveAsProject,
}: ScratchSectionProps) {
  const [collapsed, setCollapsed] = useState<boolean>(scratches.length === 0);
  const [editor, setEditor] = useState<ScratchEditorState>(null);
  // Radix restores focus to the context-menu trigger on close, but for a rename
  // that trigger has been swapped out for the editor — the restore would steal
  // focus from the input and blur-cancel the edit before it began.
  const suppressMenuFocusRestoreRef = useRef(false);
  const previousScratchCountRef = useRef(scratches.length);
  // `now` is captured per-render so the countdown updates whenever the
  // surrounding component re-renders. Refresh is naturally driven by store
  // updates (loadScratches on palette open, scratch:updated push events) —
  // an interval here would be wasteful given the daily granularity.
  const now = Date.now();

  // If a scratch was just created from the empty state, expand the section
  // so the new entry is visible.
  useEffect(() => {
    const previousScratchCount = previousScratchCountRef.current;
    previousScratchCountRef.current = scratches.length;

    if (previousScratchCount === 0 && scratches.length > 0) {
      setCollapsed(false);
    }
  }, [scratches.length]);

  // A rename target can vanish under the editor via a scratch:removed push.
  useEffect(() => {
    if (editor?.kind !== "rename") return;
    if (!scratches.some((s) => s.id === editor.scratchId)) {
      setEditor(null);
    }
  }, [editor, scratches]);

  const closeEditor = useCallback(() => setEditor(null), []);

  const handleCreateCommit = useCallback(
    (name: string) => {
      setEditor(null);
      onCreate?.(name);
    },
    [onCreate]
  );

  const handleRenameCommit = useCallback(
    (scratchId: string, previousName: string, name: string) => {
      setEditor(null);
      const trimmed = name.trim();
      if (!trimmed || trimmed === previousName) return;
      onRename?.(scratchId, trimmed);
    },
    [onRename]
  );

  const isCreating = editor?.kind === "create";

  return (
    <div className="px-2 py-1.5">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1 text-[10px] font-medium tracking-wider uppercase text-daintree-text/40 select-none hover:text-daintree-text/60 transition-colors"
        aria-expanded={!collapsed}
        aria-controls="scratch-section-list"
      >
        <span className="flex items-center gap-1.5">
          {collapsed ? (
            <ChevronRight className="w-3 h-3" aria-hidden="true" />
          ) : (
            <ChevronDown className="w-3 h-3" aria-hidden="true" />
          )}
          Scratch
        </span>
        {scratches.length > 0 && (
          <span className="text-[10px] tabular-nums">{scratches.length}</span>
        )}
      </button>
      {!collapsed && (
        <div id="scratch-section-list" className="mt-1">
          {scratches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-daintree-text/40">
              No scratch workspaces yet. Create one for a quick one-off task.
            </div>
          ) : (
            <div role="listbox" aria-label="Scratch workspaces">
              {scratches.map((scratch) => {
                const isRenaming = editor?.kind === "rename" && editor.scratchId === scratch.id;
                if (isRenaming) {
                  // Both the seed and the no-op comparison use the name frozen when
                  // editing began. Against the live name, an untouched editor would
                  // resubmit the old name and undo a rename that landed by push.
                  const originalName = editor.name;
                  return (
                    <ScratchNameEditor
                      key={scratch.id}
                      initialValue={originalName}
                      ariaLabel="Scratch name"
                      testId="scratch-rename-input"
                      onCommit={(name) => handleRenameCommit(scratch.id, originalName, name)}
                      onCancel={closeEditor}
                    />
                  );
                }

                const countdown = formatScratchCleanupCountdown(scratch.lastOpened, now);
                const hasContextActions = Boolean(onRemove || onSaveAsProject || onRename);
                return (
                  <ContextMenu key={scratch.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onSelect?.(scratch)}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors",
                          scratch.isActive ? "bg-overlay-subtle" : "hover:bg-overlay-subtle"
                        )}
                        role="option"
                        aria-selected={scratch.isActive}
                      >
                        <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] bg-tint/[0.04] text-muted-foreground shrink-0">
                          <FileText className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{scratch.name}</div>
                          <div className="text-xs text-daintree-text/40 truncate">
                            {formatTimeAgo(scratch.lastOpened)}
                          </div>
                          {countdown && (
                            <div
                              className="text-[11px] leading-none text-daintree-text/40 mt-0.5 truncate"
                              data-testid="scratch-cleanup-countdown"
                            >
                              {countdown}
                            </div>
                          )}
                        </div>
                      </button>
                    </ContextMenuTrigger>
                    {hasContextActions && (
                      <ContextMenuContent
                        onCloseAutoFocus={(e) => {
                          if (!suppressMenuFocusRestoreRef.current) return;
                          suppressMenuFocusRestoreRef.current = false;
                          e.preventDefault();
                        }}
                      >
                        {onRename && (
                          <ContextMenuItem
                            onSelect={() => {
                              suppressMenuFocusRestoreRef.current = true;
                              setEditor({
                                kind: "rename",
                                scratchId: scratch.id,
                                name: scratch.name,
                              });
                            }}
                          >
                            <Pencil className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                            Rename scratch
                          </ContextMenuItem>
                        )}
                        {onSaveAsProject && (
                          <ContextMenuItem onSelect={() => onSaveAsProject(scratch.id)}>
                            <FolderUp className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                            Save as project…
                          </ContextMenuItem>
                        )}
                        {(onSaveAsProject || onRename) && onRemove && <ContextMenuSeparator />}
                        {onRemove && (
                          <ContextMenuItem destructive onSelect={() => onRemove(scratch.id)}>
                            <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                            Delete scratch
                          </ContextMenuItem>
                        )}
                      </ContextMenuContent>
                    )}
                  </ContextMenu>
                );
              })}
            </div>
          )}
          {onCreate &&
            (isCreating ? (
              <ScratchNameEditor
                initialValue={defaultScratchName(new Date())}
                ariaLabel="Name for the new scratch workspace"
                testId="scratch-create-input"
                onCommit={handleCreateCommit}
                onCancel={closeEditor}
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditor({ kind: "create" })}
                className="w-full flex items-center gap-3 px-3 py-2 mt-1 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
                data-testid="scratch-create-button"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <Plus className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">
                  New scratch workspace
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function ProjectSwitcherFooter({ mode }: { mode?: ProjectSwitcherMode }) {
  const modifiers = useModifierKeys();

  const hint = modifiers.meta
    ? { keys: "⌘↵", label: "New window" }
    : { keys: "↵", label: "Switch" };

  return (
    <div className="w-full flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span>
          <kbd className={KBD_CLASS}>{hint.keys}</kbd>
          <span className="ml-1.5">{hint.label}</span>
        </span>
        {mode !== "modal" && (
          <span className="text-daintree-text/50">
            <kbd className={KBD_CLASS}>⌘⌫</kbd>
            <span className="ml-1.5">Remove</span>
          </span>
        )}
      </div>
      <span className="text-daintree-text/50">
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
  mode?: ProjectSwitcherMode;
  onQueryChange: (query: string) => void;
  onSelect: (project: SearchableProject) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  onClose: () => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onAddProject?: () => void;
  onCloneRepo?: () => void;
  onCreateFolder?: () => void;
  onOpenProjectSettings?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onFreeMemoryProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onHoverProject?: (projectId: string, pointerType: string) => void;
  onHoverProjectEnd?: (pointerType: string) => void;
  scratchResults?: SearchableScratch[];
  onCreateScratch?: (name?: string) => void;
  onSelectScratch?: (scratch: SearchableScratch) => void;
  onRemoveScratch?: (scratchId: string) => void;
  onRenameScratch?: (scratchId: string, name: string) => void;
  onSaveAsProject?: (scratchId: string) => void;
}

function ProjectPaletteInner({
  inputRef,
  listRef,
  query,
  results,
  selectedIndex,
  mode,
  onQueryChange,
  onSelect,
  onSelectNewWindow,
  onClose,
  onSelectPrevious,
  onSelectNext,
  onAddProject,
  onCloneRepo,
  onCreateFolder,
  onOpenProjectSettings,
  onStopProject,
  onCloseProject,
  onFreeMemoryProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
  onHoverProject,
  onHoverProjectEnd,
  scratchResults,
  onCreateScratch,
  onSelectScratch,
  onRemoveScratch,
  onRenameScratch,
  onSaveAsProject,
}: ProjectPaletteInnerProps) {
  const projectSwitcherShortcut = useEffectiveCombo("project.switcherPalette");

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && selectedIndex < results.length) {
      const selectedItem = listRef.current.querySelector(
        `#project-option-${results[selectedIndex]!.id}`
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
            const selected = results[selectedIndex]!;
            if (
              (e.metaKey || e.ctrlKey) &&
              onSelectNewWindow &&
              !selected.isActive &&
              !selected.isMissing
            ) {
              onSelectNewWindow(selected);
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
            onCloseProject(results[selectedIndex]!.id);
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
      onSelectNewWindow,
      onClose,
      onCloseProject,
    ]
  );

  const activeResult = results[selectedIndex];

  return (
    <>
      <AppPaletteDialog.Header
        label="Switch Project"
        shortcut={projectSwitcherShortcut}
        className="pb-2"
      >
        <AppPaletteDialog.Input
          className="bg-overlay-soft border-[var(--border-overlay)]"
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search projects…"
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
          mode={mode}
          onStopProject={onStopProject}
          onCloseProject={onCloseProject}
          onFreeMemoryProject={onFreeMemoryProject}
          onLocateProject={onLocateProject}
          onTogglePinProject={onTogglePinProject}
          onCopyPath={onCopyPath}
          onSelectNewWindow={onSelectNewWindow}
          onHoverProject={onHoverProject}
          onHoverProjectEnd={onHoverProjectEnd}
        />
        {(onCreateScratch || (scratchResults && scratchResults.length > 0)) && (
          <>
            <div className="h-[3px] bg-tint/[0.08]" />
            <ScratchSection
              scratches={scratchResults ?? []}
              onCreate={onCreateScratch}
              onSelect={onSelectScratch}
              onRemove={onRemoveScratch}
              onRename={onRenameScratch}
              onSaveAsProject={onSaveAsProject}
            />
          </>
        )}
      </AppPaletteDialog.Body>

      {(onOpenProjectSettings || onAddProject || onCloneRepo || onCreateFolder) && (
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
                <span className="font-medium text-sm text-muted-foreground">Project Settings…</span>
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
                <span className="font-medium text-sm text-muted-foreground">Add Project…</span>
              </button>
            )}
            {onCloneRepo && (
              <button
                type="button"
                onClick={() => onCloneRepo()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
                data-testid="project-clone-button"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <Download className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">Clone Repository…</span>
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
                  Create New Folder…
                </span>
              </button>
            )}
          </div>
        </>
      )}

      <AppPaletteDialog.Footer>
        <ProjectSwitcherFooter mode={mode} />
      </AppPaletteDialog.Footer>
    </>
  );
}

function ModalContent({
  isOpen,
  onClose,
  mode,
  ...innerProps
}: Omit<ProjectSwitcherPaletteProps, "children" | "dropdownAlign">) {
  useOverlayClaim("project-switcher", isOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  return (
    <AppPaletteDialog
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel="Project switcher"
      className={PALETTE_WIDTH}
    >
      <ProjectPaletteInner
        inputRef={inputRef}
        listRef={listRef}
        query={innerProps.query}
        results={innerProps.results}
        selectedIndex={innerProps.selectedIndex}
        mode={mode}
        onQueryChange={innerProps.onQueryChange}
        onSelect={innerProps.onSelect}
        onClose={onClose}
        onSelectPrevious={innerProps.onSelectPrevious}
        onSelectNext={innerProps.onSelectNext}
        onAddProject={innerProps.onAddProject}
        onCloneRepo={innerProps.onCloneRepo}
        onCreateFolder={innerProps.onCreateFolder}
        onOpenProjectSettings={innerProps.onOpenProjectSettings}
        onStopProject={innerProps.onStopProject}
        onCloseProject={innerProps.onCloseProject}
        onFreeMemoryProject={innerProps.onFreeMemoryProject}
        onLocateProject={innerProps.onLocateProject}
        onTogglePinProject={innerProps.onTogglePinProject}
        onCopyPath={innerProps.onCopyPath}
        onSelectNewWindow={innerProps.onSelectNewWindow}
        onHoverProject={innerProps.onHoverProject}
        onHoverProjectEnd={innerProps.onHoverProjectEnd}
        scratchResults={innerProps.scratchResults}
        onCreateScratch={innerProps.onCreateScratch}
        onSelectScratch={innerProps.onSelectScratch}
        onRemoveScratch={innerProps.onRemoveScratch}
        onRenameScratch={innerProps.onRenameScratch}
        onSaveAsProject={innerProps.onSaveAsProject}
      />
    </AppPaletteDialog>
  );
}

function DropdownContent({
  isOpen,
  onClose,
  dropdownAlign = "start",
  children,
  mode,
  onDropdownCloseAutoFocus,
  ...innerProps
}: ProjectSwitcherPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const overlayStackLength = useUIStore((state) => state.overlayStack.length);
  const prevOverlayStackLengthRef = useRef<number>(overlayStackLength);
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
    if (
      isOpen &&
      overlayStackLength > prevOverlayStackLengthRef.current &&
      overlayStackLength > 0
    ) {
      onClose();
    }
    prevOverlayStackLengthRef.current = overlayStackLength;
  }, [isOpen, overlayStackLength, onClose]);

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
        onCloseAutoFocus={() => onDropdownCloseAutoFocus?.()}
        onEscapeKeyDown={(event) => {
          // Radix dismisses on a document-capture listener, which beats the
          // scratch-name input's own handler. While that input owns focus,
          // Escape means "cancel the edit", not "close the switcher".
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.hasAttribute("data-scratch-name-input")) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof HTMLElement && target.closest('[role="menu"]')) {
            event.preventDefault();
          }
        }}
      >
        <ProjectPaletteInner
          inputRef={inputRef}
          listRef={listRef}
          query={innerProps.query}
          results={innerProps.results}
          selectedIndex={innerProps.selectedIndex}
          mode={mode}
          onQueryChange={innerProps.onQueryChange}
          onSelect={innerProps.onSelect}
          onClose={onClose}
          onSelectPrevious={innerProps.onSelectPrevious}
          onSelectNext={innerProps.onSelectNext}
          onAddProject={innerProps.onAddProject}
          onCloneRepo={innerProps.onCloneRepo}
          onCreateFolder={innerProps.onCreateFolder}
          onOpenProjectSettings={innerProps.onOpenProjectSettings}
          onStopProject={innerProps.onStopProject}
          onCloseProject={innerProps.onCloseProject}
          onFreeMemoryProject={innerProps.onFreeMemoryProject}
          onLocateProject={innerProps.onLocateProject}
          onTogglePinProject={innerProps.onTogglePinProject}
          onCopyPath={innerProps.onCopyPath}
          onSelectNewWindow={innerProps.onSelectNewWindow}
          onHoverProject={innerProps.onHoverProject}
          onHoverProjectEnd={innerProps.onHoverProjectEnd}
          scratchResults={innerProps.scratchResults}
          onCreateScratch={innerProps.onCreateScratch}
          onSelectScratch={innerProps.onSelectScratch}
          onRemoveScratch={innerProps.onRemoveScratch}
          onRenameScratch={innerProps.onRenameScratch}
          onSaveAsProject={innerProps.onSaveAsProject}
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
  onCloneRepo,
  onCreateFolder,
  onStopProject,
  onCloseProject,
  onFreeMemoryProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
  onHoverProject,
  onHoverProjectEnd,
  onOpenProjectSettings,
  onDropdownCloseAutoFocus,
  dropdownAlign,
  children,
  removeConfirmProject,
  onRemoveConfirmClose,
  onConfirmRemove,
  isRemovingProject = false,
  freeMemoryConfirmProject,
  onFreeMemoryConfirmClose,
  onConfirmFreeMemory,
  isFreeingMemory = false,
  scratchResults,
  onCreateScratch,
  onSelectScratch,
  onRemoveScratch,
  onRenameScratch,
  onSaveAsProject,
  saveAsProjectConfirm,
  onDismissSaveAsProjectConfirm,
  onConfirmDeleteOriginalScratch,
  isDeletingOriginalScratch = false,
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
        mode={mode}
        onAddProject={onAddProject}
        onCloneRepo={onCloneRepo}
        onCreateFolder={onCreateFolder}
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
        onFreeMemoryProject={onFreeMemoryProject}
        onLocateProject={onLocateProject}
        onTogglePinProject={onTogglePinProject}
        onCopyPath={onCopyPath}
        onSelectNewWindow={onSelectNewWindow}
        onHoverProject={onHoverProject}
        onHoverProjectEnd={onHoverProjectEnd}
        onOpenProjectSettings={onOpenProjectSettings}
        onDropdownCloseAutoFocus={onDropdownCloseAutoFocus}
        dropdownAlign={dropdownAlign}
        scratchResults={scratchResults}
        onCreateScratch={onCreateScratch}
        onSelectScratch={onSelectScratch}
        onRemoveScratch={onRemoveScratch}
        onRenameScratch={onRenameScratch}
        onSaveAsProject={onSaveAsProject}
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
        mode={mode}
        onAddProject={onAddProject}
        onCloneRepo={onCloneRepo}
        onCreateFolder={onCreateFolder}
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
        onFreeMemoryProject={onFreeMemoryProject}
        onLocateProject={onLocateProject}
        onTogglePinProject={onTogglePinProject}
        onCopyPath={onCopyPath}
        onSelectNewWindow={onSelectNewWindow}
        onHoverProject={onHoverProject}
        onHoverProjectEnd={onHoverProjectEnd}
        onOpenProjectSettings={onOpenProjectSettings}
        scratchResults={scratchResults}
        onCreateScratch={onCreateScratch}
        onSelectScratch={onSelectScratch}
        onRemoveScratch={onRemoveScratch}
        onRenameScratch={onRenameScratch}
        onSaveAsProject={onSaveAsProject}
      />
    );

  return (
    <>
      {content}
      {removeConfirmProject && onRemoveConfirmClose && onConfirmRemove && (
        <ConfirmDialog
          isOpen={true}
          onClose={isRemovingProject ? undefined : onRemoveConfirmClose}
          title={removeConfirmProject.isActive ? "Close project?" : "Remove project from list?"}
          zIndex="nested"
          confirmLabel={removeConfirmProject.isActive ? "Close project" : "Remove project"}
          cancelLabel="Cancel"
          onConfirm={onConfirmRemove}
          isConfirmLoading={isRemovingProject}
          variant="destructive"
        >
          <div className="space-y-3">
            <div>
              <div className="font-medium text-sm">{removeConfirmProject.name}</div>
              <div className="text-xs text-daintree-text/50 font-mono mt-1">
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
            <div className="text-xs text-daintree-text/60">
              {removeConfirmProject.isActive
                ? "The project will remain in your list and can be reopened at any time."
                : "This project will be removed from your list. You can add it back later, but any running terminals or processes will need to be restarted."}
            </div>
          </div>
        </ConfirmDialog>
      )}
      {freeMemoryConfirmProject && onFreeMemoryConfirmClose && onConfirmFreeMemory && (
        <ConfirmDialog
          isOpen={true}
          onClose={isFreeingMemory ? undefined : onFreeMemoryConfirmClose}
          title={`Free memory for '${freeMemoryConfirmProject.name}'?`}
          zIndex="nested"
          confirmLabel="Free memory"
          cancelLabel="Cancel"
          onConfirm={onConfirmFreeMemory}
          isConfirmLoading={isFreeingMemory}
          variant="default"
        >
          <div className="space-y-3">
            <div>
              <div className="font-medium text-sm">{freeMemoryConfirmProject.name}</div>
              <div className="text-xs text-daintree-text/50 font-mono mt-1">
                {freeMemoryConfirmProject.path}
              </div>
            </div>
            {(freeMemoryConfirmProject.processCount > 0 ||
              freeMemoryConfirmProject.activeAgentCount > 0 ||
              freeMemoryConfirmProject.waitingAgentCount > 0) && (
              <div className="rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20 px-3 py-2 text-xs text-status-warning">
                <div className="font-medium">Running processes will be stopped</div>
                <div className="mt-1 text-status-warning/80">
                  {freeMemoryConfirmProject.processCount > 0 && (
                    <div>• {freeMemoryConfirmProject.processCount} running process(es)</div>
                  )}
                  {freeMemoryConfirmProject.activeAgentCount > 0 && (
                    <div>• {freeMemoryConfirmProject.activeAgentCount} active agent(s)</div>
                  )}
                  {freeMemoryConfirmProject.waitingAgentCount > 0 && (
                    <div>• {freeMemoryConfirmProject.waitingAgentCount} waiting agent(s)</div>
                  )}
                </div>
              </div>
            )}
            <div className="text-xs text-daintree-text/60">
              Sessions are preserved and restored when you reopen the project.
            </div>
          </div>
        </ConfirmDialog>
      )}
      {saveAsProjectConfirm && onDismissSaveAsProjectConfirm && onConfirmDeleteOriginalScratch && (
        <ConfirmDialog
          isOpen={true}
          onClose={isDeletingOriginalScratch ? undefined : onDismissSaveAsProjectConfirm}
          title={`Delete '${saveAsProjectConfirm.scratch.name}'?`}
          zIndex="nested"
          confirmLabel="Delete scratch"
          cancelLabel="Keep scratch"
          onConfirm={onConfirmDeleteOriginalScratch}
          isConfirmLoading={isDeletingOriginalScratch}
          variant="destructive"
        >
          <div className="space-y-3">
            <div className="text-sm">
              Saved as <span className="font-medium">{saveAsProjectConfirm.project.name}</span>. The
              original scratch folder is no longer needed.
            </div>
            <div className="text-xs text-daintree-text/50 font-mono break-all">
              {saveAsProjectConfirm.scratch.path}
            </div>
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
