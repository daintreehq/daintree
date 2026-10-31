import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronRight, Ellipsis, FileText, FolderUp, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PALETTE_ROW_CLASS,
  PALETTE_SECTION_LABEL_CLASS,
  ROW_MENU_TARGET_CLASS,
} from "@/components/ui/paletteRowStyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { pluralize } from "@/lib/pluralize";
import { Input } from "@/components/ui/input";
import { inlineRenameFieldInputProps } from "@/components/Panel/inlineRenameField";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getScratchRowStatus } from "@/lib/projectRowStatus";
// Leaf import, not the `@/hooks` barrel: several palette suites mock that barrel
// and would throw on an export they don't list.
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { defaultScratchName } from "@shared/utils/scratchName";
import type { SearchableScratch } from "@/hooks/useProjectSwitcherPalette";
import { PROJECT_SWITCHER_SCRATCH_BAND_KEY } from "@/hooks/useProjectSwitcherPalette";
import { usePreferencesStore } from "@/store/preferencesStore";
import {
  SCRATCH_CLEANUP_TTL_MS,
  SCRATCH_CLEANUP_COUNTDOWN_VISIBLE_DAYS,
} from "@shared/config/scratchCleanup";
import { BandCollapsedCount, CommandTile, StatusSlotSpacer } from "./paletteTiles";
import {
  CurrentLabel,
  ResumableAgentsLabel,
  RowStatusLine,
  StatusDot,
  showResumableAgentMark,
} from "./ProjectSwitcherRows";

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
  /**
   * Blur commits a rename, like any inline rename. It never creates: making a
   * workspace switches to it, which is too much to do because focus moved, so
   * a create draft stays open for Enter or Escape instead.
   */
  commitOnBlur: boolean;
  /** Enter and Escape unmount the field; focus goes back to the palette's input. */
  onReturnFocus?: () => void;
  testId: string;
  /**
   * Spacing the editor inherits from whatever it stands in for. A rename editor
   * replaces a row in the run and takes nothing; the create editor replaces the
   * separated create action and takes its `mt-1`, so starting to type doesn't
   * shunt the list by 4px.
   */
  className?: string;
}

/**
 * Inline name field for creating or renaming a scratch. Lives inside
 * `AppPaletteDialog`, whose document-level Escape backstop would otherwise close
 * the whole switcher — so Escape is both consumed here and claimed on the escape
 * stack. Enter is stopped for the same reason: the palette's own Enter handler
 * lives on the search input, but the backstop listens on document.
 */
export function ScratchNameEditor({
  initialValue,
  ariaLabel,
  onCommit,
  onCancel,
  commitOnBlur,
  onReturnFocus,
  testId,
  className,
}: ScratchNameEditorProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set before Enter or Escape settles the edit, so the blur that follows —
  // unmount, or the focus handed back to the palette — can't commit a cancelled
  // edit or commit a second time.
  const settledRef = useRef(false);

  useEscapeStack(true, () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  });

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const settle = useCallback(
    (outcome: () => void) => {
      settledRef.current = true;
      outcome();
      if (onReturnFocus) requestAnimationFrame(onReturnFocus);
    },
    [onReturnFocus]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
        if (e.key === "Escape") e.stopPropagation();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        settle(() => onCommit(value));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle(onCancel);
      }
    },
    [settle, onCommit, onCancel, value]
  );

  const handleBlur = useCallback(() => {
    if (settledRef.current || !commitOnBlur) return;
    settledRef.current = true;
    onCommit(value);
  }, [commitOnBlur, onCommit, value]);

  return (
    <div
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1 rounded-[var(--radius-sm)] border border-transparent",
        className
      )}
    >
      <StatusSlotSpacer />
      <CommandTile icon={FileText} tone="manage" />
      <Input
        ref={inputRef}
        {...inlineRenameFieldInputProps}
        data-scratch-name-input=""
        data-testid={testId}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        // The row's own 30px, so opening the editor doesn't shift the list.
        className="min-w-0 flex-1 px-2 py-1"
      />
    </div>
  );
}

type ScratchEditorState =
  { kind: "create" } | { kind: "rename"; scratchId: string; name: string } | null;

