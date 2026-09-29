import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type {
  PluginListNavigationRowProps,
  UseListNavigationOptions,
  UseListNavigationResult,
} from "@shared/types/plugin-sdk-react";

const TYPEAHEAD_RESET_MS = 500;

/**
 * Where a navigation key lands, skipping rows `blocked` reports disabled.
 * `null` for a key that is not navigation; the current index when every row
 * in that direction is disabled.
 */
function stepIndex(
  key: string,
  index: number,
  count: number,
  loop: boolean,
  blocked: (index: number) => boolean
): number | null {
  // Walk from `start` by `dir`, at most one lap, to the first enabled row.
  const seek = (start: number, dir: 1 | -1, wrap: boolean): number => {
    let at = start;
    for (let steps = 0; steps < count; steps++) {
      if (at < 0 || at >= count) {
        if (!wrap) return index;
        at = (at + count) % count;
      }
      if (!blocked(at)) return at;
      at += dir;
    }
    return index;
  };
  switch (key) {
    case "Home":
      return seek(0, 1, false);
    case "End":
      return seek(count - 1, -1, false);
    case "ArrowDown":
      if (index < 0) return seek(0, 1, false);
      if (index === count - 1 && !loop) return index;
      return seek(index + 1, 1, loop);
    case "ArrowUp":
      if (index < 0) return seek(count - 1, -1, false);
      if (index === 0 && !loop) return index;
      return seek(index - 1, -1, loop);
    default:
      return null;
  }
}

function nearestEnabled(index: number, count: number, blocked: (index: number) => boolean) {
  if (index < 0 || !blocked(index)) return index;
  for (let at = index + 1; at < count; at++) if (!blocked(at)) return at;
  for (let at = index - 1; at >= 0; at--) if (!blocked(at)) return at;
  return -1;
}

/**
 * The keyboard model of a list the palettes share: one tab stop on the list,
 * the cursor moved by Up/Down/Home/End (and typeahead with `getLabel`), Enter
 * or Space to select. The cursor is an `aria-activedescendant`, so focus stays
 * on the list element and a virtualised list only has to keep the active row
 * mounted (pass `activeIndex` to `VirtualList`). Rows `isDisabled` reports
 * are skipped by the cursor and never selected, as in a listbox.
 */
export function useListNavigation(options: UseListNavigationOptions): UseListNavigationResult {
  const count =
    typeof options.count === "number" && Number.isFinite(options.count)
      ? Math.max(0, Math.floor(options.count))
      : 0;
  const loop = options.loop === true;
  const onSelect = typeof options.onSelect === "function" ? options.onSelect : undefined;
  const getLabel = typeof options.getLabel === "function" ? options.getLabel : undefined;
  const isDisabledOption =
    typeof options.isDisabled === "function" ? options.isDisabled : undefined;
  const isDisabled = (index: number): boolean => {
    if (!isDisabledOption || index < 0) return false;
    try {
      return isDisabledOption(index) === true;
    } catch {
      return false;
    }
  };
  const initial =
    typeof options.initialIndex === "number" && Number.isInteger(options.initialIndex)
      ? options.initialIndex
      : 0;

  const baseId = useId();
  const [cursor, setCursor] = useState(initial);
  const typeahead = useRef({ text: "", at: 0 });
  const [revealIndex, setRevealIndex] = useState(-1);

  // Clamped at read time, not corrected in an effect: the list can shrink under
  // the cursor, and for a frame the highlight and Enter's target would differ.
  // A cursor on a disabled row (the initial index, or `setActiveIndex`) moves
  // to the nearest enabled row after it, else before it; -1 when none is.
  const clamped = count === 0 ? -1 : Math.min(Math.max(cursor, 0), count - 1);
  const activeIndex = nearestEnabled(clamped, count, isDisabled);
  const rowId = (index: number) => `${baseId}option-${index}`;

  // Only after a keyboard move: scrolling on mount or on hover would yank the
  // page. A virtualised list scrolls through `activeIndex` instead, and there
  // the row may not be mounted yet, so a miss is fine.
  useEffect(() => {
    if (revealIndex < 0) return;
    document.getElementById(`${baseId}option-${revealIndex}`)?.scrollIntoView?.({
      block: "nearest",
    });
  }, [baseId, revealIndex]);

  const moveTo = (index: number) => {
    setCursor(index);
    setRevealIndex(index);
  };

  const findByPrefix = (prefix: string): number => {
    if (!getLabel) return -1;
    const needle = prefix.toLowerCase();
    for (let offset = 1; offset <= count; offset++) {
      const index = (Math.max(activeIndex, 0) + offset) % count;
      const label = getLabel(index);
      if (isDisabled(index)) continue;
      if (typeof label === "string" && label.toLowerCase().startsWith(needle)) return index;
    }
    return -1;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (count === 0) return;
    const next = stepIndex(event.key, activeIndex, count, loop, isDisabled);
    if (next !== null) {
      event.preventDefault();
      moveTo(next);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      // A Space mid-typeahead is part of the word being typed.
      if (event.key === " " && typeahead.current.text !== "") {
        const now = Date.now();
        if (now - typeahead.current.at < TYPEAHEAD_RESET_MS) {
          event.preventDefault();
          typeahead.current = { text: `${typeahead.current.text} `, at: now };
          return;
        }
      }
      event.preventDefault();
      if (activeIndex >= 0 && !isDisabled(activeIndex)) onSelect?.(activeIndex);
      return;
    }
    if (getLabel && event.key.length === 1) {
      const now = Date.now();
      const text =
        now - typeahead.current.at < TYPEAHEAD_RESET_MS
          ? typeahead.current.text + event.key
          : event.key;
      typeahead.current = { text, at: now };
      // Pressing one letter repeatedly cycles through the rows starting with it.
      const first = text.charAt(0);
      const repeated = text.length > 1 && [...text].every((char) => char === first);
      const match = findByPrefix(repeated ? first : text);
      if (match >= 0) {
        event.preventDefault();
        moveTo(match);
      }
    }
  };

  const getRowProps = (index: number): PluginListNavigationRowProps => {
    const disabled = isDisabled(index);
    return {
      id: rowId(index),
      role: "option",
      "aria-selected": index === activeIndex,
      ...(disabled ? { "aria-disabled": true as const } : {}),
      onClick: () => {
        if (isDisabled(index)) return;
        setCursor(index);
        onSelect?.(index);
      },
      onPointerMove: () => {
        if (index !== activeIndex && !isDisabled(index)) setCursor(index);
      },
    };
  };

  return {
    activeIndex,
    setActiveIndex: (index: number) => {
      if (Number.isInteger(index)) moveTo(index);
    },
    containerProps: {
      role: "listbox",
      tabIndex: 0,
      "aria-activedescendant": activeIndex >= 0 ? rowId(activeIndex) : undefined,
      onKeyDown,
    },
    getRowProps,
  };
}
