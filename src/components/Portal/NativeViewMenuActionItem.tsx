import type { ActionId } from "@shared/types/actions";
import { useAriaKeyshortcuts } from "@/hooks/useKeybinding";
import { actionService } from "@/services/ActionService";
import { ContextMenuItem, type ContextMenuItemProps } from "@/components/ui/context-menu";
import { useMenuActionSource } from "@/components/ui/menu-source";

type NativeViewMenuActionItemProps = Omit<ContextMenuItemProps, "onSelect"> & {
  actionId: ActionId;
  args?: unknown;
  /** `useNativeViewMenu`'s `afterClose` for the menu this row belongs to. */
  afterClose: (run: () => void) => () => void;
};

/**
 * `ContextMenuActionItem` for a menu drawn over the portal's native page view:
 * the action dispatches once the menu has closed and released its overlay
 * claim, rather than from inside the still-open menu.
 */
export function NativeViewMenuActionItem({
  actionId,
  args,
  afterClose,
  ...props
}: NativeViewMenuActionItemProps) {
  const source = useMenuActionSource();
  const ariaKeyshortcuts = useAriaKeyshortcuts(actionId);
  return (
    <ContextMenuItem
      {...props}
      onSelect={afterClose(() => void actionService.dispatch(actionId, args, { source }))}
      aria-keyshortcuts={ariaKeyshortcuts}
    />
  );
}
