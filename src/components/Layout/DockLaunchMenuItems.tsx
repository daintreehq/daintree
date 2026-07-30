import type * as React from "react";
import { Fragment } from "react";
import { Globe, MonitorPlay, SquareTerminal } from "lucide-react";
import { BrandMark, Workflow } from "@/components/icons";
import { useRecipeStore } from "@/store/recipeStore";
import { useActionMruStore } from "@/store/actionMruStore";
import type { RecipeContext } from "@/utils/recipeVariables";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import { getRecipeScope } from "@/utils/recipeScope";
import { logError } from "@/utils/logger";
import { actionService } from "@/services/ActionService";
import type { ActionSource, AgentAvailabilityState } from "@shared/types";
import { isAgentBlocked, isAgentLaunchable } from "@shared/utils/agentAvailability";
import { panelKindIsDockable } from "@shared/config/panelKindRegistry";

// Cap the "Recently launched" band so it stays a quick-reach shortcut rather
// than a second full agent list above the fixed Pinned/Other groups.
const RECENCY_BAND_CAP = 3;
const AGENT_MRU_PREFIX = "agent.";

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
  // Shadowed recipes stay listed (dimmed, marked "Overridden") rather than
  // vanishing — running one resolves to the winner, so hiding it only hides
  // that the collision exists (#11510).
  const visibleRecipes = recipes.filter(
    (r) => r.worktreeId === undefined || r.worktreeId === (activeWorktreeId ?? undefined)
  );

  // Subscribe to the stable getter (not its result) so the selector returns a
  // constant reference — calling getSortedActionMruList() inside the selector
  // would mint a new array every render and trip Zustand 5's infinite-loop
  // guard. Mirrors AgentTrayButton's pattern.
  const getSortedActionMruList = useActionMruStore((s) => s.getSortedActionMruList);
  // Build the capped recency band from agent launches only. Filter out
  // cold-start seeds (lastAccessedAt === 0 are never-launched), keep agent.*
  // keys, map back to the live agent objects (dropping stale/removed agents),
  // then cap. Duplicates with the Pinned/Other groups below are intentional —
  // the band is a quick-reach shortcut, not a replacement grouping.
  const recentAgents = getSortedActionMruList()
    .filter((entry) => entry.lastAccessedAt > 0 && entry.id.startsWith(AGENT_MRU_PREFIX))
    .map((entry) => agents.find((a) => a.id === entry.id.slice(AGENT_MRU_PREFIX.length)))
    .filter((agent): agent is DockLaunchAgent => agent !== undefined)
    .slice(0, RECENCY_BAND_CAP);

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
            // Record the launch so it surfaces in the recency band on the next
            // open. The dock path (both the + pill and the right-click context
            // menu route through here) previously never recorded MRU; this
            // mirrors AgentTrayButton's tray-launch recording.
            useActionMruStore.getState().recordActionMru(`${AGENT_MRU_PREFIX}${agent.id}`);
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
      {recentAgents.length > 0 && (
        <>
          <C.Label>Recently launched</C.Label>
          {recentAgents.map((agent) => (
            <Fragment key={`recent-${agent.id}`}>{renderAgentItem(agent)}</Fragment>
          ))}
          <C.Separator />
        </>
      )}

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

      {/* The dock launcher creates panels directly in the dock, so it must only
          offer kinds the dock can render (#11054) — otherwise the panel is
          redirected to the grid on create (`addPanel`) and the menu item lies
          about where it lands. Gate on the same `panelKindIsDockable` predicate
          the store guards use, so #11053 (making browser dockable) flips this
          on without touching a second allowlist. Terminal is always dockable. */}
      <C.Label>Launch panel</C.Label>
      <C.Item onSelect={() => onLaunchAgent("terminal")}>
        <SquareTerminal className="w-3.5 h-3.5 mr-2" />
        Terminal
      </C.Item>
      {panelKindIsDockable("browser") && (
        <C.Item onSelect={() => onLaunchAgent("browser")}>
          <Globe className="w-3.5 h-3.5 mr-2 text-status-info" />
          Browser
        </C.Item>
      )}
      {hasDevPreview && panelKindIsDockable("dev-preview") && (
        <C.Item onSelect={() => onLaunchAgent("dev-preview")}>
          <MonitorPlay className="w-3.5 h-3.5 mr-2 text-status-success" />
          Dev preview
        </C.Item>
      )}

      <C.Separator />
      <C.Label>Launch recipe</C.Label>
      {visibleRecipes.length > 0 ? (
        visibleRecipes.map((recipe) => (
          <C.Item
            key={recipe.id}
            className={recipe.shadowedBy ? "opacity-70" : undefined}
            onSelect={() =>
              // Fire-and-forget, but surface spawn failures — the menu closes
              // on select, so a toast/inbox entry is the only signal the user
              // gets when terminals are dropped (e.g. panel limit).
              void useRecipeStore
                .getState()
                .runRecipeWithResults(recipe.id, cwd, activeWorktreeId ?? undefined, recipeContext)
                .then((results) => notifyRecipeSpawnFailures(results, { recipeName: recipe.name }))
                .catch((error) => logError("Recipe launch from dock failed", error))
            }
          >
            <Workflow className="w-3.5 h-3.5 mr-2 shrink-0" />
            <span className="truncate">{recipe.name}</span>
            <span className="ml-auto pl-2 text-[11px] text-text-muted shrink-0">
              {recipe.shadowedBy
                ? `${getRecipeScope(recipe).label} · Overridden`
                : getRecipeScope(recipe).label}
            </span>
          </C.Item>
        ))
      ) : (
        // First-run discovery cue: route into recipes instead of hiding the
        // section, so users who have never made one can find their way in.
        // With an active worktree, open the editor scoped to it; without one
        // (the common first-run case), fall back to the manager — the editor's
        // event handler hard-requires a string worktreeId and silently no-ops
        // on undefined, so dispatching the editor here would do nothing. Both
        // actions are danger:"safe" and MRU-eligible.
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
          No recipes yet
        </C.Item>
      )}
    </>
  );
}
