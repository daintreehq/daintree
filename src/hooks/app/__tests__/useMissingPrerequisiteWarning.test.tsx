// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import type { PrerequisiteCheckResult, SystemHealthCheckResult } from "@shared/types";

const healthCheckMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  systemClient: { healthCheck: healthCheckMock },
}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { useMissingPrerequisiteWarning } from "../useMissingPrerequisiteWarning";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";

function result(overrides: Partial<PrerequisiteCheckResult> = {}): PrerequisiteCheckResult {
  return {
    tool: "git",
    label: "Git",
    available: true,
    version: "2.43.0",
    severity: "fatal",
    meetsMinVersion: true,
    ...overrides,
  };
}

function health(prerequisites: PrerequisiteCheckResult[]): SystemHealthCheckResult {
  return {
    prerequisites,
    allRequired: prerequisites.every((p) => p.available && p.meetsMinVersion),
  };
}

const MISSING_GIT = result({ available: false, unavailableReason: "not-found", version: null });

/** Fires the window focus event and flushes the hook's deferred frame read. */
async function focusWindow() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useMissingPrerequisiteStore.setState({
    missing: [],
    dismissed: false,
    inlineSurfaceCount: 0,
    install: null,
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useMissingPrerequisiteWarning", () => {
  it("does not probe until enabled", () => {
    renderHook(() => useMissingPrerequisiteWarning(false));

    expect(healthCheckMock).not.toHaveBeenCalled();
  });

  it("asks only for the fatal subset, uncached on first read", async () => {
    healthCheckMock.mockResolvedValue(health([result()]));

    renderHook(() => useMissingPrerequisiteWarning(true));

    await waitFor(() => expect(healthCheckMock).toHaveBeenCalled());
    expect(healthCheckMock).toHaveBeenCalledWith({ fatalOnly: true, force: false });
  });

  it("stores prerequisites that are unavailable", async () => {
    healthCheckMock.mockResolvedValue(health([MISSING_GIT, result({ tool: "node" })]));

    renderHook(() => useMissingPrerequisiteWarning(true));

    await waitFor(() =>
      expect(useMissingPrerequisiteStore.getState().missing.map((m) => m.tool)).toEqual(["git"])
    );
  });

  it("stores a tool that exists but is below its minimum version", async () => {
    healthCheckMock.mockResolvedValue(
      health([result({ tool: "node", label: "Node.js", meetsMinVersion: false })])
    );

    renderHook(() => useMissingPrerequisiteWarning(true));

    await waitFor(() =>
      expect(useMissingPrerequisiteStore.getState().missing.map((m) => m.tool)).toEqual(["node"])
    );
  });

  it("stores nothing when everything is healthy", async () => {
    healthCheckMock.mockResolvedValue(health([result()]));

    renderHook(() => useMissingPrerequisiteWarning(true));

    await waitFor(() => expect(healthCheckMock).toHaveBeenCalled());
    expect(useMissingPrerequisiteStore.getState().missing).toEqual([]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("routes one low-priority inbox entry naming the missing tools", async () => {
    healthCheckMock.mockResolvedValue(health([MISSING_GIT]));

    renderHook(() => useMissingPrerequisiteWarning(true));

    await waitFor(() => expect(notifyMock).toHaveBeenCalled());
    const payload = notifyMock.mock.calls[0]?.[0];
    expect(payload.priority).toBe("low");
    expect(payload.supersedeKey).toBeTruthy();
    expect(payload.message).toContain("Git");
  });

  it("does not re-notify on a later re-check", async () => {
    healthCheckMock.mockResolvedValue(health([MISSING_GIT]));

    renderHook(() => useMissingPrerequisiteWarning(true));
    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));

    await focusWindow();

    await waitFor(() => expect(healthCheckMock).toHaveBeenCalledTimes(2));
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("forces a re-probe when the window regains focus", async () => {
    healthCheckMock.mockResolvedValue(health([MISSING_GIT]));

    renderHook(() => useMissingPrerequisiteWarning(true));
    await waitFor(() => expect(healthCheckMock).toHaveBeenCalledTimes(1));

    await focusWindow();

    await waitFor(() => expect(healthCheckMock).toHaveBeenCalledTimes(2));
    expect(healthCheckMock).toHaveBeenLastCalledWith({ fatalOnly: true, force: true });
  });

  it("clears the banner when a focus re-check finds the tool installed", async () => {
    healthCheckMock.mockResolvedValueOnce(health([MISSING_GIT]));

    renderHook(() => useMissingPrerequisiteWarning(true));
    await waitFor(() => expect(useMissingPrerequisiteStore.getState().missing).toHaveLength(1));

    healthCheckMock.mockResolvedValue(health([result()]));
    await focusWindow();

    await waitFor(() => expect(useMissingPrerequisiteStore.getState().missing).toHaveLength(0));
  });

  it("ignores a focus event that arrives while the window is not focused", async () => {
    healthCheckMock.mockResolvedValue(health([result()]));

    renderHook(() => useMissingPrerequisiteWarning(true));
    await waitFor(() => expect(healthCheckMock).toHaveBeenCalledTimes(1));

    vi.mocked(document.hasFocus).mockReturnValue(false);
    await focusWindow();

    expect(healthCheckMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the last known state alone when a probe fails", async () => {
    healthCheckMock.mockResolvedValueOnce(health([MISSING_GIT]));

    renderHook(() => useMissingPrerequisiteWarning(true));
    await waitFor(() => expect(useMissingPrerequisiteStore.getState().missing).toHaveLength(1));

    healthCheckMock.mockRejectedValue(new Error("probe blew up"));
    await focusWindow();

    await waitFor(() => expect(healthCheckMock).toHaveBeenCalledTimes(2));
    expect(useMissingPrerequisiteStore.getState().missing).toHaveLength(1);
  });

  it("stops listening for focus after unmount", async () => {
    healthCheckMock.mockResolvedValue(health([result()]));

    const { unmount } = renderHook(() => useMissingPrerequisiteWarning(true));
    await waitFor(() => expect(healthCheckMock).toHaveBeenCalledTimes(1));

    unmount();
    await focusWindow();

    expect(healthCheckMock).toHaveBeenCalledTimes(1);
  });

  it("does not write to the store after unmount", async () => {
    let release: (value: SystemHealthCheckResult) => void = () => {};
    healthCheckMock.mockReturnValue(
      new Promise<SystemHealthCheckResult>((resolve) => {
        release = resolve;
      })
    );

    const { unmount } = renderHook(() => useMissingPrerequisiteWarning(true));
    await waitFor(() => expect(healthCheckMock).toHaveBeenCalled());

    unmount();
    await act(async () => {
      release(health([MISSING_GIT]));
      await Promise.resolve();
    });

    expect(useMissingPrerequisiteStore.getState().missing).toEqual([]);
  });
});
