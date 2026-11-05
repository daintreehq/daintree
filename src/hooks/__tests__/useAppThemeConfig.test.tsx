// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { AppThemeConfig } from "@shared/types/appTheme";

const setSelectedSchemeIdSilent = vi.fn();
const setProjectTheme = vi.fn();
const reconcileAppThemeConfig = vi.fn();
const storeActions = {
  setSelectedSchemeIdSilent,
  setProjectTheme,
  reconcileAppThemeConfig,
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

import { appThemeClient } from "@/clients/appThemeClient";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useAppThemeConfig } from "../useAppThemeConfig";

/** Captures the listener the hook registers, so tests can push a global theme change. */
let changeListener: ((config: AppThemeConfig) => void) | null = null;
const unsubscribe = vi.fn();

function bootWith(appTheme: Partial<AppThemeConfig>) {
  bootPromise.mockReturnValue(Promise.resolve({ ok: true, result: { appTheme } }));
}

describe("useAppThemeConfig", () => {
  beforeEach(() => {
    // Cleared here, not in afterEach: Testing Library's auto-cleanup unmounts the
    // previous test's hook after our afterEach runs, re-calling `unsubscribe`.
    vi.clearAllMocks();

    changeListener = null;
    // Object.assign, not a cast — `window as unknown as {...}` trips the
    // no-unsafe-type-assertion lint ratchet.
    Object.assign(window, {
      electron: {
        appTheme: {
          onChanged: (cb: (config: AppThemeConfig) => void) => {
            changeListener = cb;
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

  describe("global settings another view or the OS changed (#16271)", () => {
    it("crossfades a push once the boot payload has painted", async () => {
      bootWith({ colorSchemeId: "daintree" });
      renderHook(() => useAppThemeConfig());
      await waitFor(() => expect(setSelectedSchemeIdSilent).toHaveBeenCalled());

      const pushed = { colorSchemeId: "bondi", accentColorOverride: "#ff8800" };
      changeListener!(pushed);

      expect(reconcileAppThemeConfig).toHaveBeenCalledWith(pushed, { crossfade: true });
    });

    it("cuts to a push that beats the boot payload, which then leaves the global settings alone", async () => {
      let resolveBoot!: (value: unknown) => void;
      bootPromise.mockReturnValue(new Promise((resolve) => (resolveBoot = resolve)));
      Object.assign(window, { __DAINTREE_INITIAL_PROJECT__: { id: "p1" } });
      try {
        renderHook(() => useAppThemeConfig());

        const pushed = { colorSchemeId: "bondi" };
        changeListener!(pushed);
        expect(reconcileAppThemeConfig).toHaveBeenCalledWith(pushed, { crossfade: false });

        resolveBoot({
          ok: true,
          result: {
            appTheme: {
              colorSchemeId: "daintree",
              customSchemes: [{ id: "custom-stale", name: "Stale", type: "dark", tokens: {} }],
              accentColorOverride: "#123456",
              colorVisionMode: "red-green",
              recentSchemeIds: ["daintree"],
              followSystem: true,
              preferredDarkSchemeId: "namib",
              projectThemes: { p1: { colorSchemeId: "namib" } },
            },
          },
        });

        // The project's own choice still hydrates; only the stale global part is skipped.
        await waitFor(() =>
          expect(setProjectTheme).toHaveBeenCalledWith({ colorSchemeId: "namib" })
        );
        for (const action of [
          setSelectedSchemeIdSilent,
          storeActions.addCustomScheme,
          storeActions.setColorVisionMode,
          storeActions.setRecentSchemeIds,
          storeActions.setFollowSystem,
          storeActions.setPreferredDarkSchemeId,
        ]) {
          expect(action).not.toHaveBeenCalled();
        }
        // No accent or plugin snapshot seeded from the stale payload either.
        expect(useAppThemeStore.setState).not.toHaveBeenCalled();
        expect(reconcileAppThemeConfig).toHaveBeenCalledTimes(1);
      } finally {
        Reflect.deleteProperty(window, "__DAINTREE_INITIAL_PROJECT__");
      }
    });

    it("reads once more after the boot payload, for a change made before it subscribed", async () => {
      const fresh = { colorSchemeId: "bondi" };
      vi.mocked(appThemeClient.get).mockResolvedValueOnce(fresh);
      bootWith({ colorSchemeId: "daintree" });

      renderHook(() => useAppThemeConfig());

      await waitFor(() =>
        expect(reconcileAppThemeConfig).toHaveBeenCalledWith(fresh, { crossfade: true })
      );
      expect(setSelectedSchemeIdSilent.mock.invocationCallOrder[0]).toBeLessThan(
        reconcileAppThemeConfig.mock.invocationCallOrder[0]!
      );
      expect(appThemeClient.get).toHaveBeenCalledTimes(1);
    });

    it("drops that read when a push lands while it is in flight", async () => {
      let resolveRead!: (config: AppThemeConfig) => void;
      vi.mocked(appThemeClient.get).mockReturnValueOnce(
        new Promise((resolve) => (resolveRead = resolve))
      );
      bootWith({ colorSchemeId: "daintree" });
      renderHook(() => useAppThemeConfig());
      await waitFor(() => expect(appThemeClient.get).toHaveBeenCalled());

      const pushed = { colorSchemeId: "bondi" };
      changeListener!(pushed);
      resolveRead({ colorSchemeId: "daintree" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(reconcileAppThemeConfig).toHaveBeenCalledTimes(1);
      expect(reconcileAppThemeConfig).toHaveBeenCalledWith(pushed, { crossfade: true });
    });
  });

  describe("a project's own theme (#13833)", () => {
    let projectThemeListener: ((change: { projectId: string; choice: unknown }) => void) | null =
      null;

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

  it("unsubscribes from global theme pushes on unmount", () => {
    const { unmount } = renderHook(() => useAppThemeConfig());
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
