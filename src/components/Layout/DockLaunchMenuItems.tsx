import { Fragment } from "react";
import type * as React from "react";
import { EyeOff, SquareTerminal } from "lucide-react";
import { BrandMark, Workflow } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import type { RecipeContext } from "@/utils/recipeVariables";
import type { ActionSource } from "@shared/types";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import { launcherPluginGroupId } from "@shared/config/launcherArrangement";
import {
  activateCreateRecipeCue,
  activateDockLaunchCue,
  activateDockLaunchItem,
  useDockLaunchModel,
  DOCK_LAUNCH_CUE_LABELS,
  type ActivateDockLaunchItemContext,
  type DockLaunchAgent,
  type DockLaunchItem,
  type DockLaunchPanelItem,
  type DockLaunchPluginEntryItem,
  type DockLaunchRecipeItem,
  type DockLaunchSurface,
} from "./dockLaunchItems";
import { PANEL_KIND_ORIGIN_LABELS } from "@/utils/panelKindOriginCopy";

export type { DockLaunchAgent } from "./dockLaunchItems";

type MenuComponent = React.ElementType;

export interface DockLaunchMenuComponents {
  Item: MenuComponent;
  Label: MenuComponent;
  Meta: MenuComponent;
  Separator: MenuComponent;
}

interface DockLaunchMenuItemsProps {
  components: DockLaunchMenuComponents;
  agents: ReadonlyArray<DockLaunchAgent>;
  activeWorktreeId: string | null;
  cwd: string;
  recipeContext?: RecipeContext;
  onLaunchAgent: ActivateDockLaunchItemContext["onLaunchAgent"];
  /**
   * Number of leading `agents` entries that are pinned to the toolbar (as
   * produced by `sortAgentsByToolbarPin`). The menu lists every agent under one
   * "Agents" heading in that order, matching the `+` launcher; the count still
   * feeds the shared model.
   */
  pinnedCount?: number;
  // The surface attribution to attach to everything this launcher dispatches —
  // panel launches and the settings redirect for non-launchable rows. Defaults
  // to "menu"; ContentDock's context-menu path overrides it so attribution
  // stays consistent with how the user actually opened the launcher.
  source?: ActionSource;
  /**
   * Where this surface creates panels. The grid's context menu launches into
   * the grid, so it must not offer a dock destination it won't honour.
   */
  surface: DockLaunchSurface;
}

/**
 * The banded launcher list rendered through a caller-supplied menu primitive.
 * Both right-click context menus (the dock's and the grid's) use it; the `+`
 * launcher renders its own searchable palette rows instead, because a
 * `role="option"` row and a Radix menu item have incompatible contracts.
 */
