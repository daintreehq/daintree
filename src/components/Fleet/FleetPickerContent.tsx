import { useCallback, useMemo, type ReactElement } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { CheckIcon, MinusIcon, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { Kbd } from "@/components/ui/Kbd";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useEscapeStack } from "@/hooks";
import {
  FALLBACK_GROUP_ID,
  FALLBACK_GROUP_NAME,
  type PickerTerminal,
  type PickerWorktreeGroup,
  type UseFleetPickerResult,
} from "@/hooks/useFleetPicker";
import type { AgentState, SemanticSearchMatch } from "@shared/types";

export interface FleetPickerContentProps {
  /** Result of `useFleetPicker` — owned and called by the consumer. */
  picker: UseFleetPickerResult;
  /** Stable prefix for `data-testid` so two consumers (cold-start, ribbon-add) can be independently queried. */
  testIdPrefix: string;
  /**
   * Auto-focus the search input on first mount. Defaults to true. Consumers
   * mounting in a popover may want to keep their trigger anchor focused
   * instead.
   */
  autoFocusSearch?: boolean;
  /**
   * Optional consumer-rendered controls placed below the search input, inside
   * the same search section. Keeps layer-specific concerns (e.g. the
   * cold-start palette's bulk-selection helpers) with the consumer — the
   * ribbon-add popover passes nothing and gets no extra row.
   */
  headerSlot?: React.ReactNode;
}

/**
 * Layer-agnostic picker UI: search input + group-by-worktree listbox. Hosts
 * in either `AppPaletteDialog` (centered cold-start) or a Radix
 * `PopoverContent` (chip-anchored add mode). Selection logic lives in
 * `useFleetPicker`; this component is purely presentational.
 *
 * Search is fuzzy across terminal title, worktree name, branch, and path —
 * `useFleetPicker` builds a Fuse index over those fields. Semantic-buffer
 * matches (terminals whose scrollback contains the query) always pass
 * through alongside fuzzy hits.
 *
 * Keyboard model: search input is focused for typing (Space types space,
 * Cmd+A selects query text). Tab moves focus through any `headerSlot`
 * controls and then into the listbox; once there, Space toggles,
 * ArrowUp/Down navigate, Cmd+A selects all visible, Cmd+Shift+I inverts.
 * First Esc clears the search query (handled by the consumer via
 * `useEscapeStack` over `clearSearch`); second Esc closes the picker.
 */
