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

let cleanupGlobalErrorHandlers: (() => void) | undefined;
let cleanupOrchestrator: (() => void) | undefined;

function renderBootstrapError(rootEl: HTMLElement, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  rootEl.innerHTML = "";
  const container = document.createElement("div");
  container.style.cssText =
    "display:flex;align-items:center;justify-content:center;height:100vh;width:100vw;background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;padding:2rem;";

  const inner = document.createElement("div");
  inner.style.cssText = "max-width:600px;text-align:center;";

  const heading = document.createElement("h1");
  heading.textContent = "Failed to start";
  heading.style.cssText = "color:#ef4444;font-size:1.5rem;margin-bottom:1rem;";

  const msg = document.createElement("p");
  msg.textContent = message;
  msg.style.cssText = "margin-bottom:1.5rem;font-size:0.875rem;opacity:0.8;";

  inner.appendChild(heading);
  inner.appendChild(msg);

  if (import.meta.env.DEV && stack) {
    const pre = document.createElement("pre");
    pre.textContent = stack;
    pre.style.cssText =
      "text-align:left;font-size:0.75rem;background:rgba(0,0,0,0.3);padding:1rem;border-radius:0.5rem;overflow:auto;max-height:200px;margin-bottom:1.5rem;";
    inner.appendChild(pre);
  }

  const btn = document.createElement("button");
  btn.textContent = "Reload";
  btn.style.cssText =
    "padding:0.5rem 1.5rem;background:#ef4444;color:white;border:none;border-radius:0.375rem;cursor:pointer;font-size:0.875rem;";
  btn.onclick = () => window.location.reload();
  inner.appendChild(btn);

  container.appendChild(inner);
  rootEl.appendChild(container);
}

async function bootstrap() {
  cleanupGlobalErrorHandlers = registerRendererGlobalErrorHandlers();

  applyDefaultAppTheme(document.documentElement);

  cleanupOrchestrator = initStoreOrchestrator();

  await ensureTerminalFontLoaded();

  const { default: App } = await import("./App");

  const rootEl = document.getElementById("root")!;
  createRoot(rootEl).render(
    <StrictMode>
      <App />
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
