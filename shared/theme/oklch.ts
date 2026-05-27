import type { ThemePalette } from "./palette.js";

// sRGB hex → OKLab/OKLCH lightness using Ottosson 2020's direct sRGB→LMS path
// (CSS Color 4 spec). Accepts `#rrggbb` only — all built-in themes use this form.

function hexChannelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function hexToOklchL(hex: string): number {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length !== 6) {
    throw new Error(`hexToOklchL expects #rrggbb form, got "${hex}"`);
  }
  const r = hexChannelToLinear(parseInt(clean.slice(0, 2), 16));
  const g = hexChannelToLinear(parseInt(clean.slice(2, 4), 16));
  const b = hexChannelToLinear(parseInt(clean.slice(4, 6), 16));
  const lLms = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const mLms = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const sLms = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lCbrt = Math.cbrt(lLms);
  const mCbrt = Math.cbrt(mLms);
  const sCbrt = Math.cbrt(sLms);
  return 0.2104542553 * lCbrt + 0.793617785 * mCbrt - 0.0040720468 * sCbrt;
}

export interface SurfaceRampMetrics {
  lightness: { grid: number; sidebar: number; canvas: number; panel: number; elevated: number };
  steps: {
    gridToSidebar: number;
    sidebarToCanvas: number;
    canvasToPanel: number;
    panelToElevated: number;
  };
  minStep: number;
  maxStep: number;
  ratio: number;
  monotonic: boolean;
}

export function getSurfaceRampMetrics(surfaces: ThemePalette["surfaces"]): SurfaceRampMetrics {
  const lightness = {
    grid: hexToOklchL(surfaces.grid),
    sidebar: hexToOklchL(surfaces.sidebar),
    canvas: hexToOklchL(surfaces.canvas),
    panel: hexToOklchL(surfaces.panel),
    elevated: hexToOklchL(surfaces.elevated),
  };
  const steps = {
    gridToSidebar: lightness.sidebar - lightness.grid,
    sidebarToCanvas: lightness.canvas - lightness.sidebar,
    canvasToPanel: lightness.panel - lightness.canvas,
    panelToElevated: lightness.elevated - lightness.panel,
  };
  const stepValues = [
    steps.gridToSidebar,
    steps.sidebarToCanvas,
    steps.canvasToPanel,
    steps.panelToElevated,
  ];
  const monotonic = stepValues.every((s) => s > 0);
  const absSteps = stepValues.map((s) => Math.abs(s));
  const minStep = Math.min(...absSteps);
  const maxStep = Math.max(...absSteps);
  return {
    lightness,
    steps,
    minStep,
    maxStep,
    ratio: minStep === 0 ? Infinity : maxStep / minStep,
    monotonic,
  };
}