export function FleetPickerContent({
  picker,
  testIdPrefix,
  autoFocusSearch = true,
  headerSlot,
}: FleetPickerContentProps): ReactElement {
  const {
    query,
    setQuery,
    selectedIds,
    eligibleTerminals,
    visibleTerminals,
    groupedVisible,
    isSingleWorktree,
    snippetMap,
    handleToggleId,
    handleListKeyDown,
    handleConfirm,
    focusFirstRow,
    setSelectedIds,
    clearSearch,
    registerGroup,
    rovingNavKey,
  } = picker;

  // First Esc clears the search query when non-empty; second Esc bubbles to
  // the consumer's outer escape stack and closes the picker. Same idiom the
  // dialog used.
  useEscapeStack(query !== "", clearSearch);

  // Row refs live in the hook so its keydown handler can move DOM focus on
  // ArrowUp/Down (matches the tree's roving-tabindex pattern).
  const setRowRef = picker.registerRow;

  /**
   * The dialog opens with this input focused, so these two keys are the first
   * thing a keyboard user reaches for — and both used to do nothing. ArrowDown
   * hands off to the list the footer's own "↑↓ Move" hint advertises; Enter
   * commits without a detour through the mouse.
   */
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // An IME confirming a candidate also fires Enter (and ArrowDown moves
      // through candidates). Acting on those would arm the pre-selected fleet
      // and close the dialog while the user was still typing a character.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusFirstRow();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        handleConfirm();
      }
    },
    [focusFirstRow, handleConfirm]
  );

  const handleGroupHeaderToggle = useCallback(
    (group: PickerWorktreeGroup) => {
      setSelectedIds((prev) => {
        const groupIds = group.terminals.map((t) => t.id);
        const state = deriveGroupCheckedState(groupIds, prev);
        const next = new Set(prev);
        if (state === true || state === "indeterminate") {
          for (const id of groupIds) next.delete(id);
        } else {
          for (const id of groupIds) next.add(id);
        }
        return next;
      });
    },
    [setSelectedIds]
  );

  return (
    <div className="flex flex-1 flex-col min-h-0" data-testid={`${testIdPrefix}-root`}>
      {/* Hand-rolled rather than `AppPaletteDialog.Header`: this content also
          mounts inside the fleet-count popover, which has no palette header of
          its own. Padding and rule token track the palette header so the two
          hosts still read as the same surface. */}
      <div className="px-3 pt-2 pb-2 border-b border-border-strong shrink-0">
        <AppPaletteDialog.Input
          inputPrefix={
            <Search className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
          }
          autoFocus={autoFocusSearch}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search terminals, worktrees, branches, or recent output"
          aria-label="Search terminals"
          data-testid={`${testIdPrefix}-search`}
        />
        {headerSlot}
      </div>

      <div
        onKeyDown={handleListKeyDown}
        tabIndex={-1}
        // `tree`, not `listbox`: a listbox may contain only options and groups,
        // and this one held interactive group headers with checkboxes inside
        // them. APG's checkbox-treeview is the pattern this surface actually
        // implements — two levels, every node checkable.
        role="tree"
        aria-multiselectable="true"
        aria-label="Terminals"
        className="flex-1 min-h-0 overflow-y-auto px-2 py-2 outline-hidden"
        data-testid={`${testIdPrefix}-list`}
      >
        {eligibleTerminals.length === 0 ? (
          // Name the next action, not the absence. There is nothing to arm
          // until a terminal is running in the grid, so say that.
          <EmptyState
            variant="zero-data"
            scale="popover"
            title="Open a terminal in the grid to arm it"
            className="h-full min-h-[120px]"
          />
        ) : visibleTerminals.length === 0 ? (
          <EmptyState
            variant="filtered-empty"
            scale="popover"
            title="No terminals match"
            action={
              <button
                type="button"
                onClick={clearSearch}
                data-testid={`${testIdPrefix}-clear-search`}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs leading-[inherit] text-text-secondary",
                  "hover:bg-tint/[0.08] hover:text-text-primary transition-colors duration-150",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                )}
              >
                Clear search
              </button>
            }
            className="h-full min-h-[120px]"
          />
        ) : (
          groupedVisible.map((group) => (
            <WorktreeGroupSection
              key={group.worktreeId}
              group={group}
              selectedIds={selectedIds}
              rovingNavKey={rovingNavKey}
              registerGroup={registerGroup}
              hideHeader={isSingleWorktree}
              snippetMap={snippetMap}
              onToggleId={handleToggleId}
              onToggleGroup={handleGroupHeaderToggle}
              registerRow={setRowRef}
              testIdPrefix={testIdPrefix}
            />
          ))
        )}
      </div>

      {/*
        WCAG 2.2 SC 4.1.3. Typing rewrote the list silently — the only
        `role="status"` on this surface was the eligibility-drift notice.
        `query` is already deferred upstream, which is the debounce.
      */}
      <span className="sr-only" role="status" aria-live="polite">
        {eligibleTerminals.length === 0
          ? "No terminals to arm"
          : query.trim() === ""
            ? `${eligibleTerminals.length} terminals`
            : `${visibleTerminals.length} of ${eligibleTerminals.length} terminals match`}
      </span>
    </div>
  );
}

export interface FleetPickerFooterHintProps {
  /** Number of selected ids that are still eligible — drives copy and CTA disabled state in consumers. */
  confirmedCount: number;
  /** Selected − confirmed; surfaces "N became ineligible" when > 0. */
  driftCount: number;
  /** True when at least one terminal is currently visible — disables shortcut hints when the listbox is empty. */
  hasVisibleRows: boolean;
}

/**
 * Compact footer hints for the picker — two inline shortcuts and a "more"
 * popover. Exported so consumers can drop it into their own footer (`AppDialog.Footer`,
 * popover bottom, etc.) without re-implementing.
 */
export function FleetPickerFooterHint({
  confirmedCount: _confirmedCount,
  driftCount,
  hasVisibleRows,
}: FleetPickerFooterHintProps): ReactElement | null {
  // `role="status"` keeps drift changes announced to screen readers — the
  // removed footer status span carried this and the drift count is the only
  // dynamic copy left in the hint row.
  const driftNotice =
    driftCount > 0 ? (
      <span role="status" className="text-text-secondary tabular-nums">
        {driftCount} became ineligible
      </span>
    ) : null;

  if (!hasVisibleRows) return driftNotice;

  return (
    <>
      <span className="inline-flex items-center gap-1">
        <kbd className={KBD_CLASS}>↑</kbd>
        <kbd className={KBD_CLASS}>↓</kbd>
        <span>Move</span>
      </span>
      <span className="text-text-secondary">·</span>
      <span className="inline-flex items-center gap-1">
        <kbd className={KBD_CLASS}>Space</kbd>
        <span>Toggle</span>
      </span>
      <ShortcutsPopover />
      {driftNotice && (
        <>
          <span className="text-text-secondary">·</span>
          {driftNotice}
        </>
      )}
    </>
  );
}

