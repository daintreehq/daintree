// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PluginPerfSnapshot } from "@shared/types/pluginMetrics";
import type { PluginStyleReportState } from "@/hooks/usePluginStyleReport";

const styleState = vi.hoisted(() => ({
  current: { status: "checking" } as PluginStyleReportState,
}));
const recheck = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/usePluginStyleReport", () => ({
  usePluginStyleReport: () => ({ state: styleState.current, recheck }),
}));

const { PluginPerformanceSection, PluginStylesSection, formatDurationMs, groupNotGenerated } =
  await import("../PluginPerformanceTab");

function makeSnapshot(overrides: Partial<PluginPerfSnapshot> = {}): PluginPerfSnapshot {
  return {
    pluginId: "acme.demo",
    isolation: "worker",
    activation: { lastMs: 812, count: 1, at: Date.now() },
    viewLoads: [
      {
        kindId: "acme.demo.main",
        activateMs: 20,
        importMs: 40,
        stylesMs: 90,
        firstPaintMs: 180,
        retry: false,
        at: Date.now(),
      },
    ],
    viewCommits: null,
    invokes: {
      count: 12,
      p50Ms: 4,
      p95Ms: 30,
      maxMs: 61,
      lastMs: 3,
      errors: 2,
      timeouts: 0,
      oversized: 1,
    },
    pushes: { messages: 0, bytes: 0, perSecond: 0, bytesPerSecond: 0, oversized: 0 },
    longFrames: { count: 0, totalBlockingMs: 0, lastAt: null },
    workerMemory: { rssBytes: 64 * 1024 * 1024, at: Date.now() },
    overBudget: ["activationMs"],
    since: Date.now() - 5 * 60_000,
    ...overrides,
  };
}

function row(label: string): HTMLElement {
  const dt = screen.getByText(label).closest("dt");
  const container = dt?.parentElement;
  if (!container) throw new Error(`no row ${label}`);
  return container;
}

beforeEach(() => {
  recheck.mockClear();
  styleState.current = { status: "checking" };
});

describe("formatDurationMs", () => {
  it("scales precision with magnitude", () => {
    expect(formatDurationMs(3.24)).toBe("3.2 ms");
    expect(formatDurationMs(812.4)).toBe("812 ms");
    expect(formatDurationMs(1540)).toBe("1.5 s");
  });
});

