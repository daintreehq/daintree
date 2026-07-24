import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useMenuActionSource } from "@/components/ui/menu-source";
import { actionService } from "@/services/ActionService";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";

interface PluginContextMenuSectionProps {
  items: PluginContextMenuItemEntry[];
  /**
   * Menu primitives to render with. Defaults to the context-menu pair; a
   * dropdown surface passes its own so the same section can trail both menus
   * (`useMenuActionSource()` resolves the source from whichever Root wraps it).
   */
  components?: {
    Item: React.ElementType;
    Separator: React.ElementType;
  };
  /**
   * Args handed to every item's `actionService.dispatch` for this surface — the
   * surface's clicked subject (e.g. `{ path }` for a file row). Captured at
   * menu-open time by the mounting component. Undefined for surfaces whose
   * actions take no argument (the historical behavior).
   */
  dispatchArgs?: Record<string, unknown>;
  /**
   * Whether to render a leading separator above the items. Defaults to `true`
   * (the section trails native menu items on every existing surface). Pass
   * `false` when plugin items are the menu's only content — e.g. the `file`
   * surface, which has no built-in items to separate from.
   */
  leadingSeparator?: boolean;
}

/**
 * Renders plugin-contributed menu items as a trailing section, preceded by a
 * separator. Must be rendered inside a `ContextMenuContent` or
 * `DropdownMenuContent` so `useMenuActionSource()` resolves to the real surface
 * (`"context-menu"` / `"menu"`) rather than falling back to `"user"`; a dropdown
 * surface also passes its own primitives via `components`. Renders nothing when
 * there are no items, so a zero-plugin menu produces no DOM diff.
 *
 * `dispatchArgs` lets a surface pass the clicked subject (a file path, a
 * worktree id) into the dispatched action so a plugin's `file`/`worktree`
 * context-menu item receives the thing it was clicked on rather than
 * `undefined`.
 */
export function PluginContextMenuSection({
  items,
  components,
  dispatchArgs,
  leadingSeparator = true,
}: PluginContextMenuSectionProps) {
  const source = useMenuActionSource();
  const Item = components?.Item ?? ContextMenuItem;
  const Separator = components?.Separator ?? ContextMenuSeparator;
  if (items.length === 0) return null;
  return (
    <>
      {leadingSeparator && <Separator />}
      {items.map((entry) => (
        <Item
          key={`${entry.pluginId}:${entry.item.actionId}`}
          onSelect={() =>
            void actionService.dispatch(entry.item.actionId, dispatchArgs, { source })
          }
        >
          {entry.item.label}
        </Item>
      ))}
    </>
  );
}
