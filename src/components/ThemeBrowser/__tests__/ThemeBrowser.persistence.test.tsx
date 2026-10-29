// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useThemeBrowserStore } from "@/store/themeBrowserStore";
import { useUIStore } from "@/store/uiStore";
import { usePortalStore } from "@/store/portalStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
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

// The real notify still routes, so a toast that would only reach the inbox shows up as one.
vi.mock("@/lib/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify")>();
  return { ...actual, notify: vi.fn(actual.notify) };
});

// The real store still runs end to end; this only records which scheme was painted.
vi.mock("@/theme/applyAppTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/theme/applyAppTheme")>()),
  applyAppThemeToRoot: vi.fn(),
}));

import { appThemeClient } from "@/clients/appThemeClient";
import { _resetRateLimitBuckets, _setQuietUntil, notify } from "@/lib/notify";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeBrowser } from "../ThemeBrowser";

// Mounted only while open, as in the app, so a write that settles after Set
// theme settles with the browser gone.
function Harness() {
  useGlobalEscapeDispatcher();
  const isOpen = useThemeBrowserStore((s) => s.isOpen);
  return <TooltipProvider>{isOpen && <ThemeBrowser />}</TooltipProvider>;
}

const darkSchemes = BUILT_IN_APP_SCHEMES.filter(
  (s) => s.type !== "light" && s.id !== DEFAULT_APP_SCHEME_ID
);
// Three distinct themes, none the default, so a rollback can't pass by falling back.
const previous = darkSchemes[0]!;
const target = darkSchemes[1]!;
const other = darkSchemes[2]!;
const previousRecents = [previous.id, DEFAULT_APP_SCHEME_ID];

function findRowByName(name: string) {
  return screen
    .getAllByRole("option")
    .find((o) => o.textContent?.toLowerCase().includes(name.toLowerCase()))!;
}

function openBrowser() {
  act(() => useThemeBrowserStore.getState().open());
}

/** Set theme on the named row, or on the saved theme when no name is given. */
async function setTheme(schemeName?: string) {
  if (schemeName) fireEvent.click(findRowByName(schemeName));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Set theme" }));
  });
}

function toastCalls(): NotifyPayload[] {
  return vi.mocked(notify).mock.calls.map(([payload]) => payload);
}