function ShortcutsPopover(): ReactElement {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More keyboard shortcuts"
          className={cn(
            "p-0.5 rounded-sm transition-colors duration-150 text-text-secondary hover:text-text-primary cursor-pointer",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
          )}
        >
          <CircleHelp className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-auto p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-1.5 text-xs leading-[inherit] text-text-secondary">
          <span className="inline-flex items-center gap-1">
            <Kbd>{isMac() ? "⌘A" : "Ctrl+A"}</Kbd>
            <span>Select all</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Shift</Kbd>+<Kbd>Click</Kbd>
            <span>Range</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>{isMac() ? "⌘⇧I" : "Ctrl+Shift+I"}</Kbd>
            <span>Invert</span>
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function deriveGroupCheckedState(
  groupIds: string[],
  selectedIds: ReadonlySet<string>
): boolean | "indeterminate" {
  if (groupIds.length === 0) return false;
  let selected = 0;
  for (const id of groupIds) {
    if (selectedIds.has(id)) selected++;
  }
  if (selected === 0) return false;
  if (selected === groupIds.length) return true;
  return "indeterminate";
}

interface WorktreeGroupSectionProps {
  group: PickerWorktreeGroup;
  selectedIds: ReadonlySet<string>;
  rovingNavKey: string | null;
  registerGroup: (worktreeId: string) => (el: HTMLElement | null) => void;
  hideHeader: boolean;
  snippetMap: ReadonlyMap<string, SemanticSearchMatch>;
  onToggleId: (id: string, event?: React.MouseEvent) => void;
  onToggleGroup: (group: PickerWorktreeGroup) => void;
  registerRow: (id: string) => (el: HTMLLabelElement | null) => void;
  testIdPrefix: string;
}

function WorktreeGroupSection({
  group,
  selectedIds,
  rovingNavKey,
  registerGroup,
  hideHeader,
  snippetMap,
  onToggleId,
  onToggleGroup,
  registerRow,
  testIdPrefix,
}: WorktreeGroupSectionProps): ReactElement {
  const groupIds = useMemo(() => group.terminals.map((t) => t.id), [group.terminals]);
  const groupState = useMemo(
    () => deriveGroupCheckedState(groupIds, selectedIds),
    [groupIds, selectedIds]
  );
  // Two panes in one worktree routinely carry the same title ("Claude",
  // "Terminal"), and the group heading only disambiguates BETWEEN worktrees —
  // inside one, the rows were indistinguishable, so a user could not tell which
  // of them they had just ticked.
  const duplicateTitles = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const t of group.terminals) {
      if (seen.has(t.title)) dupes.add(t.title);
      else seen.add(t.title);
    }
    return dupes;
  }, [group.terminals]);

  const selectedInGroup = useMemo(() => {
    let n = 0;
    for (const id of groupIds) if (selectedIds.has(id)) n++;
    return n;
  }, [groupIds, selectedIds]);

  return (
    <section className="mb-1" role="group" aria-label={group.worktreeName}>
      {!hideHeader && (
        // ONE focusable control, not two. This was a Radix checkbox followed by
        // a separate button around the name — both tabbable, both firing the
        // same toggle — which put two extra tab stops per group inside a
        // container that is meant to be a single roving-tabindex stop. The
        // checkbox is now a non-focusable indicator and the row owns focus.
        //
        // `data-group-header` is what the list's key handler looks for: Space
        // here used to bubble up and toggle whichever ROW `focusedId` pointed
        // at instead of the group actually holding focus.
        <header
          className="sticky top-0 z-[1] bg-surface-panel"
          data-testid={`${testIdPrefix}-group-${group.worktreeId}`}
        >
          <button
            type="button"
            ref={registerGroup(group.worktreeId)}
            data-group-header={group.worktreeId}
            tabIndex={rovingNavKey === `g:${group.worktreeId}` ? 0 : -1}
            role="treeitem"
            aria-level={1}
            aria-checked={groupState === "indeterminate" ? "mixed" : groupState}
            aria-label={`Select all ${group.terminals.length} terminals in ${group.worktreeName}`}
            onClick={() => onToggleGroup(group)}
            // `px-2` matches the row's own inset so the band, the counts and
            // the rows below all share one right edge — the fill used to
            // overhang the content by 20px.
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left",
              "bg-overlay-subtle hover:bg-tint/[0.08] transition-colors duration-150",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]"
            )}
          >
            <PickerCheckbox
              checked={groupState}
              onCheckedChange={() => onToggleGroup(group)}
              ariaLabel={`Select all ${group.terminals.length} terminals in ${group.worktreeName}`}
              tabIndex={-1}
              presentational
            />
            {/* `text-sm` + `font-medium` + primary text: the worktree name is
                the only thing distinguishing a dozen rows all called "Claude",
                and it used to be set smaller and dimmer than the generic child
                title beneath it — the parent read as subordinate to its child. */}
            <span className="flex-1 truncate text-sm leading-[inherit] font-medium text-text-primary">
              {group.worktreeName}
            </span>
            <span className="shrink-0 tabular-nums text-2xs text-text-secondary">
              {selectedInGroup} / {group.terminals.length}
            </span>
          </button>
        </header>
      )}
      <ul className="flex flex-col" role="presentation">
        {group.terminals.map((t) => (
          <TerminalRow
            key={t.id}
            terminal={t}
            checked={selectedIds.has(t.id)}
            snippet={snippetMap.get(t.id)}
            isRovingStop={rovingNavKey === `t:${t.id}`}
            hasHeading={!hideHeader}
            disambiguator={duplicateTitles.has(t.title) ? shortId(t.id) : undefined}
            onToggleId={onToggleId}
            registerRow={registerRow}
            testIdPrefix={testIdPrefix}
          />
        ))}
      </ul>
    </section>
  );
}

