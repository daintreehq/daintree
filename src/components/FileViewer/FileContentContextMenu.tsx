import { useRef } from "react";
import type React from "react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  isFileRowMenuKey,
  openFileRowMenuFromKeyboard,
  stopFileRowMenuPropagation,
} from "@/hooks/useFileRowMenuItems";

/** Whether the right-click landed on something that takes text input. */
export function isEditableMenuTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select") !== null;
}

/**
 * Whether the reader has text selected inside `region`. Scoped so a selection
 * left standing in another pane doesn't turn this one's right-click into a lone
 * Copy for text it can't see.
 */
export function hasTextSelectionWithin(region: Element): boolean {
  const selection = region.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  if (selection.toString().length === 0) return false;
  const { anchorNode, focusNode } = selection;
  return (
    (anchorNode !== null && region.contains(anchorNode)) ||
    (focusNode !== null && region.contains(focusNode))
  );
}

/** A press that will open a context menu: the secondary button, or macOS's Control-click. */
function isMenuPress(event: React.PointerEvent): boolean {
  return event.button === 2 || (event.button === 0 && event.ctrlKey);
}

export interface FileContentContextMenuProps {
  /**
   * The file's menu items, from `useFileRowMenuItems`. `null` when the region
   * isn't showing a file — the trigger then stands down entirely and the
   * right-click falls through to whatever encloses it.
   */
  items: React.ReactNode;
  /** The content region itself. Must be a single element that forwards its ref. */
  children: React.ReactElement;
}

/**
 * The file menu on an open file's content (#13423) — the same canonical items
 * a tree row offers, so a file never gains or loses an action by where it is
 * shown. Wraps the existing body element rather than adding one, so its refs,
 * scroll container and height contract are untouched.
 *
 * Text editing wins over the file menu: with text selected or an editable
 * target under the pointer, the gesture goes to the native edit menu instead.
 *
 * Content that renders out of process — a PDF, rendered HTML — never delivers
 * its `contextmenu` to this document, so those get the menu only on the
 * region around the frame.
 */
export function FileContentContextMenu({ items, children }: FileContentContextMenuProps) {
  const disabled = items === null || items === undefined || items === false;
  // Sampled on the press, not at `contextmenu`: on macOS, Blink selects the
  // word under the pointer as part of the right-button press, so by the time
  // the menu event fires every right-click on text looks like a selection. A
  // keyboard-opened menu has no press and reads the selection live.
  const selectionAtPressRef = useRef<boolean | null>(null);

  const handlePointerDownCapture = (event: React.PointerEvent<HTMLElement>) => {
    selectionAtPressRef.current = isMenuPress(event)
      ? hasTextSelectionWithin(event.currentTarget)
      : null;
  };

  // Any key ends the press's claim: a right-press that never produced a menu
  // (it became a drag, say) would otherwise hand its stale answer to the next
  // keyboard-opened one, after the selection has moved on.
  const handleKeyDownCapture = () => {
    selectionAtPressRef.current = null;
  };

  // Menu / Shift+F10. `data-row-menu` stands the global panel-menu handler
  // down so these keys reach here. With text selected or an editable target
  // the key is left alone: Chromium raises its own `contextmenu` for it, which
  // the capture guard below defers to the native edit menu like a right-click.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!isFileRowMenuKey(event)) return;
    if (isEditableMenuTarget(event.target) || hasTextSelectionWithin(event.currentTarget)) return;
    event.preventDefault();
    event.stopPropagation();
    openFileRowMenuFromKeyboard(event.currentTarget);
  };

  // Capture phase on the trigger itself, so it runs before Radix's
  // bubble-phase handler and before any enclosing panel menu: stopping
  // propagation here keeps both from seeing the event at all. The default is
  // deliberately left alone — a prevented default is what tells Electron a
  // surface owned the gesture, and the main process offers Cut/Copy/Paste only
  // for one nothing claimed.
  const handleContextMenuCapture = (event: React.MouseEvent<HTMLElement>) => {
    const selectionAtPress = selectionAtPressRef.current;
    selectionAtPressRef.current = null;
    const hasSelection = selectionAtPress ?? hasTextSelectionWithin(event.currentTarget);
    if (hasSelection || isEditableMenuTarget(event.target)) {
      event.stopPropagation();
    }
  };

  // Always wrapped, and disabled rather than unwrapped when there is no file:
  // swapping the wrapper in and out would remount the body element, and the
  // panes hang refs and observers off it. A disabled trigger neither prevents
  // the default nor stops propagation, so the enclosing surface's menu opens.
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        disabled={disabled}
        {...(disabled ? {} : { "data-row-menu": "" })}
        onPointerDownCapture={disabled ? undefined : handlePointerDownCapture}
        onKeyDownCapture={disabled ? undefined : handleKeyDownCapture}
        onKeyDown={disabled ? undefined : handleKeyDown}
        onContextMenuCapture={disabled ? undefined : handleContextMenuCapture}
        onContextMenu={disabled ? undefined : stopFileRowMenuPropagation}
      >
        {children}
      </ContextMenuTrigger>
      {!disabled && <ContextMenuContent>{items}</ContextMenuContent>}
    </ContextMenu>
  );
}
