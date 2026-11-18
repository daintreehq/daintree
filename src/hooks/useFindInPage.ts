import { useState, useCallback, useRef, useEffect, type RefObject } from "react";
import { canPanelTakeFind } from "@/lib/findInPanel";
import { focusWebviewPage } from "@/components/Browser/browserUtils";

export interface FindInPageState {
  isOpen: boolean;
  query: string;
  activeMatch: number;
  matchCount: number;
  /**
   * A query is showing that the page hasn't answered yet. Its counts read 0
   * until then, which is not a miss.
   */
  isPending: boolean;
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

interface FindRequest {
  id: number;
  webview: Electron.WebviewTag;
  query: string;
  matchCase: boolean;
}

interface FindAnswer {
  request: FindRequest;
  activeMatch: number;
  matchCount: number;
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
  // The final reply to the latest request, or null while that request is
  // unanswered: zero counts alone can't tell a miss from a question in flight.
  const [answer, setAnswer] = useState<FindAnswer | null>(null);
  const [matchCase, setMatchCase] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);
  const latestRequestRef = useRef<FindRequest | null>(null);

  // The kept query and matchCase belong to one pane. A tab switch reuses this
  // instance with another pane's id, which starts a fresh find session instead
  // of inheriting the last pane's search.
  const [ownerPanelId, setOwnerPanelId] = useState(panelId);
  if (ownerPanelId !== panelId) {
    setOwnerPanelId(panelId);
    setIsOpen(false);
    setQueryState("");
    setAnswer(null);
    setMatchCase(false);
  }
  useEffect(() => {
    latestRequestRef.current = null;
    isComposingRef.current = false;
  }, [panelId]);

