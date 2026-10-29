import { useState, type ReactNode, type RefObject } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useMenuActionSource } from "@/components/ui/menu-source";
import { TerminalSelectionMenuItems } from "@/components/Terminal/contextMenu/TerminalMenuItems";
import {
  openTerminalPathInFileBrowser,
  runTerminalOutputMenuAction,
  type TerminalOutputMenuTarget,
} from "@/components/Terminal/contextMenu/terminalOutputMenuActions";
import type { WorktreeScope } from "@shared/utils/path";

/** What the pointer and the selection held when the menu opened. */
export interface CanopyTerminalMenuState {
  selection: string;
  hoveredUrl: string | null;
  hoveredUrlPluginName: string | null;
  hoveredFilePath: string | null;
  hoveredFileKind: "file" | "directory" | null;
  hoveredFileScope: WorktreeScope | null;
  selectionFilePath: string | null;
}

/** The live view's side of its menu, for the xterm it has now. */
export interface CanopyTerminalMenuHandle extends TerminalOutputMenuTarget {
  /** Read as the menu opens: the hover ends once the pointer reaches the menu. */
  read(): CanopyTerminalMenuState;
  copy(text: string): void;
  paste(): void;
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
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={() => setState(handle.current?.read() ?? null)}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent data-canopy-terminal-menu="">
        <CanopyTerminalMenuItems state={state} handle={handle} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CanopyTerminalMenuItems({
  state,
  handle,
}: {
  state: CanopyTerminalMenuState | null;
  handle: RefObject<CanopyTerminalMenuHandle | null>;
}) {
  const source = useMenuActionSource();
  const onAction = (actionId: string) => {
    const current = handle.current;
    if (!current) return;
    if (actionId === "copy") {
      if (state?.selection) current.copy(state.selection);
      return;
    }
    if (actionId === "paste") {
      current.paste();
      return;
    }
    runTerminalOutputMenuAction(actionId, current, source);
  };
  return (
    <TerminalSelectionMenuItems
      hasSelection={Boolean(state?.selection)}
      hoveredUrl={state?.hoveredUrl ?? null}
      hoveredUrlPluginName={state?.hoveredUrlPluginName ?? null}
      hoveredFilePath={state?.hoveredFilePath ?? null}
      hoveredFileKind={state?.hoveredFileKind ?? null}
      hoveredFileScope={state?.hoveredFileScope ?? null}
      selectionFilePath={state?.selectionFilePath ?? null}
      // Over the grid, so a file opens in the viewer dialog above it.
      fileView="dialog"
      separatorAfter={false}
      onOpenInFileBrowser={(scope, path, kind) =>
        openTerminalPathInFileBrowser(scope, path, kind, source)
      }
      onAction={onAction}
    />
  );
}
