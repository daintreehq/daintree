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
    getHardwareInfo: vi.fn(),
    getProcessMetrics: vi.fn(),
    getHeapStats: vi.fn(),
    getDiagnosticsInfo: vi.fn(),
  },
}));

const statsStoreState: { stats: Record<string, { processCount: number }> } = { stats: {} };
vi.mock("@/store/projectStatsStore", () => ({
  useProjectStatsStore: {
    getState: () => statsStoreState,
  },
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
}));

import { projectClient, systemClient } from "@/clients";
import type { Project } from "@shared/types";
import { ProjectResourceBadge } from "../ProjectResourceBadge";

const mockGetAll = vi.mocked(projectClient.getAll);
const mockGetAppMetrics = vi.mocked(systemClient.getAppMetrics);
const mockGetHardwareInfo = vi.mocked(systemClient.getHardwareInfo);

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "Test Project",
    path: "/tmp/test",
    emoji: "🚀",
    color: "blue",
    status: "active",
    lastOpened: 0,
    ...overrides,
  };
}

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
    mockGetHardwareInfo.mockReset();
    mockGetHardwareInfo.mockResolvedValue({
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
      logicalCpuCount: 8,
    });
    statsStoreState.stats = {};
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

  it("probes hardware info once at mount to scale thresholds to the machine", async () => {
    render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockGetHardwareInfo).toHaveBeenCalledTimes(1);
  });

  it("does not crash polling when hardware info probe rejects", async () => {
    mockGetHardwareInfo.mockRejectedValue(new Error("no hw"));

    render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Badge still polls stats using the fallback thresholds.
    expect(mockGetAll.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the running-project count and memory once a project is active", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1 } };
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 290 });

    const { container } = render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("1 project active");
    expect(container.textContent).toContain("290MB");
  });

  it("suppresses the value (stays hidden) when metrics are unavailable", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1 } };
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 0, unavailable: true });

    const { container } = render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // No misleading "0MB"; the badge withholds the reading entirely.
    expect(container.textContent ?? "").not.toContain("0MB");
    expect(container.textContent ?? "").not.toContain("project active");
  });

  it("removes visibility listener on unmount", () => {
    const { unmount } = render(<ProjectResourceBadge />);
    expect(visibilityListeners.length).toBeGreaterThan(0);

    unmount();
    expect(visibilityListeners.length).toBe(0);
  });
});
