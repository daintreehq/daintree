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
import { registerRendererGlobalErrorHandlers } from "./utils/rendererGlobalErrorHandlers";
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
  cleanupGlobalErrorHandlers = registerRendererGlobalErrorHandlers();

  applyDefaultAppTheme(document.documentElement);

  cleanupOrchestrator = initStoreOrchestrator();

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
