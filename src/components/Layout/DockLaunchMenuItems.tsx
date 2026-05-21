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
  settingsSource = "menu",
}: DockLaunchMenuItemsProps) {
  // Subscribe inside the menu so the listener only runs while open.
  const recipes = useRecipeStore((s) => s.recipes);
  const visibleRecipes = recipes.filter(
    (r) => r.worktreeId === undefined || r.worktreeId === (activeWorktreeId ?? undefined)
  );

  return (
    <>
      {agents.length > 0 && (
        <>
          <C.Label>Launch agent</C.Label>
          {agents.map((agent) => {
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
          })}
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
