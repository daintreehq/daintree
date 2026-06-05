// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock("@shared/types/panel", () => ({
  isPtyPanel: (panel: { kind?: string }) => panel?.kind !== "browser",
}));

// Real Doherty gate (useDeferredLoading) so the 400ms anti-flicker is exercised
// with fake timers, but a controllable aggregate hook so we drive the counts.
let aggregate = { pendingCount: 0, inProgressCount: 0, totalCount: 0 };
vi.mock("@/hooks/useScrollbackRestoreAggregate", () => ({
  useScrollbackRestoreAggregate: () => aggregate,
}));

const panelState = {
  panelsById: {} as Record<string, unknown>,
  panelIds: [] as string[],
};
vi.mock("@/store/panelStore", () => ({
  usePanelStore: Object.assign(
    (selector: (s: typeof panelState) => unknown) => selector(panelState),
    { getState: () => panelState }
  ),
}));

const retryMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/stateHydration/scrollbackRestoreScheduler", () => ({
  retryFailedScrollbackRestoreBatch: retryMock,
}));

import { BatchScrollbackRestoreBar } from "../BatchScrollbackRestoreBar";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      // Force reduced-motion so InlineStatusBanner skips its rAF entry animation.
      matches: query.includes("prefers-reduced-motion"),
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
  vi.useFakeTimers();
  aggregate = { pendingCount: 0, inProgressCount: 0, totalCount: 0 };
  panelState.panelsById = {};
  panelState.panelIds = [];
  retryMock.mockReset();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function setFailed(ids: string[]) {
  panelState.panelIds = ids;
  panelState.panelsById = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        id,
        kind: "pty",
        location: "main",
        scrollbackRestoreError: { type: "error", message: "x", timestamp: 1 },
      },
    ])
  );
}

describe("BatchScrollbackRestoreBar — idle", () => {
  it("renders nothing when no panels are restoring or failed", () => {
    const { container } = render(<BatchScrollbackRestoreBar />);
    expect(container.innerHTML).toBe("");
  });
});

describe("BatchScrollbackRestoreBar — Doherty-gated progress", () => {
  it("shows no banner before 400ms then reveals 'Restoring N of M'", () => {
    aggregate = { pendingCount: 3, inProgressCount: 0, totalCount: 3 };
    render(<BatchScrollbackRestoreBar />);

    // Before the Doherty threshold: nothing.
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(400);
    });

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Restoring 0 of 3");
  });

  it("computes done-count as total minus pending minus in-progress", () => {
    aggregate = { pendingCount: 1, inProgressCount: 1, totalCount: 3 };
    render(<BatchScrollbackRestoreBar />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole("status").textContent).toContain("Restoring 1 of 3");
  });

  it("never flashes a banner when the batch resolves under 400ms", () => {
    aggregate = { pendingCount: 2, inProgressCount: 0, totalCount: 2 };
    const { rerender } = render(<BatchScrollbackRestoreBar />);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Restore completes before the gate elapses.
    aggregate = { pendingCount: 0, inProgressCount: 0, totalCount: 2 };
    rerender(<BatchScrollbackRestoreBar />);
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("BatchScrollbackRestoreBar — failure", () => {
  it("shows the error banner immediately (no Doherty delay) with a singular count", () => {
    setFailed(["t1"]);
    render(<BatchScrollbackRestoreBar />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Restore failed for 1 panel");
    expect(screen.getByRole("button", { name: "Retry batch" })).toBeTruthy();
  });

  it("pluralizes the failed-panel count", () => {
    setFailed(["t1", "t2", "t3"]);
    render(<BatchScrollbackRestoreBar />);
    expect(screen.getByRole("alert").textContent).toContain("Restore failed for 3 panels");
  });

  it("invokes retryFailedScrollbackRestoreBatch with the failed ids on click", () => {
    setFailed(["t1", "t2"]);
    render(<BatchScrollbackRestoreBar />);
    fireEvent.click(screen.getByRole("button", { name: "Retry batch" }));
    expect(retryMock).toHaveBeenCalledWith(["t1", "t2"]);
  });

  it("prioritizes the failure banner over the in-progress indicator", () => {
    aggregate = { pendingCount: 2, inProgressCount: 0, totalCount: 4 };
    setFailed(["t1"]);
    render(<BatchScrollbackRestoreBar />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
