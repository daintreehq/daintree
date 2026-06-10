// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

import { useShouldSuppressLocalError } from "../useShouldSuppressLocalError";
import { LOCAL_ERROR_SETTLE_MS } from "@/lib/animationUtils";
import { usePanelStore } from "@/store/panelStore";
import { useSafeModeStore } from "@/store/safeModeStore";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";

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
}

beforeEach(() => {
  resetStores();
  delete document.body.dataset.performanceMode;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
  delete document.body.dataset.performanceMode;
});

describe("useShouldSuppressLocalError", () => {
  describe("backend-dependent category", () => {
    it("is not suppressed when no global cause is active", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));
      expect(result.current).toBe(false);
    });

    it("suppresses immediately when a global cause activates", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));
      expect(result.current).toBe(false);

      act(() => {
        usePanelStore.setState({ backendStatus: "recovering" });
      });
      expect(result.current).toBe(true);
    });

    it("returns true on the first render after rawSuppressed flips true (sync sticky-on)", () => {
      // Captures the value at every render. Sticky-on must be synchronous
      // with render — if the hook depended on `useEffect` to flip state,
      // the first re-render after the store update would still read `false`
      // (effect runs after paint), and a local banner would briefly co-paint
      // with the host-crash banner.
      const renders: boolean[] = [];
      renderHook(() => {
        const v = useShouldSuppressLocalError("backend-dependent");
        renders.push(v);
        return v;
      });
      expect(renders).toEqual([false]);

      act(() => {
        usePanelStore.setState({ backendStatus: "recovering" });
      });
      // The Zustand selector triggers a synchronous re-render; that render
      // must already return true (no effect cycle has run yet).
      expect(renders[1]).toBe(true);
    });

    it("stays suppressed for the full settle window after the cause clears", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));

      act(() => {
        usePanelStore.setState({ backendStatus: "recovering" });
      });
      expect(result.current).toBe(true);

      act(() => {
        usePanelStore.setState({ backendStatus: "connected" });
      });
      // Still suppressed — the settle timer is pending.
      expect(result.current).toBe(true);

      act(() => {
        vi.advanceTimersByTime(LOCAL_ERROR_SETTLE_MS - 1);
      });
      expect(result.current).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current).toBe(false);
    });

    it("cancels pending un-suppress if the cause re-activates mid-settle", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));

      act(() => {
        usePanelStore.setState({ backendStatus: "recovering" });
      });
      act(() => {
        usePanelStore.setState({ backendStatus: "connected" });
      });
      act(() => {
        vi.advanceTimersByTime(Math.floor(LOCAL_ERROR_SETTLE_MS / 2));
      });
      expect(result.current).toBe(true);

      // Cause re-activates before the settle timer fires.
      act(() => {
        usePanelStore.setState({ backendStatus: "recovering" });
      });
      // Advance past the original timer's deadline; we should still be
      // suppressed because the timer was cancelled.
      act(() => {
        vi.advanceTimersByTime(LOCAL_ERROR_SETTLE_MS * 2);
      });
      expect(result.current).toBe(true);
    });

    it("starts suppressed when the cause is already active at mount", () => {
      usePanelStore.setState({ backendStatus: "recovering" });
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));
      expect(result.current).toBe(true);
    });
  });

  describe("parse-error category", () => {
    it("is never suppressed, even when a global cause is active", () => {
      usePanelStore.setState({ backendStatus: "recovering" });
      const { result } = renderHook(() => useShouldSuppressLocalError("parse-error"));
      expect(result.current).toBe(false);
    });

    it("stays unsuppressed across a backend disconnect/recover cycle", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("parse-error"));
      expect(result.current).toBe(false);

      act(() => {
        usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
      });
      expect(result.current).toBe(false);

      act(() => {
        usePanelStore.setState({ backendStatus: "recovering" });
      });
      expect(result.current).toBe(false);

      act(() => {
        usePanelStore.setState({ backendStatus: "connected" });
        vi.advanceTimersByTime(LOCAL_ERROR_SETTLE_MS * 2);
      });
      expect(result.current).toBe(false);
    });
  });

  describe("permission-error category", () => {
    it("is never suppressed by a global cause", () => {
      usePanelStore.setState({ backendStatus: "recovering" });
      const { result } = renderHook(() => useShouldSuppressLocalError("permission-error"));
      expect(result.current).toBe(false);
    });
  });

  describe("performance mode bypass", () => {
    it("unsuppresses synchronously when performance mode is active", () => {
      document.body.dataset.performanceMode = "true";
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));

      act(() => {
        usePanelStore.setState({ backendStatus: "recovering" });
      });
      expect(result.current).toBe(true);

      // No timer should be required; advancing 0 ticks suffices.
      act(() => {
        usePanelStore.setState({ backendStatus: "connected" });
      });
      expect(result.current).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("clears the settle timer on unmount (no post-unmount state updates)", () => {
      const { result, unmount } = renderHook(() =>
        useShouldSuppressLocalError("backend-dependent")
      );

      act(() => {
        usePanelStore.setState({ backendStatus: "recovering" });
      });
      act(() => {
        usePanelStore.setState({ backendStatus: "connected" });
      });
      expect(result.current).toBe(true);

      unmount();

      // Advancing past the timer must not throw or warn after unmount.
      expect(() => {
        vi.advanceTimersByTime(LOCAL_ERROR_SETTLE_MS * 2);
      }).not.toThrow();
    });
  });

  describe("non-host-crash causes", () => {
    it("still suppresses backend-dependent banners when watchdog is disabled", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));
      expect(result.current).toBe(false);

      act(() => {
        usePanelStore.setState({ backendStatus: "connected", watchdogStatus: "disabled" });
      });
      expect(result.current).toBe(true);
    });

    it("still suppresses backend-dependent banners when safe mode is active", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));
      expect(result.current).toBe(false);

      act(() => {
        useSafeModeStore.setState({ safeMode: true, dismissed: false });
      });
      expect(result.current).toBe(true);
    });

    it("still suppresses backend-dependent banners when the restore-confirmation banner is visible", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));
      expect(result.current).toBe(false);

      act(() => {
        useRestoreConfirmationStore.setState({ visible: true, suspectCount: 1, crashCount: 1 });
      });
      expect(result.current).toBe(true);
    });
  });

  // The two advisory slots (forge-token, cloud-sync) win a global banner slot
  // while the backend is still connected, so pane-local spawn/reconnect/restart
  // banners remain independently actionable and must NOT be suppressed (#10038).
  // These tests pin the suppression domain to recovery slots so it can't
  // silently widen if a future advisory slot is added.
  describe("advisory causes do not suppress", () => {
    it("does not suppress backend-dependent banners when a forge token is unhealthy", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));
      expect(result.current).toBe(false);

      act(() => {
        useForgeProviderHealthStore.getState().setTokenUnhealthy("daintree.github.github", true);
      });
      expect(result.current).toBe(false);
    });

    it("does not suppress backend-dependent banners when a cloud-sync warning is active", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));
      expect(result.current).toBe(false);

      act(() => {
        useCloudSyncBannerStore.setState({ service: "OneDrive", projectId: "p1" });
      });
      expect(result.current).toBe(false);
    });

    it("does not suppress when an advisory cause is already active at mount", () => {
      useForgeProviderHealthStore.getState().setTokenUnhealthy("daintree.github.github", true);
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));
      expect(result.current).toBe(false);
    });

    it("un-suppresses immediately when the backend recovers into an advisory-only cause", () => {
      // Regression for #10038: the recovery→advisory transition must NOT keep
      // the settle-window tail alive. The tail only absorbs recovering↔connected
      // flicker (true no-cause); an advisory cause means the backend is already
      // connected, so the pane error is actionable now — no timer advance needed.
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));

      act(() => {
        usePanelStore.setState({ backendStatus: "recovering" });
        useForgeProviderHealthStore.getState().setTokenUnhealthy("daintree.github.github", true);
      });
      expect(result.current).toBe(true); // host-crash (recovery) wins; suppressed

      act(() => {
        usePanelStore.setState({ backendStatus: "connected" });
      });
      // Slot is now forge-token (advisory). Suppression drops without advancing
      // the settle timer.
      expect(result.current).toBe(false);
    });

    it("escalates to suppression immediately when a recovery cause supersedes an advisory one", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));

      act(() => {
        useForgeProviderHealthStore.getState().setTokenUnhealthy("daintree.github.github", true);
      });
      expect(result.current).toBe(false); // advisory, not suppressed

      act(() => {
        usePanelStore.setState({ watchdogStatus: "disabled" });
      });
      // watchdog-disabled (recovery) outranks forge-token; sticky-on is sync.
      expect(result.current).toBe(true);
    });

    it("suppresses when a recovery and an advisory cause are active simultaneously", () => {
      const { result } = renderHook(() => useShouldSuppressLocalError("backend-dependent"));

      act(() => {
        useRestoreConfirmationStore.setState({ visible: true, suspectCount: 1, crashCount: 1 });
        useForgeProviderHealthStore.getState().setTokenUnhealthy("daintree.github.github", true);
      });
      // restore-confirmation outranks forge-token in priority and is a recovery
      // slot, so suppression holds — precedence can't flip to advisory-first.
      expect(result.current).toBe(true);
    });
  });
});
