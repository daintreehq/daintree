import { formatErrorMessage } from "@shared/utils/errorMessage";

export function renderBootstrapError(rootEl: HTMLElement, error: unknown): void {
  const message = formatErrorMessage(error, "Renderer failed to initialize");
  const stack = error instanceof Error ? error.stack : undefined;

  // textContent (not innerHTML) — bootstrap-error path runs before the TT
  // policy module is guaranteed to be loaded, and textContent isn't a
  // TT-gated sink so it stays safe under `require-trusted-types-for 'script'`.
  rootEl.textContent = "";
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
