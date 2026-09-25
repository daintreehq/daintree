import { formatErrorMessage } from "@shared/utils/errorMessage";

// Every colour reads the theme token first and falls back to the default
// Daintree value: this screen paints exactly when boot failed, which may be
// before the stylesheet or the theme were applied. Either way it reads as the
// same family as the React crash screen — neutral canvas, red only on the glyph.
const CANVAS = "var(--color-surface-canvas,#1a1918)";
const TILE = "var(--color-overlay-subtle,rgba(255,255,255,0.04))";
const TEXT = "var(--color-text-primary,#e4e4e7)";
const TEXT_SECONDARY = "var(--color-text-secondary,#a1a1aa)";
const INVERSE = "var(--color-text-inverse,#1a1918)";
const ERROR = "var(--color-status-error,#c8746c)";

const SVG_NS = "http://www.w3.org/2000/svg";
// Lucide's triangle-alert, drawn by hand: React and lucide-react may be the
// very things that failed to load.
const TRIANGLE_ALERT_PATHS = [
  "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
  "M12 9v4",
  "M12 17h.01",
];

function warningGlyph(): HTMLElement {
  const tile = document.createElement("div");
  tile.setAttribute("aria-hidden", "true");
  tile.style.cssText = `display:flex;align-items:center;justify-content:center;width:48px;height:48px;margin:0 auto 20px;border-radius:12px;background:${TILE};`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.style.stroke = ERROR;
  for (const d of TRIANGLE_ALERT_PATHS) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  tile.appendChild(svg);
  return tile;
}

export function renderBootstrapError(rootEl: HTMLElement, error: unknown): void {
  const message = formatErrorMessage(error, "Renderer failed to initialize");
  const stack = error instanceof Error ? error.stack : undefined;

  // textContent (not innerHTML) — bootstrap-error path runs before the TT
  // policy module is guaranteed to be loaded, and textContent isn't a
  // TT-gated sink so it stays safe under `require-trusted-types-for 'script'`.
  rootEl.textContent = "";
  const container = document.createElement("div");
  // An alertdialog, like the React crash screen: focus moves to Reload window,
  // and a plain role="alert" containing focus goes unannounced in NVDA.
  container.setAttribute("role", "alertdialog");
  container.setAttribute("aria-modal", "true");
  container.setAttribute("aria-labelledby", "bootstrap-error-title");
  container.setAttribute("aria-describedby", "bootstrap-error-message");
  container.style.cssText = `display:flex;align-items:center;justify-content:center;min-height:100vh;width:100vw;box-sizing:border-box;background:${CANVAS};color:${TEXT};font-family:system-ui,sans-serif;padding:2rem;`;

  const inner = document.createElement("div");
  inner.style.cssText = "max-width:560px;width:100%;text-align:center;";

  const heading = document.createElement("h1");
  heading.id = "bootstrap-error-title";
  heading.textContent = "Daintree couldn't start";
  heading.style.cssText = "font-size:1.25rem;font-weight:600;margin:0 0 0.5rem;";

  const msg = document.createElement("p");
  msg.id = "bootstrap-error-message";
  msg.textContent = message;
  msg.style.cssText = `margin:0 0 1.5rem;font-size:0.875rem;color:${TEXT_SECONDARY};overflow-wrap:break-word;`;

  inner.appendChild(warningGlyph());
  inner.appendChild(heading);
  inner.appendChild(msg);

  if (import.meta.env.DEV && stack) {
    const pre = document.createElement("pre");
    pre.textContent = stack;
    pre.style.cssText = `text-align:left;font-size:0.75rem;color:${TEXT_SECONDARY};background:${TILE};padding:1rem;border-radius:0.5rem;overflow:auto;max-height:200px;margin:0 0 1.5rem;white-space:pre-wrap;overflow-wrap:break-word;`;
    inner.appendChild(pre);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Reload window";
  btn.style.cssText = `padding:0.5rem 1.5rem;background:${TEXT};color:${INVERSE};border:none;border-radius:0.375rem;cursor:pointer;font-size:0.875rem;font-weight:500;`;
  btn.onclick = () => window.location.reload();
  inner.appendChild(btn);

  container.appendChild(inner);
  rootEl.appendChild(container);
  btn.focus();
}
