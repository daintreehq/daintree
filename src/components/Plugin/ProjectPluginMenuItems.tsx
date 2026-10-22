import { Fragment, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Package } from "@/components/icons";
import {
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { PluginContextMenuSection } from "@/components/Plugin/PluginContextMenuSection";
import {
  usePluginContextMenuItems,
  type PluginContextMenuItemEntry,
} from "@/hooks/usePluginContextMenuItems";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";

/**
 * Plugin `project` context-menu items for the toolbar project pill, nested under
 * one Extensions submenu with a group per plugin (the shape the file and
 * worktree menus use). Visibility per project is settled in main before items
 * reach the renderer, so this only filters by location. Renders nothing when no
 * plugin contributes: an empty submenu is a dead end.
 */
export function ProjectPluginMenuItems({ projectId }: { projectId: string }) {
  const ctx = useMemo(() => ({ projectId }), [projectId]);
  const items = usePluginContextMenuItems("project", ctx);

  const groups = useMemo(() => {
    const byPluginId = new Map<string, PluginContextMenuItemEntry[]>();
    for (const entry of items) {
      const bucket = byPluginId.get(entry.pluginId);
      if (bucket) bucket.push(entry);
      else byPluginId.set(entry.pluginId, [entry]);
    }
    return [...byPluginId.entries()];
  }, [items]);

  // The group key is the instance key, which prints a machine-local project id
  // for a project plugin (#12211), so the heading is the display name.
  const names = usePluginRuntimeStore(
    useShallow((s) =>
      groups.map(
        ([pluginId]) =>
          s.pluginMetaById.get(pluginId)?.displayName ?? pluginManifestIdFromInstanceKey(pluginId)
      )
    )
  );

  if (groups.length === 0) return null;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Package data-menu-icon className="mr-2 h-3.5 w-3.5" />
        Extensions
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {groups.map(([pluginId, entries], index) => (
          <Fragment key={pluginId}>
            {groups.length > 1 && index > 0 && <ContextMenuSeparator />}
            {groups.length > 1 && <ContextMenuLabel>{names[index]}</ContextMenuLabel>}
            <PluginContextMenuSection
              items={entries}
              leadingSeparator={false}
              dispatchArgs={{ projectId }}
            />
          </Fragment>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
