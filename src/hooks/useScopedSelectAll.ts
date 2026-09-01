import { useEffect, useEffectEvent, type RefObject } from "react";

/**
 * The surfaces that bound a Select All. A viewer body owns the chord for the
 * pane or dialog it lives in — `ContentPanel`'s root carries `data-panel-id`,
 * `AppDialog`'s content carries the dialog role — and for nothing outside it.
 */
const SELECT_ALL_SCOPE = "[data-panel-id],[role='dialog'],[role='alertdialog']";

/**
 * Give a read-only rendered region an owner for Select All.
 *
 * The Edit menu's Select All is a native accelerator that ends in
 * `webContents.selectAll()` (electron/menu.ts). Chromium only scopes that
 * command to the focused element when the element is *editable*; with focus on
 * plain non-editable DOM it falls back to selecting the whole document — the
 * sidebar, toolbars and tree along with the text the user is actually reading
 * (#12135). CodeMirror and xterm escape this because both bind the chord
 * themselves and `preventDefault()` it; a rendered Markdown document or diff
 * has no such owner.
 *
 * `registerAccelerator: false` cannot be the fix: it is a Windows/Linux knob and
 * a no-op on macOS, where the accelerator always binds as an AppKit key
 * equivalent. The renderer gets the keydown first, though, and AppKit never
 * sees a key the page has already handled — so preventing the event here is
 * what suppresses the native command, on every platform.
 *
 * ## Why the listener is on `document`
 *
 * A listener on `ref.current` would never fire. Keydown bubbles up from the
 * focused element, and that element is rarely inside the viewer body: a focused
 * pane puts it on `ContentPanel`'s `tabIndex={-1}` root, an *ancestor*, and the
 * file browser leaves it on the tree root, a *sibling*. Hence a document-level
 * listener plus an explicit ownership test.
 *
 * ## Ownership
 *
 * The keydown target is the focused element, and exactly one element is focused
 * per document, so the target alone decides which mounted region owns the
 * chord — no `isFocused` prop, and stacked panes and dialogs sort themselves
 * out. Ownership is the region's *enclosing pane or dialog*, not the region
 * itself: focus legitimately rests on the pane root, on a toolbar button, or on
 * the file tree beside the preview, and Select All should mean "the document
 * I'm looking at" in all of them.
 *
 * Bounding it at that scope rather than walking ancestors freely is what keeps
 * the rule single-valued. F6 focuses the grid's macro-region wrapper, which
 * encloses *every* open pane; an unbounded "is the target an ancestor?" test
 * would make each mounted viewer claim that keypress and let mount order pick
 * the winner. Outside its own pane, a viewer declines.
 */
export function useScopedSelectAll(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean = true
): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (event.key !== "a" && event.key !== "A") return;
    // Mid-composition the keystroke belongs to the IME, not to us.
    if (event.isComposing) return;
    // A higher-priority owner already claimed the chord — an explicit user
    // keybinding, or an editor that handled it on the way up. Never override.
    if (event.defaultPrevented) return;

    const container = ref.current;
    if (!container) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    // Select All inside a text field must stay Select All *of that field*.
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }

    // No enclosing pane or dialog: fall back to the region itself, so an
    // unhosted viewer still owns focus landing inside it.
    const scope = container.closest(SELECT_ALL_SCOPE) ?? container;
    if (!scope.contains(target)) return;

    event.preventDefault();
    event.stopPropagation();
    container.ownerDocument.defaultView?.getSelection()?.selectAllChildren(container);
  });

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => handleKeyDown(event);
    // Bubble phase, so anything inside the region that owns the chord for
    // itself still gets it first.
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled]);
}
