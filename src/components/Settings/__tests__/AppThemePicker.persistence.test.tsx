// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

// jsdom ships no matchMedia; InlineStatusBanner reads it to honour reduced motion.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: vi.fn() }) },
}));

// Same seam the existing AppThemePicker suites use: the real contrast engine
// wants a full token map, and these fixtures deliberately carry only the keys the
// picker itself reads. Contrast warnings are covered by the theme suites.
vi.mock("@shared/theme", () => ({
  APP_THEME_PREVIEW_KEYS: { background: "--daintree-bg" },
  accentOverrideHasLowContrast: () => null,
  applyAccentOverrideToScheme: (scheme: unknown) => scheme,
  resolveAppTheme: (id: string, customSchemes: { id: string }[]) =>
    [
      ...customSchemes,
      { id: "dark-a", name: "Dark A", type: "dark", tokens: { "accent-primary": "#111111" } },
      { id: "dark-b", name: "Dark B", type: "dark", tokens: { "accent-primary": "#222222" } },
      { id: "light-a", name: "Light A", type: "light", tokens: { "accent-primary": "#eeeeee" } },
    ].find((s) => s.id === id) ?? { id, name: id, type: "dark", tokens: {} },
}));

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setFollowSystem: vi.fn().mockResolvedValue(undefined),
    setPreferredDarkScheme: vi.fn().mockResolvedValue(undefined),
    setPreferredLightScheme: vi.fn().mockResolvedValue(undefined),
    setAccentColorOverride: vi.fn().mockResolvedValue(undefined),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
    setCustomSchemes: vi.fn().mockResolvedValue(undefined),
    importTheme: vi.fn(),
    exportTheme: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/appThemeViewTransition", () => ({
  runThemeReveal: (_origin: unknown, cb: () => void) => cb(),
}));

// Stub the DOM-writing layer so the real store's setters still run end to end
// while we observe which scheme was actually injected.
vi.mock("@/theme/applyAppTheme", () => ({
  applyAppThemeToRoot: vi.fn(),
  applyColorVisionMode: vi.fn(),
}));

vi.mock("@/config/appColorSchemes", () => ({
  DEFAULT_APP_SCHEME_ID: "dark-a",
  BUILT_IN_APP_SCHEMES: [
    { id: "dark-a", name: "Dark A", type: "dark", tokens: { "accent-primary": "#111111" } },
    { id: "dark-b", name: "Dark B", type: "dark", tokens: { "accent-primary": "#222222" } },
    { id: "light-a", name: "Light A", type: "light", tokens: { "accent-primary": "#eeeeee" } },
  ],
}));

import { appThemeClient } from "@/clients/appThemeClient";
import { useAppThemeStore } from "@/store/appThemeStore";
import { AppThemePicker } from "../AppThemePicker";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const client = vi.mocked(appThemeClient);
const state = () => useAppThemeStore.getState();

async function settle(promise: Promise<unknown>) {
  await act(async () => {
    await promise.catch(() => {});
  });
}

const clickText = async (label: string) => act(async () => screen.getByText(label).click());
const retry = async () => act(async () => screen.getByRole("button", { name: "Retry" }).click());

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [
    client.setColorScheme,
    client.setFollowSystem,
    client.setPreferredDarkScheme,
    client.setPreferredLightScheme,
    client.setAccentColorOverride,
    client.setRecentSchemeIds,
  ]) {
    fn.mockResolvedValue(undefined);
  }
  act(() =>
    useAppThemeStore.setState({
      selectedSchemeId: "dark-a",
      customSchemes: [],
      recentSchemeIds: ["dark-a"],
      followSystem: false,
      preferredDarkSchemeId: "dark-a",
      preferredLightSchemeId: "light-a",
      accentColorOverride: null,
    })
  );
});

