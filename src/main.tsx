// Register Trusted Types policies before anything else can write to a TT-gated
// DOM sink. React DOM relies on the `default` policy this module installs to
// set `innerHTML` on framework-injected `<style>` elements (e.g. Radix Popper
// in `SelectViewport`); without it the very first render of any Select inside
// a Portal throws.
import "./lib/trustedTypesPolicy";

import { initBuiltInPanelKinds } from "./panels/registry";
initBuiltInPanelKinds();

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import latin400Woff2Url from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./index.css";
import { applyDefaultAppTheme } from "./theme/applyAppTheme";
// Importing this module has the side effect of starting the font load (via
// the eagerly-initialised `terminalFontReady` singleton). `XtermAdapter`
// suspends locally on that same promise so the grid measurement waits while
// the rest of the app shell mounts immediately.
import "./config/terminalFont";
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

function ensureLatin400Preload(href: string) {
  if (document.head.querySelector(`link[rel="preload"][href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "font";
  link.type = "font/woff2";
  link.href = href;
  document.head.appendChild(link);
}

ensureLatin400Preload(latin400Woff2Url);

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
  // Logger may not be initialized at this stage of bootstrap; console is the
  // last-resort sink before the bootstrap-error UI takes over.
  // eslint-disable-next-line no-console
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
