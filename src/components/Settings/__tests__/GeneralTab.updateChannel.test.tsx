// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CliAvailability, AgentSettings, HibernationConfig } from "@shared/types";
import { useDistributionStore } from "@/store/distributionStore";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("../SettingsSection", () => ({
  SettingsSection: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <section data-testid={`section-${title}`}>
      <h3>{title}</h3>
      {children}
    </section>
  ),
}));

vi.mock("../SettingsSubtabBar", () => ({
  SettingsSubtabBar: () => null,
}));

vi.mock("@/components/Settings/SettingsSwitchCard", () => ({
  SettingsSwitchCard: () => null,
}));

vi.mock("@/store", () => ({
  usePreferencesStore: (selector: (state: Record<string, boolean>) => unknown) =>
    selector({
      showProjectPulse: true,
      showDeveloperTools: false,
      showGridAgentHighlights: true,
      showDockAgentHighlights: true,
    }),
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    subscribe: vi.fn(() => () => {}),
    loadOverrides: vi.fn(() => Promise.resolve()),
    getBinding: vi.fn(() => null),
    getEffectiveCombo: vi.fn(() => null),
    formatComboForDisplay: vi.fn(() => ""),
  },
}));

vi.mock("@/config/agents", () => ({
  getAgentIds: () => ["claude"],
  getAgentConfig: (id: string) => ({ name: id.charAt(0).toUpperCase() + id.slice(1) }),
}));

const mockLogError = vi.fn<(message: string, error?: unknown) => void>();
vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: (message: string, error?: unknown) => mockLogError(message, error),
}));

const mockDispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (actionId: string, ...rest: unknown[]) => mockDispatch(actionId, ...rest),
  },
}));

function setupDispatchMock() {
  mockDispatch.mockImplementation(async (actionId: string) => {
    if (actionId === "cliAvailability.get") {
      return { ok: true, result: { claude: "ready" } as CliAvailability };
    }
    if (actionId === "agentSettings.get") {
      return {
        ok: true,
        result: { agents: { claude: { pinned: true } } } as unknown as AgentSettings,
      };
    }
    if (actionId === "hibernation.getConfig") {
      return {
        ok: true,
        result: { enabled: false, inactiveThresholdHours: 24 } as HibernationConfig,
      };
    }
    return { ok: true, result: undefined };
  });
}

/** A promise whose settlement this test controls, so we can observe the in-flight state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Keep the rejection from tripping an unhandled-rejection warning before the component attaches.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

type GetChannel = () => Promise<"stable" | "nightly">;

function setupElectron(getChannel: GetChannel, lastCheck: number | null = null) {
  const setChannel = vi.fn<(ch: "stable" | "nightly") => Promise<"stable" | "nightly">>((ch) =>
    Promise.resolve(ch)
  );
  (window as unknown as { electron: unknown }).electron = {
    update: {
      getChannel: vi.fn(getChannel),
      setChannel,
      getLastCheck: vi.fn(() => Promise.resolve(lastCheck)),
    },
  };
  return { setChannel };
}

function electronUpdate() {
  return (
    window as unknown as {
      electron: { update: { getChannel: { mock: { calls: unknown[] } } } };
    }
  ).electron.update;
}

async function renderGeneralTab() {
  const { GeneralTab } = await import("../GeneralTab");
  return render(
    <GeneralTab
      appVersion="1.0.0"
      onNavigateToAgents={vi.fn()}
      activeSubtab="overview"
      onSubtabChange={vi.fn()}
    />
  );
}

const BANNER_TEXT = "Couldn't load the update channel";

describe("GeneralTab — update channel load failure (issue #11119)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDispatchMock();
    useDistributionStore.setState({ isWindowsStore: false });
  });

  afterEach(() => {
    useDistributionStore.setState({ isWindowsStore: false });
  });

  it("never selects a channel when the load fails", async () => {
    setupElectron(() => Promise.reject(new Error("ipc down")));

    await renderGeneralTab();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(BANNER_TEXT);

    // The whole point of #11119: a failed load must not manufacture a "stable" selection.
    expect(screen.queryByRole("button", { name: "stable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "nightly" })).toBeNull();
    expect(screen.queryByText(/Nightly builds may contain unstable features/)).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith("Failed to get update channel", expect.anything());
  });

  it("shows the real channel and no banner when the load succeeds", async () => {
    setupElectron(() => Promise.resolve("nightly"));

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "nightly" }).hasAttribute("disabled")).toBe(false);
    });
    expect(screen.getByText(/Nightly builds may contain unstable features/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the channel buttons disabled while the load is still in flight", async () => {
    const pending = deferred<"stable" | "nightly">();
    setupElectron(() => pending.promise);

    await renderGeneralTab();

    const stable = await screen.findByRole("button", { name: "stable" });
    expect(stable.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      pending.resolve("stable");
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "stable" }).hasAttribute("disabled")).toBe(false);
    });
  });

  it("keeps the independently-loaded last-checked line visible when the channel fails", async () => {
    setupElectron(() => Promise.reject(new Error("ipc down")), 1_700_000_000_000);

    await renderGeneralTab();

    await screen.findByRole("alert");
    await waitFor(() => {
      expect(screen.getByText(/Last checked:/)).toBeTruthy();
    });
  });

  it("retry refetches and shows the recovered channel", async () => {
    const getChannel = vi
      .fn<GetChannel>()
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValueOnce("nightly");
    setupElectron(getChannel);

    await renderGeneralTab();

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "nightly" }).hasAttribute("disabled")).toBe(false);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getChannel).toHaveBeenCalledTimes(2);
  });

  it("shows the banner again when the retry also fails", async () => {
    const second = deferred<"stable" | "nightly">();
    const getChannel = vi
      .fn<GetChannel>()
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockImplementationOnce(() => second.promise);
    setupElectron(getChannel);

    await renderGeneralTab();

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    // The retry clears the error and returns to the loading (disabled) state...
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });

    await act(async () => {
      second.reject(new Error("still down"));
    });

    // ...and a second failure must surface the banner again, still retryable.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(BANNER_TEXT);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(getChannel).toHaveBeenCalledTimes(2);
    expect(mockLogError).toHaveBeenCalledTimes(2);
  });

  it("discards an in-flight channel rejection when Windows Store hydration lands", async () => {
    const pending = deferred<"stable" | "nightly">();
    setupElectron(() => pending.promise);

    await renderGeneralTab();
    expect(electronUpdate().getChannel.mock.calls).toHaveLength(1);

    // isWindowsStore hydrates asynchronously and can flip false -> true after mount.
    await act(async () => {
      useDistributionStore.getState().setIsWindowsStore(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId("section-Updates")).toBeTruthy();
    });
    expect(screen.queryByTestId("section-Update channel")).toBeNull();

    await act(async () => {
      pending.reject(new Error("ipc down"));
    });

    // The superseded attempt owns no UI: it must neither raise the banner nor log.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "stable" })).toBeNull();
    expect(mockLogError).not.toHaveBeenCalledWith(
      "Failed to get update channel",
      expect.anything()
    );
  });
});
