import { useCallback, useRef, useState } from "react";
import type React from "react";

export interface UseRovingRowsArgs {
  /** Row identities in the order the list displays them. */
  keys: readonly string[];
  /**
   * The row the tab stop should rest on when the user has not moved it — the
   * file the viewer is showing, say. Ignored when it is not in `keys`.
   */
  preferredKey?: string | null;
  /**
   * Bring the row at this display position into the DOM. A windowed list needs
   * it: the row an arrow press lands on may not be mounted yet, and focus
   * follows once it is (see `rowRef`).
   */
  reveal?: (position: number) => void;
  /**
   * The list windows its rows, so the tab-stop row can be scrolled out of the
   * DOM. Rows then report their mount through `reportTabStopMounted`, and while
   * the stop is gone the container takes the tab stop in its place.
   */
  windowed?: boolean;
  /**
   * The list's own container ref, when it already has one. Otherwise spread
   * `containerProps.ref` on the container.
   */
  containerRef?: React.RefObject<HTMLElement | null>;
}

export interface UseRovingRowsResult {
  /** The one row that carries `tabIndex={0}`; every other row is `-1`. */
  tabStopKey: string | null;
  /** Container `onKeyDown`: Up/Down step, Home/End jump. */
  onKeyDown: (event: React.KeyboardEvent) => void;
  /** Row `onFocus`, so a click or a Tab moves the stop with it. */
  onRowFocus: (key: string) => void;
  /** Row ref: focuses a row an arrow press was waiting on as soon as it mounts. */
  rowRef: (key: string) => (element: HTMLElement | null) => void;
  /** Called by the tab-stop row on mount (`true`) and unmount (`false`). */
  reportTabStopMounted: (mounted: boolean) => void;
  /**
   * Spread on the list container. Inert unless the stop row is windowed out;
   * then the container is the tab stop, and Tab into it lands on the
   * remembered row instead of skipping a list whose every mounted row is -1.
   */
  containerProps: {
    ref: (element: HTMLElement | null) => void;
    onBlur: (event: Pick<React.FocusEvent, "relatedTarget" | "currentTarget">) => void;
    tabIndex: number | undefined;
    onFocus: (event: Pick<React.FocusEvent, "target" | "currentTarget">) => void;
  };
}

/**
 * One tab stop for a persistent list of rows, with the arrow keys moving it.
 *
 * For lists that are NOT listboxes: rows here carry their own controls (a viewed
 * checkbox, a row menu), which the ARIA content model forbids inside an option,
 * so each row keeps its own button and this roves real DOM focus between them.
 * The popover pickers have `useListboxCursor` instead, which drives
 * `aria-activedescendant` and owns Enter and Escape; here Enter and Space stay
 * with the focused row's own button.
 *
 * No wrap at the ends, like the Review Hub's file list and the APG listbox
 * default: in a long list, wrapping turns one press too many into a jump to the
 * other end.
 */
function noopRef(): void {}

