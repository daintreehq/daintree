// @vitest-environment jsdom
import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
      return { ok: true, result: { claude: "ready" } };
    }
    if (actionId === "agentSettings.get") {
      return { ok: true, result: { agents: { claude: { pinned: true } } } };
    }
    if (actionId === "hibernation.getConfig") {
      return { ok: true, result: { enabled: false, inactiveThresholdHours: 24 } };
    }
    return { ok: true, result: undefined };
  });
}

/** A promise whose settlement this test controls, so the in-flight state stays observable. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // An independent handler, so a rejection we settle late doesn't trip an unhandled-rejection
  // warning. The component attaches its own catch to the same promise and still observes it.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

type Channel = "stable" | "nightly";
type GetChannel = () => Promise<Channel>;

function setupElectron(getChannel: GetChannel, lastCheck: number | null = null) {
  const setChannel = vi.fn<(ch: Channel) => Promise<Channel>>((ch) => Promise.resolve(ch));
  const getChannelMock = vi.fn(getChannel);
  Object.assign(window, {
    electron: {
      update: {
        getChannel: getChannelMock,
        setChannel,
        getLastCheck: vi.fn(() => Promise.resolve(lastCheck)),
      },
    },
  });
  return { getChannel: getChannelMock, setChannel };
}

function channelButtons() {
  return {
    stable: screen.queryByRole("button", { name: "stable" }),
    nightly: screen.queryByRole("button", { name: "nightly" }),
  };
}

const NIGHTLY_WARNING = /Nightly builds may contain unstable features/;
/** The banner must name the thing that failed — matched semantically, not by exact prose. */
const BANNER_MESSAGE = /update channel/i;

function props() {
  return {
    appVersion: "1.0.0",
    onNavigateToAgents: vi.fn(),
    activeSubtab: "overview",
    onSubtabChange: vi.fn(),
  };
}

async function renderGeneralTab() {
  const { GeneralTab } = await import("../GeneralTab");
  return render(<GeneralTab {...props()} />);
}

/** Mirrors the real root (src/main.tsx), where StrictMode double-invokes mount effects. */
async function renderGeneralTabStrict() {
  const { GeneralTab } = await import("../GeneralTab");
  return render(
    <StrictMode>
      <GeneralTab {...props()} />
    </StrictMode>
  );
}

