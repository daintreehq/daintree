import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronRight, FileText, FolderUp, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PALETTE_ROW_FOCUS_CLASS,
  PALETTE_SECTION_LABEL_CLASS,
} from "@/components/ui/paletteRowStyles";
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
function ScratchNameEditor({
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
}: ScratchSectionProps) {
  const storedCollapsed = usePreferencesStore(
    (state) => state.projectSwitcherCollapsedBands[PROJECT_SWITCHER_SCRATCH_BAND_KEY]
  );
  const setBandCollapsed = usePreferencesStore((state) => state.setProjectSwitcherBandCollapsed);
  const collapsed = storedCollapsed ?? (scratches.length === 0 && !isOnlyAction);
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

  return (
    <div className="px-1 py-1" hidden={isSearching}>
      {/*
       * The trigger stays mounted at zero scratches — only the menu content is
       * conditional. Swapping the button in and out of a ContextMenu as the last
       * scratch is deleted would remount the node Radix is restoring focus to.
       * A `contextmenu` gesture (and Shift+F10) never dispatches `click`, so the
       * collapse toggle below is safe to leave as-is.
       */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => setBandCollapsed(PROJECT_SWITCHER_SCRATCH_BAND_KEY, !collapsed)}
            className={cn(
              PALETTE_SECTION_LABEL_CLASS,
              // `px-2` like the project bands' labels: the wrapper no longer
              // carries the inset, so the label draws its own and lands on the
              // same rail as the rows below it (#11943).
              "w-full flex items-center justify-between gap-2 px-2 py-1 hover:text-text-secondary transition-colors",
              PALETTE_ROW_FOCUS_CLASS
            )}
            aria-expanded={!collapsed}
            aria-controls="scratch-section-list"
          >
            <span className="flex items-center gap-1.5">
              <ChevronRight
                data-animated-chevron
                className={cn(
                  "w-3 h-3 shrink-0 transition-transform duration-150 ease-out",
                  !collapsed && "rotate-90"
                )}
                aria-hidden="true"
              />
              Scratch
            </span>
            {scratches.length > 0 && <BandCollapsedCount count={scratches.length} />}
          </button>
        </ContextMenuTrigger>
        {onDeleteAll && scratches.length > 0 && (
          <ContextMenuContent>
            <ContextMenuItem destructive onSelect={onDeleteAll}>
              <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              Delete all scratch workspaces
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
      {!collapsed && (
        <div id="scratch-section-list">
          {scratches.length === 0 ? (
            // The palette's empty state already says this when it is the only
            // thing to do; a second line would be the same instruction twice.
            isOnlyAction ? null : (
              <div className="px-2 py-1 text-xs text-text-secondary">
                Create a scratch workspace for a quick one-off task
              </div>
            )
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
                      commitOnBlur
                      onReturnFocus={onReturnFocus}
                    />
                  );
                }

                const countdown = formatScratchCleanupCountdown(scratch.lastOpened, now);
                const status = getScratchRowStatus(scratch, now);
                const showResumeDot = showResumableAgentMark(status, scratch);
                const hasContextActions = Boolean(onRequestDelete || onSaveAsProject || onRename);
                return (
                  <ContextMenu key={scratch.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onSelect?.(scratch)}
                        className={cn(
                          "w-full flex items-center gap-2 px-2 py-1 rounded-[var(--radius-sm)] text-left transition-colors",
                          scratch.isActive
                            ? "text-text-primary"
                            : "text-text-secondary hover:text-text-primary",
                          // Reserved like `PALETTE_ROW_CLASS` does, though this
                          // row never draws one: the ranked scratch rows carry a
                          // border, and without it here the same scratch shifted
                          // 1px sideways between browse and search.
                          "border border-transparent",
                          PALETTE_ROW_FOCUS_CLASS,
                          // The scratch you're in takes a "Current" label, not a
                          // fill: a fill here read as a second cursor beside the
                          // palette's own.
                          // These rows sit outside the arrow-key domain, so hover
                          // is the lighter list step, the same on every row.
                          "hover:bg-overlay-subtle"
                        )}
                        role="option"
                        // No `aria-current` here, unlike the ranked rows above.
                        // This list has no roving cursor, so `aria-selected` is
                        // not spoken for — it has only ever meant "the scratch
                        // you're in", which is the same fact. Saying it twice
                        // would have a reader announce one state as two.
                        aria-selected={scratch.isActive}
                      >
                        <StatusDot status={status} showResumeDot={showResumeDot} />
                        <CommandTile icon={FileText} tone="manage" />
                        <div className="flex-1 min-w-0">
                          <div
                            className={cn(
                              "truncate text-sm font-semibold leading-tight",
                              scratch.isActive ? "text-text-primary" : "text-daintree-text/85"
                            )}
                          >
                            {scratch.name}
                            {/*
                             * Inside the name element, not after it: this row
                             * has no `, current` span to follow (the section's
                             * `aria-selected` carries that), so the phrase
                             * attaches to the name the way it does on a
                             * project row.
                             */}
                            {showResumeDot && (
                              <ResumableAgentsLabel count={scratch.resumableAgentCount ?? 0} />
                            )}
                          </div>
                          {/*
                           * No origin hint here — the section header already
                           * says "Scratch", so repeating it on every row would
                           * be chrome naming what the reader just read.
                           *
                           * The status line is conditional for the same reason
                           * it is on a project row (#11692); the cleanup
                           * countdown below is not, because a scratch about to
                           * be deleted is exactly the row that has something to
                           * report even when nothing is running.
                           */}
                          <RowStatusLine status={status} />
                          {countdown && (
                            <div
                              className="text-2xs leading-none text-text-secondary mt-0.5 truncate"
                              data-testid="scratch-cleanup-countdown"
                            >
                              {countdown}
                            </div>
                          )}
                        </div>
                        {/* The band here says "Scratch", not "current", so this
                            list always needs the label. */}
                        {scratch.isActive && <CurrentLabel />}
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
                        {(onSaveAsProject || onRename) && onRequestDelete && (
                          <ContextMenuSeparator />
                        )}
                        {onRequestDelete && (
                          <ContextMenuItem destructive onSelect={() => onRequestDelete(scratch.id)}>
                            <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                            Delete scratch…
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
                className="mt-1"
                onCommit={handleCreateCommit}
                onCancel={closeEditor}
                commitOnBlur={false}
                onReturnFocus={onReturnFocus}
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditor({ kind: "create" })}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1 mt-1 rounded-[var(--radius-sm)] text-left transition-colors",
                  "border border-transparent text-text-secondary hover:bg-overlay-subtle hover:text-text-primary",
                  PALETTE_ROW_FOCUS_CLASS
                )}
                data-testid="scratch-create-button"
              >
                {/* Keeps the tile on the workspace column the scratches above use. */}
                <StatusSlotSpacer />
                <CommandTile icon={Plus} tone="create" />
                <span className="font-medium text-sm leading-tight">New scratch workspace…</span>
              </button>
            ))}
          {/*
           * The same action as the header context menu, which nothing in the
           * palette hinted was there (#11705). Deliberately lighter than the
           * create button above — no icon tile, smaller type — so a standing
           * destructive control doesn't out-weigh the benign one it sits under.
           */}
          {onDeleteAll && scratches.length > 0 && (
            <button
              type="button"
              onClick={onDeleteAll}
              className={cn(
                // A grid, not a flex run: the row is deliberately shorter than
                // the ones above it, so it has no 32px tile to push its label
                // out to their text column. The middle track stands in for the
                // tile and centres the smaller glyph inside it.
                "w-full grid grid-cols-[0.5rem_2rem_minmax(0,1fr)] items-center gap-x-2",
                "px-2 py-1.5 mt-1 rounded-[var(--radius-sm)] border border-transparent text-left",
                "text-xs font-medium text-status-error transition-colors hover:bg-status-error/10",
                PALETTE_ROW_FOCUS_CLASS
              )}
              data-testid="scratch-delete-all-button"
            >
              <span aria-hidden="true" />
              <Trash2 className="h-3.5 w-3.5 justify-self-center" aria-hidden="true" />
              <span className="truncate">Delete all scratch workspaces</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
