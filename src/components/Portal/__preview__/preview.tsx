import "./installShims";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { DEFAULT_SYSTEM_LINKS } from "@shared/types/portal";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePortalStore } from "@/store/portalStore";
import { PortalDock } from "../PortalDock";
import { FIXTURES, isFixtureName, type FixtureName, type PortalFixture } from "./fixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the Portal dock: the web-chat sidebar's
 * toolbar, tab strip, launchpad and dev-server section.
 *
 * Mounts the REAL `PortalDock` with the portal store seeded from fixtures, and
 * the dev-server snapshot answered through the bridge method the dashboard
 * store subscribes to. The chat page itself is a native `WebContentsView` laid
 * over the placeholder in the app, so page states paint a light stand-in there.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=launchpad-first-run   a key of FIXTURES
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "launchpad-first-run";
const fixtureName: FixtureName = isFixtureName(fixtureParam) ? fixtureParam : "launchpad-first-run";
const fixture: PortalFixture = FIXTURES[fixtureName];

const WORKTREE_NAMES: Record<string, string> = {
  "wt-main": "main",
  "wt-billing": "feature/billing-portal",
  "wt-onboarding": "feature/onboarding-checklist-redesign",
  "wt-search": "fix/search-index",
  "wt-legacy": "chore/legacy-cleanup",
};

const worktreeStore = createWorktreeStore();
worktreeStore.setState({
  worktrees: new Map(
    Object.entries(WORKTREE_NAMES).map(([id, name]): [string, WorktreeSnapshot] => [
      id,
      {
        id,
        worktreeId: id,
        path: `/Users/you/code/orchid-studio-worktrees/${id}`,
        name,
        branch: name,
        isCurrent: id === "wt-main",
      },
    ])
  ),
});
setCurrentViewStore(worktreeStore);

usePortalStore.setState({
  isOpen: true,
  width: fixture.width,
  tabs: fixture.tabs,
  activeTabId: fixture.activeTabId,
  createdTabs: new Set(fixture.createdTabs ?? []),
  links: DEFAULT_SYSTEM_LINKS.map((l) => ({ ...l, enabled: !fixture.noLinks })),
  showDevDashboard: fixture.showDevDashboard ?? false,
  defaultNewTabUrl: null,
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.documentElement.style.height = "auto";
document.body.style.height = "auto";
document.body.style.overflow = "visible";
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

// The chat page is a native view in the app; stand in for it with a light page.
const standIn = document.createElement("style");
standIn.textContent = `[data-fixture] #portal-placeholder > .bg-surface-sidebar:only-child { background: #f7f6f3; }`;
document.head.appendChild(standIn);

await primeRadix();

function Frame() {
  return (
    <div
      data-fixture={fixtureName}
      className="flex bg-surface-canvas"
      style={{ width: fixture.width + 16, height: fixture.height, paddingLeft: 16 }}
    >
      <PortalDock />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <WorktreeStoreContext value={worktreeStore}>
    <TooltipProvider delayDuration={0}>
      <Frame />
    </TooltipProvider>
  </WorktreeStoreContext>
);
