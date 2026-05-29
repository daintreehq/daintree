import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useMenuActionSource } from "@/components/ui/menu-source";
import { actionService } from "@/services/ActionService";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";

/**
 * Renders plugin-contributed context-menu items as a trailing section, preceded
 * by a separator. Must be rendered inside a `ContextMenuContent` so
 * `useMenuActionSource()` resolves to `"context-menu"`. Renders nothing when
 * there are no items, so a zero-plugin menu produces no DOM diff.
 */
export function PluginContextMenuSection({ items }: { items: PluginContextMenuItemEntry[] }) {
  const source = useMenuActionSource();
  if (items.length === 0) return null;
  return (
    <>
      <ContextMenuSeparator />
      {items.map((entry) => (
        <ContextMenuItem
          key={`${entry.pluginId}:${entry.item.actionId}`}
          onSelect={() => void actionService.dispatch(entry.item.actionId, undefined, { source })}
        >
          {entry.item.label}
        </ContextMenuItem>
      ))}
    </>
  );
}
