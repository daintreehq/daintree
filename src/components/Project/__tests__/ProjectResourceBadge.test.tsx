// @vitest-environment jsdom
/**
 * ProjectResourceBadge — visibility-aware polling.
 *
 * Issue #6212: the 10s badge poll must pause while the project view is hidden
 * so we don't burn renderer CPU on inactive projects. The 4s popover sub-poll
 * is already gated on `open` and is intentionally untested here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { act } from "react";

vi.mock("@/clients", () => ({
  projectClient: {
    getAll: vi.fn(),
    getBulkStats: vi.fn(),
  },
  systemClient: {
    getAppMetrics: vi.fn(),
    getProcessMetrics: vi.fn(),
    getHeapStats: vi.fn(),
    getDiagnosticsInfo: vi.fn(),
  },
}));

vi.mock("@/store/projectStatsStore", () => ({
  useProjectStatsStore: {
    getState: () => ({ stats: {} }),
  },
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
}));

import { projectClient, systemClient } from "@/clients";
import { ProjectResourceBadge } from "../ProjectResourceBadge";

const mockGetAll = vi.mocked(projectClient.getAll);
const mockGetAppMetrics = vi.mocked(systemClient.getAppMetrics);

describe("ProjectResourceBadge — visibility-aware polling", () => {
  let originalHidden: boolean;
  let visibilityState: DocumentVisibilityState;
  let visibilityListeners: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityListeners = [];
    originalHidden = document.hidden;
    visibilityState = "visible";

    Object.defineProperty(document, "hidden", {
      get: () => visibilityState === "hidden",
      configurable: true,
    });
    Object.defineProperty(document, "visibilityState", {
      get: () => visibilityState,
      configurable: true,
    });

    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, handler, options) => {
      if (type === "visibilitychange") {
        visibilityListeners.push(handler as () => void);
      }
      return origAdd(type, handler, options);
    });
    vi.spyOn(document, "removeEventListener").mockImplementation((type, handler, options) => {
      if (type === "visibilitychange") {
        visibilityListeners = visibilityListeners.filter((l) => l !== handler);
      }
      return origRemove(type, handler, options);
    });

    mockGetAll.mockReset();
    mockGetAll.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 100 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, "hidden", {
      value: originalHidden,
      configurable: true,
      writable: true,
    });
  });

  function fireVisibilityChange(state: DocumentVisibilityState) {
    visibilityState = state;
    visibilityListeners.forEach((l) => l());
  }

  it("does not call getAll when mounted while hidden", async () => {
    visibilityState = "hidden";

    render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(mockGetAll).not.toHaveBeenCalled();
    expect(mockGetAppMetrics).not.toHaveBeenCalled();
  });

  it("stops polling when document becomes hidden after mount", async () => {
    render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsBeforeHide = mockGetAll.mock.calls.length;
    expect(callsBeforeHide).toBeGreaterThanOrEqual(1);

    await act(async () => {
      fireVisibilityChange("hidden");
    });

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    // No additional polls while hidden.
    expect(mockGetAll.mock.calls.length).toBe(callsBeforeHide);
  });

  it("immediately fetches and resumes polling on visibility restore", async () => {
    visibilityState = "hidden";

    render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(mockGetAll).not.toHaveBeenCalled();

    await act(async () => {
      fireVisibilityChange("visible");
      await Promise.resolve();
      await Promise.resolve();
    });
    // Immediate fetch on restore.
    expect(mockGetAll.mock.calls.length).toBeGreaterThanOrEqual(1);
    const callsAfterRestore = mockGetAll.mock.calls.length;

    // Polling resumes.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(mockGetAll.mock.calls.length).toBeGreaterThan(callsAfterRestore);
  });

  it("removes visibility listener on unmount", () => {
    const { unmount } = render(<ProjectResourceBadge />);
    expect(visibilityListeners.length).toBeGreaterThan(0);

    unmount();
    expect(visibilityListeners.length).toBe(0);
  });
});
