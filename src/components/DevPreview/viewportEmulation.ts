import type { ViewportPresetId } from "@shared/types/panel";
import type { DeviceEmulationParameters } from "@shared/types/ipc/webviewEmulation";
import { getEffectiveViewportSize, getViewportPreset } from "@/panels/dev-preview/viewportPresets";

export function buildEmulationParams(
  presetId: ViewportPresetId | undefined,
  rotated: boolean,
  dpr: number
): DeviceEmulationParameters | null {
  if (!presetId) return null;
  const { width, height } = getEffectiveViewportSize(presetId, rotated);
  return {
    screenPosition: "mobile",
    screenSize: { width, height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: dpr,
    viewSize: { width, height },
    scale: 1,
  };
}

/**
 * Apply (or clear, with `presetId` undefined) device emulation on the guest.
 *
 * The work happens in the main process: `<webview>` has no renderer-side
 * `getWebContents()`, so the UA override and `enableDeviceEmulation` that used
 * to be called here threw into a swallowing catch and never ran (#12298). Main
 * resolves the guest from `getWebContentsId()` and owns the original-UA
 * bookkeeping needed to restore desktop.
 *
 * Throws if the webview is already detached (`getWebContentsId()` raises
 * synchronously); callers decide whether that is worth reporting.
 */
export function applyDevPreviewEmulation(
  webviewElement: Electron.WebviewTag,
  panelId: string,
  presetId: ViewportPresetId | undefined,
  rotated: boolean,
  dpr: number
): Promise<void> {
  const webContentsId = webviewElement.getWebContentsId();
  const params = buildEmulationParams(presetId, rotated, dpr);
  return window.electron.webview.setDeviceEmulation({
    webContentsId,
    panelId,
    emulation:
      presetId && params
        ? {
            params,
            userAgent: getViewportPreset(presetId).userAgent,
            // Every preset in the table is a phone or tablet, so a preset being
            // active is the same signal as "emulate a touch screen".
            touch: true,
          }
        : null,
  });
}
