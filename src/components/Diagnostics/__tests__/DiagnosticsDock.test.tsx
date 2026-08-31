// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DiagnosticsDock, DIAGNOSTICS_DOCK_REGION_ID } from "../DiagnosticsDock";
import {
  useDiagnosticsStore,
  DIAGNOSTICS_MIN_HEIGHT,
  DIAGNOSTICS_DEFAULT_HEIGHT,
} from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store";

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

  it("uses the named diagnostics-dock class for transition control", () => {
    const { container } = render(<DiagnosticsDock />);
    const region = container.querySelector(`#${DIAGNOSTICS_DOCK_REGION_ID}`);
    expect(region?.getAttribute("data-resizing")).toBeNull();
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

  it("shows exact count when errors <= 99", () => {
    setErrors(99);
    const { container } = render(<DiagnosticsDock />);
    const badge = container.querySelector('[id="diagnostics-problems-tab"] span');
    expect(badge?.textContent).toBe("99");
  });

  it("caps at 99+ when errors >= 100", () => {
    setErrors(100);
    const { container } = render(<DiagnosticsDock />);
    const badge = container.querySelector('[id="diagnostics-problems-tab"] span');
    expect(badge?.textContent).toBe("99+");
  });

  it("shows no badge when error count is zero", () => {
    setErrors(0);
    const { container } = render(<DiagnosticsDock />);
    const badge = container.querySelector('[id="diagnostics-problems-tab"] span');
    expect(badge).toBeNull();
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
