import { useEffect, useState } from "react";
import { paneFocusOf } from "./useCanopyInboxKeyboard";

/**
 * Where the keyboard is in the panel, as far as the keys the open card names
 * go: the search, a row of the list (by its element's id), or the pane's reply
 * or live terminal. Anywhere else no key the card names acts.
 */
export type CanopyKeyboardPlace = "search" | "reply" | "terminal" | `row:${string}` | null;

export function canopyKeyboardPlaceOf(element: Element | null): CanopyKeyboardPlace {
  if (element === null) return null;
  if (element.closest("[data-canopy-search]") !== null) return "search";
  const pane = paneFocusOf(element);
  if (pane === "composer") return "reply";
  if (pane === "terminal") return "terminal";
  const row = element.closest("[data-canopy-card]");
  return row !== null && row.id !== "" ? `row:${row.id}` : null;
}

/** The keyboard's place in the panel while it is open, followed as focus moves. */
export function useCanopyKeyboardPlace(isOpen: boolean): CanopyKeyboardPlace {
  const [place, setPlace] = useState<CanopyKeyboardPlace>(null);
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    const onFocusIn = (event: FocusEvent) => {
      setPlace(canopyKeyboardPlaceOf(event.target instanceof Element ? event.target : null));
    };
    // Focus leaving for nothing (a click on no control, the control unmounting,
    // the window losing it) has no focusin after it: read where it settled.
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget !== null) return;
      queueMicrotask(() => {
        if (live) setPlace(canopyKeyboardPlaceOf(document.activeElement));
      });
    };
    setPlace(canopyKeyboardPlaceOf(document.activeElement));
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      live = false;
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      setPlace(null);
    };
  }, [isOpen]);
  return place;
}
