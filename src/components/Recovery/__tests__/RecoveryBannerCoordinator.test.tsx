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

import { RecoveryBannerCoordinator } from "../RecoveryBannerCoordinator";
import { usePanelStore } from "@/store/panelStore";
import { useSafeModeStore } from "@/store/safeModeStore";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";

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
  usePanelStore.setState({ backendStatus: "connected", lastCrashType: null });
  useSafeModeStore.setState({
    safeMode: false,
    dismissed: false,
    crashCount: undefined,
    skippedPanelCount: undefined,
    lastCrashAt: undefined,
  });
  useRestoreConfirmationStore.setState({ visible: false, suspectCount: 0, crashCount: 0 });
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

describe("RecoveryBannerCoordinator", () => {
  it("renders nothing when no recovery state is active", () => {
    const { container } = render(<RecoveryBannerCoordinator />);
    expect(container.firstChild).toBeNull();
  });

  it("renders only the host crash banner when all three states are active", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    useSafeModeStore.setState({ safeMode: true, dismissed: false });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<RecoveryBannerCoordinator />);

    expect(screen.getByText("Terminal service crashed")).toBeTruthy();
    expect(screen.queryByText("Safe mode — panels weren't restored")).toBeNull();
    expect(screen.queryByText(/Session recovered after unexpected exit/)).toBeNull();
  });

  it("renders the host crash banner when backend is disconnected", () => {
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "OUT_OF_MEMORY" });

    render(<RecoveryBannerCoordinator />);

    expect(screen.getByText("Terminal service ran out of memory")).toBeTruthy();
  });

  it("treats recovering backend as host-crash priority", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "recovering" });
    useSafeModeStore.setState({ safeMode: true, dismissed: false });

    render(<RecoveryBannerCoordinator />);

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.getByText("Terminal service restarting")).toBeTruthy();
    expect(screen.queryByText("Safe mode — panels weren't restored")).toBeNull();
  });

  it("renders the safe mode banner when host is connected and safe mode is active", () => {
    useSafeModeStore.setState({ safeMode: true, dismissed: false });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<RecoveryBannerCoordinator />);

    expect(screen.getByText("Safe mode — panels weren't restored")).toBeTruthy();
    expect(screen.queryByText(/Session recovered after unexpected exit/)).toBeNull();
  });

  it("renders the restore confirmation when only restore is active", () => {
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<RecoveryBannerCoordinator />);

    expect(screen.getByText("Session recovered after unexpected exit.")).toBeTruthy();
  });

  it("treats a dismissed safe mode as inactive and promotes restore", () => {
    useSafeModeStore.setState({ safeMode: true, dismissed: true });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<RecoveryBannerCoordinator />);

    expect(screen.getByText("Session recovered after unexpected exit.")).toBeTruthy();
    expect(screen.queryByText("Safe mode — panels weren't restored")).toBeNull();
  });

  it("does not auto-dismiss the restore banner while suppressed by a higher-priority banner", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<RecoveryBannerCoordinator />);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(useRestoreConfirmationStore.getState().visible).toBe(true);
  });

  it("starts the restore auto-dismiss timer fresh after promotion from suppressed", () => {
    vi.useFakeTimers();
    usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
    useRestoreConfirmationStore.setState({ visible: true, suspectCount: 0, crashCount: 1 });

    render(<RecoveryBannerCoordinator />);

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
    render(<RecoveryBannerCoordinator />);
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

    render(<RecoveryBannerCoordinator />);

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

    render(<RecoveryBannerCoordinator />);

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

    render(<RecoveryBannerCoordinator />);

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

    const { container } = render(<RecoveryBannerCoordinator />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Safe mode — panels weren't restored")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.getByText("Terminal service restarting")).toBeTruthy();
    expect(screen.queryByText("Safe mode — panels weren't restored")).toBeNull();
  });
});
