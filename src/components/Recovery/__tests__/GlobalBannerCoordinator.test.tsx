// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn().mockResolvedValue({ ok: true, result: undefined }),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { GlobalBannerCoordinator } from "../GlobalBannerCoordinator";
import { usePanelStore } from "@/store/panelStore";
import { useSafeModeStore } from "@/store/safeModeStore";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useRosettaBannerStore } from "@/store/rosettaBannerStore";
import { getCloudSyncWarningCopy } from "@/utils/cloudSyncWarningCopy";

const PROVIDER_ID = "daintree.github.github";

// These cases assert which banner wins the slot, not its wording — resolve the
// title from the copy module so rewording can't churn the routing tests.
const cloudSyncTitle = getCloudSyncWarningCopy("Dropbox").title;

function setForgeTokenUnhealthy(value: boolean) {
  const store = useForgeProviderHealthStore.getState();
  store.setTokenUnhealthy(PROVIDER_ID, value);
  store.setProviderMeta(PROVIDER_ID, { providerName: "GitHub", pluginId: "daintree.github" });
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function resetStores() {
  usePanelStore.setState({
    backendStatus: "connected",
    lastCrashType: null,
    watchdogStatus: "active",
    watchdogDisabledInfo: null,
  });
  useSafeModeStore.setState({
    safeMode: false,
    dismissed: false,
    crashCount: undefined,
    skippedPanelCount: undefined,
    lastCrashAt: undefined,
  });
  useRestoreConfirmationStore.setState({ visible: false, suspectCount: 0, crashCount: 0 });
  useForgeProviderHealthStore.setState({ providers: {} });
  useCloudSyncBannerStore.setState({ service: null, projectId: null });
  useRosettaBannerStore.setState({ visible: false });
}

beforeEach(() => {
  resetStores();
  cleanup();
});

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});

