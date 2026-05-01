import {
  memo,
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
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { Kbd } from "@/components/ui/Kbd";
import { isMac } from "@/lib/platform";
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
  const rangeAnchorRef = useRef<string | null>(null);
  // Roving-tabindex target — the id of the row that owns `tabIndex={0}`.
  // Driven by arrow keys, Space, and click; reset by the clamping effect
  // below when the visible list changes.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLLabelElement>>(new Map());

  // Reset all dialog-local state on each open/close transition. Single
  // useEffect keyed on [isOpen] per lesson #4958.
  useEffect(() => {
    if (isOpen) {
      setSearchTerm("");
      setActiveChip("all");
      setIsRegexMode(false);
      setSnippetMap(new Map());
      setRegexError(null);
      searchRequestRef.current = 0;
      rangeAnchorRef.current = null;

      // Pre-select terminals belonging to the active worktree.
      const activeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      if (activeId) {
        const preSelected = new Set<string>();
        for (const tId of usePanelStore.getState().panelIds) {
          const t = usePanelStore.getState().panelsById[tId];
          if (t && isFleetArmEligible(t) && t.worktreeId === activeId) {
            preSelected.add(t.id);
          }
        }
        setSelectedIds(preSelected);
        // Set anchor to the last pre-selected terminal so the first
        // shift+click after open extends the range rather than
        // falling through to a plain toggle.
        if (preSelected.size > 0) {
          rangeAnchorRef.current = [...preSelected].pop()!;
        }
      } else {
        setSelectedIds(new Set());
      }
    } else {
      rangeAnchorRef.current = null;
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
      window.electron.terminal
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

  // Visual render order — diverges from `visibleIds` (panel order) when
  // same-worktree terminals are non-contiguous in `panelIds`. Range
  // selection must use this so shift+click never crosses worktrees in a
  // way that contradicts what the user sees on screen.
  const flatVisibleIds = useMemo(() => {
    const out: string[] = [];
    for (const g of groupedVisible) {
      for (const t of g.terminals) out.push(t.id);
    }
    return out;
  }, [groupedVisible]);

  // Stable callback-ref factory bound per row id. Keeps memoized children
  // stable across renders — calling `setRowRef(id)` returns the same
  // callback identity for the same id (memoized inside TerminalRow).
  const setRowRef = useCallback(
    (id: string) => (el: HTMLLabelElement | null) => {
      if (el) rowRefs.current.set(id, el);
      else rowRefs.current.delete(id);
    },
    []
  );

  // Keep `focusedId` valid as the visible list changes (search/filter/open).
  // Clamps to the first visible id when the focused row is filtered out, or
  // resets to null when the list is empty. Also drives initial focus on open.
  useEffect(() => {
    if (flatVisibleIds.length === 0) {
      setFocusedId(null);
      return;
    }
    setFocusedId((prev) => {
      if (prev !== null && flatVisibleIds.includes(prev)) return prev;
      return flatVisibleIds[0]!;
    });
  }, [flatVisibleIds]);

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

  // Quick-select operates on the currently visible set so it respects the
  // active chip and search filter (WYSIWYG). Hidden terminals are never
  // pulled into the selection.
  const visibleWaitingIds = useMemo(
    () => visibleTerminals.filter(isWaiting).map((t) => t.id),
    [visibleTerminals]
  );
  const visibleWorkingIds = useMemo(
    () => visibleTerminals.filter(isWorking).map((t) => t.id),
    [visibleTerminals]
  );

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

  const handleToggleId = useCallback(
    (id: string, event?: React.MouseEvent) => {
      if (event) event.preventDefault();
      if (event?.shiftKey && rangeAnchorRef.current !== null) {
        // Range indexes into the flat visual order (groupedVisible flattened),
        // not panel order — otherwise shift+click can pull in terminals that
        // are not visually between anchor and target.
        const anchorIdx = flatVisibleIds.indexOf(rangeAnchorRef.current);
        const clickedIdx = flatVisibleIds.indexOf(id);
        if (anchorIdx !== -1 && clickedIdx !== -1 && anchorIdx !== clickedIdx) {
          const lo = Math.min(anchorIdx, clickedIdx);
          const hi = Math.max(anchorIdx, clickedIdx);
          const rangeIds = flatVisibleIds.slice(lo, hi + 1);
          setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const rid of rangeIds) next.add(rid);
            return next;
          });
          rangeAnchorRef.current = id;
          setFocusedId(id);
          return;
        }
      }
      // Plain toggle (no shift, or anchor invalid/filtered out).
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      rangeAnchorRef.current = id;
      setFocusedId(id);
    },
    [flatVisibleIds]
  );

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
      // Arrow navigation — handled before mod-required Cmd+A / Cmd+Shift+I
      // since plain Arrow / Shift+Arrow / Ctrl+Arrow have no Meta requirement.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Don't override macOS Cmd+Up/Down (page-jump); let the system handle.
        if (e.metaKey) return;
        if (flatVisibleIds.length === 0) return;
        e.preventDefault();
        const currentIdx = focusedId !== null ? flatVisibleIds.indexOf(focusedId) : -1;
        const baseIdx = currentIdx === -1 ? 0 : currentIdx;
        const nextIdx =
          e.key === "ArrowDown"
            ? Math.min(baseIdx + 1, flatVisibleIds.length - 1)
            : Math.max(baseIdx - 1, 0);
        const nextId = flatVisibleIds[nextIdx];
        if (!nextId) return;
        const moved = nextId !== focusedId;
        if (moved) {
          setFocusedId(nextId);
          rowRefs.current.get(nextId)?.focus();
        }
        // Shift extends the range from the anchor to `nextIdx`. Plain Arrow
        // and Ctrl+Arrow are focus-only — no selection change, no anchor
        // update. If the anchor is null or filtered out, fall back to focus
        // only (do not silently corrupt the user's intended range).
        if (e.shiftKey && moved && rangeAnchorRef.current !== null) {
          const anchorIdx = flatVisibleIds.indexOf(rangeAnchorRef.current);
          if (anchorIdx !== -1) {
            const lo = Math.min(anchorIdx, nextIdx);
            const hi = Math.max(anchorIdx, nextIdx);
            setSelectedIds((prev) => {
              const next = new Set(prev);
              for (let i = lo; i <= hi; i++) {
                const id = flatVisibleIds[i];
                if (id) next.add(id);
              }
              return next;
            });
          }
        }
        return;
      }

      // Space toggles the focused row and resets the anchor to it (matches
      // VS Code QuickPick canSelectMany; subsequent Shift+Arrow extends from
      // the just-toggled row).
      if (e.key === " ") {
        if (focusedId === null) return;
        e.preventDefault();
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(focusedId)) next.delete(focusedId);
          else next.add(focusedId);
          return next;
        });
        rangeAnchorRef.current = focusedId;
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "a" && !e.shiftKey) {
        e.preventDefault();
        setSelectedIds(new Set(visibleIds));
        return;
      }
      if (key === "i" && e.shiftKey) {
        // Scope to the list container only — stopPropagation prevents the
        // global Cmd+Shift+I "inject context" binding from firing while the
        // dialog has list focus.
        e.preventDefault();
        e.stopPropagation();
        setSelectedIds((prev) => {
          const next = new Set<string>();
          for (const id of visibleIds) {
            if (!prev.has(id)) next.add(id);
          }
          return next;
        });
      }
    },
    [flatVisibleIds, focusedId, visibleIds]
  );

  const handleConfirm = useCallback(() => {
    if (confirmedIds.length === 0) return;
    armIds(confirmedIds);
    onClose();
  }, [armIds, confirmedIds, onClose]);

  const confirmLabel =
    confirmedIds.length === 0 ? "Arm selected" : `Arm ${confirmedIds.length} selected`;

  const driftCount = selectedIds.size - confirmedIds.length;

  const footerHint = useMemo(() => {
    const driftNotice =
      driftCount > 0 ? (
        <span className="text-daintree-text/45 tabular-nums">{driftCount} became ineligible</span>
      ) : null;

    if (visibleIds.length === 0) {
      return driftNotice;
    }
    return (
      <>
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span>Move</span>
        </span>
        <span className="text-daintree-text/30">·</span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Space</Kbd>
          <span>Toggle</span>
        </span>
        <span className="text-daintree-text/30">·</span>
        <span className="inline-flex items-center gap-1">
          <Kbd>{isMac() ? "⌘A" : "Ctrl+A"}</Kbd>
          <span>Select all</span>
        </span>
        <span className="text-daintree-text/30">·</span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Shift</Kbd>+<Kbd>Click</Kbd>
          <span>Range</span>
        </span>
        <span className="text-daintree-text/30">·</span>
        <span className="inline-flex items-center gap-1">
          <Kbd>{isMac() ? "⌘⇧I" : "Ctrl+Shift+I"}</Kbd>
          <span>Invert</span>
        </span>
        {driftNotice && (
          <>
            <span className="text-daintree-text/30">·</span>
            {driftNotice}
          </>
        )}
      </>
    );
  }, [visibleIds.length, driftCount]);

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
          <div className="flex items-center gap-1.5">
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
            {(visibleWaitingIds.length > 0 || visibleWorkingIds.length > 0) && (
              <div className="ml-auto flex items-center gap-2 shrink-0">
                {visibleWaitingIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set(visibleWaitingIds))}
                    data-testid="fleet-arming-dialog-quick-select-waiting"
                    className={cn(
                      "text-[11px] text-daintree-text/55 hover:text-daintree-text transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1 rounded-sm"
                    )}
                  >
                    Select waiting ({visibleWaitingIds.length})
                  </button>
                )}
                {visibleWorkingIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set(visibleWorkingIds))}
                    data-testid="fleet-arming-dialog-quick-select-working"
                    className={cn(
                      "text-[11px] text-daintree-text/55 hover:text-daintree-text transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1 rounded-sm"
                    )}
                  >
                    Select working ({visibleWorkingIds.length})
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div
          ref={listContainerRef}
          onKeyDown={handleListKeyDown}
          tabIndex={-1}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Terminals"
          className="flex-1 min-h-0 overflow-y-auto px-2 py-2 outline-hidden"
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
                focusedId={focusedId}
                hideHeader={isSingleWorktree}
                snippetMap={snippetMap}
                onToggleId={handleToggleId}
                onToggleGroup={handleGroupHeaderToggle}
                registerRow={setRowRef}
              />
            ))
          )}
        </div>
      </div>

      <AppDialog.Footer
        hint={footerHint}
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
  focusedId: string | null;
  hideHeader: boolean;
  snippetMap: ReadonlyMap<string, SemanticSearchMatch>;
  onToggleId: (id: string, event?: React.MouseEvent) => void;
  onToggleGroup: (group: WorktreeGroup) => void;
  registerRow: (id: string) => (el: HTMLLabelElement | null) => void;
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
    // role="group" satisfies WAI-ARIA listbox structural rules — children of
    // role="listbox" must be option or group elements. The header controls
    // (group-toggle checkbox + name button) live inside the group; AT will
    // announce them as buttons within the group.
    <section className="mb-1" role="group" aria-label={group.worktreeName}>
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
      {/* role="presentation" suppresses the implicit <ul> list role so the
          listbox container's role="option" children aren't nested inside a
          redundant list landmark (screen readers would otherwise announce a
          list-within-listbox). */}
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
  isFocused: boolean;
  onToggleId: (id: string, event?: React.MouseEvent) => void;
  registerRow: (id: string) => (el: HTMLLabelElement | null) => void;
}