describe("GeneralTab — update channel load failure (issue #11119)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDispatchMock();
    useDistributionStore.setState({ isWindowsStore: false });
  });

  afterEach(() => {
    // Unmount before restoring the real store, or the last test's reset re-renders a live
    // component outside act() and kicks off another channel load.
    cleanup();
    useDistributionStore.setState({ isWindowsStore: false });
  });

  it("never fabricates a channel when the load fails", async () => {
    const error = new Error("ipc down");
    const { setChannel } = setupElectron(() => Promise.reject(error));

    await renderGeneralTab();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(BANNER_MESSAGE);

    // The heart of #11119: a failed load must not manufacture a selection. If it fabricated
    // "stable", the buttons would render (enabled, with stable selected) instead of the banner.
    const { stable, nightly } = channelButtons();
    expect(stable).toBeNull();
    expect(nightly).toBeNull();
    expect(screen.queryByText(NIGHTLY_WARNING)).toBeNull();

    // ...and nothing on the load path may ever write the channel back to main.
    expect(setChannel).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), error);
  });

  it("shows the real channel and no banner when the load succeeds", async () => {
    const { setChannel } = setupElectron(() => Promise.resolve("nightly"));

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "nightly" }).hasAttribute("disabled")).toBe(false);
    });
    // The nightly warning is the semantic proof that the REAL channel landed, not a fabricated one.
    expect(screen.getByText(NIGHTLY_WARNING)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(setChannel).not.toHaveBeenCalled();
  });

  it("leaves the channel unknown and un-settable while the load is in flight", async () => {
    const pending = deferred<Channel>();
    const { setChannel } = setupElectron(() => pending.promise);

    await renderGeneralTab();

    const stable = await screen.findByRole("button", { name: "stable" });
    const nightly = screen.getByRole("button", { name: "nightly" });
    expect(stable.hasAttribute("disabled")).toBe(true);
    expect(nightly.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();

    // A disabled button is a real browser gate, but prove the invariant, not the markup.
    fireEvent.click(stable);
    fireEvent.click(nightly);
    expect(setChannel).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve("stable");
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "stable" }).hasAttribute("disabled")).toBe(false);
    });
    expect(setChannel).not.toHaveBeenCalled();
  });

  it("keeps the independently-loaded last-checked line visible when the channel fails", async () => {
    setupElectron(() => Promise.reject(new Error("ipc down")), 1_700_000_000_000);

    await renderGeneralTab();

    await screen.findByRole("alert");
    await waitFor(() => {
      expect(screen.getByText(/Last checked:/)).toBeTruthy();
    });
  });

  it("retry refetches and recovers the real channel", async () => {
    const { getChannel, setChannel } = setupElectron(
      vi
        .fn<GetChannel>()
        .mockRejectedValueOnce(new Error("ipc down"))
        .mockResolvedValueOnce("nightly")
    );

    await renderGeneralTab();

    const retry = await screen.findByRole("button", { name: "Retry" });
    const callsBeforeRetry = getChannel.mock.calls.length;
    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByText(NIGHTLY_WARNING)).toBeTruthy();
    });
    // Both controls come back live, and the recovered value is the real one — not a fallback.
    const { stable, nightly } = channelButtons();
    expect(stable?.hasAttribute("disabled")).toBe(false);
    expect(nightly?.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getChannel.mock.calls.length).toBe(callsBeforeRetry + 1);
    expect(setChannel).not.toHaveBeenCalled();
  });

  it("holds the channel unknown across a retry that also fails", async () => {
    const firstError = new Error("ipc down");
    const secondError = new Error("still down");
    const second = deferred<Channel>();
    const { setChannel } = setupElectron(
      vi
        .fn<GetChannel>()
        .mockRejectedValueOnce(firstError)
        .mockImplementationOnce(() => second.promise)
    );

    await renderGeneralTab();

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    // The retry clears the error and returns to the loading state. This window is where a
    // fabricated "stable" from the FIRST failure would surface as enabled/selected buttons.
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    const { stable, nightly } = channelButtons();
    expect(stable?.hasAttribute("disabled")).toBe(true);
    expect(nightly?.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(NIGHTLY_WARNING)).toBeNull();

    await act(async () => {
      second.reject(secondError);
    });

    // A second failure surfaces the banner again, still retryable, still no channel written.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(BANNER_MESSAGE);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(setChannel).not.toHaveBeenCalled();

    // Each attempt logged its OWN error — a repeat of the first would also reach a bare count of 2.
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), firstError);
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), secondError);
  });

  it("discards an in-flight channel rejection when Windows Store hydration lands", async () => {
    const staleError = new Error("ipc down");
    const pending = deferred<Channel>();
    setupElectron(() => pending.promise);

    await renderGeneralTab();

    // isWindowsStore hydrates asynchronously and can flip false -> true after mount.
    await act(async () => {
      useDistributionStore.getState().setIsWindowsStore(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId("section-Updates")).toBeTruthy();
    });
    expect(screen.queryByTestId("section-Update channel")).toBeNull();

    await act(async () => {
      pending.reject(staleError);
    });

    // The superseded attempt owns no UI: it must not log. (Matched on the error INSTANCE, so
    // rewording the log message can't make this pass vacuously.)
    expect(mockLogError).not.toHaveBeenCalledWith(expect.anything(), staleError);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// The Store branch hides the channel UI, so it cannot prove a stale write was DISCARDED rather
// than merely hidden. StrictMode's mount double-invoke supersedes an attempt while the channel
// UI is still on screen, which makes the cancellation guard observable.
describe("GeneralTab — superseded channel loads under StrictMode (issue #11119)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDispatchMock();
    useDistributionStore.setState({ isWindowsStore: false });
  });

  afterEach(() => {
    cleanup();
    useDistributionStore.setState({ isWindowsStore: false });
  });

  it("ignores a rejection from a superseded mount attempt", async () => {
    const staleError = new Error("stale ipc failure");
    const stale = deferred<Channel>();
    const { getChannel } = setupElectron(
      vi
        .fn<GetChannel>()
        .mockImplementationOnce(() => stale.promise)
        .mockImplementationOnce(() => Promise.resolve("nightly"))
    );

    await renderGeneralTabStrict();

    // Precondition: StrictMode really did double-invoke, so attempt #1 is the superseded one.
    await waitFor(() => {
      expect(getChannel.mock.calls.length).toBe(2);
    });
    await waitFor(() => {
      expect(screen.getByText(NIGHTLY_WARNING)).toBeTruthy();
    });

    await act(async () => {
      stale.reject(staleError);
    });

    // The live channel survives: the dead attempt must not raise a banner over a loaded value.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(NIGHTLY_WARNING)).toBeTruthy();
    expect(mockLogError).not.toHaveBeenCalledWith(expect.anything(), staleError);
  });

  it("ignores a late resolution from a superseded mount attempt", async () => {
    const stale = deferred<Channel>();
    const { getChannel } = setupElectron(
      vi
        .fn<GetChannel>()
        .mockImplementationOnce(() => stale.promise)
        .mockImplementationOnce(() => Promise.resolve("nightly"))
    );

    await renderGeneralTabStrict();

    await waitFor(() => {
      expect(getChannel.mock.calls.length).toBe(2);
    });
    await waitFor(() => {
      expect(screen.getByText(NIGHTLY_WARNING)).toBeTruthy();
    });

    await act(async () => {
      stale.resolve("stable");
    });

    // A slow superseded attempt must not overwrite the live one with an outdated channel.
    expect(screen.getByText(NIGHTLY_WARNING)).toBeTruthy();
  });
});