describe("PluginPerformanceSection", () => {
  it("marks only the measurements main reports above budget, in words", () => {
    render(<PluginPerformanceSection snapshot={makeSnapshot()} developmentBuild={false} />);
    expect(row("Activation").textContent).toContain("812 ms");
    expect(row("Activation").textContent).toContain("above");
    expect(row("Last view load").textContent).not.toContain("above");
  });

  it("reports view load as activation plus the longer of import and styles", () => {
    render(<PluginPerformanceSection snapshot={makeSnapshot()} developmentBuild={false} />);
    expect(row("Last view load").textContent).toContain("110 ms");
    expect(row("Last view first paint").textContent).toContain("180 ms");
  });

  it("says render time is development-only instead of showing zero in production", () => {
    render(<PluginPerformanceSection snapshot={makeSnapshot()} developmentBuild={false} />);
    expect(row("View render time").textContent).toContain("Only measured in development builds");
    expect(row("View render time").textContent).not.toContain("0 ms");
  });

  it("shows commit percentiles once they exist", () => {
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({
          viewCommits: { count: 40, p50Ms: 2, p95Ms: 21, maxMs: 33, lastMs: 1 },
          overBudget: ["viewCommitP95Ms"],
        })}
        developmentBuild
      />
    );
    expect(row("View render time").textContent).toContain("p95 21 ms");
    expect(row("View render time").textContent).toContain("above");
  });

  it("marks each push budget separately", () => {
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({
          pushes: { messages: 900, bytes: 2048, perSecond: 90, bytesPerSecond: 512, oversized: 0 },
          overBudget: ["pushesPerSecond"],
        })}
        developmentBuild={false}
      />
    );
    const lines = [...row("Messages to views").querySelectorAll("dd > div")].map(
      (el) => el.textContent ?? ""
    );
    expect(lines.find((line) => line.startsWith("Budget 60/s"))).toContain("above");
    expect(lines.find((line) => line.includes("MB/s"))).not.toContain("above");
  });

  it("lists invoke failures only when there are some", () => {
    render(<PluginPerformanceSection snapshot={makeSnapshot()} developmentBuild={false} />);
    const text = row("Calls to the plugin").textContent ?? "";
    expect(text).toContain("12 calls");
    expect(text).toContain("2 errors");
    expect(text).toContain("1 oversized");
    expect(text).not.toContain("timed out");
  });

  it("phrases long frames as activity observed, never as the cause", () => {
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({
          longFrames: { count: 3, totalBlockingMs: 240, lastAt: Date.now() },
        })}
        developmentBuild={false}
      />
    );
    const text = row("Long frames with plugin activity").textContent ?? "";
    expect(text).toContain("3 frames");
    expect(text).toContain("the plugin was active during these frames");
  });

  it("shows worker memory for worker plugins only", () => {
    const { unmount } = render(
      <PluginPerformanceSection snapshot={makeSnapshot()} developmentBuild={false} />
    );
    expect(row("Worker memory").textContent).toContain("64 MB");
    unmount();
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({ isolation: "in-process", workerMemory: null })}
        developmentBuild={false}
      />
    );
    expect(screen.queryByText("Worker memory")).toBeNull();
  });

  it("names the empty cases rather than printing zeros", () => {
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({ activation: null, viewLoads: [] })}
        developmentBuild={false}
      />
    );
    expect(row("Activation").textContent).toContain("Not activated yet");
    expect(row("Last view load").textContent).toContain("No view opened yet");
    expect(screen.queryByText("Last view first paint")).toBeNull();
    expect(row("Messages to views").textContent).toContain("None yet");
  });
});

describe("groupNotGenerated", () => {
  it("separates stock palette colours, variants included, from everything else", () => {
    expect(
      groupNotGenerated([
        "hover:bg-blue-500",
        "text-red-600/50",
        "flx",
        "my-card",
        "bg-surface-panel",
      ])
    ).toEqual({
      stockPalette: ["hover:bg-blue-500", "text-red-600/50"],
      other: ["bg-surface-panel", "flx", "my-card"],
    });
  });
});

describe("PluginStylesSection", () => {
  it("asks for a panel to be opened when none is mounted", () => {
    styleState.current = { status: "no-views" };
    render(<PluginStylesSection pluginId="acme.demo" />);
    expect(screen.getByText("Open one of this plugin’s panels to check its styles.")).toBeTruthy();
  });

  it("groups classes that produced no CSS", () => {
    styleState.current = {
      status: "ready",
      report: { generated: ["p-4"], notGenerated: ["bg-red-500", "flx"] },
    };
    render(<PluginStylesSection pluginId="acme.demo" />);
    expect(screen.getByText("Stock Tailwind colours")).toBeTruthy();
    expect(screen.getByText("No matching utility")).toBeTruthy();
    expect(screen.getByText("bg-red-500")).toBeTruthy();
    expect(screen.getByText("flx")).toBeTruthy();
  });

  it("says so when every class produced CSS", () => {
    styleState.current = { status: "ready", report: { generated: ["p-4"], notGenerated: [] } };
    render(<PluginStylesSection pluginId="acme.demo" />);
    expect(screen.getByText(/Every class in this plugin’s open panels produced CSS/)).toBeTruthy();
  });

  it("re-checks on demand but not while a check is running", () => {
    styleState.current = { status: "no-views" };
    const { rerender } = render(<PluginStylesSection pluginId="acme.demo" />);
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(recheck).toHaveBeenCalledTimes(1);

    styleState.current = { status: "checking" };
    rerender(<PluginStylesSection pluginId="acme.demo" />);
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it("holds the checking line back under the Doherty gate", () => {
    vi.useFakeTimers();
    try {
      render(<PluginStylesSection pluginId="acme.demo" />);
      expect(screen.queryByText("Checking styles…")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByText("Checking styles…")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
