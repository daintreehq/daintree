// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { AppThemeConfig } from "@shared/types/appTheme";

const setSelectedSchemeIdSilent = vi.fn();
const setProjectTheme = vi.fn();
const storeActions = {
  setSelectedSchemeIdSilent,
  setProjectTheme,
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
let appearanceListener: ((payload: { isDark: boolean; schemeId: string }) => void) | null = null;
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
          onSystemAppearanceChanged: (
            cb: (payload: { isDark: boolean; schemeId: string }) => void
          ) => {
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
    expect(setSelectedSchemeIdSilent).toHaveBeenCalledWith(
      "bondi",
      expect.not.objectContaining({ crossfade: true })
    );
  });

  it("hydrates a missing scheme held in the light slot with a light fallback", async () => {
    bootWith({ colorSchemeId: "custom-deleted", preferredLightSchemeId: "custom-deleted" });

    renderHook(() => useAppThemeConfig());

    await waitFor(() => expect(setSelectedSchemeIdSilent).toHaveBeenCalled());
    expect(setSelectedSchemeIdSilent).toHaveBeenCalledWith("custom-deleted", {
      fallbackType: "light",
    });
  });

  it("crossfades an OS appearance change", async () => {
    renderHook(() => useAppThemeConfig());

    expect(appearanceListener).not.toBeNull();
    appearanceListener!({ isDark: true, schemeId: "daintree" });

    expect(setSelectedSchemeIdSilent).toHaveBeenCalledWith("daintree", {
      crossfade: true,
      fallbackType: "dark",
    });
  });

  it("falls back to the appearance the OS just switched to", async () => {
    renderHook(() => useAppThemeConfig());

    appearanceListener!({ isDark: false, schemeId: "custom-deleted" });

    expect(setSelectedSchemeIdSilent).toHaveBeenCalledWith("custom-deleted", {
      crossfade: true,
      fallbackType: "light",
    });
  });

  describe("a project's own theme (#13833)", () => {
    let projectThemeListener:
      | ((change: { projectId: string; choice: unknown }) => void)
      | null = null;

    beforeEach(() => {
      projectThemeListener = null;
      Object.assign(window, {
        __DAINTREE_INITIAL_PROJECT__: { id: "p1" },
        electron: {
          ...(window as { electron?: object }).electron,
          projectTheme: {
            onChanged: (cb: (change: { projectId: string; choice: unknown }) => void) => {
              projectThemeListener = cb;
              return () => {};
            },
          },
        },
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(window, "__DAINTREE_INITIAL_PROJECT__");
    });

    it("seeds this view's project choice before the selection paints", async () => {
      bootWith({
        colorSchemeId: "daintree",
        projectThemes: { p1: { colorSchemeId: "bondi" }, p2: { colorSchemeId: "namib" } },
      });

      renderHook(() => useAppThemeConfig());

      await waitFor(() => expect(setSelectedSchemeIdSilent).toHaveBeenCalled());
      expect(setProjectTheme).toHaveBeenCalledWith({ colorSchemeId: "bondi" });
      expect(setProjectTheme.mock.invocationCallOrder[0]).toBeLessThan(
        setSelectedSchemeIdSilent.mock.invocationCallOrder[0]!
      );
    });

    it("follows main's pushes for this view's project only, crossfading", () => {
      renderHook(() => useAppThemeConfig());
      expect(projectThemeListener).not.toBeNull();

      projectThemeListener!({ projectId: "p2", choice: { colorSchemeId: "namib" } });
      expect(setProjectTheme).not.toHaveBeenCalled();

      projectThemeListener!({ projectId: "p1", choice: null });
      expect(setProjectTheme).toHaveBeenCalledWith(null, { crossfade: true });
    });
  });

  it("unsubscribes from the appearance listener on unmount", () => {
    const { unmount } = renderHook(() => useAppThemeConfig());
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
