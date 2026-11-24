import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import {
  FORCED_COLORS_QUERY,
  createFindPainter,
  createRenderedTextIndex,
  findInRenderedText,
  firstVisibleMatch,
  matchAfter,
  scrollRangeIntoView,
  selectionSeed,
  type FindPainter,
  type FindResult,
  type RenderedTextIndex,
} from "./renderedFind";

const NO_MATCHES: FindResult = { ranges: [], capped: false };

/** How far a scrolled-to match stays below the top of the pane: the bar's depth plus its inset. */
export const FIND_BAR_CLEARANCE = 56;

/** Where focus goes on close when the element it came from is gone. */
const FOCUS_FALLBACK = "[data-panel-id],[role='dialog']";

function painterOf(ref: React.RefObject<FindPainter | null>): FindPainter {
  ref.current ??= createFindPainter();
  return ref.current;
}

export interface RenderedFindState {
  isOpen: boolean;
  query: string;
  matchCase: boolean;
  matchCount: number;
  /** Zero-based; -1 while nothing matches. */
  activeIndex: number;
  /** More matches exist than were counted. */
  capped: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** IME composition: the query searches once a composition commits, not per keystroke. */
  startComposition: () => void;
  endComposition: (value: string) => void;
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  goNext: () => void;
  goPrev: () => void;
  toggleMatchCase: () => void;
}

/**
 * Find in a rendered document: the bar's state, the search over `root`'s text,
 * and the highlights. The document can change under an open bar (an agent
 * rewriting the file, a code block's highlighting landing, a diagram
 * rendering), so the matches follow it.
 */
