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
