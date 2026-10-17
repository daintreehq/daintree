import * as React from "react";
import type * as ContextMenuPrimitiveType from "@radix-ui/react-context-menu";
import type { ActionId, ActionDispatchOptions } from "@shared/types/actions";
import { useAriaKeyshortcuts } from "@/hooks/useKeybinding";
import { actionService } from "@/services/ActionService";
import { useMenuActionSource } from "./menu-source";
import { ContextMenuItem, type ContextMenuItemProps } from "./context-menu-base";

// The menu primitives live in `context-menu-base`, which the plugin UI kit imports
// directly: an item bound to an action dispatches through ActionService, and
// that would pull every action definition into the kit's graph.

type ContextMenuActionItemProps = ContextMenuItemProps & {
  actionId: ActionId;
  args?: unknown;
  dispatchOptions?: Omit<ActionDispatchOptions, "source">;
};

const ContextMenuActionItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.Item>,
  ContextMenuActionItemProps
>(({ actionId, args, dispatchOptions, onSelect, disabled, ...props }, ref) => {
  const source = useMenuActionSource();
  const ariaKeyshortcuts = useAriaKeyshortcuts(actionId);

  const handleSelect: React.ComponentPropsWithoutRef<
    typeof ContextMenuPrimitiveType.Item
  >["onSelect"] = (event) => {
    onSelect?.(event);
    if (event.defaultPrevented) return;
    void actionService.dispatch(actionId, args, { ...dispatchOptions, source });
  };

  return (
    <ContextMenuItem
      ref={ref}
      onSelect={handleSelect}
      disabled={disabled}
      {...props}
      aria-keyshortcuts={ariaKeyshortcuts}
    />
  );
});
ContextMenuActionItem.displayName = "ContextMenuActionItem";

export * from "./context-menu-base";
export { ContextMenuActionItem };
