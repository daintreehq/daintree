import { defineIpcNamespace, op } from "../define.js";
import { AppError } from "../../utils/errorTypes.js";
import { getRecentPluginConsoleMessages } from "../../window/rendererConsoleCapture.js";
import {
  PLUGIN_PANEL_CAPTURE_MAX_PNG_BYTES,
  type PluginPanelCaptureRect,
  type PluginPanelCaptureResult,
} from "../../../shared/types/pluginPanelCapture.js";
import type { WindowRegistry } from "../../window/WindowRegistry.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { PLUGIN_PANEL_CAPTURE_METHOD_CHANNELS } from "./pluginPanelCapture.preload.js";

/** Longest side, in DIP, a capture may ask for — far past any real window. */
const MAX_CAPTURE_SIDE = 16_384;

let windowRegistry: WindowRegistry | undefined;

function unavailable(message: string): AppError {
  return new AppError({ code: "UNSUPPORTED", message });
}

function isFiniteRect(rect: unknown): rect is PluginPanelCaptureRect {
  if (rect === null || typeof rect !== "object") return false;
  const { x, y, width, height } = rect as Record<string, unknown>;
  return [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * The renderer's panel frame, in CSS pixels, as the DIP rect `capturePage`
 * takes: scaled by the view's zoom, pushed outward to whole pixels, and cut to
 * the view's own bounds so nothing past it is ever asked for.
 */
function toCaptureRect(
  rect: PluginPanelCaptureRect,
  zoomFactor: number,
  viewSize: { width: number; height: number } | null
): Electron.Rectangle | null {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  let left = Math.max(0, Math.floor(rect.x * zoom));
  let top = Math.max(0, Math.floor(rect.y * zoom));
  let right = Math.ceil((rect.x + rect.width) * zoom);
  let bottom = Math.ceil((rect.y + rect.height) * zoom);
  if (viewSize) {
    right = Math.min(right, viewSize.width);
    bottom = Math.min(bottom, viewSize.height);
  }
  left = Math.min(left, right);
  top = Math.min(top, bottom);
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1 || width > MAX_CAPTURE_SIDE || height > MAX_CAPTURE_SIDE) {
    return null;
  }
  return { x: left, y: top, width, height };
}

export const pluginPanelCaptureNamespace = defineIpcNamespace({
  name: "pluginPanelCapture",
  ops: {
    capturePanel: op(
      PLUGIN_PANEL_CAPTURE_METHOD_CHANNELS.capturePanel,
      async (ctx: IpcContext, rect: PluginPanelCaptureRect): Promise<PluginPanelCaptureResult> => {
        // Only ever the asking view's own pixels. A call over a link has no
        // local sender to capture, and the rect is the only thing taken from
        // the caller — never a webContents to aim at.
        const sender = ctx.event?.sender;
        if (!sender || sender.isDestroyed()) {
          throw unavailable("Panel capture is only available in a local window");
        }
        if (!isFiniteRect(rect)) {
          throw new AppError({ code: "VALIDATION", message: "Invalid panel bounds" });
        }

        const windowContext = windowRegistry?.getByWebContentsId(sender.id);
        const win = windowContext?.browserWindow;
        if (!win || win.isDestroyed()) {
          throw unavailable("The panel's window is not available");
        }
        if (win.isMinimized() || !win.isVisible()) {
          throw unavailable("The panel's window is hidden; show it and retry");
        }
        // A cached project view keeps rendering but is not on screen, and a
        // switch in flight shows the outgoing view over the incoming one: in
        // either case the pixels are not what the user sees.
        const pvm = windowContext.services.projectViewManager;
        const activeView = pvm?.getActiveView() ?? null;
        if (pvm && (activeView?.webContents.id !== sender.id || pvm.isSwitchBridged())) {
          throw unavailable("The panel's project is not the one on screen; switch to it and retry");
        }

        const viewBounds = activeView?.getBounds() ?? null;
        const captureRect = toCaptureRect(rect, sender.getZoomFactor(), viewBounds);
        if (!captureRect) {
          throw unavailable("The panel has no visible area to capture");
        }

        let image: Electron.NativeImage;
        try {
          image = await sender.capturePage(captureRect);
        } catch (err) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "The panel's view became unavailable during capture",
            cause: err instanceof Error ? err : undefined,
          });
        }
        if (image.isEmpty()) {
          throw new AppError({
            code: "INTERNAL",
            message: "Panel capture returned an empty image",
          });
        }
        const png = image.toPNG();
        if (png.byteLength > PLUGIN_PANEL_CAPTURE_MAX_PNG_BYTES) {
          throw unavailable("The panel is too large to capture; make it smaller and retry");
        }

        return {
          pngBase64: png.toString("base64"),
          consoleMessages: getRecentPluginConsoleMessages(sender),
        };
      },
      { withContext: true }
    ),
  },
});

export function registerPluginPanelCaptureHandlers(deps: HandlerDependencies): () => void {
  windowRegistry = deps.windowRegistry;
  const unregister = pluginPanelCaptureNamespace.register();
  return () => {
    unregister();
    windowRegistry = undefined;
  };
}