interface ScratchSectionProps {
  scratches: SearchableScratch[];
  /**
   * True once a query is active, where the ranked list owns the scratches. The
   * section hides rather than unmounting so the inline name editor survives the
   * round trip — the fold itself is persisted now and no longer depends on
   * staying mounted (#11943).
   */
  isSearching: boolean;
  /**
   * Nothing else in the palette: no projects, no scratches. The empty state
   * above then names this section's create row as the next step, so it opens
   * by default rather than folding that row away behind its header.
   */
  isOnlyAction?: boolean;
  onCreate?: (name?: string) => void;
  onSelect?: (scratch: SearchableScratch) => void;
  onRequestDelete?: (scratchId: string) => void;
  onDeleteAll?: () => void;
  onRename?: (scratchId: string, name: string) => void;
  onSaveAsProject?: (scratchId: string) => void;
  onReturnFocus?: () => void;
  /** The scratch row holding the palette's cursor, if any. */
  cursorScratchId?: string | null;
  /** True while the cursor is on this band's folded header row. */
  cursorOnBand?: boolean;
  /** Moves the palette's cursor onto a scratch row. */
  onHoverScratch?: (scratchId: string) => void;
  /** Moves the palette's cursor onto the folded header row. */
  onHoverBand?: () => void;
  /** True while the cursor is on the "New scratch workspace…" row. */
  cursorOnCreate?: boolean;
  onHoverCreate?: () => void;
  /** Bumped by the palette when Enter lands on the create row. */
  createRequest?: number;
  /** Scratches drawn in a band above because of the work they are doing. */
  liftedCount?: number;
  /** Told when the create row's name field opens and closes, so the cursor can leave it. */
  onCreatingChange?: (creating: boolean) => void;
  /** Folds or unfolds the band; the palette routes it so its cursor can follow. */
  onToggleCollapsed?: (collapsed: boolean) => void;
  /**
   * The fold state the palette's cursor reads, so the two can't disagree — it
   * counts scratches lifted above, where this section only sees its own.
   */
  collapsed?: boolean;
}

export const SCRATCH_CREATE_OPTION_ID = "scratch-create-option";

export const SCRATCH_LIST_ID = "scratch-list";
export const SCRATCH_BAND_OPTION_ID = "band-option-scratch";
export function scratchOptionId(scratchId: string): string {
  return `scratch-option-${scratchId}`;
}

/**
 * Whether the Scratch band is folded. Derived, not stored, until the user
 * overrules it — see `ScratchSection`. Exported so the palette walks the same
 * rows this draws.
 */
export function isScratchBandCollapsed(
  stored: boolean | undefined,
  scratchCount: number,
  isOnlyAction: boolean
): boolean {
  return stored ?? (scratchCount === 0 && !isOnlyAction);
}

/**
 * Collapsible "Scratch" section, rendered in browse only — searching ranks
 * scratches into the main list instead (#11466). Defaults to collapsed when
 * there are no scratches yet — discoverable but quiet. Once the user has
 * scratches, defaults to expanded.
 *
 * That default is DERIVED, not stored, so it keeps tracking the scratch count
 * until the user overrules it — which is why the preference stores an explicit
 * `false` rather than dropping the key: an empty section someone deliberately
 * opened has to stay open, and "absent" here still means "collapsed while
 * empty". It also retires the effect that used to force the section open on the
 * first scratch; the derived default does that on its own now (#11943).
 *
 * Sort order is purely by `lastOpened` desc (the hook already does this).
 * Scratches deliberately do NOT participate in the project frecency ranking.
 */