describe("GlobalBannerCoordinator", () => {
  it("renders nothing when no recovery state is active", () => {
    const { container } = render(<GlobalBannerCoordinator />);
    expect(container.firstChild).toBeNull();
  });

  it("renders only the host crash banner when all three states are active", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    useSafeModeStore.setState({ safeMode: true, dismissed: false });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Terminal service crashed")).toBeTruthy();
    expect(screen.queryByText("Safe mode — panels weren't restored")).toBeNull();
    expect(screen.queryByText(/Session recovered after unexpected exit/)).toBeNull();
  });

  it("renders the host crash banner when backend is disconnected", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "OUT_OF_MEMORY" });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Terminal service ran out of memory")).toBeTruthy();
  });

  it("treats recovering backend as host-crash priority", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "recovering" });
    useSafeModeStore.setState({ safeMode: true, dismissed: false });

    render(<GlobalBannerCoordinator />);

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.getByText("Terminal service restarting")).toBeTruthy();
    expect(screen.queryByText("Safe mode — panels weren't restored")).toBeNull();
  });

  it("renders the safe mode banner when host is connected and safe mode is active", () => {
    useSafeModeStore.setState({ safeMode: true, dismissed: false });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Safe mode — panels weren't restored")).toBeTruthy();
    expect(screen.queryByText(/Session recovered after unexpected exit/)).toBeNull();
  });

  it("renders the restore confirmation when only restore is active", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Session recovered after unexpected exit.")).toBeTruthy();
  });

  it("treats a dismissed safe mode as inactive and promotes restore", () => {
    useSafeModeStore.setState({ safeMode: true, dismissed: true });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Session recovered after unexpected exit.")).toBeTruthy();
    expect(screen.queryByText("Safe mode — panels weren't restored")).toBeNull();
  });

  it("does not auto-dismiss the restore banner while suppressed by a higher-priority banner", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<GlobalBannerCoordinator />);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(useRestoreConfirmationStore.getState().visible).toBe(true);
  });

  it("starts the restore auto-dismiss timer fresh after promotion from suppressed", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<GlobalBannerCoordinator />);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(useRestoreConfirmationStore.getState().visible).toBe(true);

    act(() => {
      usePanelStore.setState({ backendStatus: "connected", lastCrashType: null });
    });

    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(useRestoreConfirmationStore.getState().visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useRestoreConfirmationStore.getState().visible).toBe(false);
  });

  it("switches from restore to safe mode reactively via store subscription", async () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });
    render(<GlobalBannerCoordinator />);
    expect(screen.getByText("Session recovered after unexpected exit.")).toBeTruthy();

    act(() => {
      useSafeModeStore.setState({ safeMode: true, dismissed: false });
    });

    expect(await screen.findByText("Safe mode — panels weren't restored")).toBeTruthy();
    expect(screen.queryByText(/Session recovered after unexpected exit/)).toBeNull();
  });

  it("does not auto-dismiss the restore banner while suppressed by safe mode", () => {
    vi.useFakeTimers();
    useSafeModeStore.setState({ safeMode: true, dismissed: false });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<GlobalBannerCoordinator />);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(useRestoreConfirmationStore.getState().visible).toBe(true);
  });

  it("drains the stack: host-crash -> safe-mode -> restore with a fresh timer each step", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    useSafeModeStore.setState({ safeMode: true, dismissed: false });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Terminal service crashed")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(useRestoreConfirmationStore.getState().visible).toBe(true);

    act(() => {
      usePanelStore.setState({ backendStatus: "connected", lastCrashType: null });
    });
    expect(screen.getByText("Safe mode — panels weren't restored")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(useRestoreConfirmationStore.getState().visible).toBe(true);

    act(() => {
      useSafeModeStore.setState({ dismissed: true });
    });
    expect(screen.getByText("Session recovered after unexpected exit.")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(useRestoreConfirmationStore.getState().visible).toBe(false);
  });

  it("does not auto-dismiss a suspect-count restore after promotion", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 2, crashCount: 1 });

    render(<GlobalBannerCoordinator />);

    act(() => {
      usePanelStore.setState({ backendStatus: "connected", lastCrashType: null });
    });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(useRestoreConfirmationStore.getState().visible).toBe(true);
  });

  it("documents Doherty-gated recovering behavior: nothing shown for <400ms, then host-crash recovering banner", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "recovering" });
    useSafeModeStore.setState({ safeMode: true, dismissed: false });

    const { container } = render(<GlobalBannerCoordinator />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Safe mode — panels weren't restored")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.getByText("Terminal service restarting")).toBeTruthy();
    expect(screen.queryByText("Safe mode — panels weren't restored")).toBeNull();
  });

  it("suppresses forge-token and cloud-sync while the watchdog is disabled", () => {
    usePanelStore.setState({ watchdogStatus: "disabled" });
    setForgeTokenUnhealthy(true);
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Crash watchdog disabled")).toBeTruthy();
    expect(screen.queryByText("GitHub token expired")).toBeNull();
    expect(screen.queryByText(cloudSyncTitle)).toBeNull();
  });

  it("renders the GitHub token banner when only the token is unhealthy", () => {
    setForgeTokenUnhealthy(true);

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("GitHub token expired")).toBeTruthy();
  });

  it("renders the cloud sync banner when only a synced folder is detected", () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText(cloudSyncTitle)).toBeTruthy();
  });

  it("prefers the GitHub token banner over cloud sync when both are active", () => {
    setForgeTokenUnhealthy(true);
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("GitHub token expired")).toBeTruthy();
    expect(screen.queryByText(cloudSyncTitle)).toBeNull();
  });

  it("suppresses forge-token and cloud-sync while restore is active", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });
    setForgeTokenUnhealthy(true);
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Session recovered after unexpected exit.")).toBeTruthy();
    expect(screen.queryByText("GitHub token expired")).toBeNull();
    expect(screen.queryByText(cloudSyncTitle)).toBeNull();
  });

  it("suppresses every lower-priority banner when the host has crashed", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    setForgeTokenUnhealthy(true);
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Terminal service crashed")).toBeTruthy();
    expect(screen.queryByText("GitHub token expired")).toBeNull();
    expect(screen.queryByText(cloudSyncTitle)).toBeNull();
  });

  it("renders the Rosetta banner when only the translation warning is active", () => {
    useRosettaBannerStore.setState({ visible: true });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Running under Rosetta")).toBeTruthy();
  });

  it("suppresses the Rosetta warning while the host has crashed", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    useRosettaBannerStore.setState({ visible: true });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText("Terminal service crashed")).toBeTruthy();
    expect(screen.queryByText("Running under Rosetta")).toBeNull();
  });

  it("prefers cloud sync over the Rosetta warning when both are active", () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });
    useRosettaBannerStore.setState({ visible: true });

    render(<GlobalBannerCoordinator />);

    expect(screen.getByText(cloudSyncTitle)).toBeTruthy();
    expect(screen.queryByText("Running under Rosetta")).toBeNull();
  });
});
