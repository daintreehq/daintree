import { useUIStore } from "@/store/uiStore";
import { isProjectViewObservable } from "@/lib/viewCacheState";
import { pluginDocumentRuntime } from "@/services/plugin/pluginDocumentRuntime";
import { scrubReportText } from "@shared/utils/reportScrubbers";
import type { PluginConsoleEntry, PluginPanelCaptureRect } from "@shared/types/pluginPanelCapture";

/** Newest plugin console entries a capture returns. */
export const CAPTURE_CONSOLE_LIMIT = 20;

/**
 * UTF-8 bytes of console entries a capture returns. The MCP text body that
 * carries them is capped at 50 KiB, and an entry cut there would not parse.
 */
export const CAPTURE_CONSOLE_MAX_BYTES = 24 * 1024;

/** Sample points per side when hit-testing the panel for anything drawn over it. */
const HIT_GRID = 7;

/**
 * Host layers that float over panels without being portalled out of the app
 * root. A plugin view renders inline in the host document, so any of these
 * over the panel would be captured with it — and they can show another pane.
 */
const FLOATING_LAYER_SELECTOR = [
  "[data-radix-popper-content-wrapper]",
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="tooltip"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(",");

export class PanelCaptureRefusedError extends Error {
  override name = "PanelCaptureRefusedError";
}

export interface CapturedConsoleMessage {
  level: "warning" | "error";
  message: string;
  source: string;
  line: number;
  timestamp: string;
}

function rectOf(frame: HTMLElement): PluginPanelCaptureRect {
  const box = frame.getBoundingClientRect();
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const right = Math.min(window.innerWidth, box.right);
  const bottom = Math.min(window.innerHeight, box.bottom);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function intersects(a: DOMRect, b: PluginPanelCaptureRect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    a.left < b.x + b.width &&
    a.right > b.x &&
    a.top < b.y + b.height &&
    a.bottom > b.y
  );
}

function isPainted(el: Element): boolean {
  return typeof el.checkVisibility === "function"
    ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    : true;
}

function ancestorsOf(frame: HTMLElement): Element[] {
  const chain: Element[] = [];
  for (let el = frame.parentElement; el; el = el.parentElement) chain.push(el);
  return chain;
}

function clips(el: Element): boolean {
  const style = getComputedStyle(el);
  return [style.overflow, style.overflowX, style.overflowY].some(
    (value) => value !== "" && value !== "visible"
  );
}

function isRaisedFixed(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.position !== "fixed") return false;
  const z = Number.parseInt(style.zIndex, 10);
  return Number.isFinite(z) && z > 0;
}

/** The panel's one mounted frame, or a refusal saying why there is none to capture. */
export function locatePanelFrame(panelId: string): HTMLElement {
  const frames = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-panel-id="${CSS.escape(panelId)}"][data-panel-location]`
    )
  );
  if (frames.length === 0) {
    throw new PanelCaptureRefusedError(
      `Panel "${panelId}" isn't on screen; show it (its tab, the dock or the grid) and retry`
    );
  }
  if (frames.length > 1) {
    throw new PanelCaptureRefusedError(`Panel "${panelId}" is moving; retry once it settles`);
  }
  return frames[0]!;
}

/**
 * Refuse rather than hand back pixels that are not this panel alone: a view
 * nobody can see, a frame that is hidden, clipped, off screen or mid-animation,
 * or anything of the host's drawn over any part of it.
 */
