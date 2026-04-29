import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { CheckIcon, MinusIcon, Search, Zap } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { AppDialog } from "@/components/ui/AppDialog";
import { useEscapeStack } from "@/hooks";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { cn } from "@/lib/utils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { SemanticSearchMatch, TerminalInstance } from "@shared/types";

export type FleetArmingDialogChip = "all" | "waiting" | "working";

interface FleetArmingDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface DialogTerminal {
  id: string;
  title: string;
  worktreeId: string;
  agentState: TerminalInstance["agentState"];
}

interface WorktreeGroup {
  worktreeId: string;
  worktreeName: string;
  terminals: DialogTerminal[];
}

const FALLBACK_GROUP_ID = "__no_worktree__";
const FALLBACK_GROUP_NAME = "Unassigned";
const SEMANTIC_SEARCH_DEBOUNCE_MS = 300;

function isWaiting(t: DialogTerminal): boolean {
  return t.agentState === "waiting";
}

function isWorking(t: DialogTerminal): boolean {
  return t.agentState === "working";
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

export function FleetArmingDialog({
  isOpen,
  onClose,
}: FleetArmingDialogProps): ReactElement | null {
  const armIds = useFleetArmingStore((s) => s.armIds);

  const { panelIds, panelsById } = usePanelStore(
    useShallow((s) => ({ panelIds: s.panelIds, panelsById: s.panelsById }))
  );
  const worktreeNames = useWorktreeStore(
    useShallow((s) => {
      const out: Record<string, string> = {};
      s.worktrees.forEach((wt, id) => {
        out[id] = wt.name;
      });
      return out;
    })
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [activeChip, setActiveChip] = useState<FleetArmingDialogChip>("all");
  const [isRegexMode, setIsRegexMode] = useState(false);
  const [snippetMap, setSnippetMap] = useState<Map<string, SemanticSearchMatch>>(() => new Map());
  const [regexError, setRegexError] = useState<string | null>(null);
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  // Monotonic counter — guards against stale IPC responses overwriting fresher
  // results. Incremented before each call; the response captures its issue
  // number and is dropped if the counter has since advanced.
  const searchRequestRef = useRef(0);

  // Reset all dialog-local state on each open/close transition. Single
  // useEffect keyed on [isOpen] per lesson #4958.
  useEffect(() => {
    if (isOpen) {
      setSelectedIds(new Set());
      setSearchTerm("");
      setActiveChip("all");
      setIsRegexMode(false);
      setSnippetMap(new Map());
      setRegexError(null);
      searchRequestRef.current = 0;
    }
  }, [isOpen]);

  // Debounced semantic-buffer search. Fires one IPC round-trip per settled
  // query; stale responses are discarded via the monotonic counter.
  useEffect(() => {
    if (!isOpen) return;
    const trimmed = deferredSearchTerm.trim();
    if (trimmed === "") {
      setSnippetMap(new Map());
      setRegexError(null);
      searchRequestRef.current += 1;
      return;
    }

    if (isRegexMode) {
      try {
        new RegExp(trimmed);
        setRegexError(null);
      } catch (err) {
        setRegexError(formatErrorMessage(err, "Invalid regular expression"));
        setSnippetMap(new Map());
        searchRequestRef.current += 1;
        return;
      }
    } else {
      setRegexError(null);
    }

    const issueId = ++searchRequestRef.current;
    const timer = window.setTimeout(() => {
      void window.electron.terminal
        .searchSemanticBuffers(trimmed, isRegexMode)
        .then((matches) => {
          if (searchRequestRef.current !== issueId) return;
          const next = new Map<string, SemanticSearchMatch>();
          for (const m of matches) next.set(m.terminalId, m);
          setSnippetMap(next);
        })
        .catch(() => {
          if (searchRequestRef.current !== issueId) return;
          setSnippetMap(new Map());
        });
    }, SEMANTIC_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [deferredSearchTerm, isRegexMode, isOpen]);

  const eligibleTerminals = useMemo<DialogTerminal[]>(() => {
    const out: DialogTerminal[] = [];
    for (const id of panelIds) {
      const t = panelsById[id];
      if (!isFleetArmEligible(t)) continue;
      out.push({
        id: t.id,
        title: t.title,
        worktreeId: t.worktreeId ?? FALLBACK_GROUP_ID,
        agentState: t.agentState,
      });
    }
    return out;
  }, [panelIds, panelsById]);

  const eligibleIdSet = useMemo(() => {
    const s = new Set<string>();
    for (const t of eligibleTerminals) s.add(t.id);
    return s;
  }, [eligibleTerminals]);

  const visibleTerminals = useMemo<DialogTerminal[]>(() => {
    const trimmed = deferredSearchTerm.trim();
    const needle = isRegexMode ? "" : trimmed.toLowerCase();
    return eligibleTerminals.filter((t) => {
      if (activeChip === "waiting" && !isWaiting(t)) return false;
      if (activeChip === "working" && !isWorking(t)) return false;
      if (trimmed === "") return true;
      // Buffer match alone is enough to surface the row.
      if (snippetMap.has(t.id)) return true;
      // In regex mode, the buffer search is authoritative — title/worktree
      // are not regex-matched, so a non-matching row stays hidden unless the
      // backend returned a snippet for it.
      if (isRegexMode) return false;
      const groupName =
        t.worktreeId === FALLBACK_GROUP_ID
          ? FALLBACK_GROUP_NAME
          : (worktreeNames[t.worktreeId] ?? "");
      const haystack = `${t.title.toLowerCase()} ${groupName.toLowerCase()}`;
      return haystack.includes(needle);
    });
  }, [eligibleTerminals, activeChip, deferredSearchTerm, worktreeNames, snippetMap, isRegexMode]);

  const visibleIds = useMemo(() => visibleTerminals.map((t) => t.id), [visibleTerminals]);

  const groupedVisible = useMemo<WorktreeGroup[]>(() => {
    const order: string[] = [];
    const buckets = new Map<string, DialogTerminal[]>();
    for (const t of visibleTerminals) {
      const bucket = buckets.get(t.worktreeId);
      if (bucket) {
        bucket.push(t);
      } else {
        buckets.set(t.worktreeId, [t]);
        order.push(t.worktreeId);
      }
    }
    return order.map((wid) => ({
      worktreeId: wid,
      worktreeName: wid === FALLBACK_GROUP_ID ? FALLBACK_GROUP_NAME : (worktreeNames[wid] ?? wid),
      terminals: buckets.get(wid)!,
    }));
  }, [visibleTerminals, worktreeNames]);

  // Counts derived from full eligible set, not visibleTerminals — chip
  // labels show project-wide totals so the user can see what's available
  // even after filtering.
  const eligibleCounts = useMemo(() => {
    let waiting = 0;
    let working = 0;
    for (const t of eligibleTerminals) {
      if (isWaiting(t)) waiting++;
      if (isWorking(t)) working++;
    }
    return { all: eligibleTerminals.length, waiting, working };
  }, [eligibleTerminals]);

  // Confirm payload: filter ids that may have become ineligible while the
  // dialog was open. No pruning effect — kept inline per plan decision.
  const confirmedIds = useMemo(() => {
    const out: string[] = [];
    for (const id of selectedIds) {
      if (eligibleIdSet.has(id)) out.push(id);
    }
    return out;
  }, [selectedIds, eligibleIdSet]);

  // Hide the group header when the project itself only has one eligible
  // worktree — not when filtering happens to narrow the visible list to a
  // single group. Otherwise the user loses the only label telling them
  // which worktree the visible terminals belong to.
  const isSingleWorktree = useMemo(() => {
    const ids = new Set<string>();
    for (const t of eligibleTerminals) ids.add(t.worktreeId);
    return ids.size <= 1;
  }, [eligibleTerminals]);

  const clearSearch = useCallback(() => setSearchTerm(""), []);
  // First Esc clears search; second Esc closes the dialog (handled by
  // AppDialog itself). LIFO means the search-clear handler runs first
  // because it's registered later in the call tree only when the search
  // is non-empty.
  useEscapeStack(isOpen && searchTerm !== "", clearSearch);

  const toggleId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleGroupHeaderToggle = useCallback((group: WorktreeGroup) => {
    setSelectedIds((prev) => {
      const groupIds = group.terminals.map((t) => t.id);
      const state = deriveGroupCheckedState(groupIds, prev);
      const next = new Set(prev);
      if (state === true) {
        // All selected → deselect all in group
        for (const id of groupIds) next.delete(id);
      } else if (state === "indeterminate") {
        // Safe-reset: deselect rather than complete
        for (const id of groupIds) next.delete(id);
      } else {
        // None selected → select all in group
        for (const id of groupIds) next.add(id);
      }
      return next;
    });
  }, []);

  const handleListKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedIds(new Set(visibleIds));
      }
    },
    [visibleIds]
  );

  const handleConfirm = useCallback(() => {
    if (confirmedIds.length === 0) return;
    armIds(confirmedIds);
    onClose();
  }, [armIds, confirmedIds, onClose]);

  const confirmLabel =
    confirmedIds.length === 0 ? "Arm selected" : `Arm ${confirmedIds.length} selected`;

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      maxHeight="max-h-[75vh]"
      data-testid="fleet-arming-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<Zap className="h-4 w-4 text-daintree-text/70" />}>
          Select terminals to arm
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <div className="flex flex-1 flex-col min-h-0">
        <div className="px-6 py-3 border-b border-daintree-border shrink-0 flex flex-col gap-3">
          <div>
            <div className="relative">
              <Search
                className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-daintree-text/40 pointer-events-none"
                aria-hidden="true"
              />
              <input
                ref={searchInputRef}
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={
                  isRegexMode
                    ? "Search terminals (regex)"
                    : "Search terminals, worktrees, or recent output"
                }
                aria-label="Search terminals"
                aria-invalid={regexError !== null}
                className={cn(
                  "w-full rounded border bg-daintree-bg pl-8 pr-12 py-1.5 text-[13px] text-daintree-text",
                  "placeholder:text-daintree-text/40",
                  regexError !== null ? "border-status-error" : "border-daintree-border",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
                )}
                data-testid="fleet-arming-dialog-search"
              />
              <button
                type="button"
                onClick={() => setIsRegexMode((v) => !v)}
                aria-pressed={isRegexMode}
                aria-label={
                  isRegexMode ? "Switch to substring search" : "Switch to regular expression search"
                }
                title={isRegexMode ? "Regex (click for substring)" : "Substring (click for regex)"}
                data-testid="fleet-arming-dialog-regex-toggle"
                className={cn(
                  "absolute right-1.5 top-1/2 -translate-y-1/2 h-6 px-1.5 rounded text-[11px] font-mono tabular-nums",
                  "transition-colors",
                  isRegexMode
                    ? "bg-overlay-subtle text-daintree-text"
                    : "text-daintree-text/55 hover:text-daintree-text hover:bg-tint/[0.08]",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
                )}
              >
                {isRegexMode ? ".*" : "Aa"}
              </button>
            </div>
            {regexError !== null && (
              <p
                className="mt-1 text-[11px] text-status-error"
                data-testid="fleet-arming-dialog-regex-error"
              >
                Invalid regular expression
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5" role="tablist" aria-label="Filter by state">
            <ChipButton
              active={activeChip === "all"}
              count={eligibleCounts.all}
              onClick={() => setActiveChip("all")}
              testId="fleet-arming-dialog-chip-all"
            >
              All
            </ChipButton>
            <ChipButton
              active={activeChip === "waiting"}
              count={eligibleCounts.waiting}
              onClick={() => setActiveChip("waiting")}
              testId="fleet-arming-dialog-chip-waiting"
            >
              Waiting
            </ChipButton>
            <ChipButton
              active={activeChip === "working"}
              count={eligibleCounts.working}
              onClick={() => setActiveChip("working")}
              testId="fleet-arming-dialog-chip-working"
            >
              Working
            </ChipButton>
          </div>
        </div>

        <div
          ref={listContainerRef}
          onKeyDown={handleListKeyDown}
          tabIndex={-1}
          className="flex-1 min-h-0 overflow-y-auto px-2 py-2 outline-none"
          data-testid="fleet-arming-dialog-list"
        >
          {eligibleTerminals.length === 0 ? (
            <EmptyState
              title="No terminals available"
              hint="Open or focus a terminal to add it to the fleet."
            />
          ) : visibleTerminals.length === 0 ? (
            <EmptyState
              title="No terminals match"
              hint="Adjust the search or filter to see more terminals."
            />
          ) : (
            groupedVisible.map((group) => (
              <WorktreeGroupSection
                key={group.worktreeId}
                group={group}
                selectedIds={selectedIds}
                hideHeader={isSingleWorktree}
                snippetMap={snippetMap}
                onToggleId={toggleId}
                onToggleGroup={handleGroupHeaderToggle}
              />
            ))
          )}
        </div>
      </div>

      <AppDialog.Footer
        primaryAction={{
          label: confirmLabel,
          onClick: handleConfirm,
          disabled: confirmedIds.length === 0,
        }}
        secondaryAction={{
          label: "Cancel",
          onClick: onClose,
        }}
      />
    </AppDialog>
  );
}

interface ChipButtonProps {
  active: boolean;
  count: number;
  onClick: () => void;
  testId?: string;
  children: React.ReactNode;
}

function ChipButton({ active, count, onClick, testId, children }: ChipButtonProps): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] transition-colors",
        active
          ? "bg-overlay-subtle text-daintree-text"
          : "bg-tint/[0.06] text-daintree-text/70 hover:bg-tint/[0.1] hover:text-daintree-text",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
      )}
    >
      <span>{children}</span>
      <span className="tabular-nums text-daintree-text/55">{count}</span>
    </button>
  );
}

