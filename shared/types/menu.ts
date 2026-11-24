export type MenuItemOption =
  | {
      type: "separator";
      id?: string;
    }
  | {
      type?: "normal";
      id: string;
      label: string;
      enabled?: boolean;
      sublabel?: string;
      submenu?: MenuItemOption[];
    }
  | {
      type: "checkbox";
      id: string;
      label: string;
      checked?: boolean;
      enabled?: boolean;
      sublabel?: string;
      submenu?: MenuItemOption[];
    };

export interface ShowContextMenuPayload {
  template: MenuItemOption[];
  x?: number;
  y?: number;
}

/**
 * Anchor for popping up the installed application menu (#11813).
 *
 * Coordinates are CSS pixels relative to the sender view's viewport — the
 * project WebContentsView is always sized to the window's full content area
 * (ProjectViewManager sets `{x: 0, y: 0, width, height}`), so main only has to
 * apply the view's zoom factor to reach window coordinates.
 */
export interface ShowApplicationMenuPayload {
  x?: number;
  y?: number;
}

/**
 * What the next Cmd+Z in a project view would reopen, for Edit > Undo to name
 * (#17108): the panels in the close it takes back first, and the one panel's
 * title when there is just one. `null` when Cmd+Z there would undo text or
 * there is nothing to reopen, and Edit > Undo reads "Undo".
 */
export type UndoCloseMenuState = { count: number; title: string | null } | null;
