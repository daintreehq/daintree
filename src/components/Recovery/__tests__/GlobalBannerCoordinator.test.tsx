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

/**
 * Issue #11766. The Windows caption strip is painted by the OS above every
 * WebContentsView, so main has to be told which banner severity currently sits
 * under it — otherwise the strip keeps the canvas colour and reads as a pale
 * rectangle punched into a tinted banner.
 */
describe("GlobalBannerCoordinator caption-strip reporting", () => {
  let setBannerSeverity: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setBannerSeverity = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { electron?: unknown }).electron = {
      windowChrome: { setBannerSeverity },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("reports the severity of the banner actually on screen", () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });

    render(<GlobalBannerCoordinator />);

    expect(setBannerSeverity).toHaveBeenCalledWith({ severity: "warning" });
  });

  it("reports the winning banner's severity, not the suppressed one's", () => {
    // Host crash (error) outranks cloud sync (warning); the strip must follow
    // whichever banner actually renders.
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });

    render(<GlobalBannerCoordinator />);

    expect(setBannerSeverity).toHaveBeenCalledWith({ severity: "error" });
    expect(setBannerSeverity).not.toHaveBeenCalledWith({ severity: "warning" });
  });

  it("asserts an empty band rather than staying silent", () => {
    // A project view that becomes visible with no banner has to clear whatever
    // tint the previously presenting view left on the caption strip.
    render(<GlobalBannerCoordinator />);
    expect(setBannerSeverity).toHaveBeenCalledWith({ severity: null });
  });

  it("goes straight from one severity to the next when banners swap", () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });
    render(<GlobalBannerCoordinator />);
    setBannerSeverity.mockClear();

    // Host crash outranks cloud sync, so the mounted banner is replaced.
    act(() => {
      usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    });

    // Bouncing through null would repaint the native frame back to canvas
    // mid-swap — a visible flash between two tinted banners.
    expect(setBannerSeverity).toHaveBeenCalledWith({ severity: "error" });
    expect(setBannerSeverity).not.toHaveBeenCalledWith({ severity: null });
  });

  it("does not tint for a slot whose banner is still gated and renders nothing", () => {
    // HostCrashBanner claims the slot immediately but renders nothing for the
    // first 400ms (Doherty gate). Tinting off the slot rather than the mounted
    // banner would colour the strip for a banner that isn't on screen.
    vi.useFakeTimers();
    try {
      usePanelStore.setState({ backendStatus: "recovering", lastCrashType: null });
      render(<GlobalBannerCoordinator />);

      expect(screen.queryByText("Terminal service crashed")).toBeNull();
      expect(setBannerSeverity).not.toHaveBeenCalledWith({ severity: "error" });
      expect(setBannerSeverity).not.toHaveBeenCalledWith({ severity: "warning" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-asserts its severity when a cached view becomes visible again", () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });
    render(<GlobalBannerCoordinator />);
    setBannerSeverity.mockClear();

    // Switching back to a cached project view produces no re-render, so
    // without this the strip would keep the other view's tint.
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(setBannerSeverity).toHaveBeenCalledWith({ severity: "warning" });
  });

  it("does not re-assert while hidden", () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });
    render(<GlobalBannerCoordinator />);
    setBannerSeverity.mockClear();

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(setBannerSeverity).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
    }
  });

  it("clears the report when the banner goes away", () => {
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });
    const { unmount } = render(<GlobalBannerCoordinator />);
    setBannerSeverity.mockClear();

    unmount();

    expect(setBannerSeverity).toHaveBeenCalledWith({ severity: null });
  });

  it("survives a host without the windowChrome bridge", () => {
    delete (window as unknown as { electron?: unknown }).electron;
    useCloudSyncBannerStore.setState({ service: "Dropbox", projectId: "p1" });

    expect(() => render(<GlobalBannerCoordinator />)).not.toThrow();
  });
});
