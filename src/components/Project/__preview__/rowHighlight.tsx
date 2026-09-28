import "@/components/Layout/__preview__/launcherShims";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectSwitcherPalette } from "../ProjectSwitcherPalette";
import { NavGroup, NavItem } from "@/components/Settings/SettingsDialog";
import type { SettingsTab } from "@/components/Settings/settingsTabIds";
import { Bell, Bot, Keyboard, Palette, Plug, SlidersHorizontal } from "lucide-react";
import type {
  ProjectSwitcherBrowseBand,
  ProjectSwitcherProjectRow,
  ProjectSectionKey,
  SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";
import "@/index.css";

/**
 * Standalone visual-review harness for the app's highlighted-row language on
 * the surfaces no other preview reaches: the project switcher, a plain Radix
 * dropdown menu and the settings sidebar nav. `row-highlight-review.spec.ts` drives these beside the
 * other palette previews, so the keyboard cursor and the pointer can be judged
 * on every family in one sweep.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…        built-in theme id
 *   ?surface=project-switcher|menu|settings-nav which surface to mount
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const surface = params.get("surface") ?? "project-switcher";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";

const NOW = Date.now();

function project(
  id: string,
  name: string,
  emoji: string,
  color: string,
  section: ProjectSectionKey,
  extra: Partial<ProjectSwitcherProjectRow> = {}
): ProjectSwitcherProjectRow {
  return {
    kind: "project",
    id,
    name,
    path: `/Users/dev/Projects/${id}`,
    displayPath: `~/Projects/${id}`,
    emoji,
    color,
    status: "active",
    isBackground: false,
    isMissing: false,
    isPinned: false,
    frecencyScore: 1,
    section,
    lastOpened: NOW - 3_600_000,
    isActive: false,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    processCount: 0,
    ...extra,
  };
}

const PROJECTS: ProjectSwitcherProjectRow[] = [
  // The window is in a scratch, so the scratch section carries the "you are
  // here" check and no project is current.
  project("daintree", "daintree", "🌳", "emerald", "running", {
    activeAgentCount: 2,
    processCount: 3,
    lastOpened: NOW - 60_000,
  }),
  project("helios-dashboard", "Helios Dashboard", "☀️", "amber", "running", {
    activeAgentCount: 1,
    processCount: 1,
    latestWorkingSince: NOW - 120_000,
  }),
  project("assistant", "assistant", "🤖", "violet", "other"),
  project("backend", "backend", "🛠️", "blue", "other"),
  project("marketing-site", "marketing-site", "📣", "rose", "other"),
];

const BANDS: ProjectSwitcherBrowseBand[] = [
  { key: "running", label: "Running", itemCount: 2, collapsed: false },
  { key: "other", label: "Other projects", itemCount: 3, collapsed: false },
];

function scratch(id: string, name: string, isActive: boolean): SearchableScratch {
  return {
    id,
    name,
    path: `/Users/dev/.daintree/scratch/${id}`,
    createdAt: NOW - 86_400_000,
    lastOpened: NOW - (isActive ? 0 : 7_200_000),
    isActive,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    processCount: 0,
  };
}

const SCRATCHES: SearchableScratch[] = [
  scratch("spike-auth", "Spike: auth refresh", false),
  scratch("try-vite", "Try Vite 9", true),
];

const noop = () => {};

function ProjectSwitcherSurface() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  return (
    <ProjectSwitcherPalette
      isOpen
      mode="modal"
      query=""
      results={PROJECTS}
      browseBands={BANDS}
      selectedIndex={selectedIndex}
      onQueryChange={noop}
      onSelectPrevious={() => setSelectedIndex((i) => Math.max(0, i - 1))}
      onSelectNext={() => setSelectedIndex((i) => Math.min(PROJECTS.length - 1, i + 1))}
      onSelect={noop}
      onClose={noop}
      onHoverRow={(id) => setSelectedIndex(PROJECTS.findIndex((p) => p.id === id))}
      scratchResults={SCRATCHES}
      onSelectScratch={noop}
      onCreateScratch={noop}
    />
  );
}

function MenuSurface() {
  return (
    <div className="p-10" data-preview-frame>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger className="rounded-[var(--radius-md)] border border-border-default px-3 py-1.5 text-xs text-text-secondary">
          Copy context
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem>
            Copy full context
            <DropdownMenuShortcut>⌘⇧C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Recent</DropdownMenuLabel>
          <DropdownMenuItem>src</DropdownMenuItem>
          <DropdownMenuItem>electron</DropdownMenuItem>
          <DropdownMenuItem>shared</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Context settings</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const NAV: Array<{ tab: SettingsTab; label: string; icon: React.ReactNode }> = [
  { tab: "general", label: "General", icon: <SlidersHorizontal className="h-4 w-4" /> },
  { tab: "terminal", label: "Terminal", icon: <Palette className="h-4 w-4" /> },
  { tab: "keyboard", label: "Keyboard", icon: <Keyboard className="h-4 w-4" /> },
  { tab: "notifications", label: "Notifications", icon: <Bell className="h-4 w-4" /> },
  { tab: "agents", label: "CLI agents", icon: <Bot className="h-4 w-4" /> },
  { tab: "plugins", label: "Plugins", icon: <Plug className="h-4 w-4" /> },
];

function SettingsNavSurface() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("terminal");
  return (
    <div data-preview-frame className="p-6">
      <div
        className="settings-sidebar w-52 rounded-[var(--radius-lg)] border border-border-default p-3"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Settings sections"
      >
        <NavGroup label="App">
          {NAV.map((entry) => (
            <NavItem
              key={entry.tab}
              tab={entry.tab}
              icon={entry.icon}
              label={entry.label}
              activeTab={activeTab}
              isSearching={false}
              onSelect={setActiveTab}
            />
          ))}
        </NavGroup>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      {surface === "menu" ? (
        <MenuSurface />
      ) : surface === "settings-nav" ? (
        <SettingsNavSurface />
      ) : (
        <div data-preview-frame>
          <ProjectSwitcherSurface />
        </div>
      )}
    </TooltipProvider>
  </StrictMode>
);
