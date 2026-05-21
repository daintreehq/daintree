import * as React from "react";

export type MenuActionSourceValue = "context-menu" | "menu" | "user";

const MenuActionSourceContext = React.createContext<MenuActionSourceValue | null>(null);

export function useMenuActionSource(): MenuActionSourceValue {
  const source = React.useContext(MenuActionSourceContext);
  if (source === null) {
    if (import.meta.env.DEV) {
      console.warn(
        'useMenuActionSource: called outside a <ContextMenu> or <DropdownMenu> Root — falling back to "user".'
      );
    }
    return "user";
  }
  return source;
}

export { MenuActionSourceContext };
