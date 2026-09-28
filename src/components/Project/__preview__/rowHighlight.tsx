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
import type {
  ProjectSwitcherBrowseBand,
  ProjectSwitcherProjectRow,
  ProjectSectionKey,
} from "@/hooks/useProjectSwitcherPalette";
import "@/index.css";

/**
 * Standalone visual-review harness for the app's highlighted-row language on
 * the two surfaces no other preview reaches: the project switcher and a plain
 * Radix dropdown menu. `row-highlight-review.spec.ts` drives these beside the
 * other palette previews, so the keyboard cursor and the pointer can be judged
 * on every family in one sweep.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…        built-in theme id
 *   ?surface=project-switcher|menu which surface to mount
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
  project("daintree", "daintree", "🌳", "emerald", "current", {
    isActive: true,
    activeAgentCount: 2,
    processCount: 3,
    lastOpened: NOW,
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
  { key: "current", label: "Current project", itemCount: 1, collapsed: false },
  { key: "running", label: "Running", itemCount: 1, collapsed: false },
  { key: "other", label: "Other projects", itemCount: 3, collapsed: false },
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      {surface === "menu" ? (
        <MenuSurface />
      ) : (
        <div data-preview-frame>
          <ProjectSwitcherSurface />
        </div>
      )}
    </TooltipProvider>
  </StrictMode>
);
