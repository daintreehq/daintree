import { Puzzle } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuMeta,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useMenuActionSource, type MenuActionSourceValue } from "@/components/ui/menu-source";
import { actionService } from "@/services/ActionService";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";
import {
  contextMenuAvailabilityRequest,
  usePluginContextMenuAvailability,
} from "@/hooks/usePluginContextMenuAvailability";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";

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
    /** The surface's trailing metadata slot, for an unavailable item's reason. */
    Meta?: React.ElementType;
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
   * (the section trails native menu items on the surfaces that render it
   * inline). Pass `false` when the parent owns the boundary instead: plugin
   * items are a menu's entire content, or the section sits inside a submenu
   * whose shell already separates the groups — which is what the `file` surface
   * does since #12206.
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
 * `undefined`. An item that sets `availability` also sends the subject-naming
 * part of those args to its plugin's availability handler as the row mounts,
 * and shows the plugin's reason in the surface's `Meta` when it can't run.
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
      {items.map((entry) =>
        entry.item.availability ? (
          <CheckedPluginMenuRow
            key={`${entry.pluginId}:${entry.item.actionId}`}
            entry={entry}
            availability={entry.item.availability}
            Item={Item}
            Meta={components?.Meta}
            source={source}
            dispatchArgs={dispatchArgs}
          />
        ) : (
          <Item
            key={`${entry.pluginId}:${entry.item.actionId}`}
            onSelect={() =>
              void actionService.dispatch(entry.item.actionId, dispatchArgs, { source })
            }
          >
            <PluginMenuRowLabel label={entry.item.label} />
          </Item>
        )
      )}
    </>
  );
}

function PluginMenuRowLabel({ label }: { label: string }) {
  return (
    <>
      {/* The manifest names no icon, so every contributed row takes the
          plugin glyph the panel menus give theirs (`genericPanelMenu.ts`),
          and the host menu's icon column stays unbroken. */}
      <Puzzle data-menu-icon className="mr-2 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </>
  );
}

interface CheckedPluginMenuRowProps {
  entry: PluginContextMenuItemEntry;
  availability: string;
  Item: React.ElementType;
  /** Defaults to the context-menu slot, read only by a row that checks availability. */
  Meta: React.ElementType | undefined;
  source: MenuActionSourceValue;
  dispatchArgs: Record<string, unknown> | undefined;
}

/**
 * A row whose plugin answers, each time the menu shows it, whether it can run
 * on this subject (#18141). It stays visible throughout: disabled while the
 * answer is pending and when the plugin names a reason, which sits beside the
 * dimmed label as the built-in "New session" ceiling row's does.
 */
function CheckedPluginMenuRow({
  entry,
  availability,
  Item,
  Meta = ContextMenuMeta,
  source,
  dispatchArgs,
}: CheckedPluginMenuRowProps) {
  const { label, location, actionId } = entry.item;
  const state = usePluginContextMenuAvailability(
    entry.pluginId,
    label,
    contextMenuAvailabilityRequest(availability, location, dispatchArgs)
  );
  // A warm plugin answers well inside the gate, so the row doesn't flash.
  const showChecking = useDeferredLoading(state.status === "checking", UI_INLINE_LOADING_GATE_MS);
  const disabled = state.status !== "available";
  const dimmed = state.status === "unavailable" || showChecking;
  return (
    <Item
      disabled={disabled}
      onSelect={() => {
        // Radix withholds onSelect from a disabled row; this keeps an answer
        // still pending or unfavourable from dispatching whatever the primitive does.
        if (state.status !== "available") return;
        void actionService.dispatch(actionId, dispatchArgs, { source });
      }}
      // The row dims its own label rather than everything in it, so the reason
      // beside it stays readable.
      className="data-[disabled]:opacity-100"
    >
      <span className={cn("flex min-w-0 items-center", dimmed && "opacity-50")}>
        <PluginMenuRowLabel label={label} />
      </span>
      {state.status === "unavailable" && (
        <>
          <Meta className="max-w-56 break-words">{state.reason}</Meta>
          <span className="sr-only">, {state.reason}</span>
        </>
      )}
      {state.status === "checking" && showChecking && (
        <>
          <Meta>Checking…</Meta>
          <span className="sr-only">, checking availability</span>
        </>
      )}
    </Item>
  );
}
