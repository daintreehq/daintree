import { useRef, useState, type ReactNode, type RefObject } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useMenuActionSource, type MenuActionSourceValue } from "@/components/ui/menu-source";
import { TerminalSelectionMenuItems } from "@/components/Terminal/contextMenu/TerminalMenuItems";
import {
  openTerminalPathInFileBrowser,
  runTerminalOutputMenuAction,
  type TerminalOutputMenuTarget,
} from "@/components/Terminal/contextMenu/terminalOutputMenuActions";
import { actionService } from "@/services/ActionService";
import { reportFileLinkFailure } from "@/services/terminal/FileLinksAddon";
import { grantClickedHostFile } from "@/services/terminal/clickedHostFile";
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
  /**
   * Back to the terminal once the menu has closed, unless the keyboard went to
   * something else: a right-click lands where nothing takes focus, and the menu
   * would otherwise hand it to whatever had it before, a row of the list.
   */
  refocus(): void;
}

/** In the viewer dialog, over the panel, rather than a grid panel behind it. */
function viewFile(absolutePath: string, source: MenuActionSourceValue): void {
  void grantClickedHostFile(absolutePath)
    .then(() => actionService.dispatch("file.view", { path: absolutePath }, { source }))
    .then((result) => {
      if (!result.ok) {
        reportFileLinkFailure("Failed to view file", result.error.details, absolutePath);
      }
    });
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
    if (actionId === "copy") {
      if (state?.selection) current.copy(state.selection);
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
      hoveredFilePath={state?.hoveredFilePath ?? null}
      hoveredFileKind={state?.hoveredFileKind ?? null}
      hoveredFileScope={state?.hoveredFileScope ?? null}
      selectionFilePath={state?.selectionFilePath ?? null}
      onViewSelectedFile={(path) => defer(() => viewFile(path, source))}
      separatorAfter={false}
      onOpenInFileBrowser={(scope, path, kind) =>
        defer(() => openTerminalPathInFileBrowser(scope, path, kind, source))
      }
      onAction={onAction}
    />
  );
}
