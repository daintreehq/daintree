import { initBuiltInPanelKinds } from "./panels/registry";
initBuiltInPanelKinds();

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "./index.css";
import { applyDefaultAppTheme } from "./theme/applyAppTheme";
import { ensureTerminalFontLoaded } from "./config/terminalFont";
import { initStoreOrchestrator } from "./store/rendererStoreOrchestrator";
import { useAgentSettingsStore } from "./store/agentSettingsStore";
import { registerRendererGlobalErrorHandlers } from "./utils/rendererGlobalErrorHandlers";
import { initRendererSentry } from "./utils/rendererSentry";
import { renderBootstrapError } from "./utils/renderBootstrapError";
import {
  onCaughtError,
  onUncaughtError,
  onRecoverableError,
} from "./utils/reactRootErrorCallbacks";
import { WorktreeStoreProvider } from "./contexts/WorktreeStoreContext";

let cleanupGlobalErrorHandlers: (() => void) | undefined;
let cleanupOrchestrator: (() => void) | undefined;

async function bootstrap() {
  await initRendererSentry();

  cleanupGlobalErrorHandlers = registerRendererGlobalErrorHandlers();

  applyDefaultAppTheme(document.documentElement);

  try {
    localStorage.removeItem("project-groups-storage");
  } catch {
    // localStorage may not be available
  }

  cleanupOrchestrator = initStoreOrchestrator();

  // Kick off the agent-settings store so `App.tsx`, `Toolbar`, and the tray
  // all read from a normalized snapshot on cold boot. The install-aware
  // default-pin path in `normalizeAgentSelection` depends on this running —
  // without it the store stays null and the orchestrator's availability
  // subscription never gets a chance to reconcile (see issue #5158).
  void useAgentSettingsStore.getState().initialize();

  await ensureTerminalFontLoaded();

  const { default: App } = await import("./App");

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

bootstrap().catch((error: unknown) => {
  console.error("Bootstrap failed:", error);

  void (async () => {
    try {
      const { captureException } = await import("@sentry/electron/renderer");
      captureException(error);
    } catch {
      // Sentry may not have initialized yet
    }
  })();

  try {
    const errObj =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
    window.electron?.logs?.write("error", `Bootstrap failed: ${JSON.stringify(errObj)}`);
  } catch {
    // IPC may not be available
  }

  document.getElementById("startup-skeleton")?.remove();

  const rootEl = document.getElementById("root");
  if (rootEl) {
    renderBootstrapError(rootEl, error);
  }
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupGlobalErrorHandlers?.();
    cleanupOrchestrator?.();
  });
}
