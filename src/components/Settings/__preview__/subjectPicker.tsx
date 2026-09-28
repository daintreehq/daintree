import "@/lib/trustedTypesPolicy";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExternalLink } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentAvailabilityState } from "@shared/types";
import { getAgentConfig } from "@/config/agents";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "../SettingsSection";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsSwitchCard } from "../SettingsSwitchCard";
import { AgentSelectorDropdown, type AgentOption } from "../AgentSelectorDropdown";
import {
  ForgeProviderSelectorDropdown,
  type ForgeProviderOption,
} from "../ForgeProviderSelectorDropdown";
import {
  PROJECT_PLUGINS_OVERVIEW_ID,
  ProjectPluginSelectorDropdown,
  type ProjectPluginOption,
} from "../ProjectPluginSelectorDropdown";
import "@/index.css";

/**
 * Standalone visual-review harness for the settings subject pickers — the
 * control at the top of CLI agents, Code forge and a project's Plugins page that
 * chooses what the rest of the page is about.
 *
 * The three pickers are prop-driven, so this mounts the real components with
 * fixture options inside a stand-in for the settings dialog body (same column
 * width, inset and `settings-shell` paint) with a real section under each, so an
 * open list is judged against the page it covers.
 *
 * Query parameters (driven by `settings-subject-picker-review.spec.ts`):
 *   ?theme=daintree|bondi|…      built-in theme id
 *   ?page=agents|forge|plugins   which picker
 *   ?subject=general|<id>        the page being shown
 *   ?width=687                   dialog content column width in px
 */

installPreviewShims({});

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const page = params.get("page") ?? "agents";
const subject = params.get("subject") ?? "general";
const width = Number(params.get("width") ?? "687");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.margin = "0";
document.body.style.background = "var(--color-surface-canvas)";

const AGENT_STATES: Array<[string, AgentAvailabilityState, boolean]> = [
  ["claude", "ready", false],
  ["codex", "ready", true],
  ["gemini", "unauthenticated", false],
  ["opencode", "ready", false],
  ["cursor", "missing", false],
  ["copilot", "installed", true],
  ["goose", "blocked", false],
  ["kimi", "missing", false],
  ["grok", "ready", false],
  ["antigravity", "missing", false],
];

const AGENT_OPTIONS: AgentOption[] = AGENT_STATES.flatMap(([id, availability, dangerous]) => {
  const config = getAgentConfig(id);
  if (!config) return [];
  return [
    {
      id,
      name: config.name,
      color: config.color,
      Icon: config.icon,
      selected: availability === "ready",
      availability,
      dangerousEnabled: dangerous,
      hasCustomFlags: false,
    },
  ];
});

const FORGE_OPTIONS: ForgeProviderOption[] = [
  { id: "daintree.github.github", name: "GitHub", pluginId: "daintree.github" },
  { id: "daintree.gitlab.gitlab", name: "GitLab", pluginId: "daintree.gitlab" },
  { id: "acme.gitea.gitea", name: "Gitea (Acme)", pluginId: "acme.gitea" },
];

const PLUGIN_OPTIONS: ProjectPluginOption[] = [
  {
    id: "project:lifeplan",
    pluginId: "lifeplan",
    name: "LifePlan",
    origin: "project",
    status: "Running",
    active: true,
  },
  {
    id: "project:release-notes",
    pluginId: "release-notes",
    name: "Release notes",
    origin: "project",
    status: "Staged",
    active: false,
  },
  {
    id: "installed:docker",
    pluginId: "acme.docker",
    name: "Docker Control",
    origin: "installed",
    status: "Off",
    active: false,
  },
  {
    id: "installed:github",
    pluginId: "daintree.github",
    name: "GitHub",
    origin: "installed",
    status: "Built-in",
    active: true,
  },
  {
    id: "installed:gitlab",
    pluginId: "daintree.gitlab",
    name: "GitLab",
    origin: "installed",
    status: "Built-in",
    active: true,
  },
  {
    id: "installed:markdown",
    pluginId: "acme.markdown",
    name: "Markdown editor",
    origin: "installed",
    status: "Off",
    active: false,
  },
  {
    id: "installed:sveltekit",
    pluginId: "daintree.sveltekit",
    name: "SvelteKit Tools",
    origin: "installed",
    status: "Built-in",
    active: true,
  },
];

await primeRadix();

/** A real section under the picker, so an open list is judged over the page it covers. */
function PageBody({ title }: { title: string }) {
  const [on, setOn] = useState(true);
  return (
    <SettingsSection title={title} description="Applies to every new session on this machine">
      <SettingsGroup>
        <SettingsSwitchCard
          title="Allowed to run"
          subtitle="They execute with your account — Daintree doesn't sandbox them"
          isEnabled={on}
          onChange={() => setOn((v) => !v)}
        />
        <SettingsSwitchCard
          title="Show on the empty canvas"
          subtitle="Draws what this project shows when no panels are open"
          isEnabled={!on}
          onChange={() => setOn((v) => !v)}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

function AgentsPage() {
  const [active, setActive] = useState(subject);
  const agent = AGENT_OPTIONS.find((a) => a.id === active);
  return (
    <div className="space-y-8">
      <AgentSelectorDropdown
        agentOptions={AGENT_OPTIONS}
        activeSubtab={active}
        onSubtabChange={setActive}
        actions={
          agent && (
            <Button size="sm" variant="outline" className="shrink-0">
              <ExternalLink aria-hidden="true" />
              View usage
            </Button>
          )
        }
      />
      <PageBody title={agent ? "Launch" : "Default agent"} />
    </div>
  );
}

function ForgePage() {
  const [active, setActive] = useState(subject);
  return (
    <div className="space-y-8">
      <ForgeProviderSelectorDropdown
        providerOptions={FORGE_OPTIONS}
        activeSubtab={active}
        onSubtabChange={setActive}
      />
      <PageBody title={active === "general" ? "Forge audit log" : "Credentials"} />
    </div>
  );
}

function PluginsPage() {
  const [active, setActive] = useState(
    subject === "general" ? PROJECT_PLUGINS_OVERVIEW_ID : subject
  );
  return (
    <div className="space-y-8">
      <ProjectPluginSelectorDropdown
        options={PLUGIN_OPTIONS}
        activeId={active}
        onChange={setActive}
      />
      <PageBody
        title={active === PROJECT_PLUGINS_OVERVIEW_ID ? "This project's plugins" : "Empty canvas"}
      />
    </div>
  );
}

function Harness() {
  return (
    <div className="p-6">
      <div
        data-preview-frame=""
        className="settings-shell rounded-[var(--radius-xl)] border border-border-default py-6 px-6"
        style={{ width: `${width}px`, minHeight: "640px" }}
      >
        {page === "forge" ? <ForgePage /> : page === "plugins" ? <PluginsPage /> : <AgentsPage />}
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