export function useRovingRows({
  keys,
  preferredKey = null,
  reveal,
  windowed = false,
  containerRef: externalContainerRef,
}: UseRovingRowsArgs): UseRovingRowsResult {
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [stopMounted, setStopMounted] = useState(false);
  const pendingFocusRef = useRef<string | null>(null);
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const ownContainerRef = useRef<HTMLElement | null>(null);
  const containerRef = externalContainerRef ?? ownContainerRef;
  // Set while focus sits on the container because the focused row scrolled out
  // of the window — so the container does not bounce it straight back.
  const parkedRef = useRef(false);
  // The row that last took focus inside this list, cleared when focus moves
  // somewhere else — so a row scrolling out while the user is elsewhere never
  // pulls focus into the list.
  const focusedKeyRef = useRef<string | null>(null);

  // Resolved at read time, so a filter that removes the stop's row can never
  // leave the list with no tab stop at all for a render.
  const tabStopKey =
    cursorKey !== null && keys.includes(cursorKey)
      ? cursorKey
      : preferredKey !== null && keys.includes(preferredKey)
        ? preferredKey
        : (keys[0] ?? null);

  const focusRow = useCallback(
    (key: string, position: number) => {
      const element = elementsRef.current.get(key);
      if (element?.isConnected) {
        element.focus();
        return;
      }
      pendingFocusRef.current = key;
      reveal?.(position);
    },
    [reveal]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (keys.length === 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // The container itself counts: it holds focus while the focused row is
      // windowed out, and the arrows have to keep working from there.
      if (
        !target.closest("[data-roving-row]") &&
        target !== event.currentTarget &&
        target !== containerRef.current
      ) {
        return;
      }
      const from = tabStopKey === null ? -1 : keys.indexOf(tabStopKey);
      let to: number;
      switch (event.key) {
        case "ArrowDown":
          to = from < 0 ? 0 : Math.min(from + 1, keys.length - 1);
          break;
        case "ArrowUp":
          to = from < 0 ? keys.length - 1 : Math.max(from - 1, 0);
          break;
        case "Home":
          to = 0;
          break;
        case "End":
          to = keys.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      const key = keys[to]!;
      setCursorKey(key);
      focusRow(key, to);
    },
    [keys, tabStopKey, focusRow, containerRef]
  );

  const onContainerFocus = useCallback(
    (event: Pick<React.FocusEvent, "target" | "currentTarget">) => {
      if (event.target !== event.currentTarget || tabStopKey === null) return;
      if (parkedRef.current) {
        parkedRef.current = false;
        return;
      }
      // Only as the Tab stand-in. A pointer landing on the list's padding
      // focuses the container too, and must not scroll the list anywhere.
      if (stopMounted) return;
      focusRow(tabStopKey, keys.indexOf(tabStopKey));
    },
    [keys, tabStopKey, focusRow, stopMounted]
  );

  const onRowFocus = useCallback((key: string) => {
    focusedKeyRef.current = key;
    setCursorKey(key);
  }, []);

  const onContainerBlur = useCallback(
    (event: Pick<React.FocusEvent, "relatedTarget" | "currentTarget">) => {
      const next = event.relatedTarget;
      // A null related target is a window blur or the focused row being
      // removed, and both have to leave the record alone.
      if (next instanceof Node && !event.currentTarget.contains(next)) {
        focusedKeyRef.current = null;
      }
    },
    []
  );

  const rowRef = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      // Unmounts are left in the map: a windowed row comes and goes as it
      // scrolls, and every read checks `isConnected` before trusting an entry.
      if (!element) {
        // React also passes null on every re-render (the callback is new each
        // time), so whether this was an unmount is only knowable after the
        // commit. If the row is gone and took focus with it, park focus on the
        // list rather than leave the keyboard user on the document.
        const detached = elementsRef.current.get(key);
        queueMicrotask(() => {
          const container = containerRef.current;
          if (focusedKeyRef.current !== key) return;
          if (!detached || detached.isConnected || !container?.isConnected) return;
          if (document.activeElement !== document.body && document.activeElement !== null) {
            return;
          }
          parkedRef.current = true;
          container.focus({ preventScroll: true });
        });
        return;
      }
      elementsRef.current.set(key, element);
      if (pendingFocusRef.current === key) {
        pendingFocusRef.current = null;
        element.focus();
        return;
      }
      // Scrolled back into the window while focus was parked on the list: give
      // it back, so the next Tab leaves the list instead of re-entering it.
      const container = containerRef.current;
      if (
        focusedKeyRef.current === key &&
        container !== null &&
        document.activeElement === container
      ) {
        element.focus({ preventScroll: true });
      }
    },
    [containerRef]
  );

  const setContainer = useCallback((element: HTMLElement | null) => {
    ownContainerRef.current = element;
  }, []);

  const reportTabStopMounted = useCallback((mounted: boolean) => {
    setStopMounted(mounted);
  }, []);

  return {
    tabStopKey,
    onKeyDown,
    onRowFocus,
    rowRef,
    reportTabStopMounted,
    containerProps: {
      ref: externalContainerRef ? noopRef : setContainer,
      onBlur: onContainerBlur,
      // -1 rather than nothing on a windowed list, so focus can be parked here.
      tabIndex: windowed ? (tabStopKey !== null && !stopMounted ? 0 : -1) : undefined,
      onFocus: onContainerFocus,
    },
  };
}