export function useRenderedFind(root: HTMLElement | null): RenderedFindState {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [result, setResult] = useState<FindResult>(NO_MATCHES);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);
  const painterRef = useRef<FindPainter | null>(null);
  // The open bar's index of `root`; it goes with the bar or the document.
  const textIndexRef = useRef<RenderedTextIndex | null>(null);
  const refreshFrameRef = useRef(0);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Bumped by every Cmd+F; the effect below focuses the field once the bar
  // that holds it has committed.
  const [focusRequest, setFocusRequest] = useState(0);

  /**
   * A new search starts at the first match in view and scrolls only when that
   * match is not. A refresh of the same search (the document changed under
   * it) never scrolls: it stays on the same words if they survived, and
   * otherwise on the first match in view.
   */
  const search = (nextQuery: string, nextMatchCase: boolean, refresh: boolean) => {
    // This search reads the document as it is now. A refresh still queued
    // would only repeat it, with whatever query was last committed.
    cancelAnimationFrame(refreshFrameRef.current);
    if (!root || nextQuery.length === 0) {
      setResult(NO_MATCHES);
      setActiveIndex(-1);
      return;
    }
    const textIndex = textIndexRef.current;
    const next =
      textIndex?.root === root
        ? textIndex.find(nextQuery, nextMatchCase)
        : findInRenderedText(root, nextQuery, nextMatchCase);
    let index = refresh ? matchAfter(result.ranges[activeIndex], next.ranges) : -1;
    if (index === -1) {
      index = firstVisibleMatch(next.ranges, root, FIND_BAR_CLEARANCE);
      if (!refresh && index >= 0) {
        scrollRangeIntoView(next.ranges[index]!, root, FIND_BAR_CLEARANCE);
      }
    }
    setResult(next);
    setActiveIndex(index);
  };

  const open = () => {
    const seed = root ? selectionSeed(root) : null;
    if (seed !== null && seed !== query) {
      setQueryState(seed);
      if (isOpen) search(seed, matchCase, false);
    }
    if (!isOpen) {
      const focused = document.activeElement;
      restoreFocusRef.current =
        focused instanceof HTMLElement && focused !== document.body ? focused : null;
      // Opening searches through the effect below, once the bar is up.
      setIsOpen(true);
    }
    setFocusRequest((n) => n + 1);
  };

  const close = () => {
    const current = result.ranges[activeIndex];
    painterOf(painterRef).clear();
    cancelAnimationFrame(refreshFrameRef.current);
    textIndexRef.current?.dispose();
    textIndexRef.current = null;
    setIsOpen(false);
    setResult(NO_MATCHES);
    setActiveIndex(-1);
    // Chromium leaves the last match selected on close: it marks where the
    // reader stopped, and Cmd+C copies it.
    if (current && !current.collapsed) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(current);
    }
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    const fallback = root?.closest<HTMLElement>(FOCUS_FALLBACK) ?? null;
    (target?.isConnected ? target : fallback)?.focus({ preventScroll: true });
  };

  const setQuery = (next: string) => {
    setQueryState(next);
    if (!isComposingRef.current) search(next, matchCase, false);
  };

  const startComposition = () => {
    isComposingRef.current = true;
  };

  const endComposition = (value: string) => {
    isComposingRef.current = false;
    setQuery(value);
  };

  const step = (direction: 1 | -1) => {
    const count = result.ranges.length;
    if (count === 0) return;
    const next = activeIndex < 0 ? 0 : (activeIndex + direction + count) % count;
    setActiveIndex(next);
    if (root) scrollRangeIntoView(result.ranges[next]!, root, FIND_BAR_CLEARANCE);
  };

  const toggleMatchCase = () => {
    const next = !matchCase;
    setMatchCase(next);
    search(query, next, false);
  };

  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  // The document can change under the open bar, and the matches follow it
  // without moving the reader; a composition in progress waits for its commit
  // to search. The index lives from commit to commit, so no search or queued
  // refresh reads a document the bar has already left.
  const refresh = useEffectEvent(() => {
    if (query.length > 0 && !isComposingRef.current) search(query, matchCase, true);
  });
  useLayoutEffect(() => {
    if (!isOpen || !root) return;
    const index = createRenderedTextIndex(root, () => {
      cancelAnimationFrame(refreshFrameRef.current);
      refreshFrameRef.current = requestAnimationFrame(() => refresh());
    });
    textIndexRef.current = index;
    return () => {
      cancelAnimationFrame(refreshFrameRef.current);
      index.dispose();
      if (textIndexRef.current === index) textIndexRef.current = null;
    };
  }, [isOpen, root]);

  // The document can arrive after the bar opened (its chunk is lazy), and a
  // reopened bar searches again for the query it kept. When Source mode takes
  // the document away, this drops the matches into it.
  const searchOnArrival = useEffectEvent(() => search(query, matchCase, false));
  useEffect(() => {
    if (isOpen) searchOnArrival();
  }, [isOpen, root]);

  // `close()` clears at once, but a refresh committed just before it can still
  // flush its paint afterwards; the closed render clears that too.
  useEffect(() => {
    if (isOpen) painterOf(painterRef).paint(result.ranges, activeIndex);
    else painterOf(painterRef).clear();
  }, [isOpen, result, activeIndex]);

  // Forced colours decide whether the other matches are painted at all.
  const repaint = useEffectEvent(() => painterOf(painterRef).paint(result.ranges, activeIndex));
  useEffect(() => {
    if (!isOpen || typeof matchMedia !== "function") return;
    const forced = matchMedia(FORCED_COLORS_QUERY);
    const onChange = () => repaint();
    forced.addEventListener("change", onChange);
    return () => forced.removeEventListener("change", onChange);
  }, [isOpen]);

  useEffect(() => {
    const own = painterOf(painterRef);
    return () => own.clear();
  }, []);

  return {
    isOpen,
    query,
    matchCase,
    matchCount: result.ranges.length,
    activeIndex,
    capped: result.capped,
    inputRef,
    startComposition,
    endComposition,
    open,
    close,
    setQuery,
    goNext: () => step(1),
    goPrev: () => step(-1),
    toggleMatchCase,
  };
}
