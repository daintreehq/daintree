import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import {
  search,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  openSearchPanel,
  closeSearchPanel,
  findNext,
  findPrevious,
} from "@codemirror/search";
import { editorSearchHighlightTheme } from "@/components/Notes/editorSearchTheme";

export interface FindInNoteState {
  isOpen: boolean;
  query: string;
  activeMatch: number;
  matchCount: number;
  caseSensitive: boolean;
  regexp: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  isComposingRef: React.RefObject<boolean>;
  searchExtension: Extension;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  toggleCase: () => void;
  toggleRegexp: () => void;
  goNext: () => void;
  goPrev: () => void;
  handleEditorCreated: (view: EditorView) => void;
  handleEditorUpdate: (update: {
    state: import("@codemirror/state").EditorState;
    docChanged: boolean;
    selectionSet: boolean;
    transactions: readonly import("@codemirror/state").Transaction[];
  }) => void;
}

const HIDDEN_PANEL: { dom: HTMLElement; destroy?: () => void } = {
  dom: (() => {
    const d = typeof document !== "undefined" ? document.createElement("div") : ({} as HTMLElement);
    if (typeof document !== "undefined") d.style.display = "none";
    return d;
  })(),
};

function countMatches(
  query: SearchQuery,
  state: import("@codemirror/state").EditorState
): { count: number; active: number } {
  if (!query.search || !query.valid) return { count: 0, active: 0 };
  let count = 0;
  let active = 0;
  const sel = state.selection.main;
  try {
    const cursor = query.getCursor(state.doc) as Iterator<{ from: number; to: number }> & {
      next: () => { done: boolean; value: { from: number; to: number } };
    };
    while (true) {
      const step = cursor.next();
      if (step.done) break;
      count++;
      const { from, to } = step.value;
      if (from === sel.from && to === sel.to) active = count;
    }
  } catch {
    return { count: 0, active: 0 };
  }
  return { count, active };
}

export function useFindInNote(
  editorViewRef: React.RefObject<EditorView | null>,
  isActive: boolean
): FindInNoteState {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);
  const openRef = useRef<() => void>(() => {});

  const open = useCallback(() => {
    setIsOpen((prev) => {
      if (prev) {
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
        return prev;
      }
      return true;
    });
  }, []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const applyQuery = useCallback(
    (text: string, opts?: { caseSensitive?: boolean; regexp?: boolean }) => {
      const view = editorViewRef.current;
      if (!view) return;
      const cs = opts?.caseSensitive ?? caseSensitive;
      const rx = opts?.regexp ?? regexp;
      try {
        view.dispatch({
          effects: setSearchQuery.of(
            new SearchQuery({ search: text, caseSensitive: cs, regexp: rx })
          ),
        });
      } catch {
        // Invalid regex or unknown failure — let the editor settle
      }
    },
    [editorViewRef, caseSensitive, regexp]
  );

  const close = useCallback(() => {
    const view = editorViewRef.current;
    setIsOpen(false);
    setQueryState("");
    setMatchCount(0);
    setActiveMatch(0);
    if (view) {
      try {
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
        closeSearchPanel(view);
      } catch {
        // View may be detached
      }
    }
  }, [editorViewRef]);

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      if (isComposingRef.current) return;
      applyQuery(q);
      if (!q) {
        setMatchCount(0);
        setActiveMatch(0);
      }
    },
    [applyQuery]
  );

  const toggleCase = useCallback(() => {
    setCaseSensitive((prev) => {
      const next = !prev;
      applyQuery(query, { caseSensitive: next });
      return next;
    });
  }, [applyQuery, query]);

  const toggleRegexp = useCallback(() => {
    setRegexp((prev) => {
      const next = !prev;
      applyQuery(query, { regexp: next });
      return next;
    });
  }, [applyQuery, query]);

  const goNext = useCallback(() => {
    const view = editorViewRef.current;
    if (!view || !query) return;
    findNext(view);
  }, [editorViewRef, query]);

  const goPrev = useCallback(() => {
    const view = editorViewRef.current;
    if (!view || !query) return;
    findPrevious(view);
  }, [editorViewRef, query]);

  const handleEditorCreated = useCallback(
    (view: EditorView) => {
      try {
        openSearchPanel(view);
      } catch {
        // Older CM versions may throw if panel state is not ready
      }
    },
    []
  );

  const handleEditorUpdate = useCallback(
    (update: {
      state: import("@codemirror/state").EditorState;
      docChanged: boolean;
      selectionSet: boolean;
      transactions: readonly import("@codemirror/state").Transaction[];
    }) => {
      const queryChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setSearchQuery))
      );
      if (!update.docChanged && !update.selectionSet && !queryChanged) return;
      const cur = getSearchQuery(update.state);
      const { count, active } = countMatches(cur, update.state);
      setMatchCount(count);
      setActiveMatch(active);
    },
    []
  );

  const searchExtension = useMemo<Extension>(
    () => [
      editorSearchHighlightTheme,
      search({ createPanel: () => HIDDEN_PANEL }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-f",
            run: () => {
              openRef.current();
              return true;
            },
          },
          {
            key: "Escape",
            run: (view) => {
              const panelOpen = getSearchQuery(view.state).search !== "";
              if (!panelOpen && !isOpen) return false;
              close();
              return true;
            },
          },
        ])
      ),
    ],
    [close, isOpen]
  );

  useEffect(() => {
    if (!isActive) return;
    const handler = () => openRef.current();
    window.addEventListener("daintree:find-in-panel", handler);
    return () => window.removeEventListener("daintree:find-in-panel", handler);
  }, [isActive]);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isOpen]);

  return {
    isOpen,
    query,
    activeMatch,
    matchCount,
    caseSensitive,
    regexp,
    inputRef,
    isComposingRef,
    searchExtension,
    open,
    close,
    setQuery,
    toggleCase,
    toggleRegexp,
    goNext,
    goPrev,
    handleEditorCreated,
    handleEditorUpdate,
  };
}
