// Register Trusted Types policies before anything else can write to a TT-gated
// DOM sink. React DOM relies on the `default` policy this module installs to
// set `innerHTML` on framework-injected `<style>` elements (e.g. Radix Popper
// in `SelectViewport`); without it the very first render of any Select inside
// a Portal throws.
import "./lib/trustedTypesPolicy";

// Must run before xterm rasterizes its first glyph atlas.
import "./lib/canvasFontWhitespaceShim";

// The entry every window role shares: a project view, a plugin surface host,
// and the Canopy window. Only what all three need is imported statically here;
// the project shell loads for a project view alone (see `bootstrap()`).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import latin400Woff2Url from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import "./index.css";
import { applyDefaultAppTheme } from "./theme/applyAppTheme";
import {
  markScrollbarPlatform,
  publishScrollbarGutter,
  watchScrollbarGutter,
} from "./lib/scrollbarGutter";
import { ensureLatin400Preload } from "./lib/fontPreload";
import { registerRendererGlobalErrorHandlers } from "./utils/rendererGlobalErrorHandlers";
import { initRendererSentry } from "./utils/rendererSentry";
import { reportBootstrapFailure } from "./utils/reportBootstrapFailure";
import {
  onCaughtError,
  onUncaughtError,
  onRecoverableError,
} from "./utils/reactRootErrorCallbacks";
import { installPluginDocumentRuntime } from "./services/plugin/pluginDocumentRuntime";
import { usePluginHostedViewsStore } from "./store/pluginHostedViewsStore";
import { getSafeBootPromise } from "./lib/bootPromise";
import { PROJECT_SHELL_URL } from "./projectWindow/projectShellUrl";

let cleanupGlobalErrorHandlers: (() => void) | undefined;
let cleanupScrollbarGutterWatch: (() => void) | undefined;

ensureLatin400Preload(latin400Woff2Url);

/**
 * Loads the project shell through a module script element rather than
 * `import()`: the element holds the document's load event until the shell's
 * whole graph has evaluated, which keeps every listener it installs ahead of
 * main's `did-finish-load` sends, as when it was part of this entry.
 */
function loadProjectShell(): void {
  const script = document.createElement("script");
  script.type = "module";
  script.crossOrigin = "";
  script.src = PROJECT_SHELL_URL;
  script.addEventListener(
    "error",
    () =>
      reportBootstrapFailure(new Error(`Couldn't load the project shell (${PROJECT_SHELL_URL})`)),
    { once: true }
  );
  document.head.append(script);
}

async function bootstrap() {
  const surfaceHostId = window.__DAINTREE_SURFACE_HOST__?.surfaceId ?? null;
  const isProjectWindow = surfaceHostId === null && window.__DAINTREE_CANOPY_WINDOW__ !== true;

  // The project shell sends `app:boot` itself, in the same evaluation that
  // installs its listeners. The other roles send it here, first, as the
  // boot-IPC-eager import did for every role.
  if (!isProjectWindow) void getSafeBootPromise();

  // Fire-and-forget — the SDK module loads via dynamic import off the
  // first-render path, with a pre-init capture queue replaying anything
  // recorded before `Sentry.init` runs. Awaiting here would block the
  // first React render on the chunk fetch plus a renderer→main consent
  // round-trip (#8632); `bootstrap().catch()` below has its own dynamic
  // import fallback in case this throws before init.
  void initRendererSentry();

  cleanupGlobalErrorHandlers = registerRendererGlobalErrorHandlers();
  installPluginDocumentRuntime();

  applyDefaultAppTheme(document.documentElement);
  markScrollbarPlatform(document.documentElement);

  // Publish the platform's reserved scrollbar gutter before the first render,
  // so dialogs paint on the right column from their first frame rather than
  // settling onto it. AppDialog re-measures as it opens and the watcher below
  // catches a change made while a dialog is already open.
  publishScrollbarGutter();
  cleanupScrollbarGutterWatch = watchScrollbarGutter();

  // Paint-fabric surface view (Phase 1V): the preload seeds the surface-host
  // role from additionalArguments. A surface view hosts terminals only —
  // mount the minimal surface root and skip the app shell, store
  // orchestrator, and panel registries entirely.
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

  // The Canopy window: the inbox over every project, so none of the project
  // shell. `app:boot` still answers for it, with no project, and seeds the
  // theme and terminal settings the inbox reads.
  if (window.__DAINTREE_CANOPY_WINDOW__ === true) {
    // Its app-wide plugins' views, as main narrows them for a window with no
    // project; listening before the first render, as a project window does.
    usePluginHostedViewsStore.getState().init();
    const { CanopyWindowRoot } = await import("./canopyWindow/CanopyWindowRoot");
    document.getElementById("startup-skeleton")?.remove();
    createRoot(document.getElementById("root")!, {
      onCaughtError,
      onUncaughtError,
      onRecoverableError,
    }).render(
      <StrictMode>
        <CanopyWindowRoot />
      </StrictMode>
    );
    return;
  }

  loadProjectShell();
}

bootstrap().catch(reportBootstrapFailure);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupGlobalErrorHandlers?.();
    cleanupScrollbarGutterWatch?.();
  });
}
