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
