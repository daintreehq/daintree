// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { AppThemeConfig } from "@shared/types/appTheme";

const setSelectedSchemeIdSilent = vi.fn();
const storeActions = {
  setSelectedSchemeIdSilent,
  addCustomScheme: vi.fn(),
  setColorVisionMode: vi.fn(),
  setFollowSystem: vi.fn(),
  setPreferredDarkSchemeId: vi.fn(),
  setPreferredLightSchemeId: vi.fn(),
  setRecentSchemeIds: vi.fn(),
};

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: Object.assign((selector: (s: unknown) => unknown) => selector(storeActions), {
    setState: vi.fn(),
  }),
}));

const bootPromise = vi.fn();
vi.mock("@/lib/bootPromise", () => ({
  getSafeBootPromise: () => bootPromise(),
}));

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: { get: vi.fn(() => new Promise(() => {})) },
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { useAppThemeConfig } from "../useAppThemeConfig";

/** Captures the listener the hook registers, so tests can fire an OS appearance change. */
let appearanceListener: ((payload: { schemeId: string }) => void) | null = null;
const unsubscribe = vi.fn();

function bootWith(appTheme: Partial<AppThemeConfig>) {
  bootPromise.mockReturnValue(Promise.resolve({ ok: true, result: { appTheme } }));
}

describe("useAppThemeConfig", () => {
  beforeEach(() => {
    // Cleared here, not in afterEach: Testing Library's auto-cleanup unmounts the
    // previous test's hook after our afterEach runs, re-calling `unsubscribe`.
    vi.clearAllMocks();

    appearanceListener = null;
    // Object.assign, not a cast — `window as unknown as {...}` trips the
    // no-unsafe-type-assertion lint ratchet.
    Object.assign(window, {
      electron: {
        appTheme: {
          onSystemAppearanceChanged: (cb: (payload: { schemeId: string }) => void) => {
            appearanceListener = cb;
            return unsubscribe;
          },
        },
      },
    });
    // Never resolves by default — keeps hydration from racing the IPC assertions.
    bootPromise.mockReturnValue(new Promise(() => {}));
  });

  it("hydrates the persisted scheme without a transition", async () => {
    bootWith({ colorSchemeId: "bondi" });

    renderHook(() => useAppThemeConfig());

    await waitFor(() => expect(setSelectedSchemeIdSilent).toHaveBeenCalled());
    // Startup has no prior theme to fade from — only the placeholder default, so
    // hydration must stay an instant swap rather than animating that placeholder out.
    expect(setSelectedSchemeIdSilent).toHaveBeenCalledWith("bondi");
  });

  it("crossfades an OS appearance change", async () => {
    renderHook(() => useAppThemeConfig());

    expect(appearanceListener).not.toBeNull();
    appearanceListener!({ schemeId: "daintree" });

    expect(setSelectedSchemeIdSilent).toHaveBeenCalledWith("daintree", { crossfade: true });
  });

  it("unsubscribes from the appearance listener on unmount", () => {
    const { unmount } = renderHook(() => useAppThemeConfig());
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