export function assertPanelCapturable(
  panelId: string,
  frame: HTMLElement,
  location: string | undefined
): PluginPanelCaptureRect {
  if (!isProjectViewObservable()) {
    throw new PanelCaptureRefusedError(
      "The panel's project isn't on screen; switch to it and retry"
    );
  }
  if (!frame.isConnected || !isPainted(frame)) {
    throw new PanelCaptureRefusedError(`Panel "${panelId}" is hidden; show it and retry`);
  }
  const box = frame.getBoundingClientRect();
  const rect = rectOf(frame);
  if (rect.width < 1 || rect.height < 1) {
    throw new PanelCaptureRefusedError(`Panel "${panelId}" has no visible area to capture`);
  }
  if (rect.width < box.width - 1 || rect.height < box.height - 1) {
    throw new PanelCaptureRefusedError(
      `Panel "${panelId}" extends past the window; make room for it and retry`
    );
  }

  const ancestors = ancestorsOf(frame);
  // A scroll container cuts the frame off at its own edge, and whatever the
  // host draws beyond that edge sits inside the frame's rect.
  for (const el of ancestors) {
    if (!clips(el)) continue;
    const edge = el.getBoundingClientRect();
    if (
      box.left < edge.left - 0.5 ||
      box.top < edge.top - 0.5 ||
      box.right > edge.right + 0.5 ||
      box.bottom > edge.bottom + 0.5
    ) {
      throw new PanelCaptureRefusedError(
        `Panel "${panelId}" is partly scrolled out of view; bring all of it into view and retry`
      );
    }
  }

  // A panel mid-transition — a dock fading in, a move animating — is blended
  // with whatever is under it, and the frame's own rect is not yet its own.
  const settling = () =>
    new PanelCaptureRefusedError(`Panel "${panelId}" is animating; retry once it settles`);
  for (const el of [frame, ...ancestors]) {
    const opacity = Number.parseFloat(getComputedStyle(el).opacity);
    if (Number.isFinite(opacity) && opacity < 0.999) throw settling();
  }
  if (typeof document.getAnimations === "function") {
    for (const animation of document.getAnimations()) {
      const effect = animation.effect;
      const target = effect && "target" in effect ? effect.target : null;
      if (
        animation.playState === "running" &&
        target instanceof Element &&
        (target === frame || target.contains(frame))
      ) {
        throw settling();
      }
    }
  }

  const blocked = () =>
    new PanelCaptureRefusedError(
      "Something is open over the panel (a dialog, menu, tooltip or notification); close it and retry"
    );
  // A panel presented in a dialog holds an overlay claim of its own; whatever
  // else is open is still caught by the layer checks below.
  if (location !== "dialog" && useUIStore.getState().overlayStack.length > 0) throw blocked();

  // Everything portalled out of the app root — dialogs, menus, tooltips,
  // toasts, the panel-move overlay — paints over the app. Portals stack in
  // insertion order, so only the ones after the panel's own layer (when the
  // panel is itself in one, as a dialog panel is) are above it.
  const layers = Array.from(document.body.children);
  const ownLayer = layers.findIndex((layer) => layer.contains(frame));
  for (const [index, layer] of layers.entries()) {
    if (index <= ownLayer && ownLayer !== -1) continue;
    if (layer.contains(frame)) continue;
    // Parked behind the app on purpose (the terminal offscreen container).
    if (Number.parseInt(getComputedStyle(layer).zIndex, 10) < 0) continue;
    for (const el of [layer, ...layer.querySelectorAll("*")]) {
      if (intersects(el.getBoundingClientRect(), rect) && isPainted(el)) throw blocked();
    }
  }

  // Inside the app root, floating layers that skip the portal and fixed
  // layers raised above the panels (a drag preview, a popover in place).
  const appRoot = ownLayer === -1 ? null : layers[ownLayer];
  const scope = appRoot ?? document.body;
  for (const el of scope.querySelectorAll("*")) {
    if (frame.contains(el) || el.contains(frame)) continue;
    if (!el.matches(FLOATING_LAYER_SELECTOR) && !isRaisedFixed(el)) continue;
    if (intersects(el.getBoundingClientRect(), rect) && isPainted(el)) throw blocked();
  }

  for (let row = 0; row < HIT_GRID; row++) {
    for (let col = 0; col < HIT_GRID; col++) {
      const x = rect.x + ((col + 0.5) * rect.width) / HIT_GRID;
      const y = rect.y + ((row + 0.5) * rect.height) / HIT_GRID;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !frame.contains(hit)) throw blocked();
    }
  }
  return rect;
}

export function sameRect(a: PluginPanelCaptureRect, b: PluginPanelCaptureRect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/**
 * The plugin's own entries out of everything the view buffered: those logged
 * from a module this plugin's load registered, scrubbed of paths and secrets
 * before they leave for an agent. Newest last, up to the count and byte
 * budgets; `omitted` counts the older matching entries left out.
 */
export function consoleMessagesForPlugin(
  entries: readonly PluginConsoleEntry[],
  pluginId: string
): { messages: CapturedConsoleMessage[]; omitted: number } {
  const own = entries.filter(
    (entry) => pluginDocumentRuntime.sourceForUrl(entry.sourceId)?.pluginId === pluginId
  );
  const messages: CapturedConsoleMessage[] = [];
  let bytes = 0;
  for (let i = own.length - 1; i >= 0 && messages.length < CAPTURE_CONSOLE_LIMIT; i--) {
    const entry = own[i]!;
    const message: CapturedConsoleMessage = {
      level: entry.level,
      message: scrubReportText(entry.message),
      source: entry.sourceId.split(/[?#]/)[0]!,
      line: entry.lineNumber,
      timestamp: new Date(entry.timestamp).toISOString(),
    };
    const size = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    if (bytes + size > CAPTURE_CONSOLE_MAX_BYTES) break;
    bytes += size;
    messages.unshift(message);
  }
  return { messages, omitted: own.length - messages.length };
}
