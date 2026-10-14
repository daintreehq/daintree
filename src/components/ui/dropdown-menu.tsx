import * as React from "react";
import type * as DropdownMenuPrimitiveType from "@radix-ui/react-dropdown-menu";
import type { ActionId, ActionDispatchOptions } from "@shared/types/actions";
import { useAriaKeyshortcuts } from "@/hooks/useKeybinding";
import { actionService } from "@/services/ActionService";
import { useMenuActionSource } from "./menu-source";
import { DropdownMenuItem, type DropdownMenuItemProps } from "./dropdown-menu-base";

// The menu primitives live in `dropdown-menu-base`, which the plugin UI kit imports
// directly: an item bound to an action dispatches through ActionService, and
// that would pull every action definition into the kit's graph.

type DropdownMenuActionItemProps = DropdownMenuItemProps & {
  actionId: ActionId;
  args?: unknown;
  dispatchOptions?: Omit<ActionDispatchOptions, "source">;
};

const DropdownMenuActionItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.Item>,
  DropdownMenuActionItemProps
>(({ actionId, args, dispatchOptions, onSelect, disabled, ...props }, ref) => {
  const source = useMenuActionSource();
  const ariaKeyshortcuts = useAriaKeyshortcuts(actionId);

  const handleSelect: React.ComponentPropsWithoutRef<
    typeof DropdownMenuPrimitiveType.Item
  >["onSelect"] = (event) => {
    onSelect?.(event);
    if (event.defaultPrevented) return;
    void actionService.dispatch(actionId, args, { ...dispatchOptions, source });
  };

  return (
    <DropdownMenuItem
      ref={ref}
      onSelect={handleSelect}
      disabled={disabled}
      {...props}
      aria-keyshortcuts={ariaKeyshortcuts}
    />
  );
});
DropdownMenuActionItem.displayName = "DropdownMenuActionItem";

export * from "./dropdown-menu-base";
export { DropdownMenuActionItem };