interface TerminalRowProps {
  terminal: PickerTerminal;
  checked: boolean;
  snippet?: SemanticSearchMatch;
  isRovingStop: boolean;
  /** False when the group heading is hidden (single worktree), which makes rows the top level. */
  hasHeading: boolean;
  /** Rendered beside the title when a worktree holds two terminals of the same name. */
  disambiguator?: string;
  onToggleId: (id: string, event?: React.MouseEvent) => void;
  registerRow: (id: string) => (el: HTMLLabelElement | null) => void;
  testIdPrefix: string;
}

function TerminalRow({
  terminal,
  checked,
  snippet,
  isRovingStop,
  hasHeading,
  disambiguator,
  onToggleId,
  registerRow,
  testIdPrefix,
}: TerminalRowProps): ReactElement {
  const stateBadge = renderStateBadge(terminal.agentState);
  const handleClick = useCallback(
    (e: React.MouseEvent) => onToggleId(terminal.id, e),
    [onToggleId, terminal.id]
  );
  const handleCheckedChange = useCallback(() => onToggleId(terminal.id), [onToggleId, terminal.id]);
  const rowRefCallback = useMemo(() => registerRow(terminal.id), [registerRow, terminal.id]);
  return (
    <li className="flex items-stretch">
      <label
        ref={rowRefCallback}
        tabIndex={isRovingStop ? 0 : -1}
        data-terminal-id={terminal.id}
        // `aria-checked` on a treeitem, not `aria-selected` on an option —
        // these rows carry a checkbox, and APG is explicit that the two
        // selection vocabularies must not be mixed on one node.
        role="treeitem"
        aria-checked={checked}
        // Level 2 only when there is a level-1 heading above it; with one
        // worktree the headings are hidden and the rows are the top level.
        aria-level={hasHeading ? 2 : 1}
        className={cn(
          // `pl-8` puts the child control 20px right of the parent's, inside
          // the 20–24px band where two-level nesting actually reads. It was
          // 12px — barely more than the checkbox's own width.
          "flex flex-1 items-start gap-2 pl-8 pr-2 py-1.5 rounded-sm text-sm leading-[inherit] text-text-primary cursor-pointer outline-hidden",
          "hover:bg-tint/[0.06]",
          "focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]"
        )}
        onClick={handleClick}
        data-testid={`${testIdPrefix}-row-${terminal.id}`}
      >
        <PickerCheckbox
          checked={checked}
          onCheckedChange={handleCheckedChange}
          ariaLabel={`Select ${terminal.title}`}
          enableShiftBubble
          tabIndex={-1}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate">{terminal.title}</span>
            {disambiguator && (
              <span className="shrink-0 font-mono text-2xs text-text-secondary">
                {disambiguator}
              </span>
            )}
            <span className="flex-1" />
            {stateBadge}
          </div>
          {snippet && <SnippetLine snippet={snippet} testIdPrefix={testIdPrefix} />}
        </div>
      </label>
    </li>
  );
}

