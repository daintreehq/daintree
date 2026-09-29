import "./buttonStatesBootstrap";
import { Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { CliAvailability, Project } from "@shared/types";
import type { PendingCrash } from "@shared/types/ipc/crashRecovery";
import type { ResourceEnvironment } from "@shared/types/project";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { useProjectStore } from "@/store/projectStore";
import { SettingsValidationProvider } from "@/components/Settings/SettingsValidationRegistry";
import { SettingsFlushProvider } from "@/components/Settings/SettingsFlushRegistry";
import { ResourceEnvironmentsSection } from "@/components/Settings/ResourceEnvironmentsSection";
import { CrashRecoveryDialog } from "@/components/Recovery/CrashRecoveryDialog";
import { HelpAssistantAgentChooser } from "@/components/HelpPanel/HelpAssistantAgentChooser";
import { HelpPanel } from "@/components/HelpPanel/HelpPanel";
import { LauncherQuickActions } from "@/components/Terminal/LauncherQuickActions";
import { FROZEN_NOW, setPreviewCliAvailability } from "./buttonStatesBootstrap";
import { fixture, never, noop, noopAsync } from "./buttonStatesFrame";
import "@/index.css";

// Dynamic rather than static so the harness entry obeys the app's lazy-load rule
// (#7659), as the button-states entry does.
const { LazyMotion, domAnimation } = await import("framer-motion");

/**
 * Visual-review harness for the app's clickable choice and action cards that no
 * other preview page reaches: the crash dialog's no-panels branch, the assistant
 * agent chooser and the idle assistant panel's starter prompts, the canvas
 * launcher's quick-action chips, and the resource-environments add form.
 *
 * Every scene mounts the SHIPPED component, imported, never copied, fed through
 * its real props and stores. The bridge comes from `buttonStatesBootstrap.ts`
 * (frozen clock, inert fallbacks), so nothing here stubs IPC of its own.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?scene=<name>             one of SCENES below
 *   ?panels=0|1               crash scene: with or without restorable panels
 */

interface Scene {
  width?: number;
  seed?: () => void;
  render: () => ReactNode;
}

const PROJECT = fixture<Project>({
  id: "preview-project",
  path: "/Users/dev/helios-dashboard",
  name: "helios-dashboard",
  emoji: "🌻",
  lastOpened: FROZEN_NOW,
});

function crashFixture(withPanels: boolean): PendingCrash {
  return {
    logPath: "/Users/greg/Library/Logs/Daintree/crash-2025-11-24.json",
    hasBackup: true,
    backupTimestamp: FROZEN_NOW - 60_000,
    crashCount: 1,
    entry: {
      id: "crash-1",
      timestamp: FROZEN_NOW - 60_000,
      appVersion: "0.14.0",
      platform: "darwin",
      osVersion: "25.4.0",
      arch: "arm64",
      errorMessage: "Renderer process gone: oom",
      errorStack:
        "Error: Renderer process gone: oom\n    at WebContents.<anonymous> (main.js:4120:17)\n    at WebContents.emit (node:events:519:28)",
      sessionDurationMs: 3_600_000,
      electronVersion: "42.0.0",
      panelCount: withPanels ? 3 : 0,
    },
    panels: withPanels
      ? [
          {
            id: "p-1",
            kind: "terminal",
            title: "Claude",
            location: "grid",
            isSuspect: false,
            worktreeId: "wt-main",
          },
          {
            id: "p-2",
            kind: "terminal",
            title: "npm run dev",
            location: "dock",
            isSuspect: true,
            suspectReason: "crash-window",
          },
          {
            id: "p-3",
            kind: "browser",
            title: "localhost:5173",
            location: "grid",
            isSuspect: false,
          },
        ]
      : [],
  };
}

function seedAgents(ids: readonly string[], pinned: boolean) {
  const availability = fixture<CliAvailability>(Object.fromEntries(ids.map((id) => [id, "ready"])));
  setPreviewCliAvailability(availability);
  useCliAvailabilityStore.setState({
    availability,
    hasRealData: true,
    isLoading: false,
    isRefreshing: false,
  });
  if (pinned) {
    useAgentSettingsStore.setState({
      settings: { agents: Object.fromEntries(ids.map((id) => [id, { pinned: true }])) },
    });
  }
}

function EnvironmentsScene() {
  const [envs, setEnvs] = useState<Record<string, ResourceEnvironment>>({
    "docker-local": {},
  });
  const [active, setActive] = useState("docker-local");
  const [mode, setMode] = useState("local");
  return (
    <ResourceEnvironmentsSection
      resourceEnvironments={envs}
      onResourceEnvironmentsChange={setEnvs}
      activeResourceEnvironment={active}
      onActiveResourceEnvironmentChange={setActive}
      defaultWorktreeMode={mode}
      onDefaultWorktreeModeChange={setMode}
      isOpen
    />
  );
}

const params = new URLSearchParams(window.location.search);

const SCENES: Record<string, Scene> = {
  crash: {
    width: 760,
    render: () => (
      <CrashRecoveryDialog
        crash={crashFixture(params.get("panels") !== "0")}
        config={{ autoRestoreOnCrash: false }}
        onResolve={never}
        onUpdateConfig={noopAsync}
      />
    ),
  },
  "help-chooser": {
    width: 380,
    render: () => (
      <div className="bg-surface-canvas p-8">
        <HelpAssistantAgentChooser agentIds={["claude", "codex", "gemini"]} onChoose={noop} />
      </div>
    ),
  },
  "help-panel": {
    width: 380,
    seed: () => {
      seedAgents(["claude"], false);
      useProjectStore.setState({ currentProject: PROJECT, isLoading: false });
      useHelpPanelStore.setState({
        isOpen: true,
        preferredAgentId: "claude",
        autoLaunchEnabled: false,
        introDismissed: false,
      });
    },
    render: () => (
      <div className="flex" style={{ width: 380, height: 640 }}>
        <HelpPanel width={380} isVisible isReadyToLaunch />
      </div>
    ),
  },
  "launcher-quick-actions": {
    width: 640,
    seed: () => {
      const pinned = ["claude", "codex", "gemini"] as const;
      seedAgents(pinned, true);
      const layout = useToolbarPreferencesStore.getState().layout;
      useToolbarPreferencesStore.setState({
        layout: {
          ...layout,
          leftButtons: [
            ...pinned,
            ...layout.leftButtons.filter((id) => !(pinned as readonly string[]).includes(id)),
          ],
        },
      });
      useProjectStore.setState({ currentProject: PROJECT, isLoading: false });
    },
    render: () => (
      <div className="bg-surface-canvas p-6">
        <div className="@container/launcher flex w-[38rem] max-w-full flex-col items-center gap-2">
          <LauncherQuickActions />
        </div>
      </div>
    ),
  },
  environments: {
    width: 720,
    render: () => (
      <div className="bg-surface-panel p-6">
        <EnvironmentsScene />
      </div>
    ),
  },
};

const themeId = params.get("theme") ?? "daintree";
const sceneName = params.get("scene") ?? "";
const scene = SCENES[sceneName];
if (!scene) {
  throw new Error(
    `unknown scene "${sceneName}" — expected one of ${Object.keys(SCENES).join(", ")}`
  );
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.documentElement.style.height = "auto";
document.body.style.height = "auto";
document.body.style.overflow = "visible";
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

// Seeded before the first render, never from inside a component body.
initBuiltInPanelKinds();
useAppThemeStore.setState({ selectedSchemeId: themeId });
scene.seed?.();

/** A scene that throws fails the capture loudly via `data-preview-error`. */
class SceneBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: formatErrorMessage(error, "scene threw") };
  }
  componentDidCatch(error: unknown) {
    document.documentElement.setAttribute(
      "data-preview-error",
      formatErrorMessage(error, "scene threw")
    );
  }
  render() {
    return this.state.error ? (
      <pre className="text-xs text-status-error">{this.state.error}</pre>
    ) : (
      this.props.children
    );
  }
}

function Ready() {
  useEffect(() => {
    document.documentElement.setAttribute("data-preview-ready", "");
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      <TooltipProvider>
        <SettingsValidationProvider>
          <SettingsFlushProvider>
            <WorktreeStoreProvider>
              <div className="p-4">
                <div
                  data-preview-surface
                  data-scene={sceneName}
                  className="inline-block"
                  style={{ width: scene.width ? `${scene.width}px` : undefined }}
                >
                  <SceneBoundary>{scene.render()}</SceneBoundary>
                </div>
              </div>
            </WorktreeStoreProvider>
          </SettingsFlushProvider>
        </SettingsValidationProvider>
        <Ready />
      </TooltipProvider>
    </LazyMotion>
  </StrictMode>
);
