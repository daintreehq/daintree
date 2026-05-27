import { useState, useCallback, useRef, useEffect } from "react";

export interface FindInPageState {
  isOpen: boolean;
  query: string;
  activeMatch: number;
  matchCount: number;
  matchCase: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  isComposingRef: React.RefObject<boolean>;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  goNext: () => void;
  goPrev: () => void;
  toggleMatchCase: () => void;
}

export function useFindInPage(
  panelId: string,
  webviewElement: Electron.WebviewTag | null,
  isWebviewReady: boolean,
  isFocused: boolean | undefined
): FindInPageState {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [matchCase, setMatchCase] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);
  const latestRequestIdRef = useRef<number | null>(null);

  const safeFind = useCallback(
    (text: string, opts: { forward?: boolean; findNext?: boolean }) => {
      if (!webviewElement || !isWebviewReady || !text) return;
      try {
        const requestId = webviewElement.findInPage(text, { ...opts, matchCase });
        latestRequestIdRef.current = requestId;
      } catch {
        // webview detached
      }
    },
    [webviewElement, isWebviewReady, matchCase]
  );

  const safeStopFind = useCallback(() => {
    if (!webviewElement) return;
    try {
      webviewElement.stopFindInPage("clearSelection");
    } catch {
      // webview detached
    }
  }, [webviewElement]);

  const open = useCallback(() => {
    if (isOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    setIsOpen(true);
  }, [isOpen]);

  const close = useCallback(() => {
    setIsOpen(false);
    setQueryState("");
    setActiveMatch(0);
    setMatchCount(0);
    setMatchCase(false);
    latestRequestIdRef.current = null;
    safeStopFind();
  }, [safeStopFind]);

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      if (!q) {
        setActiveMatch(0);
        setMatchCount(0);
        latestRequestIdRef.current = null;
        safeStopFind();
        return;
      }
      if (!isComposingRef.current) {
        safeFind(q, { findNext: false });
      }
    },
    [safeFind, safeStopFind]
  );

  const goNext = useCallback(() => {
    if (query) safeFind(query, { forward: true, findNext: true });
  }, [query, safeFind]);

  const goPrev = useCallback(() => {
    if (query) safeFind(query, { forward: false, findNext: true });
  }, [query, safeFind]);

  const toggleMatchCase = useCallback(() => {
    setMatchCase((prev) => !prev);
  }, []);

  // Re-issue find when matchCase toggles
  useEffect(() => {
    if (!query || !isOpen) return;
    safeFind(query, { findNext: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchCase]);

  // Listen for found-in-page events
  useEffect(() => {
    if (!webviewElement || !isOpen) return;

    const handler = (event: Electron.FoundInPageEvent) => {
      const { result } = event;
      if (result.requestId !== latestRequestIdRef.current) return;
      if (!result.finalUpdate) return;
      setActiveMatch(result.activeMatchOrdinal);
      setMatchCount(result.matches);
    };

    webviewElement.addEventListener("found-in-page", handler);
    return () => {
      webviewElement.removeEventListener("found-in-page", handler);
    };
  }, [webviewElement, isOpen]);

  // Restart find on SPA navigation
  useEffect(() => {
    if (!webviewElement || !isOpen || !query) return;

    const handler = (event: Electron.DidNavigateInPageEvent) => {
      if (!event.isMainFrame) return;
      safeFind(query, { findNext: false });
    };

    webviewElement.addEventListener("did-navigate-in-page", handler as unknown as EventListener);
    return () => {
      webviewElement.removeEventListener(
        "did-navigate-in-page",
        handler as unknown as EventListener
      );
    };
  }, [webviewElement, isOpen, query, safeFind]);

  // Listen for daintree:find-in-panel (Cmd+F from keybinding when renderer has focus)
  useEffect(() => {
    if (!isFocused) return;

    const handler = () => open();
    window.addEventListener("daintree:find-in-panel", handler);
    return () => window.removeEventListener("daintree:find-in-panel", handler);
  }, [isFocused, open]);

  // Listen for find shortcuts forwarded from webview guest via main process IPC
  useEffect(() => {
    const cleanup = window.electron.webview.onFindShortcut((payload) => {
      if (payload.panelId !== panelId) return;
      switch (payload.shortcut) {
        case "find":
          open();
          break;
        case "next":
          goNext();
          break;
        case "prev":
          goPrev();
          break;
        case "close":
          if (isOpen) close();
          break;
      }
    });
    return cleanup;
  }, [panelId, open, close, goNext, goPrev, isOpen]);

  // Clean up on unmount or webview detach
  useEffect(() => {
    return () => {
      safeStopFind();
    };
  }, [safeStopFind]);

  // Auto-focus input when find bar opens
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
    matchCase,
    inputRef,
    isComposingRef,
    open,
    close,
    setQuery,
    goNext,
    goPrev,
    toggleMatchCase,
  };
}
