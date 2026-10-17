// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DiagnosticsDock, DIAGNOSTICS_DOCK_REGION_ID } from "../DiagnosticsDock";
import {
  useDiagnosticsStore,
  DIAGNOSTICS_MIN_HEIGHT,
  DIAGNOSTICS_DEFAULT_HEIGHT,
} from "@/store/diagnosticsStore";
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

vi.mock("../ProblemsContent", () => ({
  ProblemsContent: () => <div data-testid="problems-content" />,
}));
vi.mock("../LogsContent", () => ({
  LogsContent: () => <div data-testid="logs-content" />,
}));
vi.mock("../EventsContent", () => ({
  EventsContent: () => <div data-testid="events-content" />,
}));
vi.mock("../TelemetryContent", () => ({
  TelemetryContent: () => <div data-testid="telemetry-content" />,
}));
vi.mock("../PerfContent", () => ({
  PerfContent: () => <div data-testid="perf-content" />,
}));
vi.mock("../WhySlowContent", () => ({
  WhySlowContent: () => <div data-testid="why-slow-content" />,
}));
vi.mock("../DiagnosticsActions", () => ({
  ProblemsActions: () => null,
  LogsActions: () => null,
  EventsActions: () => null,
  TelemetryActions: () => null,
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

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

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

describe("DiagnosticsDock — region id and aria wiring", () => {
  beforeEach(() => {
    resetStores();
  });

  it("renders the outer region with the shared id constant", () => {
    const { container } = render(<DiagnosticsDock />);
    const region = container.querySelector(`#${DIAGNOSTICS_DOCK_REGION_ID}`);
    expect(region).not.toBeNull();
    expect(region?.getAttribute("role")).toBe("region");
  });

  it("derives aria-valuemax from the store maxHeight, not window.innerHeight", () => {
    const { container } = render(<DiagnosticsDock />);
    act(() => {
      useDiagnosticsStore.setState({ maxHeight: 480 });
    });
    const separator = container.querySelector('[role="separator"]');
    expect(separator?.getAttribute("aria-valuemax")).toBe("480");
  });
});

describe("DiagnosticsDock — roving tabindex on the tab strip", () => {
  beforeEach(() => {
    resetStores();
  });

  it("gives only the active tab tabIndex=0", () => {
    const { container } = render(<DiagnosticsDock />);
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(6);
    const active = container.querySelector('[role="tab"][aria-selected="true"]');
    expect(active?.getAttribute("tabindex")).toBe("0");
    container.querySelectorAll('[role="tab"][aria-selected="false"]').forEach((el) => {
      expect(el.getAttribute("tabindex")).toBe("-1");
    });
  });

  it("ArrowRight moves focus and activates the next tab", () => {
    const { container } = render(<DiagnosticsDock />);
    const tablist = container.querySelector('[role="tablist"]') as HTMLDivElement;
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    tabs[0]!.focus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(useDiagnosticsStore.getState().activeTab).toBe("logs");
    expect(document.activeElement).toBe(tabs[1]);
  });

  it("reaching Problems by keyboard promotes errors exactly as a click does", () => {
    useDiagnosticsStore.setState({ activeTab: "logs" });
    const promoteErrors = vi.fn();
    useErrorStore.setState({ promoteErrors });
    const { container } = render(<DiagnosticsDock />);
    const tablist = container.querySelector('[role="tablist"]') as HTMLDivElement;
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    tabs.find((t) => t.dataset.tab === "logs")!.focus();

    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(useDiagnosticsStore.getState().activeTab).toBe("problems");
    expect(promoteErrors).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    fireEvent.click(tabs.find((t) => t.dataset.tab === "problems")!);
    expect(promoteErrors).toHaveBeenCalledTimes(2);
  });

  it("gives the tab panel a focus stop so empty content is still reachable", () => {
    // APG tabs: a panel whose content may open with nothing focusable is itself
    // in the tab sequence. Empty Problems and no-project Perf are such panels.
    for (const tab of ["problems", "logs", "events", "telemetry", "perf", "whySlow"] as const) {
      useDiagnosticsStore.setState({ activeTab: tab });
      const { container, unmount } = render(<DiagnosticsDock />);
      const panel = container.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
      expect(panel?.tabIndex).toBe(0);
      unmount();
    }
  });

  it("ArrowLeft from the first tab wraps to the last", () => {
    const { container } = render(<DiagnosticsDock />);
    const tablist = container.querySelector('[role="tablist"]') as HTMLDivElement;
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    tabs[0]!.focus();
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(useDiagnosticsStore.getState().activeTab).toBe("whySlow");
    expect(document.activeElement).toBe(tabs[tabs.length - 1]);
  });

  it("Home jumps to the first tab and End jumps to the last", () => {
    useDiagnosticsStore.setState({ activeTab: "events" });
    const { container } = render(<DiagnosticsDock />);
    const tablist = container.querySelector('[role="tablist"]') as HTMLDivElement;
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const eventsTab = tabs.find((t) => t.dataset.tab === "events")!;
    eventsTab.focus();

    fireEvent.keyDown(tablist, { key: "Home" });
    expect(useDiagnosticsStore.getState().activeTab).toBe("problems");

    tabs.find((t) => t.dataset.tab === "problems")!.focus();
    fireEvent.keyDown(tablist, { key: "End" });
    expect(useDiagnosticsStore.getState().activeTab).toBe("whySlow");
  });
});

describe("DiagnosticsDock — separator keyboard resize", () => {
  beforeEach(() => {
    resetStores();
  });

  // The ResizeObserver effect runs once on mount and seeds maxHeight from the
  // parent's bounding rect — which is 0 in jsdom. Set the harness state after
  // render to bypass that initial seed.
  function renderWith(height: number, maxHeight: number) {
    const result = render(<DiagnosticsDock />);
    act(() => {
      useDiagnosticsStore.setState({ height, maxHeight });
    });
    return result;
  }

  it("ArrowUp grows by 10px, ArrowDown shrinks by 10px", () => {
    const { container } = renderWith(300, 600);
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement;
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(useDiagnosticsStore.getState().height).toBe(310);
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(useDiagnosticsStore.getState().height).toBe(300);
  });

  it("Shift+ArrowUp / Shift+ArrowDown step by 50px", () => {
    const { container } = renderWith(300, 600);
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement;
    fireEvent.keyDown(separator, { key: "ArrowUp", shiftKey: true });
    expect(useDiagnosticsStore.getState().height).toBe(350);
    fireEvent.keyDown(separator, { key: "ArrowDown", shiftKey: true });
    expect(useDiagnosticsStore.getState().height).toBe(300);
  });

  it("PageUp / PageDown step by 50px", () => {
    const { container } = renderWith(300, 600);
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement;
    fireEvent.keyDown(separator, { key: "PageUp" });
    expect(useDiagnosticsStore.getState().height).toBe(350);
    fireEvent.keyDown(separator, { key: "PageDown" });
    expect(useDiagnosticsStore.getState().height).toBe(300);
  });

  it("Home jumps to DIAGNOSTICS_MIN_HEIGHT, End jumps to maxHeight", () => {
    const { container } = renderWith(300, 480);
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement;
    fireEvent.keyDown(separator, { key: "Home" });
    expect(useDiagnosticsStore.getState().height).toBe(DIAGNOSTICS_MIN_HEIGHT);
    fireEvent.keyDown(separator, { key: "End" });
    expect(useDiagnosticsStore.getState().height).toBe(480);
  });

  it("respects clamp ceiling when growing past the cap", () => {
    const { container } = renderWith(470, 480);
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement;
    fireEvent.keyDown(separator, { key: "PageUp" });
    expect(useDiagnosticsStore.getState().height).toBe(480);
  });

  it("double-click resets height to DIAGNOSTICS_DEFAULT_HEIGHT", () => {
    const { container } = renderWith(420, 600);
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement;
    fireEvent.doubleClick(separator);
    expect(useDiagnosticsStore.getState().height).toBe(DIAGNOSTICS_DEFAULT_HEIGHT);
  });

  it("Enter key resets height to DIAGNOSTICS_DEFAULT_HEIGHT", () => {
    const { container } = renderWith(420, 600);
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement;
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(useDiagnosticsStore.getState().height).toBe(DIAGNOSTICS_DEFAULT_HEIGHT);
  });

  it("Space key resets height to DIAGNOSTICS_DEFAULT_HEIGHT", () => {
    const { container } = renderWith(420, 600);
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement;
    fireEvent.keyDown(separator, { key: " " });
    expect(useDiagnosticsStore.getState().height).toBe(DIAGNOSTICS_DEFAULT_HEIGHT);
  });
});

describe("DiagnosticsDock — focus on close", () => {
  beforeEach(() => {
    resetStores();
  });

  function renderWithOpener() {
    const utils = render(
      <>
        <button type="button">opener</button>
        <DiagnosticsDock />
      </>
    );
    const opener = utils.getByText("opener");
    const tab = utils.container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
    opener.focus();
    tab.focus();
    expect(document.activeElement).toBe(tab);
    return { opener, tab };
  }

  it("hands focus back to where it came from when it closes around it", () => {
    const { opener } = renderWithOpener();
    act(() => useDiagnosticsStore.getState().closeDock());
    expect(document.activeElement).toBe(opener);
  });

  it("forgets the origin once focus drops out of the dock onto nothing", async () => {
    const { opener, tab } = renderWithOpener();
    // A click on an unfocusable surface blurs the tab with no new target.
    tab.blur();
    await Promise.resolve();
    act(() => useDiagnosticsStore.getState().closeDock());
    expect(document.activeElement).not.toBe(opener);
  });

  it("leaves focus alone when the keyboard had already left the dock", () => {
    const { opener } = renderWithOpener();
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    act(() => useDiagnosticsStore.getState().closeDock());
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(opener);
    elsewhere.remove();
  });
});

describe("DiagnosticsDock — badge cap", () => {
  beforeEach(() => {
    resetStores();
  });

  function setErrors(count: number) {
    useErrorStore.setState({
      errors: Array.from({ length: count }, (_, i) => ({
        id: `err-${i}`,
        type: "unknown" as const,
        message: `Error ${i}`,
        retryability: "none" as const,
        source: "test",
        timestamp: Date.now(),
        dismissed: false,
        fromPreviousSession: false,
      })),
    });
  }

  const badgeIn = (container: HTMLElement) =>
    container.querySelector('[id="diagnostics-problems-tab"] [data-slot="badge"]');

  it("shows exact count when errors <= 99", () => {
    setErrors(99);
    const { container } = render(<DiagnosticsDock />);
    expect(badgeIn(container)?.querySelector('[aria-hidden="true"]')?.textContent).toBe("99");
  });

  it("caps the numeral at 99+ but says the exact count", () => {
    setErrors(100);
    const { container } = render(<DiagnosticsDock />);
    const badge = badgeIn(container);
    expect(badge?.querySelector('[aria-hidden="true"]')?.textContent).toBe("99+");
    expect(badge?.querySelector(".sr-only")?.textContent).toBe("100 errors");
  });

  it("shows no badge when error count is zero", () => {
    setErrors(0);
    const { container } = render(<DiagnosticsDock />);
    expect(badgeIn(container)).toBeNull();
  });
});

describe("DiagnosticsDock — resize lag suppression", () => {
  beforeEach(() => {
    resetStores();
  });

  it("flips data-resizing on mousedown and clears it on mouseup", () => {
    const { container } = render(<DiagnosticsDock />);
    const region = container.querySelector(`#${DIAGNOSTICS_DOCK_REGION_ID}`) as HTMLDivElement;
    const separator = container.querySelector('[role="separator"]') as HTMLDivElement;

    expect(region.getAttribute("data-resizing")).toBeNull();

    act(() => {
      fireEvent.mouseDown(separator, { clientY: 100 });
    });
    expect(region.getAttribute("data-resizing")).toBe("true");

    act(() => {
      fireEvent(document, new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(region.getAttribute("data-resizing")).toBeNull();
  });
});

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
