import {
  use,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFleetPickerSessionStore, type FleetPickerOwner } from "@/store/fleetPickerSessionStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { SemanticSearchMatch, TerminalInstance } from "@shared/types";

// Fallback empty worktree store for hosts that mount the picker without a
// `WorktreeStoreContext.Provider` (e.g. legacy ribbon tests, places where the
// picker mounts before the per-project view tree is ready). Worktree names
// are display-only — `groupedVisible` falls back to the worktreeId when a
// name is missing — so an empty store is harmless.
const fallbackWorktreeStore = createWorktreeStore();

export const FALLBACK_GROUP_ID = "__no_worktree__";
export const FALLBACK_GROUP_NAME = "Unassigned";
const SEMANTIC_SEARCH_DEBOUNCE_MS = 300;

/**
 * Lifetime-monotonic counter — never reset across opens. Each `useFleetPicker`
 * instance reads its own current request id from this counter, and the IPC
 * response is dropped if a fresher request has incremented it. Module-scope
 * so two pickers can't accidentally collide on a low integer after one of
 * them resets.
 */
let nextSearchRequestId = 0;

export interface PickerTerminal {
  id: string;
  title: string;
  worktreeId: string;
  agentState: TerminalInstance["agentState"];
}

export interface PickerWorktreeGroup {
  worktreeId: string;
  worktreeName: string;
  terminals: PickerTerminal[];
}

export type FleetPickerMode = "cold-start" | "add";

export interface UseFleetPickerOptions {
  /**
   * Open/closed lifecycle. The hook resets internal state on each false→true
   * transition (per-open reset). When `false`, search effects and IPC are
   * skipped.
   */
  isOpen: boolean;
  /**
   * `"cold-start"` (sidebar Zap, no fleet yet): preselects active-worktree
   * eligibles; commit REPLACES the armed set.
   * `"add"` (ribbon `+ Add panes…`): never preselects; already-armed terminals
   * are excluded from the visible list; commit APPENDS to the armed set.
   */
  mode: FleetPickerMode;
  /**
   * Called with the eligible-filtered selection when the user confirms (Enter
   * or primary action). The consumer is responsible for routing to the
   * correct store method (`armIds` for replace, `addToFleet` for append).
   */
  onCommit: (selectedIds: string[]) => void;
  /**
   * Owner identifier for the single-active-picker guard. The hook attempts
   * to acquire on open and releases on close/unmount. If acquisition fails
   * (another picker is already open), the hook returns `acquired: false` and
   * skips effects — the consumer should bail or close the prior picker first.
   */
  owner: FleetPickerOwner;
}

export interface UseFleetPickerResult {
  // Acquisition state
  acquired: boolean;

  // Query state
  query: string;
  setQuery: (q: string) => void;
  isRegexMode: boolean;
  toggleRegexMode: () => void;
  regexError: string | null;

  // Selection
  selectedIds: ReadonlySet<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  focusedId: string | null;
  setFocusedId: React.Dispatch<React.SetStateAction<string | null>>;

  // Derived data
  eligibleTerminals: PickerTerminal[];
  visibleTerminals: PickerTerminal[];
  groupedVisible: PickerWorktreeGroup[];
  flatVisibleIds: string[];
  visibleIds: string[];
  isSingleWorktree: boolean;
  snippetMap: ReadonlyMap<string, SemanticSearchMatch>;
  confirmedIds: string[];
  driftCount: number;

  // Handlers
  handleToggleId: (id: string, event?: React.MouseEvent) => void;
  handleListKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  handleConfirm: () => void;
  clearSearch: () => void;
}

/**
 * Layer-agnostic picker state hook for the fleet picker. Owns query/regex
 * state, debounced semantic-buffer search with stale-response guarding,
 * selection set with range/invert/select-all keyboard handlers, and a
 * mode-driven commit contract.
 *
 * Pre-selection rules:
 * - `cold-start`: preselect terminals belonging to the active worktree.
 * - `add`: never preselect; the visible list also hides already-armed
 *   terminals so the user can only pick *additions*.
 *
 * Single-active guard via `useFleetPickerSessionStore` — if another picker
 * holds the session, this hook reports `acquired: false` and the consumer
 * should not render its UI.
 */
