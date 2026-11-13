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

function publishFindOpen(panelId: string, open: boolean): void {
  // Best effort: missing it only costs the page seeing that one Escape too.
  window.electron.webview.setFindOpen(panelId, open).catch(() => {});
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

  // The kept query and matchCase belong to one pane. A tab switch reuses this
  // instance with another pane's id, which starts a fresh find session instead
  // of inheriting the last pane's search.
  const [ownerPanelId, setOwnerPanelId] = useState(panelId);
  if (ownerPanelId !== panelId) {
    setOwnerPanelId(panelId);
    setIsOpen(false);
    setQueryState("");
    setActiveMatch(0);
    setMatchCount(0);
    setMatchCase(false);
  }
  useEffect(() => {
    latestRequestIdRef.current = null;
    isComposingRef.current = false;
  }, [panelId]);

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
    const pane = inputRef.current?.closest<HTMLElement>("[data-panel-id]") ?? null;
    const active = document.activeElement;
    // The bar is about to unmount; its input is gone, so a composition in it
    // can no longer end on its own.
    isComposingRef.current = false;
    setIsOpen(false);
    setActiveMatch(0);
    setMatchCount(0);
    latestRequestIdRef.current = null;
    safeStopFind();
    // Unmounting the bar would leave the keyboard on `document.body`. A close
    // forwarded from the guest can land after the user has moved to another pane;
    // that keyboard stays where it went.
    if (pane && active && active !== document.body && !pane.contains(active)) return;
    if (!focusWebviewPage(webviewElement)) pane?.focus({ preventScroll: true });
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

  // A step is only meaningful inside an open session; the kept query would
  // otherwise let a guest's Cmd+G step a search the bar no longer shows.
  const goNext = useCallback(() => {
    if (isOpen && query) safeFind(query, { forward: true, findNext: false });
  }, [isOpen, query, safeFind]);

  const goPrev = useCallback(() => {
    if (isOpen && query) safeFind(query, { forward: false, findNext: false });
  }, [isOpen, query, safeFind]);

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

  // Resume an open search when the webview becomes ready or is replaced, or when
  // the bar reopens: close ended the page's find session, and the kept query would
  // otherwise read "No matches". Typing and toggling matchCase already search, so
  // only a target change or a reopen acts here. Declared after the found-in-page
  // listener so a reopen's results find it attached.
  const resumeTargetRef = useRef({ webviewElement, isWebviewReady, isOpen });
  useEffect(() => {
    const prev = resumeTargetRef.current;
    const targetChanged =
      prev.webviewElement !== webviewElement || prev.isWebviewReady !== isWebviewReady;
    const reopened = isOpen && !prev.isOpen;
    resumeTargetRef.current = { webviewElement, isWebviewReady, isOpen };
    if (!isOpen || (!targetChanged && !reopened)) return;
    latestRequestIdRef.current = null;
    setActiveMatch(0);
    setMatchCount(0);
    if (query && !isComposingRef.current) safeFind(query, { findNext: true });
  }, [webviewElement, isWebviewReady, isOpen, query, safeFind]);

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

  // While the bar is open, main keeps the guest's Escape for it alone: the one
  // that closes the bar must not also reach the page under it. Said only while
  // open, and unsaid on close, unmount or a pane switch.
  useEffect(() => {
    if (!isOpen) return;
    publishFindOpen(panelId, true);
    return () => publishFindOpen(panelId, false);
  }, [panelId, isOpen]);

  // Clean up on unmount, webview detach, or a pane switch that keeps the webview
  useEffect(() => {
    return () => {
      safeStopFind();
    };
  }, [safeStopFind, panelId]);

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
