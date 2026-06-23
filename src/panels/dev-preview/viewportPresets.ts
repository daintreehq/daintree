import type { ViewportPresetId } from "@shared/types/panel";

export interface ViewportPreset {
  id: ViewportPresetId;
  label: string;
  width: number;
  height: number;
  userAgent: string;
}

export const VIEWPORT_PRESETS: Record<ViewportPresetId, ViewportPreset> = {
  galaxy: {
    id: "galaxy",
    label: "Galaxy S26",
    width: 360,
    height: 780,
    userAgent:
      "Mozilla/5.0 (Linux; Android 16; SM-S941U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
  },
  iphone: {
    id: "iphone",
    label: "iPhone 17",
    width: 393,
    height: 852,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 19_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.4 Mobile/15E148 Safari/604.1",
  },
  pixel: {
    id: "pixel",
    label: "Pixel 10",
    width: 412,
    height: 923,
    userAgent:
      "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
  },
  ipad: {
    id: "ipad",
    label: 'iPad Air 11"',
    width: 820,
    height: 1180,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 19_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.4 Mobile/15E148 Safari/604.1",
  },
};

export const VIEWPORT_PRESET_LIST: ViewportPreset[] = Object.values(VIEWPORT_PRESETS);

export function getViewportPreset(id: ViewportPresetId): ViewportPreset {
  return VIEWPORT_PRESETS[id] ?? VIEWPORT_PRESETS.iphone;
}

/**
 * Effective viewport dimensions for a preset, with width/height swapped when
 * the preset is rotated to landscape.
 */
export function getEffectiveViewportSize(
  id: ViewportPresetId,
  rotated: boolean
): { width: number; height: number } {
  const preset = getViewportPreset(id);
  return rotated
    ? { width: preset.height, height: preset.width }
    : { width: preset.width, height: preset.height };
}

/**
 * Scale factor that fits a viewport of `viewportW`×`viewportH` into a container
 * of `containerW`×`containerH`. Never upscales (capped at 1) so small mobile
 * viewports stay device-accurate instead of filling large panes. Returns 1 when
 * the container has not been measured yet.
 */
export function computeFitScale(
  containerW: number,
  containerH: number,
  viewportW: number,
  viewportH: number
): number {
  if (containerW <= 0 || containerH <= 0 || viewportW <= 0 || viewportH <= 0) {
    return 1;
  }
  return Math.min(containerW / viewportW, containerH / viewportH, 1);
}