  // Electron's `findNext: true` starts a new find session, and `false` steps
  // through the current one. A step sent with no session open gets no
  // `found-in-page` reply at all, so a new query must start a session.
  const safeFind = useCallback(
    (text: string, opts: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => {
      if (!webviewElement || !isWebviewReady || !text) return;
      const { matchCase: explicitMatchCase, ...restOpts } = opts;
      const requestMatchCase = explicitMatchCase ?? matchCase;
      try {
        const id = webviewElement.findInPage(text, { ...restOpts, matchCase: requestMatchCase });
        latestRequestRef.current = {
          id,
          webview: webviewElement,
          query: text,
          matchCase: requestMatchCase,
        };
      } catch {
        // webview detached
      }
    },
    [webviewElement, isWebviewReady, matchCase]
  );

  // Every new question (another query, match case, a reopen, a new page) drops
  // the counts on screen: they answered something else, and a late reply to
  // that request must not land on this one.
  const forgetAnswer = useCallback(() => {
    latestRequestRef.current = null;
    setAnswer(null);
  }, []);

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
    forgetAnswer();
    safeStopFind();
    // Said now, not when the effect below catches up: the keyboard goes back to
    // the page next, and its very next Escape must reach it.
    publishFindOpen(panelId, false);
    // Unmounting the bar would leave the keyboard on `document.body`. A close
    // forwarded from the guest can land after the user has moved to another pane;
    // that keyboard stays where it went.
    if (pane && active && active !== document.body && !pane.contains(active)) return;
    if (!focusWebviewPage(webviewElement)) pane?.focus({ preventScroll: true });
  }, [panelId, forgetAnswer, safeStopFind, webviewElement]);

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      // A composition edits the query too; its text is searched once it ends.
      forgetAnswer();
      if (!q) {
        safeStopFind();
        return;
      }
      if (!isComposingRef.current) {
        safeFind(q, { findNext: true });
      }
    },
    [forgetAnswer, safeFind, safeStopFind]
  );

  // A step is only meaningful inside an open session; the kept query would
  // otherwise let a guest's Cmd+G step a search the bar no longer shows. It
  // also steps only a session asked for exactly what the bar shows, and asks
  // afresh otherwise: a step with no session open is never answered, and
  // Chromium answers a step that lands during a short query's delayed search
  // with that search's own request id, which would credit its text's count to
  // this query.
  const step = useCallback(
    (forward: boolean) => {
      if (!isOpen || !query) return;
      const asked = latestRequestRef.current;
      const inSession =
        asked?.webview === webviewElement && asked.query === query && asked.matchCase === matchCase;
      if (inSession) {
        safeFind(query, { forward, findNext: false });
        return;
      }
      forgetAnswer();
      safeFind(query, { forward, findNext: true });
    },
    [isOpen, query, matchCase, webviewElement, forgetAnswer, safeFind]
  );

  const goNext = useCallback(() => step(true), [step]);
  const goPrev = useCallback(() => step(false), [step]);

  const toggleMatchCase = useCallback(() => {
    const next = !matchCase;
    setMatchCase(next);
    if (query && isOpen) {
      forgetAnswer();
      safeFind(query, { findNext: true, matchCase: next });
    }
  }, [query, isOpen, matchCase, forgetAnswer, safeFind]);

  // Listen for found-in-page events
  useEffect(() => {
    if (!webviewElement || !isOpen) return;

    const handler = (event: Electron.FoundInPageEvent) => {
      const { result } = event;
      const request = latestRequestRef.current;
      if (!request || result.requestId !== request.id) return;
      if (!result.finalUpdate) return;
      setAnswer({
        request,
        activeMatch: result.activeMatchOrdinal,
        matchCount: result.matches,
      });
    };

    webviewElement.addEventListener("found-in-page", handler);
    return () => {
      webviewElement.removeEventListener("found-in-page", handler);
    };
  }, [webviewElement, isOpen]);

  // Restart an open search when the page changes under it: an in-page (SPA)
  // navigation, or a new document. A DOM move of the <webview> (dock, grid
  // reorder) also swaps in a new guest under the same element while it stays
  // ready, and only its `dom-ready` says so.
  useEffect(() => {
    if (!webviewElement || !isOpen || !query) return;

    const restart = () => {
      forgetAnswer();
      if (!isComposingRef.current) safeFind(query, { findNext: true });
    };
    const handleInPage = (event: Electron.DidNavigateInPageEvent) => {
      if (event.isMainFrame) restart();
    };

    webviewElement.addEventListener(
      "did-navigate-in-page",
      handleInPage as unknown as EventListener
    );
    webviewElement.addEventListener("dom-ready", restart);
    return () => {
      webviewElement.removeEventListener(
        "did-navigate-in-page",
        handleInPage as unknown as EventListener
      );
      webviewElement.removeEventListener("dom-ready", restart);
    };
  }, [webviewElement, isOpen, query, forgetAnswer, safeFind]);

  // Resume an open search when the webview becomes ready or is replaced, or when
  // the bar reopens: close ended the page's find session, and the kept query would
  // otherwise read "No matches". Typing and toggling matchCase already search, so
  // only a target change or a reopen acts here. Declared after the found-in-page
  // listener so a reopen's results find it attached. Close, a pane switch and a
  // readiness drop all forget the last request, so one already made of this
  // ready page was typed between this commit and this effect: it asked for newer
  // text than this render's query, and asking again would overtake it.
  const resumeTargetRef = useRef({ webviewElement, isWebviewReady, isOpen });
  useEffect(() => {
    const prev = resumeTargetRef.current;
    const targetChanged =
      prev.webviewElement !== webviewElement || prev.isWebviewReady !== isWebviewReady;
    const reopened = isOpen && !prev.isOpen;
    resumeTargetRef.current = { webviewElement, isWebviewReady, isOpen };
    if (!isOpen) {
      // A guest's queued step or a navigation can still reach the open bar's
      // listeners after close(), and ask the page again. Its reply has no
      // listener now, and the recorded request would make a reopen skip ahead.
      if (prev.isOpen && latestRequestRef.current) {
        safeStopFind();
        forgetAnswer();
      }
      return;
    }
    if (!targetChanged && !reopened) return;
    if (isWebviewReady && latestRequestRef.current?.webview === webviewElement) return;
    forgetAnswer();
    if (query && !isComposingRef.current) safeFind(query, { findNext: true });
  }, [webviewElement, isWebviewReady, isOpen, query, forgetAnswer, safeFind, safeStopFind]);

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

  // An answer shows only while the bar still asks what it answered: the same
  // text and case, of the same ready page. Checked here rather than left to the
  // effects that forget it, which run a paint late (a replaced or unready
  // webview) and can be overtaken (a keystroke between a commit and its resume).
  const asked = answer?.request;
  const currentAnswer =
    answer &&
    isWebviewReady &&
    asked?.webview === webviewElement &&
    asked.query === query &&
    asked.matchCase === matchCase
      ? answer
      : null;

  return {
    isOpen,
    query,
    activeMatch: currentAnswer?.activeMatch ?? 0,
    matchCount: currentAnswer?.matchCount ?? 0,
    isPending: query !== "" && currentAnswer === null,
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
