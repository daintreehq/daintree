import type * as React from "react";
import { Fragment } from "react";
import { SquareTerminal } from "lucide-react";
import { BrandMark, Workflow } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import type { RecipeContext } from "@/utils/recipeVariables";
import type { ActionSource } from "@shared/types";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import {
  activateCreateRecipeCue,
  activateDockLaunchItem,
  useDockLaunchModel,
  type DockLaunchAgent,
  type DockLaunchItem,
  type DockLaunchPanelItem,
  type DockLaunchRecipeItem,
  type DockLaunchSurface,
  unavailableAgentHint,
} from "./dockLaunchItems";

export type { DockLaunchAgent } from "./dockLaunchItems";

type MenuComponent = React.ElementType;

export interface DockLaunchMenuComponents {
  Item: MenuComponent;
  Label: MenuComponent;
  Separator: MenuComponent;
}

interface DockLaunchMenuItemsProps {
  components: DockLaunchMenuComponents;
  agents: ReadonlyArray<DockLaunchAgent>;
  activeWorktreeId: string | null;
  cwd: string;
  recipeContext?: RecipeContext;
  onLaunchAgent: (agentId: string) => void;
  /**
   * Number of leading `agents` entries that are pinned to the toolbar (as
   * produced by `sortAgentsByToolbarPin`). When defined and a strict subset of
   * `agents`, the list renders as two labelled groups ("Pinned" / "Other")
   * split by a separator. Otherwise the list renders flat under a single
   * "Launch agent" label, preserving the original behavior for callers that
   * don't pass it.
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

  const renderAgentItem = (agent: DockLaunchAgent, keyPrefix?: string) => {
    const Icon = agent.icon;
    const isLaunchable = isAgentLaunchable(agent.availability);
    return (
      <C.Item
        key={keyPrefix ? `${keyPrefix}-${agent.id}` : agent.id}
        className={!isLaunchable ? "opacity-70" : undefined}
        title={!isLaunchable ? unavailableAgentHint(agent.name, agent.availability) : undefined}
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
            <Icon className="w-3.5 h-3.5" brandColor={agent.brandColor} />
          </BrandMark>
        ) : (
          <SquareTerminal className="w-3.5 h-3.5 mr-2" />
        )}
        {agent.name}
      </C.Item>
    );
  };

  const renderPanelItem = (item: DockLaunchPanelItem) => (
    <C.Item key={item.key} onSelect={() => activate(item)}>
      <PanelKindIcon iconId={item.iconId} color={item.color} size={14} className="mr-2" />
      {item.name}
    </C.Item>
  );

  const renderRecipeItem = (item: DockLaunchRecipeItem) => (
    <C.Item
      key={item.key}
      className={item.isShadowed ? "opacity-70" : undefined}
      onSelect={() => activate(item)}
    >
      <Workflow className="w-3.5 h-3.5 mr-2 shrink-0" />
      <span className="truncate">{item.name}</span>
      <span className="ml-auto pl-2 text-[11px] text-text-muted shrink-0">
        {item.isShadowed ? `${item.scopeLabel} · Overridden by Team` : item.scopeLabel}
      </span>
    </C.Item>
  );

  const renderCreateRecipeCue = () => (
    <C.Item onSelect={() => activateCreateRecipeCue(activeWorktreeId, source)}>
      <Workflow className="w-3.5 h-3.5 mr-2" />
      Create a recipe
    </C.Item>
  );

  const isSplitByDestination = model.dockPanels.length > 0 && model.gridPanels.length > 0;

  return (
    <>
      {model.recentAgents.length > 0 && (
        <>
          <C.Label>Recently launched</C.Label>
          {model.recentAgents.map((agent) => (
            <Fragment key={`recent-${agent.id}`}>{renderAgentItem(agent, "recent")}</Fragment>
          ))}
          <C.Separator />
        </>
      )}

      {agents.length > 0 && (
        <>
          {model.showAgentGroups ? (
            <>
              <C.Label>Pinned</C.Label>
              {agents.slice(0, pinnedCount).map((agent) => renderAgentItem(agent))}
              <C.Separator />
              <C.Label>Other</C.Label>
              {agents.slice(pinnedCount).map((agent) => renderAgentItem(agent))}
            </>
          ) : (
            <>
              <C.Label>Launch agent</C.Label>
              {agents.map((agent) => renderAgentItem(agent))}
            </>
          )}
          <C.Separator />
        </>
      )}

      {/* The launcher creates dockable kinds directly in the dock, and `addPanel`
          redirects a non-dockable kind to the grid (#11054) — so rather than
          hiding those kinds, the headings state where each group lands. Both
          lists derive from `panelKindIsDockable`, the same predicate the store
          guards use, so a dockability flip moves an item between sections
          instead of letting a heading lie about it. When every panel shares one
          destination (the grid context menu, where nothing docks) the split
          would be noise, so a single neutral heading is used instead. */}
      {isSplitByDestination ? (
        <>
          <C.Label>Open in dock</C.Label>
          {model.dockPanels.map(renderPanelItem)}
          <C.Label>Open in grid</C.Label>
          {model.gridPanels.map(renderPanelItem)}
        </>
      ) : (
        <>
          <C.Label>Launch panel</C.Label>
          {[...model.dockPanels, ...model.gridPanels].map(renderPanelItem)}
        </>
      )}

      <C.Separator />
      <C.Label>Launch recipe</C.Label>
      {model.recipes.length > 0 ? model.recipes.map(renderRecipeItem) : renderCreateRecipeCue()}
    </>
  );
}