export function ScratchSection({
  scratches,
  isSearching,
  isOnlyAction = false,
  onCreate,
  onSelect,
  onRequestDelete,
  onDeleteAll,
  onRename,
  onSaveAsProject,
  onReturnFocus,
  cursorScratchId = null,
  cursorOnBand = false,
  onHoverScratch,
  onHoverBand,
  cursorOnCreate = false,
  onHoverCreate,
  createRequest = 0,
  liftedCount = 0,
  onToggleCollapsed,
  collapsed: collapsedProp,
  onCreatingChange,
}: ScratchSectionProps) {
  const storedCollapsed = usePreferencesStore(
    (state) => state.projectSwitcherCollapsedBands[PROJECT_SWITCHER_SCRATCH_BAND_KEY]
  );
  const setBandCollapsed = usePreferencesStore((state) => state.setProjectSwitcherBandCollapsed);
  const collapsed =
    collapsedProp ??
    isScratchBandCollapsed(storedCollapsed, scratches.length + liftedCount, isOnlyAction);
  const [editor, setEditor] = useState<ScratchEditorState>(null);
  // Radix restores focus to the context-menu trigger on close, but for a rename
  // that trigger has been swapped out for the editor — the restore would steal
  // focus from the input and blur-cancel the edit before it began.
  const suppressMenuFocusRestoreRef = useRef(false);
  // `now` is captured per-render so the countdown updates whenever the
  // surrounding component re-renders. Refresh is naturally driven by store
  // updates (loadScratches on palette open, scratch:updated push events) —
  // an interval here would be wasteful given the daily granularity.
  const now = Date.now();

  // A rename target can vanish under the editor via a scratch:removed push.
  useEffect(() => {
    if (editor?.kind !== "rename") return;
    if (!scratches.some((s) => s.id === editor.scratchId)) {
      setEditor(null);
    }
  }, [editor, scratches]);

  // Searching hides this section, and a hidden editor is worse than a closed
  // one: it still holds its claim on the escape stack, so Escape would cancel
  // an edit nobody can see instead of closing the palette.
  useEffect(() => {
    if (isSearching) setEditor(null);
  }, [isSearching]);

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
  useEffect(() => {
    onCreatingChange?.(isCreating);
  }, [isCreating, onCreatingChange]);

  const toggleCollapsed = () =>
    onToggleCollapsed
      ? onToggleCollapsed(!collapsed)
      : setBandCollapsed(PROJECT_SWITCHER_SCRATCH_BAND_KEY, !collapsed);

  // Enter on the create row, from the palette's cursor: the same draft a click opens.
  useEffect(() => {
    if (createRequest > 0) setEditor({ kind: "create" });
  }, [createRequest]);

  const runningAgents = scratches.reduce((sum, scratch) => sum + scratch.activeAgentCount, 0);
  // Bulk delete covers every scratch, the ones drawn above included.
  const hasAnyScratch = scratches.length + liftedCount > 0;
  const deleteAllItem =
    onDeleteAll && hasAnyScratch ? (
      <ContextMenuItem destructive onSelect={onDeleteAll}>
        <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
        Delete all scratch workspaces…
      </ContextMenuItem>
    ) : null;

  return (
    <div className="px-1 pt-2 pb-1" hidden={isSearching}>
      {/*
       * One listbox for the band, header included, so the palette's cursor can
       * address every row in it: the scratches while it is open, the header
       * itself while it is folded. The create row and the empty hint sit after
       * it — a button is not a listbox child — and keep their Tab stop.
       */}
      <div role="listbox" id={SCRATCH_LIST_ID} aria-label="Scratch workspaces">
        {/*
         * The trigger stays mounted at zero scratches — only the menu content is
         * conditional. Swapping the node in and out of a ContextMenu as the last
         * scratch is deleted would remount the node Radix is restoring focus to.
         */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            {collapsed ? (
              // Folded, the header is the band's only row: an option the cursor
              // lands on, and Enter or → unfolds it.
              <div
                role="option"
                id={SCRATCH_BAND_OPTION_ID}
                aria-selected={cursorOnBand}
                onClick={toggleCollapsed}
                onPointerMove={onHoverBand && !cursorOnBand ? onHoverBand : undefined}
                className={cn(
                  PALETTE_SECTION_LABEL_CLASS,
                  PALETTE_ROW_CLASS,
                  "flex min-h-6 cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2"
                )}
              >
                <span className="flex items-center gap-1.5">
                  <ChevronRight
                    data-animated-chevron
                    className="w-3 h-3 shrink-0"
                    aria-hidden="true"
                  />
                  Scratch
                  <span className="sr-only">
                    , folded, {pluralize(scratches.length, "scratch workspace")}
                  </span>
                  {runningAgents > 0 && (
                    // Folded, the header is all that is left to say work is
                    // running in here — the project bands' rollup, same words.
                    <span className="ml-1 flex items-center gap-1 normal-case tracking-normal text-text-secondary">
                      <span
                        className="workspace-mark h-1.5 w-1.5 shrink-0 rounded-full bg-activity-working"
                        aria-hidden="true"
                      />
                      {pluralize(runningAgents, "agent")} running
                    </span>
                  )}
                </span>
                {scratches.length > 0 && <BandCollapsedCount count={scratches.length} />}
              </div>
            ) : (
              // Open, a pointer-only bar, hidden from assistive technology like
              // the project bands' headers: its controls are not options.
              <div
                aria-hidden="true"
                className={cn(
                  PALETTE_SECTION_LABEL_CLASS,
                  "group/band-header flex min-h-6 items-center justify-between gap-2 border border-transparent px-2"
                )}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={toggleCollapsed}
                  className="flex min-h-6 flex-1 items-center gap-1.5 text-left hover:text-text-primary transition-colors"
                  data-testid="scratch-band-toggle"
                >
                  <ChevronRight
                    data-animated-chevron
                    className="w-3 h-3 shrink-0 rotate-90 transition-transform duration-150 ease-out"
                    aria-hidden="true"
                  />
                  {/* A button resets `text-transform`, so the label carries its own. */}
                  <span className="uppercase tracking-wider">Scratch</span>
                </button>
                {onDeleteAll && hasAnyScratch && (
                  // The bulk delete lives here and on the right-click menus,
                  // not as a standing red row: a destructive control parked one
                  // slip below "New scratch workspace…" outweighed it. Drawn
                  // with the header like a group's ⋯, so it stays findable
                  // (#11705) without claiming a row.
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label="Scratch actions"
                        data-testid="scratch-band-menu"
                        className={cn(
                          "-my-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-[opacity,background-color,color] duration-150 ease-out hover:text-text-primary",
                          "opacity-0 group-hover/band-header:opacity-100",
                          "data-[state=open]:opacity-100 data-[state=open]:bg-overlay-subtle data-[state=open]:text-text-primary"
                        )}
                      >
                        <Ellipsis className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        requestAnimationFrame(() => {
                          const active = document.activeElement;
                          if (active === null || active === document.body) onReturnFocus?.();
                        });
                      }}
                    >
                      <DropdownMenuItem destructive onSelect={onDeleteAll}>
                        <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                        Delete all scratch workspaces…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            )}
          </ContextMenuTrigger>
          {deleteAllItem && <ContextMenuContent>{deleteAllItem}</ContextMenuContent>}
        </ContextMenu>
        {!collapsed &&
          scratches.map((scratch) => {
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
                  commitOnBlur
                  onReturnFocus={onReturnFocus}
                />
              );
            }

            const countdown = formatScratchCleanupCountdown(scratch.lastOpened, now);
            const status = getScratchRowStatus(scratch, now);
            const showResumeDot = showResumableAgentMark(status, scratch);
            const hasContextActions = Boolean(onRequestDelete || onSaveAsProject || onRename);
            const isCursor = cursorScratchId === scratch.id;
            return (
              <ContextMenu key={scratch.id}>
                <ContextMenuTrigger asChild>
                  <div
                    id={scratchOptionId(scratch.id)}
                    role="option"
                    // The palette's one cursor, like every project row: the
                    // pointer moves it and Enter acts on it. The scratch you're
                    // in is `aria-current` plus the "Current" label, never a
                    // second fill.
                    aria-selected={isCursor}
                    aria-current={scratch.isActive ? "true" : undefined}
                    onClick={() => onSelect?.(scratch)}
                    onPointerMove={
                      onHoverScratch && !isCursor ? () => onHoverScratch(scratch.id) : undefined
                    }
                    onContextMenu={
                      onHoverScratch && !isCursor ? () => onHoverScratch(scratch.id) : undefined
                    }
                    className={cn(
                      PALETTE_ROW_CLASS,
                      ROW_MENU_TARGET_CLASS,
                      "w-full flex items-center gap-2 px-2 py-1 rounded-[var(--radius-sm)] text-left cursor-pointer",
                      scratch.isActive ? "text-text-primary" : "text-text-secondary"
                    )}
                  >
                    <StatusDot status={status} showResumeDot={showResumeDot} />
                    <CommandTile icon={FileText} tone="manage" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm font-semibold leading-tight text-text-primary">
                        {scratch.name}
                        {scratch.isActive && <span className="sr-only">, current</span>}
                        {showResumeDot && (
                          <ResumableAgentsLabel count={scratch.resumableAgentCount ?? 0} />
                        )}
                      </div>
                      {/*
                       * No origin hint here — the section header already says
                       * "Scratch". The status line is earned, as on a project
                       * row (#11692); the cleanup countdown is not, because a
                       * scratch about to be deleted always has something to say.
                       */}
                      <RowStatusLine status={status} />
                      {countdown && (
                        <div
                          className="text-2xs leading-tight text-text-secondary mt-px truncate"
                          data-testid="scratch-cleanup-countdown"
                        >
                          {countdown}
                        </div>
                      )}
                    </div>
                    {scratch.isActive && <CurrentLabel />}
                  </div>
                </ContextMenuTrigger>
                {hasContextActions && (
                  <ContextMenuContent
                    onCloseAutoFocus={(e) => {
                      if (suppressMenuFocusRestoreRef.current) {
                        suppressMenuFocusRestoreRef.current = false;
                        e.preventDefault();
                        return;
                      }
                      // The row never takes focus, so Radix's restore would
                      // strand a Shift+F10 user on the body; hand it back.
                      if (!onReturnFocus) return;
                      requestAnimationFrame(() => {
                        const active = document.activeElement;
                        if (active === null || active === document.body) onReturnFocus();
                      });
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
                    {(onSaveAsProject || onRename) && onRequestDelete && <ContextMenuSeparator />}
                    {onRequestDelete && (
                      <ContextMenuItem destructive onSelect={() => onRequestDelete(scratch.id)}>
                        <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                        Delete scratch…
                      </ContextMenuItem>
                    )}
                    {/* The keyboard's way to the bulk delete: the header's ⋯ is pointer-only. */}
                    {deleteAllItem}
                  </ContextMenuContent>
                )}
              </ContextMenu>
            );
          })}
        {!collapsed && scratches.length === 0 && (liftedCount > 0 || !isOnlyAction) && (
          // The palette's empty state already says this when it is the only
          // thing to do; a second line would be the same instruction twice.
          // Hidden from readers: the create row below names the action.
          // On a row's own frame, so the sentence starts on the column the
          // names do, like a group's "shown above" note.
          <div
            aria-hidden="true"
            className="flex items-center gap-2 border border-transparent px-2 py-1 text-xs text-text-secondary"
          >
            <StatusSlotSpacer />
            <span className="w-8 shrink-0" />
            <span className="min-w-0 truncate">
              {liftedCount > 0
                ? `${pluralize(liftedCount, "scratch workspace")} shown above`
                : "Create a scratch workspace for a quick one-off task"}
            </span>
          </div>
        )}
        {!collapsed &&
          onCreate &&
          (isCreating ? (
            <ScratchNameEditor
              initialValue={defaultScratchName(new Date())}
              ariaLabel="Name for the new scratch workspace"
              testId="scratch-create-input"
              onCommit={handleCreateCommit}
              onCancel={closeEditor}
              commitOnBlur={false}
              onReturnFocus={onReturnFocus}
            />
          ) : (
            // A row of the cursor like the scratches above it, so ↓ from the
            // last scratch lands here rather than jumping it, and the pointer
            // lights it the way it lights every other row.
            <div
              role="option"
              id={SCRATCH_CREATE_OPTION_ID}
              aria-selected={cursorOnCreate}
              onClick={() => setEditor({ kind: "create" })}
              onPointerMove={onHoverCreate && !cursorOnCreate ? onHoverCreate : undefined}
              className={cn(
                PALETTE_ROW_CLASS,
                "w-full flex items-center gap-2 px-2 py-1 rounded-[var(--radius-sm)] text-left cursor-pointer text-text-secondary"
              )}
              data-testid="scratch-create-button"
            >
              {/* Keeps the tile on the workspace column the scratches above use. */}
              <StatusSlotSpacer />
              <CommandTile icon={Plus} tone="create" />
              <span className="font-medium text-sm leading-tight">New scratch workspace…</span>
            </div>
          ))}
      </div>
    </div>
  );
}
