import type * as React from "react";
import { Globe, MonitorPlay, SquareTerminal } from "lucide-react";
import { BrandMark, Workflow } from "@/components/icons";
import { useRecipeStore } from "@/store/recipeStore";
import type { RecipeContext } from "@/utils/recipeVariables";
import { actionService } from "@/services/ActionService";
import type { ActionSource, AgentAvailabilityState } from "@shared/types";
import { isAgentBlocked, isAgentLaunchable } from "@shared/utils/agentAvailability";

type MenuComponent = React.ElementType;
type LaunchAgentIcon = React.ComponentType<{ className?: string; brandColor?: string }>;

export interface DockLaunchMenuComponents {
  Item: MenuComponent;
  Label: MenuComponent;
  Separator: MenuComponent;
}

export interface DockLaunchAgent {
  id: string;
  name: string;
  icon?: LaunchAgentIcon;
  brandColor?: string;
  availability?: AgentAvailabilityState;
}

interface DockLaunchMenuItemsProps {
  components: DockLaunchMenuComponents;
  agents: ReadonlyArray<DockLaunchAgent>;
  hasDevPreview: boolean;
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
}

export function DockLaunchMenuItems({
  components: C,
  agents,
  hasDevPreview,
  activeWorktreeId,
  cwd,
  recipeContext,
  onLaunchAgent,
  pinnedCount,
  settingsSource = "menu",
}: DockLaunchMenuItemsProps) {
  // Subscribe inside the menu so the listener only runs while open.
  const recipes = useRecipeStore((s) => s.recipes);
  const visibleRecipes = recipes.filter(
    (r) =>
      !r.shadowedBy &&
      (r.worktreeId === undefined || r.worktreeId === (activeWorktreeId ?? undefined))
  );

  const renderAgentItem = (agent: DockLaunchAgent) => {
    const Icon = agent.icon;
    const isLaunchable = isAgentLaunchable(agent.availability);
    const blocked = isAgentBlocked(agent.availability);
    // Mirrors AgentButton.tsx: a non-launchable but installed agent
    // dims and routes to its settings subtab so the user can resolve
    // the precondition instead of bouncing off a disabled row.
    const settingsTooltip = blocked
      ? `${agent.name} is blocked by endpoint security. Click to configure.`
      : `${agent.name} needs setup. Click to configure.`;
    return (
      <C.Item
        key={agent.id}
        className={!isLaunchable ? "opacity-70" : undefined}
        title={!isLaunchable ? settingsTooltip : undefined}
        onSelect={() => {
          if (isLaunchable) {
            onLaunchAgent(agent.id);
          } else {
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "agents", subtab: agent.id },
              { source: settingsSource }
            );
          }
        }}
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

  // Only split into labelled groups when the pinned set is a strict subset —
  // an all-pinned or all-unpinned list stays a single "Launch agent" group so
  // a lone "Pinned"/"Other" header never sits over the whole list.
  const showGroups = pinnedCount !== undefined && pinnedCount > 0 && pinnedCount < agents.length;

  return (
    <>
      {agents.length > 0 && (
        <>
          {showGroups ? (
            <>
              <C.Label>Pinned</C.Label>
              {agents.slice(0, pinnedCount).map(renderAgentItem)}
              <C.Separator />
              <C.Label>Other</C.Label>
              {agents.slice(pinnedCount).map(renderAgentItem)}
            </>
          ) : (
            <>
              <C.Label>Launch agent</C.Label>
              {agents.map(renderAgentItem)}
            </>
          )}
          <C.Separator />
        </>
      )}

      <C.Label>Launch panel</C.Label>
      <C.Item onSelect={() => onLaunchAgent("terminal")}>
        <SquareTerminal className="w-3.5 h-3.5 mr-2" />
        Terminal
      </C.Item>
      <C.Item onSelect={() => onLaunchAgent("browser")}>
        <Globe className="w-3.5 h-3.5 mr-2 text-status-info" />
        Browser
      </C.Item>
      {hasDevPreview && (
        <C.Item onSelect={() => onLaunchAgent("dev-preview")}>
          <MonitorPlay className="w-3.5 h-3.5 mr-2 text-status-success" />
          Dev preview
        </C.Item>
      )}

      {visibleRecipes.length > 0 && (
        <>
          <C.Separator />
          <C.Label>Launch recipe</C.Label>
          {visibleRecipes.map((recipe) => (
            <C.Item
              key={recipe.id}
              onSelect={() =>
                void useRecipeStore
                  .getState()
                  .runRecipe(recipe.id, cwd, activeWorktreeId ?? undefined, recipeContext)
              }
            >
              <Workflow className="w-3.5 h-3.5 mr-2" />
              {recipe.name}
            </C.Item>
          ))}
        </>
      )}
    </>
  );
}
