// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useThemeBrowserStore } from "@/store/themeBrowserStore";
import { useUIStore } from "@/store/uiStore";
import { usePortalStore } from "@/store/portalStore";
import { _resetForTests } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";
import type { NotifyPayload } from "@/lib/notify";

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setFollowSystem: vi.fn().mockResolvedValue(undefined),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify")>()),
  notify: vi.fn(() => "notification-id"),
}));

// The real store still runs end to end; this only records which scheme was painted.
vi.mock("@/theme/applyAppTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/theme/applyAppTheme")>()),
  applyAppThemeToRoot: vi.fn(),
}));

import { appThemeClient } from "@/clients/appThemeClient";
import { notify } from "@/lib/notify";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeBrowser } from "../ThemeBrowser";

function Harness() {
  useGlobalEscapeDispatcher();
  return (
    <TooltipProvider>
      <ThemeBrowser />
    </TooltipProvider>
  );
}

const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light");
const target = darkSchemes.find((s) => s.id !== DEFAULT_APP_SCHEME_ID)!;
const other = darkSchemes.find((s) => s.id !== DEFAULT_APP_SCHEME_ID && s.id !== target.id)!;
const previousRecents = [DEFAULT_APP_SCHEME_ID, other.id];

function findRowByName(name: string) {
  return screen
    .getAllByRole("option")
    .find((o) => o.textContent?.toLowerCase().includes(name.toLowerCase()))!;
}

async function setThemeInBrowser(schemeName: string) {
  render(<Harness />);
  fireEvent.click(findRowByName(schemeName));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Set theme" }));
  });
}

function lastToast(): NotifyPayload {
  const calls = vi.mocked(notify).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0];
}

function paintedSchemeId(): string | undefined {
  const calls = vi.mocked(applyAppThemeToRoot).mock.calls;
  return calls[calls.length - 1]?.[1].id;
}

