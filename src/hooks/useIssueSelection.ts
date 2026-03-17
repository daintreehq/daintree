import { useReducer, useRef, useCallback } from "react";

interface SelectionState {
  selectedIds: Set<number>;
}

type SelectionAction =
  | { type: "TOGGLE"; id: number }
  | { type: "TOGGLE_RANGE"; fromIndex: number; toIndex: number; getIdAt: (index: number) => number }
  | { type: "SELECT_ALL"; ids: number[] }
  | { type: "CLEAR" };

function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case "TOGGLE": {
      const next = new Set(state.selectedIds);
      if (next.has(action.id)) {
        next.delete(action.id);
      } else {
        next.add(action.id);
      }
      return { selectedIds: next };
    }
    case "TOGGLE_RANGE": {
      const start = Math.min(action.fromIndex, action.toIndex);
      const end = Math.max(action.fromIndex, action.toIndex);
      const next = new Set(state.selectedIds);
      for (let i = start; i <= end; i++) {
        next.add(action.getIdAt(i));
      }
      return { selectedIds: next };
    }
    case "SELECT_ALL": {
      return { selectedIds: new Set(action.ids) };
    }
    case "CLEAR": {
      if (state.selectedIds.size === 0) return state;
      return { selectedIds: new Set() };
    }
  }
}

const INITIAL_STATE: SelectionState = { selectedIds: new Set() };

export interface UseIssueSelectionReturn {
  selectedIds: Set<number>;
  isSelectionActive: boolean;
  toggle: (id: number, index: number) => void;
  toggleRange: (toIndex: number, getIdAt: (index: number) => number) => void;
  selectAll: (ids: number[]) => void;
  clear: () => void;
}

export function useIssueSelection(): UseIssueSelectionReturn {
  const [state, dispatch] = useReducer(selectionReducer, INITIAL_STATE);
  const lastSelectedIndexRef = useRef<number>(-1);

  const toggle = useCallback((id: number, index: number) => {
    dispatch({ type: "TOGGLE", id });
    lastSelectedIndexRef.current = index;
  }, []);

  const toggleRange = useCallback((toIndex: number, getIdAt: (index: number) => number) => {
    const fromIndex = lastSelectedIndexRef.current;
    if (fromIndex < 0) {
      dispatch({ type: "TOGGLE", id: getIdAt(toIndex) });
      lastSelectedIndexRef.current = toIndex;
      return;
    }
    dispatch({ type: "TOGGLE_RANGE", fromIndex, toIndex, getIdAt });
  }, []);

  const selectAll = useCallback((ids: number[]) => {
    dispatch({ type: "SELECT_ALL", ids });
  }, []);

  const clear = useCallback(() => {
    dispatch({ type: "CLEAR" });
    lastSelectedIndexRef.current = -1;
  }, []);

  return {
    selectedIds: state.selectedIds,
    isSelectionActive: state.selectedIds.size > 0,
    toggle,
    toggleRange,
    selectAll,
    clear,
  };
}
