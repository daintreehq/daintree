import type { ViewportPresetId } from "@shared/types/panel";
import { getEffectiveViewportSize } from "@/panels/dev-preview/viewportPresets";

export type DevPreviewWebContents = {
  setUserAgent(ua: string): void;
  getUserAgent(): string;
  enableDeviceEmulation(parameters: Electron.Parameters): void;
  disableDeviceEmulation(): void;
};

export function getDevPreviewWebContents(
  webviewElement: Electron.WebviewTag | null
): DevPreviewWebContents | null {
  if (!webviewElement) return null;
  try {
    return (
      webviewElement as unknown as { getWebContents(): DevPreviewWebContents }
    ).getWebContents();
  } catch {
    return null;
  }
}

export function buildEmulationParams(
  presetId: ViewportPresetId | undefined,
  rotated: boolean,
  dpr: number
): Electron.Parameters | null {
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
