import "./launcherShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentAvailabilityState } from "@shared/types/ipc/system";
import type { TerminalRecipe } from "@shared/types";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getAgentConfig } from "@/config/agents";
import { sortAgentsByToolbarPin } from "@/lib/agentMenuOrder";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useActionMruStore } from "@/store/actionMruStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { DockLaunchButton, type DockLaunchPlacement } from "../DockLaunchButton";
import type { DockLaunchAgent } from "../dockLaunchItems";
import "@/index.css";

/**
 * Standalone visual-review harness for the `+` launcher.
 *
 * Mounts the real `DockLaunchButton` against the real theme tokens and
 * `index.css`, with the stores it reads seeded to a populated machine: nine
 * launchable agents (four pinned to the toolbar), one recently launched, three
 * recipes across two scopes, and the built-in panel kinds. The Electron harness
 * (`launcher-review.spec.ts`) cannot reach that state without a fake binary per
 * agent, and a launcher with one agent in it hides every layout question worth
 * asking.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…      built-in theme id
 *   ?placement=toolbar|dock      which trigger is mounted (default toolbar)
 *   ?fixture=populated|setup|few inventory to seed (default populated)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const placement: DockLaunchPlacement = params.get("placement") === "dock" ? "dock" : "toolbar";
const fixture = params.get("fixture") ?? "populated";

const PINNED = ["claude", "antigravity", "codex", "grok"] as const;
const OTHERS = ["opencode", "gemini", "cursor", "goose", "kimi"] as const;

function availabilityFor(): Record<string, AgentAvailabilityState> {
  const availability: Record<string, AgentAvailabilityState> = {};
  const launchable = fixture === "few" ? ["claude", "codex"] : [...PINNED, ...OTHERS];
  for (const id of launchable) availability[id] = "ready";
  if (fixture === "setup") {
    availability.aider = "installed";
    availability.copilot = "blocked";
  }
  return availability;
}

const RECIPES: TerminalRecipe[] = [
  {
    id: "global-work",
    name: "Work",
    terminals: [{ type: "claude", title: "Work", env: {} }],
    createdAt: 1775381905486,
  },
  {
    id: "global-design-review",
    name: "Design Review",
    terminals: [{ type: "claude", title: "Design Review", env: {} }],
    createdAt: 1775381905487,
  },
  {
    id: "inrepo-work",
    name: "Work",
    projectId: "preview-project",
    scope: "inrepo",
    terminals: [{ type: "claude", title: "Work", env: {} }],
    createdAt: 1775381905488,
  },
] as TerminalRecipe[];

/**
 * Seeded before the first render, never from inside a component body — React
 * flags a store write during another component's render as a cross-component
 * update, and the launcher reads every one of these on mount.
 */
function seedStores(): void {
  initBuiltInPanelKinds();
  const availability = availabilityFor();
  useCliAvailabilityStore.setState({
    availability,
    hasRealData: true,
    refresh: async () => {},
  } as never);
  const pinned = fixture === "few" ? ["claude"] : [...PINNED];
  useAgentSettingsStore.setState({
    settings: {
      agents: Object.fromEntries(pinned.map((id) => [id, { pinned: true }])),
    },
  } as never);
  const layout = useToolbarPreferencesStore.getState().layout;
  useToolbarPreferencesStore.setState({
    layout: {
      ...layout,
      leftButtons: [...pinned, ...layout.leftButtons.filter((id) => !pinned.includes(id))],
    },
  } as never);
  useRecipeStore.setState({
    recipes: fixture === "few" ? [] : RECIPES,
    currentProjectId: "preview-project",
    isLoading: false,
  } as never);
  // Two shared presets on Claude, so the row carries its disclosure and the
  // expansion has a provenance heading and a non-current choice to show.
  useProjectPresetsStore.setState({
    presetsByAgent: {
      claude: [
        { id: "team-plan", name: "Plan first" },
        { id: "team-sonnet", name: "Sonnet" },
      ],
    },
  } as never);
  if (fixture !== "few") useActionMruStore.getState().recordActionMru("agent.opencode");
}

function buildAgents(): { agents: DockLaunchAgent[]; pinnedCount: number } {
  const availability = useCliAvailabilityStore.getState().availability ?? {};
  const toAgent = (id: string): DockLaunchAgent => {
    const config = getAgentConfig(id);
    return {
      id,
      name: config?.name ?? id,
      icon: config?.icon,
      brandColor: config?.color,
      availability: availability[id],
    };
  };
  const ids = Object.keys(availability);
  const launchable = ids.filter((id) => availability[id] === "ready").map(toAgent);
  const setup = ids.filter((id) => availability[id] !== "ready").map(toAgent);
  const layout = useToolbarPreferencesStore.getState().layout;
  const { sorted, pinnedCount } = sortAgentsByToolbarPin(
    launchable,
    layout.leftButtons,
    useAgentSettingsStore.getState().settings,
    layout.rightButtons,
    layout.pinnedButtons
  );
  return { agents: [...sorted, ...setup], pinnedCount };
}

seedStores();

function Launcher({ where }: { where: DockLaunchPlacement }) {
  const { agents, pinnedCount } = useMemo(() => buildAgents(), []);
  return (
    <DockLaunchButton
      placement={where}
      agents={agents}
      pinnedCount={pinnedCount}
      agentInventoryState="installed"
      hasWorkspace
      hasProject
      activeWorktreeId="wt-main"
      cwd="/Users/dev/helios-dashboard"
      onLaunchAgent={() => {}}
      data-toolbar-item=""
    />
  );
}

/**
 * A stand-in for the app chrome the launcher hangs off: a toolbar strip across
 * the top, a canvas, and a dock strip across the bottom. Only the trigger is
 * real; the chrome is here so the popover has the edges it opens against.
 */
function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col">
        <div
          data-preview-toolbar=""
          className="flex h-11 shrink-0 items-center gap-1 border-b border-divider bg-surface-sidebar px-3"
          style={{ paddingLeft: 160 }}
        >
          {placement === "toolbar" && <Launcher where="toolbar" />}
        </div>
        <div className="flex-1 bg-surface-canvas" />
        <div
          data-preview-dock=""
          className="flex h-10 shrink-0 items-center border-t border-divider bg-surface-sidebar px-3"
          style={{ paddingLeft: 160 }}
        >
          {placement === "dock" && <Launcher where="dock" />}
        </div>
      </div>
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
