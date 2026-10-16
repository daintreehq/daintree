import { useUIStore } from "@/store/uiStore";
import { isProjectViewObservable } from "@/lib/viewCacheState";
import { pluginDocumentRuntime } from "@/services/plugin/pluginDocumentRuntime";
import { scrubReportText } from "@shared/utils/reportScrubbers";
import type { PluginConsoleEntry, PluginPanelCaptureRect } from "@shared/types/pluginPanelCapture";

/** Newest plugin console entries a capture returns. */
export const CAPTURE_CONSOLE_LIMIT = 20;

/** Sample points per side when hit-testing the panel for anything drawn over it. */
const HIT_GRID = 7;

/**
 * Host layers that float over panels. A plugin view renders inline in the host
 * document, so any of these over the panel would be captured with it — and
 * they can show another pane's content.
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

/** The panel's one mounted frame, or a refusal saying why there is none to capture. */
export function locatePanelFrame(panelId: string): HTMLElement {
  const frames = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-panel-id="${CSS.escape(panelId)}"][data-panel-location]`
    )
  );
  if (frames.length === 0) {
    throw new PanelCaptureRefusedError(
      `Panel "${panelId}" is not on screen; show it (its tab, the dock or the grid) and retry`
    );
  }
  if (frames.length > 1) {
    throw new PanelCaptureRefusedError(`Panel "${panelId}" is moving; retry once it settles`);
  }
  return frames[0]!;
}

/**
 * Refuse rather than hand back pixels that are not this panel alone: a view
 * nobody can see, a frame that is hidden, clipped or off screen, or a host
 * layer drawn over any part of it.
 */
export function assertPanelCapturable(
  panelId: string,
  frame: HTMLElement,
  location: string | undefined
): PluginPanelCaptureRect {
  if (!isProjectViewObservable()) {
    throw new PanelCaptureRefusedError(
      "The panel's project is not on screen; switch to it and retry"
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

  const blocked = () =>
    new PanelCaptureRefusedError(
      "Something is open over the panel (a dialog, menu or tooltip); close it and retry"
    );
  // A panel presented in a dialog holds an overlay claim of its own; whatever
  // else is open is still caught by the two checks below.
  if (location !== "dialog" && useUIStore.getState().overlayStack.length > 0) throw blocked();

  for (const layer of document.querySelectorAll(FLOATING_LAYER_SELECTOR)) {
    if (frame.contains(layer) || layer.contains(frame)) continue;
    if (isPainted(layer) && intersects(layer.getBoundingClientRect(), rect)) throw blocked();
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
 * from a module this plugin's load registered, newest last, scrubbed of paths
 * and secrets before they leave for an agent.
 */
export function consoleMessagesForPlugin(
  entries: readonly PluginConsoleEntry[],
  pluginId: string
): CapturedConsoleMessage[] {
  return entries
    .filter((entry) => pluginDocumentRuntime.sourceForUrl(entry.sourceId)?.pluginId === pluginId)
    .slice(-CAPTURE_CONSOLE_LIMIT)
    .map((entry) => ({
      level: entry.level,
      message: scrubReportText(entry.message),
      source: entry.sourceId.split(/[?#]/)[0]!,
      line: entry.lineNumber,
      timestamp: new Date(entry.timestamp).toISOString(),
    }));
}
