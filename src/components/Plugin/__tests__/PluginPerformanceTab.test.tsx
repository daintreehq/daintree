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

const { PluginPerformanceSection, PluginStylesSection, groupNotGenerated } =
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
        loadMs: 110,
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
      promptWaits: 0,
    },
    pushes: {
      messages: 0,
      bytes: 0,
      perSecond: 0,
      bytesPerSecond: 0,
      peakPerSecond: 0,
      peakBytesPerSecond: 0,
      oversized: 0,
    },
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

describe("PluginPerformanceSection", () => {
  it("renders the measurement window's start as an age with the exact time behind it", () => {
    const snapshot = makeSnapshot();
    const { container } = render(
      <PluginPerformanceSection snapshot={snapshot} developmentBuild={false} />
    );
    const since = container.querySelector("p time");
    expect(since?.textContent).toBe("5 minutes ago");
    expect(since?.getAttribute("dateTime")).toBe(new Date(snapshot.since).toISOString());
    expect(since?.getAttribute("title")).toBe(new Date(snapshot.since).toLocaleString());
  });

  it("marks only the measurements main reports above budget, in words", () => {
    render(<PluginPerformanceSection snapshot={makeSnapshot()} developmentBuild={false} />);
    expect(row("Activation").textContent).toContain("812ms");
    expect(row("Activation").textContent).toContain("above");
    expect(row("Last view load").textContent).not.toContain("above");
  });

  it("reports view load as activation plus the longer of import and styles", () => {
    render(<PluginPerformanceSection snapshot={makeSnapshot()} developmentBuild={false} />);
    expect(row("Last view load").textContent).toContain("110ms");
    expect(row("Last view first frame").textContent).toContain("180ms");
  });

  it("says render time is development-only instead of showing zero in production", () => {
    render(<PluginPerformanceSection snapshot={makeSnapshot()} developmentBuild={false} />);
    expect(row("View render time").textContent).toContain("Only measured in development builds");
    expect(row("View render time").textContent).not.toContain("0ms");
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
    expect(row("View render time").textContent).toContain("p95 21ms");
    expect(row("View render time").textContent).toContain("above");
  });

  it("marks each push budget separately", () => {
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({
          pushes: {
            messages: 900,
            bytes: 2048,
            perSecond: 90,
            bytesPerSecond: 512,
            peakPerSecond: 400,
            peakBytesPerSecond: 1024,
            oversized: 0,
          },
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

  it("shows the busiest second beside the sustained push rate", () => {
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({
          pushes: {
            messages: 900,
            bytes: 2048,
            perSecond: 90,
            bytesPerSecond: 512,
            peakPerSecond: 400,
            peakBytesPerSecond: 1024,
            oversized: 0,
          },
        })}
        developmentBuild={false}
      />
    );
    const text = row("Messages to views").textContent ?? "";
    expect(text).toContain("90/s");
    expect(text).toContain("busiest second 400/s");
  });

  it("reports the measured view load, not a sum of overlapping phases", () => {
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({
          viewLoads: [
            {
              kindId: "acme.demo.main",
              activateMs: 80,
              importMs: 40,
              stylesMs: 90,
              loadMs: 95,
              firstPaintMs: 180,
              retry: false,
              at: Date.now(),
            },
          ],
        })}
        developmentBuild={false}
      />
    );
    expect(row("Last view load").querySelector("dd")?.textContent).toContain("95ms");
  });

  it("keeps the cold load visible beside a warm re-open", () => {
    const load = makeSnapshot().viewLoads[0]!;
    const cold = { ...load, importMs: 30, stylesMs: 60, loadMs: 91, firstPaintMs: 120 };
    const warm = { ...load, importMs: 0, stylesMs: 0, loadMs: 9.1, firstPaintMs: 14 };
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({ viewLoads: [cold, warm], overBudget: [] })}
        developmentBuild={false}
      />
    );
    expect(row("Last view load").querySelector("dd")?.textContent).toContain("9.1ms");
    const slowest = row("Slowest view load");
    expect(slowest.querySelector("dd")?.textContent).toContain("91ms");
    expect(slowest.textContent).toContain("Slowest of the last 2 loads");
    expect(slowest.textContent).toContain("styles 60ms");
    expect(slowest.textContent).toContain("first frame 120ms");
    // Budgets are main's verdict on the latest load; this row carries none.
    expect(slowest.textContent).not.toContain("Budget");
  });

  it("shows no separate slowest load when the latest is the slowest", () => {
    const load = makeSnapshot().viewLoads[0]!;
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({ viewLoads: [{ ...load, loadMs: 20 }, load] })}
        developmentBuild={false}
      />
    );
    expect(screen.queryByText("Slowest view load")).toBeNull();
  });

  it("keeps prompt waits out of the call timings and says so", () => {
    render(
      <PluginPerformanceSection
        snapshot={makeSnapshot({
          invokes: {
            count: 3,
            p50Ms: 0,
            p95Ms: 0,
            maxMs: 0,
            lastMs: 0,
            errors: 0,
            timeouts: 0,
            oversized: 0,
            promptWaits: 3,
          },
        })}
        developmentBuild={false}
      />
    );
    const text = row("Calls to the plugin").textContent ?? "";
    expect(text).toContain("Not timed");
    expect(text).toContain("3 waited on a prompt");
    expect(text).not.toContain("p50");
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
    expect(screen.queryByText("Last view first frame")).toBeNull();
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

  it("says so when every class matches a plugin utility", () => {
    styleState.current = { status: "ready", report: { generated: ["p-4"], notGenerated: [] } };
    render(<PluginStylesSection pluginId="acme.demo" />);
    expect(
      screen.getByText(/Every class in this plugin’s open panels matches a Daintree plugin utility/)
    ).toBeTruthy();
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
