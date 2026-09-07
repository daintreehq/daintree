import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Selector for the controls a toolbar owns. Deliberately narrow: only elements
 * that are genuinely actionable belong in the roving order, and anything the
 * author has explicitly removed from the tab order (`tabindex="-1"` set by
 * something other than us) stays out.
 */
const CONTROL_SELECTOR = 'button:not([disabled]), [role="button"]:not([aria-disabled="true"])';

/**
 * The WAI-ARIA toolbar pattern: the whole row is ONE tab stop, and Left/Right
 * move between its controls.
 *
 * Without this, a dense header is a Tab trap in miniature — the file browser's
 * rooted tree header carries a root anchor, a path button, up-one-level, a view
 * menu and a column toggle, so reaching the tree past it costs five presses,
 * and the viewer's toolbar costs several more. The APG's answer is roving
 * tabindex, and it is a hard requirement rather than a preference.
 *
 * Roving is applied imperatively against the live DOM rather than by threading
 * a tabIndex prop through every control. The toolbars this serves are composed
 * from a namespace of primitives whose children are supplied by four different
 * panels, several conditionally rendered, one of them a Radix menu trigger —
 * so the set changes shape constantly, and a hook that reads the DOM after each
 * render always sees the row that actually exists. Threading props would mean
 * every caller correctly enumerating and ordering its own children forever.
 *
 * @param ref        the toolbar container
 * @param enabled    false leaves the DOM completely untouched, for a container
 *                   that is not currently acting as a toolbar
 */
export function useToolbarRoving(
  ref: RefObject<HTMLElement | null>,
  enabled = true
): (event: React.KeyboardEvent<HTMLElement>) => void {
  // Which control currently holds the row's single tab stop. Kept as an index
  // rather than a node so a re-render that swaps controls (the viewer toggle
  // changes icon, Up one level appears on re-root) cannot leave a stale
  // reference pinning the tab stop to a node no longer in the document.
  const activeIndexRef = useRef(0);

  const controls = useCallback((): HTMLElement[] => {
    const root = ref.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(
      // A control inside an open portalled menu is not part of this row.
      (element) => element.closest("[data-radix-popper-content-wrapper]") === null
    );
  }, [ref]);

  // Give the row's single tab stop to `active` and take it from everyone else.
  const applyStop = useCallback((items: HTMLElement[], active: number): void => {
    activeIndexRef.current = active;
    items.forEach((item, index) => {
      item.tabIndex = index === active ? 0 : -1;
    });
  }, []);

  // Re-applied after every render, because the control set is conditional: the
  // root anchor becomes a button when the tree is scoped, Up one level appears
  // with it, and the viewer's actions come and go with the selection. An effect
  // without dependencies runs on each commit, which is exactly the cadence the
  // DOM changes at.
  useEffect(() => {
    if (!enabled) return;
    const items = controls();
    if (items.length === 0) return;

    // Focus wins over the remembered index whenever it is already inside the
    // row: a control appearing ahead of the focused one shifts every index
    // after it, so trusting the index alone would hand the tab stop to a
    // different control and mark the focused one `tabindex="-1"`.
    //
    // Clamp for the rest: a control disappearing from the middle of the row
    // should leave the tab stop near where it was, not throw it back to the
    // start of the toolbar.
    const focused = items.findIndex((item) => item === document.activeElement);
    applyStop(items, focused === -1 ? Math.min(activeIndexRef.current, items.length - 1) : focused);
  });

  // Repairing on commit alone is not enough, because focus moves on its own
  // schedule. A pointer click focuses whichever control was hit — routinely one
  // the row currently marks `tabindex="-1"` — and nothing guarantees the
  // toolbar's owner re-renders afterwards, since a descendant can re-render
  // alone. Leaving focus on an untabbable control is what lets Tab escape a
  // focus trap: `TABBABLE_SELECTOR` excludes negative tabindex, so AppDialog
  // stops recognising the focused element as the row's first or last and never
  // wraps. `focusin` rather than `focus` because only the former bubbles, so one
  // listener on the container covers every control the row will ever hold.
  useEffect(() => {
    if (!enabled) return;
    const root = ref.current;
    if (!root) return;

    const handleFocusIn = (event: FocusEvent): void => {
      const items = controls();
      const index = items.findIndex((item) => item === event.target);
      if (index === -1) return;
      applyStop(items, index);
    };

    root.addEventListener("focusin", handleFocusIn);
    return () => root.removeEventListener("focusin", handleFocusIn);
  }, [applyStop, controls, enabled, ref]);

  return useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (!enabled) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      const items = controls();
      if (items.length === 0) return;

      // Where focus actually is, not where we last put it: a pointer click
      // moves focus without telling us, and arrowing from there must continue
      // from the clicked control rather than jumping somewhere else.
      const current = items.findIndex((item) => item === document.activeElement);
      if (current === -1) return;

      let next: number;
      switch (event.key) {
        // Wrapping, per the APG: the row is a loop, and stopping at the ends
        // makes the last control a dead end for a key that has nothing else to
        // do here.
        case "ArrowRight":
          next = (current + 1) % items.length;
          break;
        case "ArrowLeft":
          next = (current - 1 + items.length) % items.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = items.length - 1;
          break;
        default:
          return;
      }

      // Only once a branch above claimed the key — an unhandled key must keep
      // its default behaviour, which for a toolbar includes Tab leaving it.
      event.preventDefault();
      event.stopPropagation();
      applyStop(items, next);
      items[next]?.focus();
    },
    [applyStop, controls, enabled]
  );
}