function deferred() {
  let reject!: (error: unknown) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ThemeBrowser persistence", () => {
  beforeEach(() => {
    _resetForTests();
    vi.mocked(appThemeClient.setColorScheme).mockReset().mockResolvedValue(undefined);
    vi.mocked(appThemeClient.setFollowSystem).mockReset().mockResolvedValue(undefined);
    vi.mocked(appThemeClient.setRecentSchemeIds).mockReset().mockResolvedValue(undefined);
    vi.mocked(notify).mockClear();
    vi.mocked(applyAppThemeToRoot).mockClear();
    useAppThemeStore.setState({
      selectedSchemeId: DEFAULT_APP_SCHEME_ID,
      customSchemes: [],
      colorVisionMode: "default",
      followSystem: false,
      preferredDarkSchemeId: "daintree",
      preferredLightSchemeId: "bondi",
      recentSchemeIds: previousRecents,
      accentColorOverride: null,
      previewSchemeId: null,
    });
    useThemeBrowserStore.setState({ isOpen: true });
    useUIStore.setState({ overlayStack: [] });
    usePortalStore.setState({ isOpen: false });
  });

  afterEach(() => {
    cleanup();
    _resetForTests();
    useAppThemeStore.setState({ previewSchemeId: null });
    useThemeBrowserStore.setState({ isOpen: false });
    useUIStore.setState({ overlayStack: [] });
  });

  it("restores the previous theme and says so when the theme can't be saved", async () => {
    vi.mocked(appThemeClient.setColorScheme).mockRejectedValueOnce(new Error("disk full"));

    await setThemeInBrowser(target.name);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const state = useAppThemeStore.getState();
    expect(state.selectedSchemeId).toBe(DEFAULT_APP_SCHEME_ID);
    expect(state.recentSchemeIds).toEqual(previousRecents);
    expect(paintedSchemeId()).toBe(DEFAULT_APP_SCHEME_ID);
    expect(appThemeClient.setRecentSchemeIds).not.toHaveBeenCalled();

    const toast = lastToast();
    expect(toast.type).toBe("error");
    expect(toast.title).toBe("Couldn't save theme");
    expect(toast.message).toBe("The previous theme was restored, so it won't change on restart.");
    expect(toast.action?.label).toBe("Retry");
  });

  it("re-applies and saves the theme when the toast's Retry is pressed", async () => {
    vi.mocked(appThemeClient.setColorScheme).mockRejectedValueOnce(new Error("disk full"));

    await setThemeInBrowser(target.name);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(useThemeBrowserStore.getState().isOpen).toBe(false);
    // The toast outlives the browser, so its Retry has to work with it gone.
    cleanup();

    await act(async () => {
      await lastToast().action!.onClick();
    });

    await vi.waitFor(() =>
      expect(appThemeClient.setRecentSchemeIds).toHaveBeenCalledWith([
        target.id,
        ...previousRecents,
      ])
    );
    expect(appThemeClient.setColorScheme).toHaveBeenCalledTimes(2);
    expect(appThemeClient.setColorScheme).toHaveBeenLastCalledWith(target.id);
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(target.id);
    expect(paintedSchemeId()).toBe(target.id);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does nothing on Retry once another theme has been picked", async () => {
    vi.mocked(appThemeClient.setColorScheme).mockRejectedValueOnce(new Error("disk full"));

    await setThemeInBrowser(target.name);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    act(() => useAppThemeStore.getState().commitSchemeSelection(other.id));

    await act(async () => {
      await lastToast().action!.onClick();
    });

    expect(appThemeClient.setColorScheme).toHaveBeenCalledTimes(1);
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(other.id);
  });

  it("puts system matching and the theme back when turning matching off can't be saved", async () => {
    useAppThemeStore.setState({ followSystem: true });
    vi.mocked(appThemeClient.setFollowSystem).mockRejectedValueOnce(new Error("disk full"));

    await setThemeInBrowser(target.name);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const state = useAppThemeStore.getState();
    expect(state.followSystem).toBe(true);
    expect(state.selectedSchemeId).toBe(DEFAULT_APP_SCHEME_ID);
    // The app would boot following the system, so the scheme write would be a lie.
    expect(appThemeClient.setColorScheme).not.toHaveBeenCalled();
    expect(lastToast().title).toBe("Couldn't save theme");
  });

  it("keeps system matching off when only the theme write fails after it landed", async () => {
    useAppThemeStore.setState({ followSystem: true });
    vi.mocked(appThemeClient.setColorScheme).mockRejectedValueOnce(new Error("disk full"));

    await setThemeInBrowser(target.name);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(appThemeClient.setFollowSystem).toHaveBeenCalledWith(false);
    const state = useAppThemeStore.getState();
    expect(state.followSystem).toBe(false);
    expect(state.selectedSchemeId).toBe(DEFAULT_APP_SCHEME_ID);
  });

  it("stays quiet when only the recent themes list can't be saved", async () => {
    vi.mocked(appThemeClient.setRecentSchemeIds).mockRejectedValueOnce(new Error("disk full"));

    await setThemeInBrowser(target.name);

    await vi.waitFor(() => expect(appThemeClient.setRecentSchemeIds).toHaveBeenCalled());
    await act(async () => {});
    const state = useAppThemeStore.getState();
    expect(state.selectedSchemeId).toBe(target.id);
    expect(state.recentSchemeIds).toEqual(previousRecents);
    expect(notify).not.toHaveBeenCalled();
  });

  it("doesn't save the theme once another pick overtakes turning matching off", async () => {
    useAppThemeStore.setState({ followSystem: true });
    const slow = deferred();
    vi.mocked(appThemeClient.setFollowSystem).mockReturnValueOnce(slow.promise);

    await setThemeInBrowser(target.name);
    act(() => useAppThemeStore.getState().commitSchemeSelection(other.id));
    await act(async () => {
      slow.resolve();
    });

    // Writing it now would land after the newer pick and boot into the wrong theme.
    expect(appThemeClient.setColorScheme).not.toHaveBeenCalled();
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(other.id);
  });

  it("leaves a newer selection alone when an older save fails late", async () => {
    const slow = deferred();
    vi.mocked(appThemeClient.setColorScheme).mockReturnValueOnce(slow.promise);

    await setThemeInBrowser(target.name);
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(target.id);

    // Something else (the Appearance picker, the palette) picks another theme
    // while the browser's write is still in flight.
    act(() => useAppThemeStore.getState().commitSchemeSelection(other.id));

    await act(async () => {
      slow.reject(new Error("disk full"));
    });

    expect(useAppThemeStore.getState().selectedSchemeId).toBe(other.id);
    expect(notify).not.toHaveBeenCalled();
  });
});
