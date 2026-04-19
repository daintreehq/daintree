import type { ViewportPresetId } from "@shared/types/panel";

export interface ViewportPreset {
  id: ViewportPresetId;
  label: string;
  width: number;
  height: number;
  userAgent: string;
}

export const VIEWPORT_PRESETS: Record<ViewportPresetId, ViewportPreset> = {
  iphone: {
    id: "iphone",
    label: "iPhone 15",
    width: 393,
    height: 852,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  pixel: {
    id: "pixel",
    label: "Pixel 8",
    width: 412,
    height: 915,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36",
  },
  ipad: {
    id: "ipad",
    label: "iPad Air",
    width: 820,
    height: 1180,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
};

export const VIEWPORT_PRESET_LIST: ViewportPreset[] = Object.values(VIEWPORT_PRESETS);

export function getViewportPreset(id: ViewportPresetId): ViewportPreset {
  return VIEWPORT_PRESETS[id];
}
