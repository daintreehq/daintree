// The project window's shell. `src/main.tsx` is the renderer entry for every
// window role and loads this only for a project view, so a plugin surface host
// or the Canopy window never evaluates the panel registry, store orchestration,
// or App.
//
// It is loaded through a `<script type="module">` element, not `import()`. An
// inserted module script holds the document's load event until its graph has
// evaluated; an `import()` (top-level `await` included) does not, and main
// gates sends on `did-finish-load` (project switches, plugin replays, the
// cold-launch git-init dialog, worktree load status) that reach only listeners
// this graph installs synchronously as it evaluates.

// `app:boot` goes out first, in the same synchronous evaluation that installs
// every listener below, so no push Main sends after reading the boot payload
// can be dispatched before its listener exists (see keybindingOverridesSync).
import "@/lib/bootIpcEager";

import { initBuiltInPanelKinds, preloadRestoredPanesFromBoot } from "@/panels/registry";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Importing this module has the side effect of starting the font load (via
// the eagerly-initialised `terminalFontReady` singleton). Terminals open
// immediately against whatever font is resolved; if JetBrains Mono arrives
// late, `TerminalInstanceService.repairFontGrid()` re-measures the grid
// out-of-band via `onTerminalFontArrivedLate` (#9809).
import "@/config/terminalFont";
import { initStoreOrchestrator } from "@/store/rendererStoreOrchestrator";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { reportBootstrapFailure } from "@/utils/reportBootstrapFailure";
import {
  onCaughtError,
  onUncaughtError,
  onRecoverableError,
} from "@/utils/reactRootErrorCallbacks";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { installProjectSwitchStatusTiming } from "@/services/projectSwitchStatusTiming";
import { installRunningPluginActions } from "@/services/plugin/runningPluginActions";
import { usePluginContextKeyStore } from "@/store/pluginContextKeyStore";
import { usePluginProjectSurfacesStore } from "@/store/pluginProjectSurfacesStore";
import { usePluginHostedViewsStore } from "@/store/pluginHostedViewsStore";
import { installAppPluginKitHost } from "@/services/plugin/appPluginKitHost";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { answerBufferSamplesUntilLoaded } from "@/services/terminal/terminalInstanceServiceAccessor";

let cleanupOrchestrator: (() => void) | undefined;
let cleanupPluginKitHost: (() => void) | undefined;

async function startProjectWindow(): Promise<void> {
  initBuiltInPanelKinds();

  try {
    localStorage.removeItem("project-groups-storage");
  } catch {
    // localStorage may not be available
  }

  cleanupOrchestrator = initStoreOrchestrator();

  // The terminal service loads with the first terminal (#14267); until then,
  // main's buffer samples get this view's empty answer instead of a timeout.
  answerBufferSamplesUntilLoaded();

  // Synchronous with module evaluation, so it is listening before main's
  // `did-finish-load` gate lets it send `project:on-switch` to a new view.
  installProjectSwitchStatusTiming();
  // Same reason: main replays the running plugin actions at `did-finish-load`,
  // and its events reach only a listener that already exists.
  installRunningPluginActions();
  // Plugin `when`-clause keys replay at the same point, and a keybinding can
  // fire before any hook that would otherwise subscribe the store has mounted.
  usePluginContextKeyStore.getState().init();
  // A project plugin's default editors (#13811) decide where a file opens, and
  // an agent's `file.openPanel` or a terminal link can ask before any slot
  // frame or file panel has mounted to start these.
  usePluginProjectSurfacesStore.getState().init();
  usePluginHostedViewsStore.getState().init();
  // Before the first render: a kit view reads its host as it draws.
  cleanupPluginKitHost = installAppPluginKitHost();

  // Off the startup chunks, and never loaded where remote hosts can't exist.
  if (isRemoteShellSupported()) {
    void import("@/components/Hosts/installHostProjectsLoader")
      .then((m) => m.installHostProjectsLoader())
      .catch((error: unknown) => {
        console.warn("[Hosts] Couldn't install the host project listing:", error);
      });
    void import("@/lib/forgetHostLocalState")
      .then((m) => m.installForgetHostLocalState())
      .catch((error: unknown) => {
        console.warn("[Hosts] Couldn't install removed-host cleanup:", error);
      });
  }

  // Kick off the agent-settings store so `App.tsx`, `Toolbar`, and the tray
  // all read from a normalized snapshot on cold boot. The install-aware
  // default-pin path in `normalizeAgentSelection` depends on this running —
  // without it the store stays null and the orchestrator's availability
  // subscription never gets a chance to reconcile (see issue #5158).
  void useAgentSettingsStore.getState().initialize();

  // The restored session's pane chunks are not preloaded from index.html (that
  // would charge every boot for every pane kind); warm just the kinds this
  // session restores as soon as the boot payload names them, in parallel with
  // the App chunk below.
  void getSafeBootPromise().then(preloadRestoredPanesFromBoot);

  const { default: App } = await import("@/App");

  const rootEl = document.getElementById("root")!;
  createRoot(rootEl, {
    onCaughtError,
    onUncaughtError,
    onRecoverableError,
  }).render(
    <StrictMode>
      <WorktreeStoreProvider>
        <App />
      </WorktreeStoreProvider>
    </StrictMode>
  );
}

startProjectWindow().catch(reportBootstrapFailure);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupOrchestrator?.();
    cleanupPluginKitHost?.();
  });
}
