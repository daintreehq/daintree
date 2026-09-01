import { useEffect, useEffectEvent, type RefObject } from "react";

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
 * focused element, and for a focused pane that element is `ContentPanel`'s
 * `tabIndex={-1}` root — an *ancestor* of the viewer body, not a descendant.
 * Hence a document-level listener plus an explicit ownership test.
 *
 * ## Ownership
 *
 * The keydown target is the focused element, and exactly one element is focused
 * per document, so the target alone decides which mounted region owns the
 * chord — no `isFocused` prop, and stacked dialogs sort themselves out. Focus
 * either sits inside the region (a Markdown link, a diff's focusable rows) or on
 * an ancestor that wraps it (the panel root, a dialog's focus sink), so both
 * containment directions count. `body`/`documentElement` are excluded: they are
 * the target when *nothing* holds focus, and they contain every mounted region,
 * so treating them as ownership would let every instance claim the key at once.
 */
export function useScopedSelectAll(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean = true
): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (event.key !== "a" && event.key !== "A") return;
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

    const doc = container.ownerDocument;
    if (target === doc.body || target === doc.documentElement) return;
    if (!container.contains(target) && !target.contains(container)) return;

    event.preventDefault();
    event.stopPropagation();
    doc.defaultView?.getSelection()?.selectAllChildren(container);
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
