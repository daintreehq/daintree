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
export function useRovingRows({
  keys,
  preferredKey = null,
  reveal,
  windowed = false,
}: UseRovingRowsArgs): UseRovingRowsResult {
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [stopMounted, setStopMounted] = useState(false);
  const pendingFocusRef = useRef<string | null>(null);
  const elementsRef = useRef(new Map<string, HTMLElement>());

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
      if (!(target instanceof Element) || !target.closest("[data-roving-row]")) return;
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
    [keys, tabStopKey, focusRow]
  );

  const onContainerFocus = useCallback(
    (event: Pick<React.FocusEvent, "target" | "currentTarget">) => {
      if (event.target !== event.currentTarget || tabStopKey === null) return;
      focusRow(tabStopKey, keys.indexOf(tabStopKey));
    },
    [keys, tabStopKey, focusRow]
  );

  const onRowFocus = useCallback((key: string) => {
    setCursorKey(key);
  }, []);

  const rowRef = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      // Unmounts are left in the map: a windowed row comes and goes as it
      // scrolls, and every read checks `isConnected` before trusting an entry.
      if (!element) return;
      elementsRef.current.set(key, element);
      if (pendingFocusRef.current === key) {
        pendingFocusRef.current = null;
        element.focus();
      }
    },
    []
  );

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
      tabIndex: windowed && tabStopKey !== null && !stopMounted ? 0 : undefined,
      onFocus: onContainerFocus,
    },
  };
}
