import { useRef, useState, type ReactNode, type RefObject } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useMenuActionSource } from "@/components/ui/menu-source";
import { TerminalSelectionMenuItems } from "@/components/Terminal/contextMenu/TerminalMenuItems";
import {
  runTerminalOutputMenuAction,
  type TerminalOutputMenuTarget,
} from "@/components/Terminal/contextMenu/terminalOutputMenuActions";

/** What the pointer and the selection held when the menu opened. */
export interface CanopyTerminalMenuState {
  selection: string;
  hoveredUrl: string | null;
  hoveredUrlPluginName: string | null;
}

/** The live view's side of its menu, for the xterm it has now. */
export interface CanopyTerminalMenuHandle extends TerminalOutputMenuTarget {
  /** Read as the menu opens: the hover ends once the pointer reaches the menu. */
  read(): CanopyTerminalMenuState;
  copy(text: string): void;
  /** Copies the selection cleaned, or `captured` cleaned when the selection has changed since. */
  copyClean(captured: string): void;
  paste(): void;
  /**
   * Back to the terminal once the menu has closed, unless the keyboard went to
   * something else: a right-click lands where nothing takes focus, and the menu
   * would otherwise hand it to whatever had it before, a row of the list.
   */
  refocus(): void;
}

/**
 * The grid terminal's menu of what is in the output — copy, paste, and the
 * link, file or folder under the pointer — on Canopy's live view. The pane's
 * own management (move, fleet, restart) stays with the pane.
 */
export function CanopyTerminalMenu({
  handle,
  children,
}: {
  handle: RefObject<CanopyTerminalMenuHandle | null>;
  children: ReactNode;
}) {
  const [state, setState] = useState<CanopyTerminalMenuState | null>(null);
  // What an item opens waits for the menu to close and the terminal to have
  // the keyboard again: a dialog opened sooner records the vanishing item as
  // where to hand focus back, and the menu's own restore takes it from the dialog.
  const pendingRef = useRef<(() => void) | null>(null);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={() => setState(handle.current?.read() ?? null)}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        data-canopy-terminal-menu=""
        // After the menu's own restore, so it settles what that left.
        onCloseAutoFocus={() =>
          setTimeout(() => {
            handle.current?.refocus();
            const run = pendingRef.current;
            pendingRef.current = null;
            run?.();
          }, 0)
        }
      >
        <CanopyTerminalMenuItems
          state={state}
          handle={handle}
          defer={(run) => {
            pendingRef.current = run;
          }}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CanopyTerminalMenuItems({
  state,
  handle,
  defer,
}: {
  state: CanopyTerminalMenuState | null;
  handle: RefObject<CanopyTerminalMenuHandle | null>;
  defer: (run: () => void) => void;
}) {
  const source = useMenuActionSource();
  const onAction = (actionId: string) => {
    const current = handle.current;
    if (!current) return;
    // A link's own copy needs no project window, which the Canopy window isn't.
    if (actionId.startsWith("copy-link:")) {
      current.copy(actionId.slice("copy-link:".length));
      return;
    }
    if (actionId === "copy") {
      if (state?.selection) current.copy(state.selection);
      return;
    }
    if (actionId === "copy-clean") {
      if (state?.selection) current.copyClean(state.selection);
      return;
    }
    if (actionId === "paste") {
      current.paste();
      return;
    }
    defer(() => runTerminalOutputMenuAction(actionId, current, source));
  };
  return (
    <TerminalSelectionMenuItems
      hasSelection={Boolean(state?.selection)}
      hoveredUrl={state?.hoveredUrl ?? null}
      hoveredUrlPluginName={state?.hoveredUrlPluginName ?? null}
      // Files open in the viewer and panels of a project window: the Canopy
      // window has neither, so no file is offered.
      hoveredFilePath={null}
      hoveredFileKind={null}
      hoveredFileScope={null}
      selectionFilePath={null}
      separatorAfter={false}
      onOpenInFileBrowser={noFileBrowser}
      onAction={onAction}
    />
  );
}

function noFileBrowser() {}