function lastToast(): NotifyPayload {
  const calls = toastCalls();
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]!;
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
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    useNotificationSettingsStore.setState({ enabled: true, hydrated: true });
    _resetRateLimitBuckets();
    _setQuietUntil(0);
    useAppThemeStore.setState({
      selectedSchemeId: previous.id,
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
    render(<Harness />);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    _resetForTests();
    useAppThemeStore.setState({ previewSchemeId: null });
    useThemeBrowserStore.setState({ isOpen: false });
    useUIStore.setState({ overlayStack: [] });
  });

  it("restores the previous theme and says so when the theme can't be saved", async () => {
    vi.mocked(appThemeClient.setColorScheme).mockRejectedValueOnce(new Error("disk full"));

    await setTheme(target.name);

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const state = useAppThemeStore.getState();
    expect(state.selectedSchemeId).toBe(previous.id);
    expect(state.recentSchemeIds).toEqual(previousRecents);
    expect(state.followSystem).toBe(false);
    expect(paintedSchemeId()).toBe(previous.id);
    expect(appThemeClient.setRecentSchemeIds).not.toHaveBeenCalled();

    const toast = lastToast();
    expect(toast.type).toBe("error");
    expect(toast.title).toBe("Couldn't save theme");
    expect(toast.action?.label).toBe("Retry");
  });

  it("shows the failure as a toast even while startup notifications are held", async () => {
    _setQuietUntil(Date.now() + 60_000);
    vi.mocked(appThemeClient.setColorScheme).mockRejectedValueOnce(new Error("disk full"));

    await setTheme(target.name);

    await waitFor(() => {
      const live = useNotificationStore.getState().notifications.filter((n) => !n.dismissed);
      expect(live).toHaveLength(1);
      expect(live[0]!.title).toBe("Couldn't save theme");
      expect(live[0]!.action?.label).toBe("Retry");
    });
  });

  it("closes before the save settles and retries with the browser gone", async () => {
    const slow = deferred();
    vi.mocked(appThemeClient.setColorScheme).mockReturnValueOnce(slow.promise);

    await setTheme(target.name);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      slow.reject(new Error("disk full"));
    });
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));

    await act(async () => {
      await lastToast().action!.onClick();
    });

    await waitFor(() =>
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

    await setTheme(target.name);
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    act(() => useAppThemeStore.getState().commitSchemeSelection(other.id));

    await act(async () => {
      await lastToast().action!.onClick();
    });

    expect(appThemeClient.setColorScheme).toHaveBeenCalledTimes(1);
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(other.id);
  });

  it("does nothing on an old Retry after a newer Set theme, even on the same theme", async () => {
    vi.mocked(appThemeClient.setColorScheme).mockRejectedValueOnce(new Error("disk full"));

    await setTheme(target.name);
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const staleRetry = lastToast().action!;

    // The restored theme saved again, so the selection still reads the same.
    openBrowser();
    await setTheme();
    expect(appThemeClient.setColorScheme).toHaveBeenLastCalledWith(previous.id);

    await act(async () => {
      await staleRetry.onClick();
    });

    expect(appThemeClient.setColorScheme).toHaveBeenCalledTimes(2);
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(previous.id);
  });

  it("leaves a newer Set theme of the same theme alone when the older save fails late", async () => {
    const slow = deferred();
    vi.mocked(appThemeClient.setColorScheme).mockReturnValueOnce(slow.promise);

    await setTheme(target.name);
    openBrowser();
    await setTheme();
    expect(appThemeClient.setColorScheme).toHaveBeenCalledTimes(2);

    await act(async () => {
      slow.reject(new Error("disk full"));
    });

    expect(useAppThemeStore.getState().selectedSchemeId).toBe(target.id);
    expect(paintedSchemeId()).toBe(target.id);
    expect(notify).not.toHaveBeenCalled();
  });

  it("puts system matching and the theme back when turning matching off can't be saved", async () => {
    useAppThemeStore.setState({ followSystem: true });
    vi.mocked(appThemeClient.setFollowSystem).mockRejectedValueOnce(new Error("disk full"));

    await setTheme(target.name);

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const state = useAppThemeStore.getState();
    expect(state.followSystem).toBe(true);
    expect(state.selectedSchemeId).toBe(previous.id);
    // The app would boot following the system, so the scheme write would be a lie.
    expect(appThemeClient.setColorScheme).not.toHaveBeenCalled();
    expect(lastToast().title).toBe("Couldn't save theme");
  });

  it("keeps system matching off when only the theme write fails after it landed", async () => {
    useAppThemeStore.setState({ followSystem: true });
    vi.mocked(appThemeClient.setColorScheme).mockRejectedValueOnce(new Error("disk full"));

    await setTheme(target.name);

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(appThemeClient.setFollowSystem).toHaveBeenCalledWith(false);
    const state = useAppThemeStore.getState();
    expect(state.followSystem).toBe(false);
    expect(state.selectedSchemeId).toBe(previous.id);
  });

  it("stays quiet when only the recent themes list can't be saved", async () => {
    const slow = deferred();
    vi.mocked(appThemeClient.setRecentSchemeIds).mockReturnValueOnce(slow.promise);

    await setTheme(target.name);
    await act(async () => {
      slow.reject(new Error("disk full"));
    });

    const state = useAppThemeStore.getState();
    expect(state.selectedSchemeId).toBe(target.id);
    expect(state.recentSchemeIds).toEqual(previousRecents);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps a newer recent themes list when an older one fails to save", async () => {
    const slow = deferred();
    vi.mocked(appThemeClient.setRecentSchemeIds).mockReturnValueOnce(slow.promise);

    await setTheme(target.name);
    const newer = [target.id, other.id];
    act(() => useAppThemeStore.getState().setRecentSchemeIds(newer));
    await act(async () => {
      slow.reject(new Error("disk full"));
    });

    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(newer);
  });

  it("doesn't save the recent themes list once a newer pick owns the selection", async () => {
    const slow = deferred();
    vi.mocked(appThemeClient.setColorScheme).mockReturnValueOnce(slow.promise);

    await setTheme(target.name);
    act(() => useAppThemeStore.getState().commitSchemeSelection(other.id));
    await act(async () => {
      slow.resolve();
    });

    expect(appThemeClient.setRecentSchemeIds).not.toHaveBeenCalled();
  });

  it("doesn't save the theme once another pick overtakes turning matching off", async () => {
    useAppThemeStore.setState({ followSystem: true });
    const slow = deferred();
    vi.mocked(appThemeClient.setFollowSystem).mockReturnValueOnce(slow.promise);

    await setTheme(target.name);
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

    await setTheme(target.name);
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

  it("rolls back the saved theme without painting over a preview in a reopened browser", async () => {
    const slow = deferred();
    vi.mocked(appThemeClient.setColorScheme).mockReturnValueOnce(slow.promise);

    await setTheme(target.name);
    openBrowser();
    fireEvent.click(findRowByName(other.name));
    await waitFor(() => expect(paintedSchemeId()).toBe(other.id));

    await act(async () => {
      slow.reject(new Error("disk full"));
    });

    const state = useAppThemeStore.getState();
    expect(state.selectedSchemeId).toBe(previous.id);
    expect(state.previewSchemeId).toBe(other.id);
    expect(paintedSchemeId()).toBe(other.id);
  });
});
