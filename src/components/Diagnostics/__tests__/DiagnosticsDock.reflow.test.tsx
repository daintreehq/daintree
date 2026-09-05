// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { DiagnosticsDock, DIAGNOSTICS_DOCK_REGION_ID } from "../DiagnosticsDock";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store";

const signalMock = vi.hoisted(() => vi.fn());
/**
 * What the DOM looked like at the moment each signal fired. Asserting after
 * `render()` returns would pass for an implementation that published during
 * render — the whole point is that subscribers measure a committed box.
 */
const observations = vi.hoisted((): Array<{ present: boolean; height: string }> => []);

vi.mock("@/lib/diagnosticsDockLayout", () => ({
  signalDiagnosticsDockLayoutChange: signalMock,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../ProblemsContent", () => ({ ProblemsContent: () => <div /> }));
vi.mock("../LogsContent", () => ({ LogsContent: () => <div /> }));
vi.mock("../EventsContent", () => ({ EventsContent: () => <div /> }));
vi.mock("../TelemetryContent", () => ({ TelemetryContent: () => <div /> }));
vi.mock("../PerfContent", () => ({ PerfContent: () => <div /> }));
vi.mock("../WhySlowContent", () => ({ WhySlowContent: () => <div /> }));
vi.mock("../DiagnosticsActions", () => ({
  ProblemsActions: () => null,
  LogsActions: () => null,
  EventsActions: () => null,
  TelemetryActions: () => null,
  PerfActions: () => null,
}));

vi.mock("@/store/perfMetricsStore", () => {
  const state = { outsideReferenceCount: 0 };
  return {
    usePerfMetricsStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

vi.mock("@/clients", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    appClient: {
      setState: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue({}),
    },
  };
});

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function resetStores() {
  useDiagnosticsStore.setState({
    isOpen: true,
    activeTab: "problems",
    height: 256,
    maxHeight: 600,
  });
  useErrorStore.setState({ errors: [] });
}

// Issue #12264 — opening the dock takes its height out of the flex column that
// holds the panel grid, but nothing told the grid to remeasure or told the
// terminals to refit, so the bottom strip of every agent panel stayed hidden.
// The dock now publishes each committed geometry change; the grid subscribes.
describe("DiagnosticsDock layout signal (issue #12264)", () => {
  let rectSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // jsdom reports a zero-height rect for every element, which drives the
    // dock's own maxHeight observer to clamp the store height down to the 128px
    // floor on mount — a real height change that would publish a second,
    // fixture-induced signal. Give the dock a plausible container so the clamp
    // is the no-op it is in the app.
    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 1000, 1200));
    resetStores();
    signalMock.mockClear();
    observations.length = 0;
    signalMock.mockImplementation(() => {
      const el = document.getElementById(DIAGNOSTICS_DOCK_REGION_ID);
      observations.push({ present: el !== null, height: el?.style.height ?? "" });
    });
  });

  afterEach(() => {
    rectSpy?.mockRestore();
    rectSpy = undefined;
  });

  it("publishes once the opened dock is in the DOM, not when the store flips", () => {
    // The mount IS the open: the dock is lazy-loaded behind a first-open gate,
    // so `isOpen` flips a frame or more before any dock DOM exists to measure.
    render(<DiagnosticsDock />);

    expect(signalMock).toHaveBeenCalledTimes(1);
    // Recorded inside the signal: a publish during render, or before the dock's
    // height landed on the element, would not see this.
    expect(observations).toEqual([{ present: true, height: "256px" }]);
  });

  it("publishes when the dock closes and gives the space back", () => {
    render(<DiagnosticsDock />);
    signalMock.mockClear();
    observations.length = 0;

    act(() => {
      useDiagnosticsStore.getState().closeDock();
    });

    expect(signalMock).toHaveBeenCalledTimes(1);
    // The space is already returned when the grid is told to remeasure.
    expect(observations).toEqual([{ present: false, height: "" }]);
  });

  it("publishes on a height change so a drag- or keyboard-resize reflows the grid", () => {
    render(<DiagnosticsDock />);
    signalMock.mockClear();
    observations.length = 0;

    act(() => {
      useDiagnosticsStore.getState().setHeight(400);
    });

    expect(signalMock).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([{ present: true, height: "400px" }]);
  });

  it("stays quiet for a tab switch, which moves nothing", () => {
    render(<DiagnosticsDock />);
    signalMock.mockClear();

    act(() => {
      useDiagnosticsStore.getState().setActiveTab("logs");
    });

    expect(signalMock).not.toHaveBeenCalled();
  });

  it("stays quiet when a clamped setHeight leaves the height where it was", () => {
    // setHeight clamps to [MIN, maxHeight]; a no-op clamp must not re-arm the
    // resize suppression on every keystroke at the limit.
    render(<DiagnosticsDock />);
    act(() => {
      useDiagnosticsStore.getState().setHeight(600);
    });
    signalMock.mockClear();

    act(() => {
      useDiagnosticsStore.getState().setHeight(900);
    });

    expect(signalMock).not.toHaveBeenCalled();
  });

  it("publishes again on reopen after a close", () => {
    render(<DiagnosticsDock />);
    act(() => {
      useDiagnosticsStore.getState().closeDock();
    });
    signalMock.mockClear();

    act(() => {
      useDiagnosticsStore.getState().openDock("problems");
    });

    expect(signalMock).toHaveBeenCalledTimes(1);
  });
});
