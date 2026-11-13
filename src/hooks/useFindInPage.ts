import { useState, useCallback, useRef, useEffect, type RefObject } from "react";
import { canPanelTakeFind } from "@/lib/findInPanel";
import { focusWebviewPage } from "@/components/Browser/browserUtils";

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
  isFocused: boolean | undefined,
  // The pane's root, mounted even while the webview isn't (evicted, or a
  // remote forward still pending): where a modal over the pane is read from.
  paneRef?: RefObject<Element | null>
): FindInPageState {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [matchCase, setMatchCase] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);
  const latestRequestIdRef = useRef<number | null>(null);

  // Electron's `findNext: true` starts a new find session, and `false` steps
  // through the current one. A step sent with no session open gets no
  // `found-in-page` reply at all, so a new query must start a session.
  const safeFind = useCallback(
    (text: string, opts: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => {
      if (!webviewElement || !isWebviewReady || !text) return;
      try {
        const { matchCase: explicitMatchCase, ...restOpts } = opts;
        const requestId = webviewElement.findInPage(text, {
          ...restOpts,
          matchCase: explicitMatchCase ?? matchCase,
        });
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

  // The query and matchCase outlive the bar, so Cmd+F again picks up where the
  // user left off; only the page's find session and its counts end here.
  const close = useCallback(() => {
    setIsOpen(false);
    setActiveMatch(0);
    setMatchCount(0);
    latestRequestIdRef.current = null;
    safeStopFind();
    // Unmounting the bar would leave the keyboard on `document.body`.
    focusWebviewPage(webviewElement);
  }, [safeStopFind, webviewElement]);

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
        safeFind(q, { findNext: true });
      }
    },
    [safeFind, safeStopFind]
  );

  const goNext = useCallback(() => {
    if (query) safeFind(query, { forward: true, findNext: false });
  }, [query, safeFind]);

  const goPrev = useCallback(() => {
    if (query) safeFind(query, { forward: false, findNext: false });
  }, [query, safeFind]);

  const toggleMatchCase = useCallback(() => {
    const next = !matchCase;
    setMatchCase(next);
    if (query && isOpen) {
      safeFind(query, { findNext: true, matchCase: next });
    }
  }, [query, isOpen, matchCase, safeFind]);

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
      safeFind(query, { findNext: true });
    };

    webviewElement.addEventListener("did-navigate-in-page", handler as unknown as EventListener);
    return () => {
      webviewElement.removeEventListener(
        "did-navigate-in-page",
        handler as unknown as EventListener
      );
    };
  }, [webviewElement, isOpen, query, safeFind]);

  // Resume an open search when the webview becomes ready or is replaced. Only a
  // target change acts here; typing and toggling matchCase already search.
  const resumeTargetRef = useRef({ webviewElement, isWebviewReady });
  useEffect(() => {
    const prev = resumeTargetRef.current;
    if (prev.webviewElement === webviewElement && prev.isWebviewReady === isWebviewReady) return;
    resumeTargetRef.current = { webviewElement, isWebviewReady };
    if (!isOpen) return;
    latestRequestIdRef.current = null;
    setActiveMatch(0);
    setMatchCount(0);
    if (query && !isComposingRef.current) safeFind(query, { findNext: true });
  }, [webviewElement, isWebviewReady, isOpen, query, safeFind]);

  // Close ended the page's find session, so a reopened bar with a kept query
  // starts one again; otherwise its counter would read "No matches". Declared
  // after the found-in-page listener so the listener is attached first.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const reopened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (reopened && query && !isComposingRef.current) safeFind(query, { findNext: true });
  }, [isOpen, query, safeFind]);

  // Listen for daintree:find-in-panel (Cmd+F from keybinding when renderer has focus)
  useEffect(() => {
    if (!isFocused) return;

    // A modal over the pane keeps it out.
    const handler = () => {
      if (canPanelTakeFind(paneRef?.current ?? webviewElement)) open();
    };
    window.addEventListener("daintree:find-in-panel", handler);
    return () => window.removeEventListener("daintree:find-in-panel", handler);
  }, [isFocused, open, paneRef, webviewElement]);

  // Listen for find shortcuts forwarded from webview guest via main process IPC
  useEffect(() => {
    const cleanup = window.electron.webview.onFindShortcut((payload) => {
      if (payload.panelId !== panelId) return;
      switch (payload.shortcut) {
        case "find":
          // The guest's keystroke can arrive after a modal took the keys.
          if (canPanelTakeFind(paneRef?.current ?? webviewElement)) open();
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
  }, [panelId, open, close, goNext, goPrev, isOpen, paneRef, webviewElement]);

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