describe("AppThemePicker — accent colour persistence", () => {
  const setAccent = (color: string) => {
    const input = screen.getByTestId("accent-color-override-input");
    // The live-drag preview writes to the store WITHOUT persisting; the commit is
    // what persists. Firing both is what makes this a real regression test: a
    // rollback that reads its baseline from the store at commit time would read
    // the previewed colour and silently restore nothing.
    fireEvent.input(input, { target: { value: color } });
    fireEvent.change(input, { target: { value: color } });
  };

  it("restores the last saved accent — not the previewed one — when the commit is rejected", async () => {
    const write = deferred();
    client.setAccentColorOverride.mockReturnValue(write.promise);

    render(<AppThemePicker />);
    await act(async () => setAccent("#ff0000"));
    expect(state().accentColorOverride).toBe("#ff0000"); // optimistic

    write.reject(new Error("nope"));
    await settle(write.promise);

    expect(state().accentColorOverride).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("rolls back to the previously saved override rather than to no override at all", async () => {
    // A first accent that DID save becomes the new baseline.
    render(<AppThemePicker />);
    await act(async () => setAccent("#00ff00"));
    expect(state().accentColorOverride).toBe("#00ff00");

    const failing = deferred();
    client.setAccentColorOverride.mockReturnValue(failing.promise);
    await act(async () => setAccent("#0000ff"));

    await act(async () => {
      failing.reject(new Error("disk"));
      await failing.promise.catch(() => {});
    });

    // Back to the last colour that reached disk, not to null.
    expect(state().accentColorOverride).toBe("#00ff00");
  });

  it("re-applies and re-persists the requested accent on Retry", async () => {
    const failing = deferred();
    client.setAccentColorOverride.mockReturnValueOnce(failing.promise);

    render(<AppThemePicker />);
    await act(async () => setAccent("#abcdef"));
    await act(async () => {
      failing.reject(new Error("x"));
      await failing.promise.catch(() => {});
    });
    expect(state().accentColorOverride).toBeNull();

    await retry();

    expect(client.setAccentColorOverride.mock.calls.at(-1)?.[0]).toBe("#abcdef");
    expect(state().accentColorOverride).toBe("#abcdef");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AppThemePicker — follow-system and preferred schemes", () => {
  it("reverts the follow-system toggle when its write is rejected", async () => {
    const write = deferred();
    client.setFollowSystem.mockReturnValue(write.promise);

    render(<AppThemePicker />);
    await act(async () => screen.getByLabelText("Toggle automatic theme switching").click());
    expect(state().followSystem).toBe(true);

    await act(async () => {
      write.reject(new Error("nope"));
      await write.promise.catch(() => {});
    });

    expect(state().followSystem).toBe(false);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("reverts only the preferred dark scheme, leaving the light one untouched", async () => {
    act(() => useAppThemeStore.setState({ followSystem: true }));
    const write = deferred();
    client.setPreferredDarkScheme.mockReturnValue(write.promise);

    render(<AppThemePicker />);
    await clickText("Dark B");
    expect(state().preferredDarkSchemeId).toBe("dark-b");

    await act(async () => {
      write.reject(new Error("nope"));
      await write.promise.catch(() => {});
    });

    expect(state().preferredDarkSchemeId).toBe("dark-a");
    expect(state().preferredLightSchemeId).toBe("light-a");
  });
});

describe("AppThemePicker — theme selection is three separate durable writes", () => {
  const selectDarkB = async () => {
    // Shuffle is the in-component path that calls handleSelect with a concrete id.
    await act(async () => screen.getByText("Random theme").click());
  };

  it("restores the scheme AND the recents list when the scheme write is rejected", async () => {
    const write = deferred();
    client.setColorScheme.mockReturnValue(write.promise);

    render(<AppThemePicker />);
    await selectDarkB();
    const optimisticId = state().selectedSchemeId;
    expect(optimisticId).not.toBe("dark-a");

    await act(async () => {
      write.reject(new Error("nope"));
      await write.promise.catch(() => {});
    });

    expect(state().selectedSchemeId).toBe("dark-a");
    // commitSchemeSelection mutates the MRU as a side effect; the rollback has to
    // put the list back too, or the recents row keeps a theme that never saved.
    expect(state().recentSchemeIds).toEqual(["dark-a"]);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("keeps system matching off when it saved but the scheme that followed did not", async () => {
    act(() => useAppThemeStore.setState({ followSystem: true }));
    client.setFollowSystem.mockResolvedValue(undefined);
    const schemeWrite = deferred();
    client.setColorScheme.mockReturnValue(schemeWrite.promise);

    render(<AppThemePicker />);
    await selectDarkB();

    await act(async () => {
      schemeWrite.reject(new Error("nope"));
      await schemeWrite.promise.catch(() => {});
    });

    // Turning matching off DID reach disk — rolling it back would misrepresent
    // durable state just as badly as leaving the failed theme on screen.
    expect(state().followSystem).toBe(false);
    expect(state().selectedSchemeId).toBe("dark-a");
  });

  it("keeps the saved theme but restores the recents list when only the MRU write fails", async () => {
    client.setColorScheme.mockResolvedValue(undefined);
    const recentsWrite = deferred();
    client.setRecentSchemeIds.mockReturnValue(recentsWrite.promise);

    render(<AppThemePicker />);
    await selectDarkB();
    const savedId = state().selectedSchemeId;

    await act(async () => {
      recentsWrite.reject(new Error("nope"));
      await recentsWrite.promise.catch(() => {});
    });

    // The theme itself is durable, so it stays — and no banner interrupts a
    // change that actually succeeded.
    expect(state().selectedSchemeId).toBe(savedId);
    expect(state().recentSchemeIds).toEqual(["dark-a"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not let a stale scheme rejection roll back a newer scheme that saved", async () => {
    const stale = deferred();
    client.setColorScheme.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(undefined);

    render(<AppThemePicker />);
    await selectDarkB(); // in flight, fails late
    await selectDarkB(); // supersedes it, succeeds
    const newestId = state().selectedSchemeId;

    await act(async () => {
      stale.reject(new Error("late"));
      await stale.promise.catch(() => {});
    });

    expect(state().selectedSchemeId).toBe(newestId);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
