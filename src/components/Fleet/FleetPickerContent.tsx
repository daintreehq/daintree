import { useCallback, useMemo, type ReactElement } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { CheckIcon, MinusIcon, Search } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { AppPaletteDialog, KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { Kbd } from "@/components/ui/Kbd";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useEscapeStack } from "@/hooks/useEscapeStack";
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
    focusedId,
    eligibleTerminals,
    visibleTerminals,
    groupedVisible,
    isSingleWorktree,
    snippetMap,
    handleToggleId,
    handleListKeyDown,
    setSelectedIds,
    clearSearch,
  } = picker;

  // First Esc clears the search query when non-empty; second Esc bubbles to
  // the consumer's outer escape stack and closes the picker. Same idiom the
  // dialog used.
  useEscapeStack(query !== "", clearSearch);

  // Row refs live in the hook so its keydown handler can move DOM focus on
  // ArrowUp/Down (matches the listbox roving-tabindex pattern).
  const setRowRef = picker.registerRow;

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
            <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
          }
          autoFocus={autoFocusSearch}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search terminals, worktrees, branches, or recent output"
          aria-label="Search terminals"
          data-testid={`${testIdPrefix}-search`}
        />
        {headerSlot}
      </div>

      <div
        onKeyDown={handleListKeyDown}
        tabIndex={-1}
        role="listbox"
        aria-multiselectable="true"
        aria-label="Terminals"
        className="flex-1 min-h-0 overflow-y-auto px-2 py-2 outline-hidden"
        data-testid={`${testIdPrefix}-list`}
      >
        {eligibleTerminals.length === 0 ? (
          <EmptyState
            variant="zero-data"
            scale="popover"
            title="No terminals available"
            className="h-full min-h-[120px]"
          />
        ) : visibleTerminals.length === 0 ? (
          <EmptyState
            variant="filtered-empty"
            scale="popover"
            title="No terminals match"
            className="h-full min-h-[120px]"
          />
        ) : (
          groupedVisible.map((group) => (
            <WorktreeGroupSection
              key={group.worktreeId}
              group={group}
              selectedIds={selectedIds}
              focusedId={focusedId}
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
      <span role="status" className="text-daintree-text/45 tabular-nums">
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
      <span className="text-daintree-text/30">·</span>
      <span className="inline-flex items-center gap-1">
        <kbd className={KBD_CLASS}>Space</kbd>
        <span>Toggle</span>
      </span>
      <ShortcutsPopover />
      {driftNotice && (
        <>
          <span className="text-daintree-text/30">·</span>
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
            "p-0.5 rounded transition-colors text-daintree-text/40 hover:text-daintree-text/70 cursor-pointer",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
        <div className="flex flex-col gap-1.5 text-[12px] text-daintree-text/60">
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
  focusedId: string | null;
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
  focusedId,
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
  const selectedInGroup = useMemo(() => {
    let n = 0;
    for (const id of groupIds) if (selectedIds.has(id)) n++;
    return n;
  }, [groupIds, selectedIds]);

  return (
    <section className="mb-1" role="group" aria-label={group.worktreeName}>
      {!hideHeader && (
        <header
          className="flex items-center gap-2 px-2 py-1.5 sticky top-0 bg-surface-panel z-[1]"
          data-testid={`${testIdPrefix}-group-${group.worktreeId}`}
        >
          <PickerCheckbox
            checked={groupState}
            onCheckedChange={() => onToggleGroup(group)}
            ariaLabel={`Select all ${group.terminals.length} terminals in ${group.worktreeName}`}
          />
          <button
            type="button"
            onClick={() => onToggleGroup(group)}
            className="flex flex-1 items-center justify-between gap-2 text-left text-[12px] font-medium text-daintree-text/80 hover:text-daintree-text"
          >
            <span className="truncate">{group.worktreeName}</span>
            <span className="shrink-0 tabular-nums text-[11px] text-daintree-text/55">
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
            isFocused={focusedId === t.id}
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
  isFocused: boolean;
  onToggleId: (id: string, event?: React.MouseEvent) => void;
  registerRow: (id: string) => (el: HTMLLabelElement | null) => void;
  testIdPrefix: string;
}

function TerminalRow({
  terminal,
  checked,
  snippet,
  isFocused,
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
        tabIndex={isFocused ? 0 : -1}
        role="option"
        aria-selected={checked}
        className={cn(
          "flex flex-1 items-start gap-2 pl-5 pr-2 py-1.5 rounded text-[13px] text-daintree-text cursor-pointer outline-hidden",
          "hover:bg-tint/[0.06]",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]"
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
            <span className="truncate flex-1">{terminal.title}</span>
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
      className="font-mono text-[11px] text-daintree-text/40 truncate mt-0.5"
      data-testid={`${testIdPrefix}-snippet`}
    >
      {before}
      <mark className="bg-transparent text-daintree-text/85 font-medium">{match}</mark>
      {after}
    </p>
  );
}

function renderStateBadge(agentState: AgentState | undefined): ReactElement | null {
  if (agentState !== "waiting" && agentState !== "working") return null;
  const label = agentState === "waiting" ? "Waiting" : "Working";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        "bg-tint/[0.08] text-daintree-text/70"
      )}
    >
      {label}
    </span>
  );
}

interface PickerCheckboxProps {
  checked: boolean | "indeterminate";
  onCheckedChange: () => void;
  ariaLabel: string;
  enableShiftBubble?: boolean;
  tabIndex?: number;
}

function PickerCheckbox({
  checked,
  onCheckedChange,
  ariaLabel,
  enableShiftBubble = false,
  tabIndex,
}: PickerCheckboxProps): ReactElement {
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
      className={cn(
        "relative flex shrink-0 w-4 h-4 rounded border transition-colors duration-150",
        "bg-daintree-bg border-border-strong",
        "data-[state=checked]:bg-daintree-text data-[state=checked]:border-daintree-text",
        "data-[state=indeterminate]:bg-daintree-text data-[state=indeterminate]:border-daintree-text",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent"
      )}
    >
      <Checkbox.Indicator className="flex items-center justify-center w-full h-full text-text-inverse">
        {checked === "indeterminate" ? (
          <MinusIcon className="w-3 h-3" />
        ) : (
          <CheckIcon className="w-3 h-3" />
        )}
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}

// Re-export the fallback group constants so consumers (e.g. confirm-button
// label builder) can recognize the unassigned-worktree case without importing
// the hook module directly.
export { FALLBACK_GROUP_ID, FALLBACK_GROUP_NAME };
