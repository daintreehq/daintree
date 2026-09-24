import "./toolbarSettingsShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentAvailabilityState } from "@shared/types/ipc/system";
import type { TerminalRecipe } from "@shared/types";
import {
  launcherItemToolbarButtonId,
  type AnyToolbarButtonId,
  type ToolbarPinnedState,
} from "@shared/types/toolbar";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useRecipeStore } from "@/store/recipeStore";
import { recipeToolbarSourceId } from "@/utils/recipeScope";
import "@/index.css";

/**
 * Standalone visual-review harness for Settings → Toolbar customization.
 *
 * Mounts the real `ToolbarSettingsTab` inside a stand-in for the settings
 * dialog body — the same column width, inset and `settings-shell` paint — with
 * the stores it reads seeded before the first render.
 *
 * Query parameters (driven by `toolbar-settings-review.spec.ts`):
 *   ?theme=daintree|bondi|bali|…  built-in theme id
 *   ?fixture=fresh|legacy|populated|empty-right
 *     fresh        a current profile: four agents pinned, the shipped side arrays
 *     legacy       a profile from before agents left the default left array, so
 *                  every agent id still sits in it (most of them off)
 *     populated    fresh plus pinned recipes and plugin panels, two plugin
 *                  buttons (one promoted), a hidden right-side button, and
 *                  modified launcher options
 *     empty-right  every right-side button moved to the left
 *   ?width=687     dialog content column width in px (the 4xl dialog minus its nav)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixture = params.get("fixture") ?? "fresh";
const width = Number(params.get("width") ?? "687");

const PINNED_AGENTS = ["claude", "antigravity", "codex", "grok"] as const;
const INSTALLED_AGENTS = ["opencode", "gemini", "cursor", "goose", "kimi", "copilot"] as const;

const RECIPES: TerminalRecipe[] = [
  {
    id: "global-design-review",
    name: "Design review",
    terminals: [{ type: "claude", title: "Design review", env: {} }],
    createdAt: 1775381905487,
  },
  {
    id: "inrepo-release",
    name: "Cut a release and draft the changelog",
    projectId: "preview-project",
    scope: "inrepo",
    terminals: [{ type: "claude", title: "Release", env: {} }],
    createdAt: 1775381905488,
  },
] as TerminalRecipe[];

function seed(): void {
  initBuiltInPanelKinds();

  const availability: Record<string, AgentAvailabilityState> = {};
  for (const id of [...PINNED_AGENTS, ...INSTALLED_AGENTS]) availability[id] = "ready";
  useCliAvailabilityStore.setState({ availability, hasRealData: true });

  // Every launchable agent carries an explicit pin, the way a profile that has
  // been through the launcher does, so nothing hinges on the "installed" default.
  useAgentSettingsStore.setState({
    settings: {
      agents: Object.fromEntries(
        LAUNCHABLE_AGENT_IDS.map((id) => [
          id,
          { pinned: (PINNED_AGENTS as readonly string[]).includes(id) },
        ])
      ),
    },
  });

  const defaults = useToolbarPreferencesStore.getState().layout;
  let leftButtons: AnyToolbarButtonId[] = [
    "launcher",
    ...PINNED_AGENTS,
    ...defaults.leftButtons.filter((id) => id !== "launcher"),
  ];
  let rightButtons: AnyToolbarButtonId[] = [...defaults.rightButtons];
  const pinnedButtons: ToolbarPinnedState = {};

  if (fixture === "legacy") {
    leftButtons = [
      "launcher",
      ...LAUNCHABLE_AGENT_IDS,
      "terminal",
      "file-browser",
      "browser",
      "dev-server",
    ];
    pinnedButtons.browser = false;
  }

  if (fixture === "populated") {
    useRecipeStore.setState({
      recipes: RECIPES,
      currentProjectId: "preview-project",
      isLoading: false,
    });
    const recipeIds = RECIPES.map((recipe) =>
      launcherItemToolbarButtonId("recipe", recipeToolbarSourceId(recipe, "preview-project"))
    );
    for (const id of recipeIds) pinnedButtons[id] = true;
    leftButtons = [...leftButtons, ...recipeIds];
    pinnedButtons["acme.pull-requests"] = true;
    rightButtons = ["acme.pull-requests" as AnyToolbarButtonId, ...rightButtons];
    pinnedButtons["notification-center"] = false;
    pinnedButtons["voice-recording"] = false;
    pinnedButtons["dev-server"] = true;
    leftButtons.push("dev-server");
    useToolbarPreferencesStore.setState({
      launcher: { alwaysShowDevServer: true, defaultSelection: "claude" },
    });
  }

  if (fixture === "empty-right") {
    leftButtons = [...leftButtons, ...rightButtons];
    rightButtons = [];
  }

  useToolbarPreferencesStore.setState({
    layout: { ...defaults, leftButtons, rightButtons, pinnedButtons },
  });
}

seed();
applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.margin = "0";
document.body.style.background = "var(--color-surface-canvas)";

await primeRadix();
const { ToolbarSettingsTab } = await import("../ToolbarSettingsTab");

function Harness() {
  return (
    <div className="p-6">
      {/* The dialog's own body: `settings-shell` paint, 24px inset, fixed column width. */}
      <div
        data-preview-frame=""
        className="settings-shell rounded-[var(--radius-xl)] border border-border-default py-6 px-6"
        style={{ width: `${width}px` }}
      >
        <ToolbarSettingsTab />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </StrictMode>
);