export function DockLaunchMenuItems({
  components: C,
  agents,
  activeWorktreeId,
  cwd,
  recipeContext,
  onLaunchAgent,
  pinnedCount,
  source = "menu",
  surface,
}: DockLaunchMenuItemsProps) {
  const model = useDockLaunchModel({ agents, pinnedCount, activeWorktreeId, surface });

  const activate = (item: DockLaunchItem) =>
    activateDockLaunchItem(item, {
      cwd,
      activeWorktreeId,
      recipeContext,
      onLaunchAgent,
      source,
    });

  const renderAgentItem = (agent: DockLaunchAgent, isRecent = false) => {
    const Icon = agent.icon;
    const isLaunchable = isAgentLaunchable(agent.availability);
    return (
      <C.Item
        key={agent.id}
        // The launcher's treatment for the same row: secondary text plus a
        // stated reason, never a fade (which took the reason down with it) and
        // never a `title` (the only place the reason used to live).
        className={!isLaunchable ? "text-text-secondary" : undefined}
        onSelect={() =>
          activate({
            category: "agent",
            key: `agent:${agent.id}`,
            name: agent.name,
            agent,
            agentBand: isLaunchable ? "launch" : "needs-setup",
          })
        }
      >
        {Icon ? (
          <BrandMark brandColor={agent.brandColor} className="w-3.5 h-3.5 mr-2">
            <Icon className="w-3.5 h-3.5" />
          </BrandMark>
        ) : (
          <SquareTerminal className="w-3.5 h-3.5 mr-2" />
        )}
        <span className="truncate">{agent.name}</span>
        {/* The same trailing mark the launcher's row carries, so a recently
            launched agent is listed once rather than twice. */}
        {!isLaunchable ? (
          <C.Meta aria-hidden={false} className="shrink-0">
            Setup
          </C.Meta>
        ) : (
          isRecent && (
            <C.Meta aria-hidden={false} className="shrink-0">
              Recent
            </C.Meta>
          )
        )}
      </C.Item>
    );
  };

  const renderPanelItem = (item: DockLaunchPanelItem) => {
    // The shared trailing slot, left audible: `role="menuitem"` takes its
    // accessible name from its text content, so the marker reaches a screen
    // reader by being rendered; an `aria-label` would only be a second copy to
    // keep in sync.
    const originLabel = PANEL_KIND_ORIGIN_LABELS[item.origin];
    return (
      <C.Item key={item.key} onSelect={() => activate(item)}>
        <PanelKindIcon iconId={item.iconId} color={item.color} size={14} className="mr-2" />
        <span className="truncate">{item.name}</span>
        {originLabel && (
          <C.Meta aria-hidden={false} className="shrink-0">
            {originLabel}
          </C.Meta>
        )}
      </C.Item>
    );
  };

  const renderPluginEntryItem = (item: DockLaunchPluginEntryItem) => (
    <C.Item
      key={item.key}
      className={item.disabled ? "text-text-secondary" : undefined}
      // The group label isn't tied to its items, so the item names its plugin
      // itself: two plugins' "New record…" must not read the same.
      aria-label={[item.name, item.pluginName, item.disabled?.reason].filter(Boolean).join(", ")}
      title={item.description}
      onSelect={() => activate(item)}
    >
      <PanelKindIcon iconId={item.iconId} size={14} className="mr-2" />
      <span className="truncate">{item.name}</span>
      {item.disabled && (
        <C.Meta aria-hidden={false} className="shrink-0">
          {item.disabled.reason}
        </C.Meta>
      )}
    </C.Item>
  );

  const renderRecipeItem = (item: DockLaunchRecipeItem) => (
    <C.Item
      key={item.key}
      className={item.isShadowed ? "text-text-secondary" : undefined}
      onSelect={() => activate(item)}
    >
      <Workflow className="w-3.5 h-3.5 mr-2 shrink-0" />
      <span className="truncate">{item.name}</span>
      <C.Meta aria-hidden={false} className="shrink-0">
        {item.isShadowed ? `${item.scopeLabel} · Overridden by Team` : item.scopeLabel}
      </C.Meta>
    </C.Item>
  );

  const renderCreateRecipeCue = () => (
    <C.Item onSelect={() => activateCreateRecipeCue(activeWorktreeId, source)}>
      <Workflow className="w-3.5 h-3.5 mr-2" />
      Create a recipe
    </C.Item>
  );

  const recentIds = new Set(model.recentAgents.map((agent) => agent.id));

  const renderGroup = (groupId: string): React.ReactNode => {
    switch (groupId) {
      case "agents":
        // One agent group, recent first and each agent once — the grouping the
        // `+` launcher uses. Pinned state lives on the toolbar button itself.
        if (agents.length === 0) return null;
        return (
          <>
            <C.Label>Agents</C.Label>
            {model.recentAgents.map((agent) => renderAgentItem(agent, true))}
            {agents
              .filter((agent) => !recentIds.has(agent.id))
              .map((agent) => renderAgentItem(agent))}
          </>
        );
      case "panels":
        // The launcher creates dockable kinds directly in the dock, and
        // `addPanel` redirects a non-dockable kind to the grid (#11054) — so
        // rather than hiding those kinds, the headings state where each group
        // lands. Both lists derive from `panelKindIsDockable`, the same
        // predicate the store guards use, so a dockability flip moves an item
        // between sections instead of letting a heading lie about it. The
        // heading always names the destination, even when there is only one.
        if (model.dockPanels.length === 0 && model.gridPanels.length === 0) return null;
        return (
          <>
            {model.dockPanels.length > 0 && (
              <>
                <C.Label>Open in dock</C.Label>
                {model.dockPanels.map(renderPanelItem)}
              </>
            )}
            {model.gridPanels.length > 0 && (
              <>
                <C.Label>Open in grid</C.Label>
                {model.gridPanels.map(renderPanelItem)}
              </>
            )}
          </>
        );
      case "recipes":
        return (
          <>
            <C.Label>Recipes</C.Label>
            {model.recipes.length > 0
              ? model.recipes.map(renderRecipeItem)
              : renderCreateRecipeCue()}
          </>
        );
    }
    // One group per plugin, headed by the plugin's name — the attribution — and
    // ended by a real menu item that hides it, so the control is reachable the
    // same way every row is.
    const group = model.pluginGroups.find(
      (candidate) => launcherPluginGroupId(candidate.pluginId) === groupId
    );
    if (!group) return null;
    return (
      <>
        <C.Label>{group.pluginName}</C.Label>
        {group.items.map(renderPluginEntryItem)}
        <C.Item
          className="text-text-secondary"
          aria-label={`Hide ${group.pluginName} in this project`}
          onSelect={() =>
            activateDockLaunchCue("hide-plugin-group", activeWorktreeId, source, group)
          }
        >
          <EyeOff className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
          {DOCK_LAUNCH_CUE_LABELS["hide-plugin-group"]}
        </C.Item>
      </>
    );
  };

  // In the project's order (#13791). A menu can't hold the launcher's
  // collapsed More, so the groups it demotes come last, still open.
  const groups = model.groupOrder.flatMap((groupId) => {
    const content = renderGroup(groupId);
    return content === null ? [] : [{ groupId, content }];
  });

  return (
    <>
      {groups.map(({ groupId, content }, index) => (
        <Fragment key={groupId}>
          {index > 0 && <C.Separator />}
          {content}
        </Fragment>
      ))}
    </>
  );
}
