import type * as React from "react";
import { Fragment } from "react";
import { SquareTerminal } from "lucide-react";
import { BrandMark, Workflow } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import type { RecipeContext } from "@/utils/recipeVariables";
import { actionService } from "@/services/ActionService";
import { cn } from "@/lib/utils";
import type { ActionSource } from "@shared/types";
import { isAgentBlocked, isAgentLaunchable } from "@shared/utils/agentAvailability";
import {
  activateDockLaunchItem,
  useDockLaunchModel,
  type DockLaunchAgent,
  type DockLaunchItem,
  type DockLaunchModel,
  type DockLaunchPanelItem,
  type DockLaunchRecipeItem,
} from "./dockLaunchItems";

export type { DockLaunchAgent } from "./dockLaunchItems";

type MenuComponent = React.ElementType;

export interface DockLaunchMenuComponents {
  Item: MenuComponent;
  Label: MenuComponent;
  Separator: MenuComponent;
}

/**
 * Search state owned by the `+` dropdown. Absent for the dock's right-click
 * context menu, where a text input doesn't belong — the item set is shared, the
 * search field is not.
 */
export interface DockLaunchSearchState {
  query: string;
  results: ReadonlyArray<DockLaunchItem>;
  selectedIndex: number;
  /** DOM id for a result row, so the input can point `aria-activedescendant` at it. */
  getOptionId: (key: string) => string;
  onHoverIndex: (index: number) => void;
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
  // The surface attribution to attach to the settings dispatch for
  // non-launchable rows. Defaults to "menu"; ContentDock's context-menu
  // path overrides it so telemetry stays consistent with how the user
  // actually opened the launcher.
  settingsSource?: ActionSource;
  search?: DockLaunchSearchState;
  /**
   * Model built by the caller. The `+` dropdown already derives one to feed its
   * search index and passes it down so both halves render from one snapshot;
   * the context menu omits it and the component derives its own.
   */
  model?: DockLaunchModel;
}

export function DockLaunchMenuItems({
  components: C,
  agents,
  activeWorktreeId,
  cwd,
  recipeContext,
  onLaunchAgent,
  pinnedCount,
  settingsSource = "menu",
  search,
  model: providedModel,
}: DockLaunchMenuItemsProps) {
  const derivedModel = useDockLaunchModel({ agents, pinnedCount, activeWorktreeId });
  const model = providedModel ?? derivedModel;

  const activate = (item: DockLaunchItem) =>
    activateDockLaunchItem(item, {
      cwd,
      activeWorktreeId,
      recipeContext,
      onLaunchAgent,
      settingsSource,
    });

  const renderAgentItem = (agent: DockLaunchAgent, keyPrefix?: string) => {
    const Icon = agent.icon;
    const isLaunchable = isAgentLaunchable(agent.availability);
    const blocked = isAgentBlocked(agent.availability);
    const settingsTooltip = blocked
      ? `${agent.name} is blocked by endpoint security. Click to configure.`
      : `${agent.name} needs setup. Click to configure.`;
    return (
      <C.Item
        key={keyPrefix ? `${keyPrefix}-${agent.id}` : agent.id}
        className={!isLaunchable ? "opacity-70" : undefined}
        title={!isLaunchable ? settingsTooltip : undefined}
        onSelect={() =>
          activate({ category: "agent", key: `agent:${agent.id}`, name: agent.name, agent })
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

  // First-run discovery cue: route into recipes instead of hiding the section,
  // so users who have never made one can find their way in. With an active
  // worktree, open the editor scoped to it; without one (the common first-run
  // case), fall back to the manager — the editor's event handler hard-requires
  // a string worktreeId and silently no-ops on undefined, so dispatching the
  // editor here would do nothing. Both actions are danger:"safe" and MRU-eligible.
  const renderCreateRecipeCue = () => (
    <C.Item
      onSelect={() => {
        if (activeWorktreeId) {
          void actionService.dispatch(
            "recipe.editor.open",
            { worktreeId: activeWorktreeId },
            { source: settingsSource }
          );
        } else {
          void actionService.dispatch("recipe.manager.open", {}, { source: settingsSource });
        }
      }}
    >
      <Workflow className="w-3.5 h-3.5 mr-2" />
      Create a recipe
    </C.Item>
  );

  const isFiltering = search !== undefined && search.query.trim().length > 0;

  if (isFiltering) {
    if (search.results.length === 0) {
      return (
        <>
          <C.Label>Search results</C.Label>
          <C.Item disabled>Try a different search</C.Item>
        </>
      );
    }

    return (
      <>
        <C.Label>Search results</C.Label>
        {search.results.map((item, index) => {
          const isSelected = index === search.selectedIndex;
          return (
            <C.Item
              key={item.key}
              id={search.getOptionId(item.key)}
              data-selected-row={isSelected ? "true" : "false"}
              // Radix focuses a menu item on pointer move unless the event is
              // prevented, which would yank DOM focus off the search input the
              // moment the pointer crosses a row. Keep focus on the input and
              // mirror the hover into the visual selection instead.
              onPointerMove={(event: React.PointerEvent) => {
                event.preventDefault();
                search.onHoverIndex(index);
              }}
              className={cn(
                "relative",
                isSelected &&
                  "bg-overlay-raised before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[2px] before:bg-daintree-accent before:content-['']"
              )}
              onSelect={() => activate(item)}
            >
              {item.category === "agent" ? (
                item.agent.icon ? (
                  <BrandMark brandColor={item.agent.brandColor} className="w-3.5 h-3.5 mr-2">
                    <item.agent.icon className="w-3.5 h-3.5" brandColor={item.agent.brandColor} />
                  </BrandMark>
                ) : (
                  <SquareTerminal className="w-3.5 h-3.5 mr-2" />
                )
              ) : item.category === "panel" ? (
                <PanelKindIcon iconId={item.iconId} color={item.color} size={14} className="mr-2" />
              ) : (
                <Workflow className="w-3.5 h-3.5 mr-2 shrink-0" />
              )}
              <span className="truncate">{item.name}</span>
              <span className="ml-auto pl-2 text-[11px] text-text-muted shrink-0">
                {item.category === "panel"
                  ? item.location === "dock"
                    ? "Dock"
                    : "Grid"
                  : item.category === "recipe"
                    ? item.scopeLabel
                    : "Agent"}
              </span>
            </C.Item>
          );
        })}
      </>
    );
  }

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
          hiding those kinds, the two headings state where each group lands.
          Both lists derive from `panelKindIsDockable`, the same predicate the
          store guards use, so a dockability flip moves an item between sections
          instead of letting a heading lie about it. */}
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
      <C.Label>Launch recipe</C.Label>
      {model.recipes.length > 0 ? model.recipes.map(renderRecipeItem) : renderCreateRecipeCue()}
    </>
  );
}