interface EmptyStateProps {
  title: string;
  hint: string;
}

function EmptyState({ title, hint }: EmptyStateProps): ReactElement {
  return (
    <div
      className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1 px-6 text-center"
      data-testid="fleet-arming-dialog-empty"
    >
      <div className="text-[13px] font-medium text-daintree-text">{title}</div>
      <div className="text-[12px] text-daintree-text/60">{hint}</div>
    </div>
  );
}

interface WorktreeGroupSectionProps {
  group: WorktreeGroup;
  selectedIds: ReadonlySet<string>;
  hideHeader: boolean;
  snippetMap: ReadonlyMap<string, SemanticSearchMatch>;
  onToggleId: (id: string) => void;
  onToggleGroup: (group: WorktreeGroup) => void;
}

function WorktreeGroupSection({
  group,
  selectedIds,
  hideHeader,
  snippetMap,
  onToggleId,
  onToggleGroup,
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
    <section className="mb-1">
      {!hideHeader && (
        <header
          className="flex items-center gap-2 px-2 py-1.5 sticky top-0 bg-surface-panel z-[1]"
          data-testid={`fleet-arming-dialog-group-${group.worktreeId}`}
        >
          <DialogCheckbox
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
      <ul className="flex flex-col">
        {group.terminals.map((t) => (
          <TerminalRow
            key={t.id}
            terminal={t}
            checked={selectedIds.has(t.id)}
            snippet={snippetMap.get(t.id)}
            onToggle={() => onToggleId(t.id)}
          />
        ))}
      </ul>
    </section>
  );
}

interface TerminalRowProps {
  terminal: DialogTerminal;
  checked: boolean;
  snippet?: SemanticSearchMatch;
  onToggle: () => void;
}

function TerminalRow({ terminal, checked, snippet, onToggle }: TerminalRowProps): ReactElement {
  const stateBadge = renderStateBadge(terminal.agentState);
  return (
    <li className="flex items-stretch">
      <label
        className={cn(
          "flex flex-1 items-start gap-2 pl-5 pr-2 py-1.5 rounded text-[13px] text-daintree-text cursor-pointer",
          "hover:bg-tint/[0.06]"
        )}
      >
        <DialogCheckbox
          checked={checked}
          onCheckedChange={onToggle}
          ariaLabel={`Select ${terminal.title}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate flex-1">{terminal.title}</span>
            {stateBadge}
          </div>
          {snippet && <SnippetLine snippet={snippet} />}
        </div>
      </label>
    </li>
  );
}

function SnippetLine({ snippet }: { snippet: SemanticSearchMatch }): ReactElement {
  // Truncate from the left so the matched range stays in the visible window
  // for long lines. Right-truncation is handled by `overflow-hidden`.
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
      data-testid="fleet-arming-dialog-snippet"
    >
      {before}
      <mark className="bg-transparent text-daintree-text/85 font-medium">{match}</mark>
      {after}
    </p>
  );
}

function renderStateBadge(agentState: TerminalInstance["agentState"]): ReactElement | null {
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

interface DialogCheckboxProps {
  checked: boolean | "indeterminate";
  onCheckedChange: () => void;
  ariaLabel: string;
}

function DialogCheckbox({
  checked,
  onCheckedChange,
  ariaLabel,
}: DialogCheckboxProps): ReactElement {
  return (
    <Checkbox.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "relative flex shrink-0 w-4 h-4 rounded border transition-colors duration-150",
        "bg-daintree-bg border-border-strong",
        "data-[state=checked]:bg-daintree-accent data-[state=checked]:border-daintree-accent",
        // Neutral indeterminate fill — accent is reserved for the primary
        // signal (the confirm CTA). Per CLAUDE.md accent restraint rule.
        "data-[state=indeterminate]:bg-border-strong data-[state=indeterminate]:border-border-strong",
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
