import type { ViewportPresetId } from "@shared/types/panel";

/**
 * States of the dev preview's chrome — the pane header and the toolbar under it.
 *
 * Type imports only: the screenshot spec imports this module under Playwright's
 * Node loader, where anything reaching `import.meta.glob` fails to load.
 */

export const PROJECT_ID = "8e8efe1218ac32d2d9784706";
export const PANEL_ID = "dev-preview-bbda886a-4f1c";
/** What the webview actually sits on: the stable proxy origin (#9100). */
export const PROXY_ORIGIN = `http://dp-${PROJECT_ID}-dev-preview-bbda886a-4f1c.localhost:43000`;
/** What the dev server printed. The proxy forwards to it. */
export const DEV_SERVER_URL = "http://localhost:5173";

export interface DevPreviewChromeFixture {
  /** Pane width in CSS px. The grid gives a pane anything from ~480 to the full window. */
  width: number;
  /** Route on the proxy origin, e.g. "/" or "/dashboard?tab=billing". */
  route: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
  isWebviewReady?: boolean;
  zoomFactor?: number;
  consoleOpen?: boolean;
  /** False when the dev server has no terminal behind it (stopped). */
  canToggleConsole?: boolean;
  toolActive?: boolean;
  viewportPreset?: ViewportPresetId;
  viewportDpr?: 1 | 2 | 3;
  viewportRotated?: boolean;
  viewportFit?: boolean;
  /** The pane frame's focus state. */
  isFocused?: boolean;
  /** A pointer or keyboard drive the spec performs after load. */
  drive?: "address-history" | "address-error" | "keyboard-focus" | "hover-action";
}

export const FIXTURES = {
  rest: { width: 900, route: "/", canGoBack: true, isFocused: true },
  route: {
    width: 900,
    route: "/dashboard/projects/orchid-studio/settings?tab=billing",
    canGoBack: true,
    canGoForward: true,
    isFocused: true,
  },
  narrow: { width: 560, route: "/dashboard", canGoBack: true, isFocused: true },
  wide: { width: 1400, route: "/", canGoBack: true, isFocused: true },
  unfocused: { width: 900, route: "/", canGoBack: true, isFocused: false },
  zoomed: { width: 900, route: "/", canGoBack: true, zoomFactor: 1.25, isFocused: true },
  viewport: {
    width: 900,
    route: "/",
    canGoBack: true,
    viewportPreset: "iphone",
    viewportDpr: 2,
    isFocused: true,
  },
  "viewport-wide": {
    width: 1400,
    route: "/pricing",
    canGoBack: true,
    viewportPreset: "ipad",
    viewportDpr: 2,
    viewportRotated: true,
    viewportFit: true,
    isFocused: true,
  },
  "tools-open": {
    width: 900,
    route: "/",
    canGoBack: true,
    consoleOpen: true,
    toolActive: true,
    isFocused: true,
  },
  loading: {
    width: 900,
    route: "/",
    isLoading: true,
    isWebviewReady: false,
    canToggleConsole: true,
    isFocused: true,
  },
  stopped: {
    width: 900,
    route: "/",
    canToggleConsole: false,
    isWebviewReady: false,
    isFocused: true,
  },
  "address-history": {
    width: 900,
    route: "/",
    canGoBack: true,
    isFocused: true,
    drive: "address-history",
  },
  "address-error": {
    width: 900,
    route: "/",
    canGoBack: true,
    isFocused: true,
    drive: "address-error",
  },
  "keyboard-focus": {
    width: 900,
    route: "/",
    canGoBack: true,
    isFocused: true,
    drive: "keyboard-focus",
  },
  "hover-action": {
    width: 900,
    route: "/",
    canGoBack: true,
    isFocused: true,
    drive: "hover-action",
  },
} satisfies Record<string, DevPreviewChromeFixture>;

export type FixtureName = keyof typeof FIXTURES;
export const FIXTURE_NAMES: FixtureName[] = Object.keys(FIXTURES).filter(isFixtureName);

export function isFixtureName(value: string): value is FixtureName {
  return Object.prototype.hasOwnProperty.call(FIXTURES, value);
}
