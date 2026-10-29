import { nativeImage, webContents } from "electron";
import { defineIpcNamespace, op } from "../define.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  guestDocument,
  isGuestPageReadableByHost,
  isRemoteView,
} from "../../window/webviewSrcGate.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { WEBVIEW_CAPTURE_METHOD_CHANNELS } from "./webviewCapture.preload.js";
import { saveElementCapture } from "./clipboard.js";

/**
 * Context kept around an element crop, in the page's CSS pixels: enough for
 * the picker's chips on a selection's outline, its tag above and its key
 * hints below, to come out whole, never as a sliver along the picture's edge.
 */
const ELEMENT_CROP_MARGIN = 32;
/** Larger than any real viewport or element; anything past it was not measured. */
const MAX_CSS_EXTENT = 100_000;

// Spelled out where it is used, never exported: the IPC codegen copies an
// op's parameter types into `shared/`, and a named type from here would pull
// this file into the renderer's type program.
type ElementCaptureRequest = {
  /** The element's box in the page's viewport, in CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
  /** The page's own `innerWidth` and `innerHeight` when the rect was measured. */
  viewportWidth: number;
  viewportHeight: number;
};

/** How far the captured frame's shape may drift from the measured viewport's: rounding, not a resize. */
const VIEWPORT_ASPECT_TOLERANCE = 0.02;

function validElementRequest(request: unknown): request is ElementCaptureRequest {
  if (typeof request !== "object" || request === null) return false;
  const { rect, viewportWidth, viewportHeight } = request as Partial<ElementCaptureRequest>;
  const bounded = (value: unknown, min: number) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    Math.abs(value) <= MAX_CSS_EXTENT;
  if (typeof rect !== "object" || rect === null) return false;
  return (
    bounded(viewportWidth, 1) &&
    bounded(viewportHeight, 1) &&
    bounded(rect.x, -MAX_CSS_EXTENT) &&
    bounded(rect.y, -MAX_CSS_EXTENT) &&
    bounded(rect.width, 0) &&
    bounded(rect.height, 0)
  );
}

/**
 * The visible page of a panel the asking view embeds, as an image. Shared by
 * the viewport capture and the element crop, so both refuse the same panels.
 */
async function capturePanel(
  ctx: IpcContext,
  panelId: string,
  options?: { forHost?: boolean }
): Promise<Electron.NativeImage> {
  // The renderer only has the panel id; resolve the live webContentsId
  // from the panel registry (populated by both browser and dev-preview
  // webviews) so this works for either panel kind.
  const webContentsId = getWebviewDialogService().getWebContentsId(panelId);
  if (webContentsId === undefined) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "No browser panel is available to screenshot",
      context: { panelId },
    });
  }

  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "Browser webview is no longer available",
      context: { panelId, webContentsId },
    });
  }

  // Only a panel the asking view embeds, as registration requires: the
  // registry is process-wide, and a panel id from another window (or a
  // host's MCP asking through a view it drives) must not read its pixels.
  const embedder = wc.hostWebContents;
  if (!embedder || embedder.isDestroyed() || embedder.id !== ctx.webContentsId) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "No browser panel is available to screenshot",
      context: { panelId },
    });
  }

  const url = wc.getURL();
  if (!url || url === "about:blank") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "Browser has no page loaded to screenshot",
      context: { panelId },
    });
  }

  // A capture the host asked for, from a window attached to it: never a
  // page on this computer's own network, nor one that loaded anything
  // from it, which isn't the host's to see. Judged again once the pixels
  // are in, so a page that navigates meanwhile is never what's handed over.
  const forHost = options?.forHost === true && isRemoteView(ctx.webContentsId);
  const notForHost = () =>
    new AppError({
      code: "PERMISSION",
      message: "The page shows content from this computer's own network",
      userMessage:
        "This page shows content from this computer's own network, so it isn't shown to the host.",
      context: { panelId },
    });
  const shown = forHost ? guestDocument(webContentsId) : null;
  if (forHost) {
    if (shown === null || shown.localNetwork) throw notForHost();
    const readable = await isGuestPageReadableByHost(ctx.webContentsId, url, async (host) =>
      (await wc.session.resolveHost(host)).endpoints.map((endpoint) => endpoint.address)
    );
    if (!readable) throw notForHost();
  }

  let image: Electron.NativeImage;
  try {
    image = await wc.capturePage();
  } catch (err) {
    // The webContents can be destroyed in the gap between the isDestroyed
    // check and this await (tab closed / project evicted mid-call), which
    // surfaces as a raw Electron rejection. Normalize it to the same
    // AppError the caller and MCP error path expect.
    throw new AppError({
      code: "NOT_FOUND",
      message: "Browser panel became unavailable during capture",
      context: { panelId, webContentsId },
      cause: err instanceof Error ? err : undefined,
    });
  }
  if (forHost) {
    const now = guestDocument(webContentsId);
    if (
      now === null ||
      now.generation !== shown!.generation ||
      now.localNetwork ||
      wc.isDestroyed() ||
      wc.getURL() !== url
    ) {
      throw notForHost();
    }
  }
  if (image.isEmpty()) {
    throw new AppError({
      code: "INTERNAL",
      message: "Screenshot capture returned an empty image",
      context: { panelId },
    });
  }
  return image;
}

