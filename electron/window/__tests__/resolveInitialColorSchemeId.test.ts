import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests resolveInitialColorSchemeId from skeletonCss.ts — the helper that seeds
 * the renderer's first-paint theme via webPreferences.additionalArguments
 * (#9169). It must mirror createWindow/getAppThemeConfig fallback behavior.
 */

const mocks = vi.hoisted(() => ({
  storeGet: vi.fn(),
  shouldUseDarkColors: { value: true },
}));

vi.mock("../../store.js", () => ({
  store: { get: mocks.storeGet },
}));

vi.mock("electron", () => ({
  nativeTheme: {
    get shouldUseDarkColors() {
      return mocks.shouldUseDarkColors.value;
    },
  },
}));

import { resolveInitialColorSchemeId, INITIAL_COLOR_SCHEME_ARG } from "../skeletonCss.js";

describe("resolveInitialColorSchemeId (#9169)", () => {
  const originalScreenshotScale = process.env.DAINTREE_SCREENSHOT_SCALE;

  beforeEach(() => {
    mocks.storeGet.mockReset();
    mocks.shouldUseDarkColors.value = true;
    delete process.env.DAINTREE_SCREENSHOT_SCALE;
  });

  afterEach(() => {
    if (originalScreenshotScale === undefined) {
      delete process.env.DAINTREE_SCREENSHOT_SCALE;
    } else {
      process.env.DAINTREE_SCREENSHOT_SCALE = originalScreenshotScale;
    }
  });

  it("returns the persisted color scheme id, trimmed", () => {
    mocks.storeGet.mockReturnValue({ colorSchemeId: "  bondi  " });
    expect(resolveInitialColorSchemeId()).toBe("bondi");
  });

  it("returns a custom persisted id verbatim", () => {
    mocks.storeGet.mockReturnValue({ colorSchemeId: "my-custom-scheme" });
    expect(resolveInitialColorSchemeId()).toBe("my-custom-scheme");
  });

  it("falls back to daintree when no theme is persisted and the OS prefers dark", () => {
    mocks.storeGet.mockReturnValue(undefined);
    mocks.shouldUseDarkColors.value = true;
    expect(resolveInitialColorSchemeId()).toBe("daintree");
  });

  it("falls back to bondi when no theme is persisted and the OS prefers light", () => {
    mocks.storeGet.mockReturnValue(undefined);
    mocks.shouldUseDarkColors.value = false;
    expect(resolveInitialColorSchemeId()).toBe("bondi");
  });

  it("falls back when colorSchemeId is not a string", () => {
    mocks.storeGet.mockReturnValue({ colorSchemeId: 123 });
    mocks.shouldUseDarkColors.value = false;
    expect(resolveInitialColorSchemeId()).toBe("bondi");
  });

  it("falls back when colorSchemeId is whitespace only", () => {
    mocks.storeGet.mockReturnValue({ colorSchemeId: "   " });
    mocks.shouldUseDarkColors.value = false;
    expect(resolveInitialColorSchemeId()).toBe("bondi");
  });

  it("forces daintree when DAINTREE_SCREENSHOT_SCALE is set, even on a light OS", () => {
    mocks.storeGet.mockReturnValue(undefined);
    mocks.shouldUseDarkColors.value = false;
    process.env.DAINTREE_SCREENSHOT_SCALE = "2";
    expect(resolveInitialColorSchemeId()).toBe("daintree");
  });

  it("matches the prefix preload.cts parses (drift guard)", () => {
    // preload.cts hardcodes this literal rather than importing the constant
    // (esbuild cross-bundle); this ties both halves of the contract together so
    // a rename of INITIAL_COLOR_SCHEME_ARG fails loudly instead of silently
    // reintroducing the flash (#9169).
    expect(`${INITIAL_COLOR_SCHEME_ARG}=`).toBe("--daintree-initial-color-scheme-id=");
  });

  it("returns a trimmed value with no whitespace for a valid argv flag", () => {
    mocks.storeGet.mockReturnValue({ colorSchemeId: "  table-mountain  " });
    const arg = `${INITIAL_COLOR_SCHEME_ARG}=${resolveInitialColorSchemeId()}`;
    expect(arg).toBe("--daintree-initial-color-scheme-id=table-mountain");
    expect(arg).not.toMatch(/\s/);
  });
});
