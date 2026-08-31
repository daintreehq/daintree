// Register Trusted Types policies before anything else can write to a TT-gated
// DOM sink. React DOM relies on the `default` policy this module installs to
// set `innerHTML` on framework-injected `<style>` elements (e.g. Radix Popper
// in `SelectViewport`); without it the very first render of any Select inside
// a Portal throws.
import "./lib/trustedTypesPolicy";

// Fires the `app:boot` IPC at the top of entry-graph evaluation — see the
// module comment for ordering semantics (#8820).
import "./lib/bootIpcEager";

import { initBuiltInPanelKinds } from "./panels/registry";
initBuiltInPanelKinds();

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import latin400Woff2Url from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./index.css";
import { applyDefaultAppTheme } from "./theme/applyAppTheme";
import { publishScrollbarGutter } from "./lib/scrollbarGutter";
import { ensureLatin400Preload } from "./lib/fontPreload";
// Importing this module has the side effect of starting the font load (via
// the eagerly-initialised `terminalFontReady` singleton). Terminals open
// immediately against whatever font is resolved; if JetBrains Mono arrives
// late, `TerminalInstanceService.repairFontGrid()` re-measures the grid
// out-of-band via `onTerminalFontArrivedLate` (#9809).
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

ensureLatin400Preload(latin400Woff2Url);

async function bootstrap() {
  // Fire-and-forget — the SDK module loads via dynamic import off the
  // first-render path, with a pre-init capture queue replaying anything
  // recorded before `Sentry.init` runs. Awaiting here would block the
  // first React render on the chunk fetch plus a renderer→main consent
  // round-trip (#8632); `bootstrap().catch()` below has its own dynamic
  // import fallback in case this throws before init.
  void initRendererSentry();

  cleanupGlobalErrorHandlers = registerRendererGlobalErrorHandlers();

  applyDefaultAppTheme(document.documentElement);

  // Publish the platform's reserved scrollbar gutter before the first render,
  // so dialogs paint on the right column from their first frame rather than
  // settling onto it. AppDialog re-measures on each open to track a mid-session
  // change; this is only the seed.
  publishScrollbarGutter();

  // Paint-fabric surface view (Phase 1V): the preload seeds the surface-host
  // role from additionalArguments. A surface view hosts terminals only —
  // mount the minimal surface root and skip the app shell, store
  // orchestrator, and panel registries entirely.
  const surfaceHostId = window.__DAINTREE_SURFACE_HOST__?.surfaceId ?? null;
  if (surfaceHostId !== null) {
    const { SurfaceHostRoot } = await import("./surfaceHost/SurfaceHostRoot");
    document.getElementById("startup-skeleton")?.remove();
    createRoot(document.getElementById("root")!, {
      onCaughtError,
      onUncaughtError,
      onRecoverableError,
    }).render(
      <StrictMode>
        <SurfaceHostRoot surfaceId={surfaceHostId} />
      </StrictMode>
    );
    return;
  }

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
    void window.electron?.logs?.write("error", `Bootstrap failed: ${JSON.stringify(errObj)}`);
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
