import { useCallback, useRef, useState } from "react";
import type React from "react";
import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import { PopoverAnchor } from "@/components/ui/popover";
import { MoveToWorktreePicker } from "@/components/Panel/MoveToWorktreePicker";

/** A zero-size point the picker hangs off, tracking the pane it sits in. */
export interface MovePickerAnchor {
  contextElement: HTMLElement;
  getBoundingClientRect: () => DOMRect;
}

/**
 * The move-to-worktree picker a panel's context menu opens from "More
 * worktrees…": where it hangs, where focus goes back to, and the handoff from
 * the menu's close so the menu's own focus return can't land after the picker
 * has taken focus.
 */
export function useMovePickerCoordination(
  terminalId: string,
  proxy: boolean,
  triggerScope: "surface" | "header"
) {
  // Which panel the picker was opened for, not a bare flag: the dock's tab
  // group hands this menu a new terminal when its active tab changes, and the
  // picker must not quietly retarget. Dropped during render so switching back
  // can't reopen it.
  const [movePickerPanelId, setMovePickerPanelId] = useState<string | null>(null);
  if (movePickerPanelId !== null && movePickerPanelId !== terminalId) {
    setMovePickerPanelId(null);
  }
  const isMovePickerOpen = movePickerPanelId !== null;
  // Mounted from the first opening on, not with the menu: every pane has one,
  // and the content carries its own positioning observers. Kept after that so
  // the picker still gets its exit animation.
  const [hasOpenedMovePicker, setHasOpenedMovePicker] = useState(false);
  const [movePickerAnchor, setMovePickerAnchor] = useState<MovePickerAnchor | null>(null);
  // Selecting "More worktrees…" records the intent and the root content's
  // close hook spends it — the only one that runs, since Radix pins the
  // submenu's own. Opening straight from `onSelect` would raise the picker while
  // the menu still holds the focus trap, and the menu's focus return would then
  // land after the picker had focused its search field.
  const pendingMovePickerRef = useRef<string | null>(null);
  // Captured on every gesture that can open the menu. A context menu has no
  // trigger to hang the picker off or hand a keyboard dismissal back to, so the
  // pane stands in.
  const capturedMovePickerAnchorRef = useRef<MovePickerAnchor | null>(null);
  const movePickerReturnFocusRef = useRef<HTMLElement | null>(null);

  const handleMovePickerOpenChange = useCallback(
    (open: boolean) => setMovePickerPanelId(open ? terminalId : null),
    [terminalId]
  );

  const handleMoveToWorktreeMore = useCallback(() => {
    pendingMovePickerRef.current = terminalId;
  }, [terminalId]);

  const clearPendingMovePicker = useCallback(() => {
    pendingMovePickerRef.current = null;
  }, []);

  const captureMovePickerAnchor = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      // The trigger wrapper is `display: contents` and has no box of its own.
      const pane = event.currentTarget.firstElementChild;
      if (!(pane instanceof HTMLElement)) {
        capturedMovePickerAnchorRef.current = null;
        movePickerReturnFocusRef.current = null;
        return;
      }
      // Where the menu opened, kept relative to the pane: the picker takes the
      // menu's place. Hung off the pane's own rect, it would have to sit outside
      // a box that usually fills the window's height, with no room either side.
      const bounds = pane.getBoundingClientRect();
      const offsetX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
      const offsetY = Math.min(Math.max(event.clientY - bounds.top, 0), bounds.height);
      // A panel surface takes focus back itself. A proxy's first child is a
      // row or tab wrapper, so return to the control that was right-clicked.
      const FOCUSABLE = 'button, [tabindex]:not([tabindex="-1"]), [role="tab"]';
      const hit =
        proxy && event.target instanceof Element
          ? event.target.closest<HTMLElement>(FOCUSABLE)
          : null;
      const focusable =
        hit && pane.contains(hit) ? hit : proxy ? pane.querySelector<HTMLElement>(FOCUSABLE) : null;
      // A header-scoped trigger wraps the title bar, not the surface that takes focus.
      const panelRoot =
        triggerScope === "header" ? pane.closest<HTMLElement>("[data-panel-id]") : null;
      movePickerReturnFocusRef.current = focusable ?? panelRoot ?? pane;
      capturedMovePickerAnchorRef.current = {
        // Lets Floating UI follow the pane itself when it moves or resizes.
        contextElement: pane,
        getBoundingClientRect: () => {
          const rect = pane.getBoundingClientRect();
          return DOMRect.fromRect({
            x: rect.left + Math.min(offsetX, rect.width),
            y: rect.top + Math.min(offsetY, rect.height),
            width: 0,
            height: 0,
          });
        },
      };
    },
    [proxy, triggerScope]
  );

  /**
   * Spent from the root content's close hook. Returns whether the picker
   * claimed this close.
   */
  const spendPendingMovePicker = useCallback(
    (event: Event): boolean => {
      const pendingPanelId = pendingMovePickerRef.current;
      pendingMovePickerRef.current = null;
      if (pendingPanelId === null || pendingPanelId !== terminalId) return false;
      const anchor = capturedMovePickerAnchorRef.current;
      if (!anchor?.contextElement.isConnected) return false;
      // The picker takes focus into its search field; handing it back to the
      // pane first would only flash a ring on the way.
      event.preventDefault();
      setMovePickerAnchor(anchor);
      setHasOpenedMovePicker(true);
      setMovePickerPanelId(terminalId);
      return true;
    },
    [terminalId]
  );

  return {
    isMovePickerOpen,
    hasOpenedMovePicker,
    movePickerAnchor,
    movePickerReturnFocusRef,
    handleMovePickerOpenChange,
    handleMoveToWorktreeMore,
    clearPendingMovePicker,
    captureMovePickerAnchor,
    spendPendingMovePicker,
  };
}

export function MoveToWorktreeMenuPicker({
  panelId,
  currentWorktreeId,
  isOpen,
  anchor,
  onOpenChange,
  returnFocusRef,
}: {
  panelId: string;
  currentWorktreeId: string | undefined;
  isOpen: boolean;
  anchor: MovePickerAnchor | null;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
  return (
    <AppPalettePopover
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      // Modal like the header's: Tab cycles inside, and the outside press that
      // dismisses it doesn't also land on what it hit.
      modal={true}
    >
      <PopoverAnchor virtualRef={{ current: anchor }} />
      <MoveToWorktreePicker
        panelId={panelId}
        currentWorktreeId={currentWorktreeId}
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        returnFocusRef={returnFocusRef}
        // Opens from the point the way the menu did.
        align="start"
      />
    </AppPalettePopover>
  );
}