export function useFleetPicker(options: UseFleetPickerOptions): UseFleetPickerResult {
  const { isOpen, mode, onCommit, owner } = options;

  const armedIds = useFleetArmingStore((s) => s.armedIds);

  const { panelIds, panelsById } = usePanelStore(
    useShallow((s) => ({ panelIds: s.panelIds, panelsById: s.panelsById }))
  );
  // Tolerate hosts that mount the picker without a worktree-store provider —
  // names are display-only and `groupedVisible` falls back to the worktreeId.
  const worktreeStore = use(WorktreeStoreContext) ?? fallbackWorktreeStore;
  const worktreeNames = useStore(
    worktreeStore,
    useShallow((s) => {
      const out: Record<string, string> = {};
      s.worktrees.forEach((wt, id) => {
        out[id] = wt.name;
      });
      return out;
    })
  );

  const [acquired, setAcquired] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [isRegexMode, setIsRegexMode] = useState(false);
  const [snippetMap, setSnippetMap] = useState<Map<string, SemanticSearchMatch>>(() => new Map());
  const [regexError, setRegexError] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const rangeAnchorRef = useRef<string | null>(null);
  const currentRequestRef = useRef(0);

  // Acquire/release the single-active-picker session as the consumer opens
  // and closes. We do this in a layout-effect-ish window via a normal effect
  // with two dependencies (isOpen + owner) — release only when transitioning
  // away from open, and on unmount. If acquire fails, the hook reports
  // `acquired: false` and skips the per-open reset.
  useEffect(() => {
    if (!isOpen) return;
    const ok = useFleetPickerSessionStore.getState().acquire(owner);
    setAcquired(ok);
    if (!ok) return;
    return () => {
      useFleetPickerSessionStore.getState().release(owner);
      setAcquired(false);
    };
  }, [isOpen, owner]);

  // Per-open state reset. Pre-selection is mode-specific. Range anchor is
  // seeded so the first shift+click after a cold-start open extends the
  // pre-selected range rather than collapsing to a plain toggle.
  useEffect(() => {
    if (!isOpen || !acquired) {
      rangeAnchorRef.current = null;
      return;
    }
    setQuery("");
    setIsRegexMode(false);
    setSnippetMap(new Map());
    setRegexError(null);
    rangeAnchorRef.current = null;

    if (mode === "cold-start") {
      const activeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      if (activeId) {
        const preSelected = new Set<string>();
        const panelState = usePanelStore.getState();
        for (const tId of panelState.panelIds) {
          const t = panelState.panelsById[tId];
          if (t && isFleetArmEligible(t) && t.worktreeId === activeId) {
            preSelected.add(t.id);
          }
        }
        setSelectedIds(preSelected);
        if (preSelected.size > 0) {
          rangeAnchorRef.current = [...preSelected].pop()!;
        }
      } else {
        setSelectedIds(new Set());
      }
    } else {
      // mode === "add": always start from an empty selection. The visible
      // list excludes already-armed terminals (see `eligibleTerminals` below)
      // so the picker is exclusively a "what to add" surface.
      setSelectedIds(new Set());
    }
  }, [isOpen, acquired, mode]);

  // Debounced semantic-buffer search with stale-response guarding via the
  // module-scope monotonic counter. Each request bumps `nextSearchRequestId`
  // and stores the issued id in `currentRequestRef`; responses whose issued
  // id no longer matches are dropped.
  useEffect(() => {
    if (!isOpen || !acquired) return;
    const trimmed = deferredQuery.trim();
    if (trimmed === "") {
      setSnippetMap(new Map());
      setRegexError(null);
      currentRequestRef.current = ++nextSearchRequestId;
      return;
    }

    if (isRegexMode) {
      try {
        new RegExp(trimmed);
        setRegexError(null);
      } catch (err) {
        setRegexError(formatErrorMessage(err, "Invalid regular expression"));
        setSnippetMap(new Map());
        currentRequestRef.current = ++nextSearchRequestId;
        return;
      }
    } else {
      setRegexError(null);
    }

    const issueId = ++nextSearchRequestId;
    currentRequestRef.current = issueId;

    const timer = window.setTimeout(() => {
      window.electron.terminal
        .searchSemanticBuffers(trimmed, isRegexMode)
        .then((matches) => {
          if (currentRequestRef.current !== issueId) return;
          const next = new Map<string, SemanticSearchMatch>();
          for (const m of matches) next.set(m.terminalId, m);
          setSnippetMap(next);
        })
        .catch(() => {
          if (currentRequestRef.current !== issueId) return;
          setSnippetMap(new Map());
        });
    }, SEMANTIC_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [deferredQuery, isRegexMode, isOpen, acquired]);

  const eligibleTerminals = useMemo<PickerTerminal[]>(() => {
    const out: PickerTerminal[] = [];
    for (const id of panelIds) {
      const t = panelsById[id];
      if (!isFleetArmEligible(t)) continue;
      // `add` mode hides already-armed terminals so the picker is
      // exclusively a "what to add" surface — matches the user's mental
      // model when invoking from the ribbon's `+ Add panes…` row.
      if (mode === "add" && armedIds.has(t.id)) continue;
      out.push({
        id: t.id,
        title: t.title,
        worktreeId: t.worktreeId ?? FALLBACK_GROUP_ID,
        agentState: t.agentState,
      });
    }
    return out;
  }, [panelIds, panelsById, mode, armedIds]);

  const eligibleIdSet = useMemo(() => {
    const s = new Set<string>();
    for (const t of eligibleTerminals) s.add(t.id);
    return s;
  }, [eligibleTerminals]);

  const visibleTerminals = useMemo<PickerTerminal[]>(() => {
    const trimmed = deferredQuery.trim();
    const needle = isRegexMode ? "" : trimmed.toLowerCase();
    return eligibleTerminals.filter((t) => {
      if (trimmed === "") return true;
      if (snippetMap.has(t.id)) return true;
      if (isRegexMode) return false;
      const groupName =
        t.worktreeId === FALLBACK_GROUP_ID
          ? FALLBACK_GROUP_NAME
          : (worktreeNames[t.worktreeId] ?? "");
      const haystack = `${t.title.toLowerCase()} ${groupName.toLowerCase()}`;
      return haystack.includes(needle);
    });
  }, [eligibleTerminals, deferredQuery, worktreeNames, snippetMap, isRegexMode]);

  const visibleIds = useMemo(() => visibleTerminals.map((t) => t.id), [visibleTerminals]);

  const groupedVisible = useMemo<PickerWorktreeGroup[]>(() => {
    const order: string[] = [];
    const buckets = new Map<string, PickerTerminal[]>();
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

  // Keep `focusedId` valid as the visible list changes (search/filter/open).
  // Clamps to the first visible id when the focused row is filtered out, or
  // resets to null when the list is empty.
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

  const isSingleWorktree = useMemo(() => {
    const ids = new Set<string>();
    for (const t of eligibleTerminals) ids.add(t.worktreeId);
    return ids.size <= 1;
  }, [eligibleTerminals]);

  // Confirm payload: filter ids that may have become ineligible while the
  // picker was open (terminal exited, moved to trash, etc.).
  const confirmedIds = useMemo(() => {
    const out: string[] = [];
    for (const id of selectedIds) {
      if (eligibleIdSet.has(id)) out.push(id);
    }
    return out;
  }, [selectedIds, eligibleIdSet]);

  const driftCount = selectedIds.size - confirmedIds.length;

  const clearSearch = useCallback(() => setQuery(""), []);
  const toggleRegexMode = useCallback(() => setIsRegexMode((v) => !v), []);

  const handleToggleId = useCallback(
    (id: string, event?: React.MouseEvent) => {
      if (event) event.preventDefault();
      if (event?.shiftKey && rangeAnchorRef.current !== null) {
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

  const handleListKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
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
        if (moved) setFocusedId(nextId);
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
        // Scope to the listbox only — stopPropagation prevents the global
        // Cmd+Shift+I "inject context" binding from firing while the picker
        // has list focus.
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
    onCommit(confirmedIds);
  }, [confirmedIds, onCommit]);

  return {
    acquired,
    query,
    setQuery,
    isRegexMode,
    toggleRegexMode,
    regexError,
    selectedIds,
    setSelectedIds,
    focusedId,
    setFocusedId,
    eligibleTerminals,
    visibleTerminals,
    groupedVisible,
    flatVisibleIds,
    visibleIds,
    isSingleWorktree,
    snippetMap,
    confirmedIds,
    driftCount,
    handleToggleId,
    handleListKeyDown,
    handleConfirm,
    clearSearch,
  };
}
