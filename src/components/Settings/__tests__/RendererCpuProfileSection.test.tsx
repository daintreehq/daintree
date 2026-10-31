// @vitest-environment jsdom
import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  RendererCpuProfileStartResult,
  RendererCpuProfileStopResult,
} from "@shared/types/ipc/system";

const startMock = vi.hoisted(() => vi.fn<() => Promise<RendererCpuProfileStartResult>>());
const stopMock = vi.hoisted(() => vi.fn<() => Promise<RendererCpuProfileStopResult>>());

vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  systemClient: {
    startRendererCpuProfile: startMock,
    stopRendererCpuProfile: stopMock,
  },
}));

import { RendererCpuProfileSection } from "../TroubleshootingTab";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const getButton = () => screen.getByRole<HTMLButtonElement>("button");

describe("RendererCpuProfileSection — starting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one start when Record profile is clicked again before the first start resolves", async () => {
    const start = deferred<RendererCpuProfileStartResult>();
    startMock.mockReturnValueOnce(start.promise);
    render(<RendererCpuProfileSection />);

    const button = getButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(getButton());

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(getButton().getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      start.resolve({ status: "started", expiresAt: Date.now() + 15_000 });
      await start.promise;
    });

    expect(getButton().textContent).toContain("Stop recording");
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("allows another start after a failed one resolves", async () => {
    startMock.mockResolvedValueOnce({
      status: "failed",
      reason: "cdp-error",
      message: "Profiler is not enabled",
    });
    render(<RendererCpuProfileSection />);

    await act(async () => {
      fireEvent.click(getButton());
    });

    expect(screen.getByText("Profiler is not enabled")).toBeTruthy();
    expect(getButton().getAttribute("aria-busy")).toBeNull();

    startMock.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(getButton());
    expect(startMock).toHaveBeenCalledTimes(2);
  });

  it("reports a capture failure with its own message rather than blaming DevTools", async () => {
    startMock.mockResolvedValueOnce({ status: "started", expiresAt: Date.now() + 15_000 });
    stopMock.mockResolvedValueOnce({
      status: "failed",
      reason: "capture-failed",
      message: "No recording profiles found",
    });
    render(<RendererCpuProfileSection />);

    await act(async () => {
      fireEvent.click(getButton());
    });
    await act(async () => {
      fireEvent.click(getButton());
    });

    expect(screen.getByText("No recording profiles found")).toBeTruthy();
    expect(screen.queryByText(/DevTools attached/)).toBeNull();
  });
});
