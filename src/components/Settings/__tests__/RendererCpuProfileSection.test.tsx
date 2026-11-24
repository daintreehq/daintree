// @vitest-environment jsdom
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
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
import { useRendererCpuProfileStore } from "@/store/rendererCpuProfileStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const getButton = () => screen.getByRole<HTMLButtonElement>("button");

beforeEach(() => {
  // The recording outlives the row by design, so one test's would leak into the next.
  useRendererCpuProfileStore.setState(useRendererCpuProfileStore.getInitialState(), true);
});

describe("RendererCpuProfileSection — starting", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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

  it("drops a second click that lands before the busy state renders", () => {
    startMock.mockReturnValue(new Promise(() => {}));
    render(<RendererCpuProfileSection />);

    const button = getButton();
    act(() => {
      button.click();
      button.click();
    });

    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("allows another start after a start that threw", async () => {
    startMock.mockRejectedValueOnce(new Error("IPC channel closed"));
    render(<RendererCpuProfileSection />);

    await act(async () => {
      fireEvent.click(getButton());
    });

    expect(screen.getByText("IPC channel closed")).toBeTruthy();
    startMock.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(getButton());
    expect(startMock).toHaveBeenCalledTimes(2);
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

  it.each([
    ["capture-failed", "Couldn't capture the profile"],
    ["save-failed", "Couldn't save the profile"],
  ] as const)("falls back to its own copy for a message-free %s", async (reason, copy) => {
    startMock.mockResolvedValueOnce({ status: "started", expiresAt: Date.now() + 15_000 });
    stopMock.mockResolvedValueOnce({ status: "failed", reason });
    render(<RendererCpuProfileSection />);

    await act(async () => {
      fireEvent.click(getButton());
    });
    await act(async () => {
      fireEvent.click(getButton());
    });

    expect(screen.getByText(copy)).toBeTruthy();
  });
});

describe("RendererCpuProfileSection — leaving Settings during a recording", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function startRecording() {
    const expiresAt = Date.now() + 15_000;
    startMock.mockResolvedValueOnce({ status: "started", expiresAt });
    const view = render(<RendererCpuProfileSection />);
    await act(async () => {
      fireEvent.click(getButton());
    });
    expect(getButton().textContent).toContain("Stop recording");
    return { view, expiresAt };
  }

  it("collects the capture Main made while Settings was closed, without recording again", async () => {
    stopMock.mockResolvedValueOnce({ status: "saved" });
    (await startRecording()).view.unmount();

    // Using the app to reproduce the lag, well past the deadline.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(stopMock).not.toHaveBeenCalled();

    render(<RendererCpuProfileSection />);
    expect(getButton().textContent).toContain("Save profile");
    expect(screen.getByText(/Recording ended/)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(stopMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(getButton());
    });

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(getButton().textContent).toContain("Record profile");
    expect(useRendererCpuProfileStore.getState().expiresAt).toBe(0);
  });

  it("resumes the countdown when reopened before the deadline and saves once at zero", async () => {
    const stopCalledAt: number[] = [];
    stopMock.mockImplementation(() => {
      stopCalledAt.push(Date.now());
      return Promise.resolve({ status: "saved" });
    });
    const { view, expiresAt } = await startRecording();
    view.unmount();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    render(<RendererCpuProfileSection />);
    expect(getButton().textContent).toContain("Stop recording");
    expect(screen.getByText(/auto-stops in 10s/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(screen.getByText(/auto-stops in 1s/)).toBeTruthy();
    expect(stopMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1_001);
    });

    expect(stopCalledAt).toEqual([expiresAt]);
    expect(getButton().textContent).toContain("Record profile");
  });

  it("saves at once when a start reply arrives after the deadline while the row is open", async () => {
    const start = deferred<RendererCpuProfileStartResult>();
    startMock.mockReturnValueOnce(start.promise);
    stopMock.mockResolvedValueOnce({ status: "saved" });
    const expiresAt = Date.now() + 15_000;
    render(<RendererCpuProfileSection />);
    fireEvent.click(getButton());

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    await act(async () => {
      start.resolve({ status: "started", expiresAt });
      await start.promise;
    });

    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a start that resolves after Settings closed", async () => {
    const start = deferred<RendererCpuProfileStartResult>();
    startMock.mockReturnValueOnce(start.promise);
    const first = render(<RendererCpuProfileSection />);
    fireEvent.click(getButton());
    first.unmount();

    await act(async () => {
      start.resolve({ status: "started", expiresAt: Date.now() + 15_000 });
      await start.promise;
    });

    render(<RendererCpuProfileSection />);
    expect(getButton().textContent).toContain("Stop recording");
    expect(screen.getByText(/auto-stops in 15s/)).toBeTruthy();
  });

  it("keeps Record profile busy when reopened while the start is still pending", async () => {
    const start = deferred<RendererCpuProfileStartResult>();
    startMock.mockReturnValueOnce(start.promise);
    const first = render(<RendererCpuProfileSection />);
    fireEvent.click(getButton());
    first.unmount();

    render(<RendererCpuProfileSection />);
    expect(getButton().textContent).toContain("Record profile");
    expect(getButton().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(getButton());
    expect(startMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      start.resolve({ status: "started", expiresAt: Date.now() + 15_000 });
      await start.promise;
    });

    expect(getButton().textContent).toContain("Stop recording");
    expect(screen.getByText(/auto-stops in 15s/)).toBeTruthy();
  });

  it("keeps a save that is still in flight busy across a reopen and shows its failure", async () => {
    const stop = deferred<RendererCpuProfileStopResult>();
    stopMock.mockReturnValueOnce(stop.promise);
    const { view } = await startRecording();
    fireEvent.click(getButton());
    view.unmount();

    render(<RendererCpuProfileSection />);
    expect(getButton().textContent).toContain("Save profile");
    expect(getButton().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(getButton());
    expect(stopMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      stop.resolve({ status: "failed", reason: "devtools-detached" });
      await stop.promise;
    });

    expect(screen.getByText(/DevTools attached to this window/)).toBeTruthy();
    expect(getButton().textContent).toContain("Record profile");
  });
});