function SnippetLine({
  snippet,
  testIdPrefix,
}: {
  snippet: SemanticSearchMatch;
  testIdPrefix: string;
}): ReactElement {
  const VIEWPORT = 80;
  const LEAD = 20;
  let line = snippet.line;
  let start = snippet.matchStart;
  let end = snippet.matchEnd;
  if (start > LEAD && line.length > VIEWPORT) {
    const cut = start - LEAD;
    line = "…" + line.slice(cut);
    start = start - cut + 1;
    end = end - cut + 1;
  }
  const before = line.slice(0, start);
  const match = line.slice(start, end);
  const after = line.slice(end);
  return (
    <p
      className="font-mono text-2xs text-text-secondary truncate mt-0.5"
      data-testid={`${testIdPrefix}-snippet`}
    >
      {before}
      <mark className="bg-transparent text-text-primary font-medium">{match}</mark>
      {after}
    </p>
  );
}

/**
 * The same `Badge` the arming ribbon uses, with the same waiting tone.
 *
 * This was a hand-rolled pill on a flat `text-text-secondary`, which rendered
 * "Waiting" and "Working" in identical grey — so the one question a fleet scan
 * is actually asking ("which of these is asking me for something?") could not
 * be answered by looking. `renderPaneStateBadge` already had the answer; the
 * picker just wasn't using it.
 */
/** Last six characters of the pane id — enough to tell two same-named panes apart. */
function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
}

function renderStateBadge(agentState: AgentState | undefined): ReactElement | null {
  if (agentState !== "waiting" && agentState !== "working") return null;
  const waiting = agentState === "waiting";
  return (
    <Badge
      size="xs"
      tone="outline"
      className={cn("shrink-0", waiting ? "text-state-waiting" : "text-text-secondary")}
      data-state={agentState}
    >
      {waiting ? "Waiting" : "Working"}
    </Badge>
  );
}

interface PickerCheckboxProps {
  checked: boolean | "indeterminate";
  onCheckedChange: () => void;
  ariaLabel: string;
  enableShiftBubble?: boolean;
  tabIndex?: number;
  /**
   * Render as a pure glyph: no role, no accessible name, invisible to AT. Used
   * where an ancestor already carries the checkbox semantics (the group header
   * row), so the state is announced once instead of twice.
   */
  presentational?: boolean;
}

/** Shape, fill and border — shared so the glyph and the real control cannot drift apart. */
const CHECKBOX_CLASS = cn(
  // `rounded-xs`, never the repo's bare `rounded` — that resolves to the
  // 10px `--radius-lg` value, which on a 16px box is a full circle and
  // told every user this multi-select list was single-select.
  "relative flex shrink-0 w-4 h-4 rounded-xs border transition-colors duration-150",
  // `border-text-secondary`, not `border-border-strong`: the unchecked
  // ring measured ~1.4:1 against the row, under the 3:1 non-text floor,
  // so the un-picked rows — the ones the user has to act on — were the
  // hardest things on the surface to find.
  "bg-surface-canvas border-text-secondary",
  "data-[state=checked]:bg-text-primary data-[state=checked]:border-text-primary",
  "data-[state=indeterminate]:bg-text-primary data-[state=indeterminate]:border-text-primary",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
);

function CheckGlyph({ checked }: { checked: boolean | "indeterminate" }): ReactElement | null {
  if (checked === false) return null;
  return checked === "indeterminate" ? (
    <MinusIcon className="w-3 h-3" />
  ) : (
    <CheckIcon className="w-3 h-3" />
  );
}

function PickerCheckbox({
  checked,
  onCheckedChange,
  ariaLabel,
  enableShiftBubble = false,
  tabIndex,
  presentational = false,
}: PickerCheckboxProps): ReactElement {
  // A Radix `Checkbox.Root` renders a <button>, which cannot be nested inside
  // the group header's own button. Where an ancestor already owns the checkbox
  // semantics, emit a plain span carrying the same geometry instead.
  if (presentational) {
    return (
      <span
        aria-hidden="true"
        data-state={
          checked === "indeterminate" ? "indeterminate" : checked ? "checked" : "unchecked"
        }
        className={cn(CHECKBOX_CLASS, "items-center justify-center text-text-inverse")}
      >
        <CheckGlyph checked={checked} />
      </span>
    );
  }

  return (
    <Checkbox.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      onClick={(e) => {
        if (enableShiftBubble && e.shiftKey) {
          e.preventDefault();
        } else {
          e.stopPropagation();
        }
      }}
      className={CHECKBOX_CLASS}
    >
      <Checkbox.Indicator className="flex items-center justify-center w-full h-full text-text-inverse">
        <CheckGlyph checked={checked} />
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}

// Re-export the fallback group constants so consumers (e.g. confirm-button
// label builder) can recognize the unassigned-worktree case without importing
// the hook module directly.
export { FALLBACK_GROUP_ID, FALLBACK_GROUP_NAME };
