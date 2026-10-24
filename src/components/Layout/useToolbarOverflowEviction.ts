import { useEffect } from "react";
import type React from "react";
import type { AnyToolbarButtonId } from "@shared/types/toolbar";
import { useUIStore } from "@/store/uiStore";
import { closePluginToolbarPopoverIfHidden } from "./PluginToolbarPopover";
import type { ForgeStatsHandle } from "./ForgeStatsToolbarButton";

export interface ToolbarOverflowEvictionInput {
  measuredLeftOverflow: AnyToolbarButtonId[];
  measuredRightOverflow: AnyToolbarButtonId[];
  demotedIds: ReadonlySet<AnyToolbarButtonId>;
  copyTreeOnRight: boolean;
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  forgeStatsRef: React.RefObject<ForgeStatsHandle | null>;
  recordCopyTreeEvictionFocus: (target: HTMLElement | null) => void;
  setCopyTreeOpen: (open: boolean) => void;
}

export function useToolbarOverflowEviction({
  measuredLeftOverflow,
  measuredRightOverflow,
  demotedIds,
  copyTreeOnRight,
  toolbarRef,
  forgeStatsRef,
  recordCopyTreeEvictionFocus,
  setCopyTreeOpen,
}: ToolbarOverflowEvictionInput) {
  // Close open dropdowns when their buttons move into overflow. Keyed on the
  // overflow hook's own results and the demoted set, not the merged lists:
  // those are rebuilt whenever the button registry is (a problem count, the
  // copy-tree hover), and re-running on each would shut a forge dropdown the
  // user just opened from the `…` menu of a project that demotes the pill.
  useEffect(() => {
    const overflowSet = new Set<AnyToolbarButtonId>([
      ...measuredLeftOverflow,
      ...measuredRightOverflow,
      ...demotedIds,
    ]);
    if (overflowSet.has("forge-stats")) {
      forgeStatsRef.current?.closeAll();
    }
    if (overflowSet.has("notification-center")) {
      useUIStore.getState().closeNotificationCenter();
    }
    // The panel is portaled to document.body, so the wrapper's `invisible
    // absolute` eviction styles never reach it — an open panel would strand on
    // screen and then re-anchor to the hidden button's rect on the next resize.
    if (overflowSet.has("copy-tree")) {
      // The menu portals out of the toolbar, so "is focus inside it?" is a
      // closest() against the content's marker, not a DOM-ancestor check
      // from the trigger.
      const focusWasInPanel =
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest("[data-copy-tree-panel]") !== null;
      // The anchor is on its way to being hidden, so it can't take focus back.
      // The overflow trigger is where the command now lives, which makes it the
      // honest destination — otherwise a keyboard user is dropped onto <body>.
      // It has to be the trigger on the side that swallowed the button: the
      // other one renders display:none and untabbable when its own side has no
      // overflow, so focusing it would be the silent no-op this prevents.
      //
      // Recorded, not focused here: the menu is a modal Radix menu and its
      // FocusScope is still trapping while it is open, so a synchronous
      // `.focus()` at this point is bounced straight back inside. The move
      // happens in the menu's own onCloseAutoFocus, once the trap has let go.
      if (focusWasInPanel) {
        const side = copyTreeOnRight ? "right" : "left";
        recordCopyTreeEvictionFocus(
          toolbarRef.current?.querySelector<HTMLElement>(
            `[data-toolbar-overflow-trigger][data-toolbar-overflow-side="${side}"][data-visible="true"]`
          ) ?? null
        );
      }
      setCopyTreeOpen(false);
    }
    // A plugin popover is portaled too. It hangs off a promoted button or the
    // tray, so it closes with whichever one moved, and focus goes where the
    // command lives now: the `…` trigger on the side that took it (see the
    // copy-tree note above for why that side).
    const hiddenIds: ReadonlySet<string> = overflowSet;
    const rightHiddenIds: readonly string[] = measuredRightOverflow;
    closePluginToolbarPopoverIfHidden(
      (opening) =>
        (opening.origin === "button" && hiddenIds.has(opening.buttonId)) ||
        (opening.origin === "tray" && hiddenIds.has("plugin-tray")),
      (opening) =>
        rightHiddenIds.includes(opening.origin === "tray" ? "plugin-tray" : opening.buttonId)
          ? "right"
          : "left"
    );
  }, [
    measuredLeftOverflow,
    measuredRightOverflow,
    demotedIds,
    copyTreeOnRight,
    // Stable refs and callbacks: listed for the linter, never a rerun.
    toolbarRef,
    forgeStatsRef,
    recordCopyTreeEvictionFocus,
    setCopyTreeOpen,
  ]);
}
