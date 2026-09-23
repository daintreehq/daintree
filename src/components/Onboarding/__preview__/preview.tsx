// First: the bridge must exist before any store module reads it.
import { previewAgentSettings, previewAvailability } from "./firstRunShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, domAnimation } from "framer-motion";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useGettingStartedChecklist } from "@/hooks/app/useGettingStartedChecklist";
import { WelcomeScreen } from "@/components/Project/WelcomeScreen";
import { ContentGridEmptyState } from "@/components/Terminal/ContentGridEmptyState";
import { OnboardingFlow } from "../OnboardingFlow";
import { GettingStartedChecklist } from "../GettingStartedChecklist";
import type { Project } from "@shared/types";
import "@/index.css";

/**
 * Standalone visual-review harness for the first-run journey: the welcome
 * screen, the agent setup wizard it opens, and the getting-started checklist
 * that follows the user into their first project.
 *
 * The three are composed the way `ModalHostLayer` and `useEmptyCanvasContent`
 * compose them — the real `useGettingStartedChecklist` decides visibility, the
 * real `OnboardingFlow` listens for the banner's open event, and every write
 * goes through the onboarding IPC answered in `firstRunShims.ts`. So a spec that
 * clicks through the journey sees the app's own gating choose each next screen.
 *
 * What is a stand-in: the app chrome around the canvas (toolbar, sidebar).
 *
 * Query parameters (see also firstRunShims.ts):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?projects=0|3             how many known projects the user has
 *   ?open=1                   a project is already open when the page loads
 *
 * `window.__firstRun.openProject()` opens the first project mid-session.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const projectCount = Number(params.get("projects") ?? "0");
const projectOpen = params.get("open") === "1";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
useAppThemeStore.setState({ selectedSchemeId: themeId });
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const PROJECTS: Project[] = [
  {
    id: "p-helios",
    path: "/Users/you/Code/helios-dashboard",
    name: "Helios Dashboard",
    emoji: "🌤️",
    color: "sky",
    lastOpened: NOW - 2 * 60 * 60 * 1000,
    frecencyScore: 6,
    lastAccessedAt: NOW - 2 * 60 * 60 * 1000,
  },
  {
    id: "p-ledger",
    path: "/Users/you/Code/work/ledger-service",
    name: "ledger-service",
    emoji: "📒",
    color: "emerald",
    lastOpened: NOW - 1 * DAY,
    frecencyScore: 4,
    lastAccessedAt: NOW - 1 * DAY,
  },
  {
    id: "p-notes",
    path: "/Users/you/Code/side/field-notes",
    name: "field-notes",
    emoji: "🌿",
    lastOpened: NOW - 9 * DAY,
    frecencyScore: 2,
    lastAccessedAt: NOW - 9 * DAY,
  },
].slice(0, projectCount) as Project[];

const openProject = projectOpen ? (PROJECTS[0] ?? null) : null;

// Seeded before the first render so no component observes an empty store and
// then a populated one.
useProjectStore.setState({
  projects: PROJECTS,
  currentProject: openProject,
  isLoading: false,
});
useCliAvailabilityStore.setState({
  availability: previewAvailability,
  hasRealData: true,
  isLoading: false,
  isRefreshing: false,
  isInitialized: true,
  lastCheckedAt: NOW,
});
useAgentSettingsStore.setState({
  settings: structuredClone(previewAgentSettings),
  isLoading: false,
  isInitialized: true,
});

// Opens a project the way the app does — by setting it current — so the
// checklist's own store subscription sees the transition and marks it.
Reflect.set(window, "__firstRun", {
  openProject: () => useProjectStore.setState({ currentProject: PROJECTS[0] ?? null }),
});

const worktreeStore = createWorktreeStore();
setCurrentViewStore(worktreeStore);

function Canvas() {
  const gettingStarted = useGettingStartedChecklist(true);
  const availability = useCliAvailabilityStore((s) => s.availability);
  const currentProject = useProjectStore((s) => s.currentProject);

  return (
    <div data-preview-shell className="h-screen w-screen bg-surface-canvas">
      {currentProject ? (
        <div className="h-full w-full">
          <ContentGridEmptyState
            hasLaunchTarget
            hasProjectContext
            hasWorktrees={false}
            isWorktreeInitialized={false}
            workspaceName={currentProject.name}
            projectEmoji={currentProject.emoji}
            activeWorktreePath={currentProject.path}
            showProjectPulse={false}
            defaultCwd={currentProject.path}
          />
        </div>
      ) : (
        <WelcomeScreen gettingStarted={gettingStarted} />
      )}
      <OnboardingFlow
        availability={availability}
        hasWorkspace={currentProject !== null}
        onRefreshSettings={async () => undefined}
        onComplete={gettingStarted.notifyOnboardingComplete}
      />
      {currentProject !== null && gettingStarted.visible && gettingStarted.checklist && (
        <GettingStartedChecklist
          checklist={gettingStarted.checklist}
          collapsed={gettingStarted.collapsed}
          onDismiss={gettingStarted.dismiss}
          onToggleCollapse={gettingStarted.toggleCollapse}
          onMarkItem={gettingStarted.markItem}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The app mounts one in App.tsx; without it every `m.*` holds its
        `initial` frame, and the wizard's steps sit at opacity 0. */}
    <LazyMotion features={domAnimation}>
      <TooltipProvider>
        <WorktreeStoreContext value={worktreeStore}>
          <Canvas />
        </WorktreeStoreContext>
      </TooltipProvider>
    </LazyMotion>
  </StrictMode>
);
