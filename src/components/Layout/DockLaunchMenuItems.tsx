import type * as React from "react";
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
} from "./dockLaunchItems";
import { unavailableAgentHint } from "@/utils/agentAvailabilityCopy";
import { PANEL_KIND_ORIGIN_LABELS } from "@/utils/panelKindOriginCopy";

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
            <Icon className="w-3.5 h-3.5" />
          </BrandMark>
        ) : (
          <SquareTerminal className="w-3.5 h-3.5 mr-2" />
        )}
        <span className="truncate">{agent.name}</span>
        {/* The same trailing mark the launcher's row carries, so a recently
            launched agent is listed once rather than twice. */}
        {isRecent && (
          <span className="ml-auto pl-2 text-2xs text-text-secondary shrink-0">Recent</span>
        )}
      </C.Item>
    );
  };

  const renderPanelItem = (item: DockLaunchPanelItem) => {
    // The menu has no qualifier column of its own, so this is a new slot rather
    // than a filled one. It follows the recipe row below — trailing, dimmed,
    // shrink-proof — except on the colour: that row is on `text-muted`, which
    // has no dark-theme contrast floor here, and provenance is not decoration.
    // `role="menuitem"` takes its accessible name from its text content, so the
    // marker reaches a screen reader by being rendered; an `aria-label` would
    // only be a second copy to keep in sync.
    const originLabel = PANEL_KIND_ORIGIN_LABELS[item.origin];
    return (
      <C.Item key={item.key} onSelect={() => activate(item)}>
        <PanelKindIcon iconId={item.iconId} color={item.color} size={14} className="mr-2" />
        <span className="truncate">{item.name}</span>
        {originLabel && (
          <span className="ml-auto pl-2 text-2xs text-text-secondary shrink-0">{originLabel}</span>
        )}
      </C.Item>
    );
  };

  const renderRecipeItem = (item: DockLaunchRecipeItem) => (
    <C.Item
      key={item.key}
      className={item.isShadowed ? "opacity-70" : undefined}
      onSelect={() => activate(item)}
    >
      <Workflow className="w-3.5 h-3.5 mr-2 shrink-0" />
      <span className="truncate">{item.name}</span>
      <span className="ml-auto pl-2 text-2xs text-text-muted shrink-0">
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

  const recentIds = new Set(model.recentAgents.map((agent) => agent.id));

  return (
    <>
      {/* One agent group, recent first and each agent once — the grouping the
          `+` launcher uses. Pinned state lives on the toolbar button itself. */}
      {agents.length > 0 && (
        <>
          <C.Label>Agents</C.Label>
          {model.recentAgents.map((agent) => renderAgentItem(agent, true))}
          {agents
            .filter((agent) => !recentIds.has(agent.id))
            .map((agent) => renderAgentItem(agent))}
          <C.Separator />
        </>
      )}

      {/* The launcher creates dockable kinds directly in the dock, and `addPanel`
          redirects a non-dockable kind to the grid (#11054) — so rather than
          hiding those kinds, the headings state where each group lands. Both
          lists derive from `panelKindIsDockable`, the same predicate the store
          guards use, so a dockability flip moves an item between sections
          instead of letting a heading lie about it. The heading always names
          the destination, even when there is only one. */}
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

      <C.Separator />
      <C.Label>Recipes</C.Label>
      {model.recipes.length > 0 ? model.recipes.map(renderRecipeItem) : renderCreateRecipeCue()}
    </>
  );
}
