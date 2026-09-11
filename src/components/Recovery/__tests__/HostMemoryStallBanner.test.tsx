// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const dispatchMock = vi.fn().mockResolvedValue({ ok: true, result: undefined });
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { HostMemoryStallBanner } from "../HostMemoryStallBanner";
import { useHostMemoryPauseStore } from "@/store/hostMemoryPauseStore";
import { HOST_MEMORY_PAUSE_COPY } from "@/lib/hostMemoryPauseCopy";

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

beforeEach(() => {
  dispatchMock.mockClear();
  useHostMemoryPauseStore.setState({ snapshot: null, visible: false });
});

afterEach(() => {
  cleanup();
});

describe("HostMemoryStallBanner", () => {
  it("renders nothing for a pause that is still recovering normally", () => {
    useHostMemoryPauseStore.setState({
      snapshot: { active: true, paused: true, stalled: false },
      visible: true,
    });

    const { container } = render(<HostMemoryStallBanner />);

    expect(container.firstChild).toBeNull();
  });

  it("offers Why am I slow? once recovery has stalled", () => {
    useHostMemoryPauseStore.setState({
      snapshot: { active: true, paused: false, stalled: true },
      visible: true,
    });

    render(<HostMemoryStallBanner />);
    fireEvent.click(screen.getByRole("button", { name: HOST_MEMORY_PAUSE_COPY.stall.action }));

    expect(dispatchMock).toHaveBeenCalledWith("diagnostics.openWhySlow", undefined, {
      source: "user",
    });
  });

  it("cannot be dismissed while the stall lasts", () => {
    useHostMemoryPauseStore.setState({
      snapshot: { active: true, paused: true, stalled: true },
      visible: true,
    });

    render(<HostMemoryStallBanner />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