const TerminalRow = memo(function TerminalRow({
  terminal,
  checked,
  snippet,
  isFocused,
  onToggleId,
  registerRow,
}: TerminalRowProps): ReactElement {
  const stateBadge = renderStateBadge(terminal.agentState);
  const handleClick = useCallback(
    (e: React.MouseEvent) => onToggleId(terminal.id, e),
    [onToggleId, terminal.id]
  );
  const handleCheckedChange = useCallback(() => onToggleId(terminal.id), [onToggleId, terminal.id]);
  // Memoize the bound ref-callback so React doesn't unmount/remount the ref
  // entry on every render (would cause Map churn for N rows).
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
      >
        <DialogCheckbox
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
          {snippet && <SnippetLine snippet={snippet} />}
        </div>
      </label>
    </li>
  );
});

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
  // When the checkbox lives inside a <label> whose onClick handles
  // range-aware toggling, set this to let shift-clicks bubble to the label.
  // Group-header checkboxes (no parent label) leave this off so the original
  // always-stopPropagation behavior is preserved.
  enableShiftBubble?: boolean;
  // Row checkboxes pass -1 so the roving tabindex on the parent <label>
  // (role="option") owns keyboard focus exclusively. Without this Radix
  // defaults to tabIndex={0}, which would let Tab land on every checkbox
  // and bypass the listbox roving system.
  tabIndex?: number;
}

function DialogCheckbox({
  checked,
  onCheckedChange,
  ariaLabel,
  enableShiftBubble = false,
  tabIndex,
}: DialogCheckboxProps): ReactElement {
  return (
    <Checkbox.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      onClick={(e) => {
        if (enableShiftBubble && e.shiftKey) {
          // Suppress Radix's internal onCheckedChange (composed via
          // checkForDefaultPrevented) so the clicked id isn't double-toggled.
          // Let the click bubble to the parent <label>, whose onClick performs
          // the range-aware toggle with the shift modifier preserved.
          e.preventDefault();
        } else {
          // Stop propagation so the label's onClick doesn't fire a duplicate
          // plain toggle — Radix's onCheckedChange handles state for non-shift
          // clicks.
          e.stopPropagation();
        }
      }}
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