export const webviewCaptureNamespace = defineIpcNamespace({
  name: "webviewCapture",
  ops: {
    captureScreenshot: op(
      WEBVIEW_CAPTURE_METHOD_CHANNELS.captureScreenshot,
      async (ctx: IpcContext, panelId: string, options?: { forHost?: boolean }) => {
        const image = await capturePanel(ctx, panelId, options);
        const size = image.getSize();
        return {
          pngBase64: image.toPNG().toString("base64"),
          width: size.width,
          height: size.height,
        };
      },
      { withContext: true }
    ),
    captureElement: op(
      WEBVIEW_CAPTURE_METHOD_CHANNELS.captureElement,
      async (
        ctx: IpcContext,
        panelId: string,
        request: {
          rect: { x: number; y: number; width: number; height: number };
          viewportWidth: number;
          viewportHeight: number;
        }
      ): Promise<
        | { status: "saved"; filePath: string; width: number; height: number }
        | { status: "offscreen" }
        | { status: "resized" }
      > => {
        if (!validElementRequest(request)) {
          throw new AppError({
            code: "VALIDATION",
            message: "Element capture needs a measured box and viewport width",
            context: { panelId },
          });
        }
        const image = await capturePanel(ctx, panelId);
        // Re-read at a scale factor of one, so its size is the bitmap's own
        // pixels and the crop below is in those pixels too. The ratio to the
        // page's CSS width then carries both zoom and device scale, without
        // assuming what either is.
        const bitmap = nativeImage.createFromBuffer(image.toPNG());
        const size = bitmap.getSize();
        // A frame of another shape is a page that was resized after the box
        // was measured — a drawer opening beside it, say — and the box no
        // longer frames the element in it.
        const measured = request.viewportWidth / request.viewportHeight;
        const captured = size.width / Math.max(1, size.height);
        if (Math.abs(captured - measured) / measured > VIEWPORT_ASPECT_TOLERANCE) {
          return { status: "resized" };
        }
        const scale = size.width / request.viewportWidth;
        const margin = ELEMENT_CROP_MARGIN * scale;
        const { rect } = request;
        const left = Math.max(0, Math.floor(rect.x * scale - margin));
        const top = Math.max(0, Math.floor(rect.y * scale - margin));
        const right = Math.min(size.width, Math.ceil((rect.x + rect.width) * scale + margin));
        const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height) * scale + margin));
        // Scrolled out of view, or too small to show anything: no picture,
        // which the caller says rather than attaching an empty one.
        if (right - left < 2 || bottom - top < 2) return { status: "offscreen" };
        const cropped = bitmap.crop({ x: left, y: top, width: right - left, height: bottom - top });
        if (cropped.isEmpty()) return { status: "offscreen" };
        const filePath = await saveElementCapture(cropped.toPNG());
        return { status: "saved", filePath, width: right - left, height: bottom - top };
      },
      { withContext: true }
    ),
  },
});

export function registerWebviewCaptureHandlers(_deps: HandlerDependencies): () => void {
  return webviewCaptureNamespace.register();
}
