// @vitest-environment jsdom
import type { ReactElement } from "react";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { describe, expect, it, vi } from "vitest";
import { HostCard } from "../HostCard";
import { makeRow, makeSummary } from "./fixtures";

// The app mounts one TooltipProvider at its root; truncated text discloses through it.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

/** The value the card's facts list gives `label`, or null when it lists none. */
function fact(card: HTMLElement, label: string): string | null {
  const term = [...card.querySelectorAll("dt")].find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent ?? null;
}

describe("HostCard", () => {
  it("shows a connected host's load, observed agents, link and driver", () => {
    const summary = makeSummary({
      driver: {
        leaseId: 1,
        endpointId: "e",
        clientId: "c",
        clientName: "greg-mbp",
        isHostLocal: false,
        acquiredAt: 1,
      },
    });
    render(
      <HostCard
        row={makeRow({ summary })}
        history={[summary, summary, summary]}
        onSwitch={() => {}}
      />
    );
    const card = screen.getByTestId("host-overview-card");
    expect(card.textContent).toContain("CPU 20%");
    // An older host's used bytes count the file cache: it keeps the pressure chart.
    expect(card.textContent).toContain("Memory pressure normal");
    expect(fact(card, "Memory")).toBe("4 GB of 16 GB");
    expect(card.textContent).toContain("1 working · 2 waiting · 3 idle (observed)");
    expect(fact(card, "Link")).toBe("12 ms");
    expect(fact(card, "Control")).toBe("greg-mbp has control");
    expect(screen.getAllByTestId("host-sparkline")).toHaveLength(2);
  });

  it("names every launch driving the host, not only the newest", () => {
    const holder = (clientId: string, clientName: string) => ({
      leaseId: 1,
      endpointId: `${clientId}:e`,
      clientId,
      clientName,
      isHostLocal: false,
      acquiredAt: 1,
    });
    const summary = makeSummary({
      driver: holder("c2", "studio-02"),
      drivers: [
        {
          projectId: "p2",
          projectName: "site",
          holder: holder("c2", "studio-02"),
          state: "live",
          awayUntil: null,
        },
        {
          projectId: "p1",
          projectName: "daintree",
          holder: holder("c1", "greg-mbp"),
          state: "away",
          awayUntil: 5,
        },
      ],
    });
    render(<HostCard row={makeRow({ summary })} history={[summary]} onSwitch={() => {}} />);
    expect(fact(screen.getByTestId("host-overview-card"), "Control")).toBe(
      "studio-02 and greg-mbp (away) have control"
    );
  });

  it("reads CPU in cores and adds load, cluster and stall facts where the host reports them", () => {
    const summary = makeSummary({
      platform: "darwin",
      cpuPercent: 50,
      cpuLogicalCoreCount: 14,
      cpuLoadAverage1m: 6.214,
      cpuPerformanceCoreCount: 10,
      cpuEfficiencyCoreCount: 4,
      cpuPerformancePercent: 61.6,
      cpuEfficiencyPercent: 18.2,
      cpuPressure: 3.25,
      memoryPressure: "warn",
      memoryUsedBytes: 20.1 * 1024 ** 3,
      memoryTotalBytes: 36 * 1024 ** 3,
    });
    render(<HostCard row={makeRow({ summary })} history={[summary]} onSwitch={() => {}} />);
    const card = screen.getByTestId("host-overview-card");
    expect(card.textContent).toContain("CPU 7 of 14 cores");
    expect(card.textContent).toContain("Memory 20.1 / 36 GB");
    expect(fact(card, "Memory pressure")).toBe("High");
    expect(fact(card, "Load (1 min)")).toBe("6.21");
    expect(fact(card, "Core clusters")).toBe("Performance 62% · efficiency 18%");
    expect(fact(card, "CPU pressure")).toBe("3.3% of the last 10 s stalled");
  });

  it("charts memory in use for a host on the newer memory reading", () => {
    const GB = 1024 ** 3;
    // Pressure stays normal while use climbs: a pressure chart would be flat.
    const history = [12, 8, 4].map((used) =>
      makeSummary({ cpuLogicalCoreCount: null, memoryUsedBytes: used * GB })
    );
    render(
      <HostCard row={makeRow({ summary: history[0] })} history={history} onSwitch={() => {}} />
    );
    const card = screen.getByTestId("host-overview-card");
    expect(card.textContent).toContain("CPU 20%");
    expect(card.textContent).toContain("Memory 12 / 16 GB");
    expect(fact(card, "Memory pressure")).toBe("Normal");
    expect(fact(card, "Memory")).toBeNull();
    const chart = screen.getByLabelText(/Memory in use over the last/);
    const heights = (chart.querySelector("polyline")?.getAttribute("points") ?? "")
      .split(" ")
      .map((point) => Number(point.split(",")[1]));
    expect(heights).toHaveLength(3);
    // Oldest first, rising use draws lower y values.
    expect(heights[0]).toBeGreaterThan(heights[1]!);
    expect(heights[1]).toBeGreaterThan(heights[2]!);
  });

  it("keeps the capacity chart through a missed memory read", () => {
    const newer = { cpuLogicalCoreCount: 8, memoryPressure: "warn" as const };
    const history = [
      makeSummary({ ...newer, memoryUsedBytes: null }),
      makeSummary(newer),
      makeSummary(newer),
      makeSummary(newer),
    ];
    render(
      <HostCard row={makeRow({ summary: history[0] })} history={history} onSwitch={() => {}} />
    );
    const card = screen.getByTestId("host-overview-card");
    expect(card.textContent).toContain("Memory not measured");
    expect(card.textContent).not.toContain("Memory pressure warn");
    expect(fact(card, "Memory pressure")).toBe("High");
    expect(screen.getByLabelText(/Memory in use over the last/)).toBeTruthy();
    expect(fact(card, "Load (1 min)")).toBeNull();
    expect(fact(card, "Core clusters")).toBeNull();
    expect(fact(card, "CPU pressure")).toBeNull();
  });

  it("shows swap activity beside swap in use, and no row where it wasn't measured", () => {
    const measured = makeSummary({
      swapTotalBytes: 8 * 1024 ** 3,
      swapUsedBytes: 3 * 1024 ** 3,
      swapInBytesPerSec: 12 * 1024,
      swapOutBytesPerSec: 0,
    });
    const { unmount } = render(
      <HostCard row={makeRow({ summary: measured })} history={[measured]} onSwitch={() => {}} />
    );
    let card = screen.getByTestId("host-overview-card");
    expect(fact(card, "Swap")).toBe("3 GB of 8 GB");
    expect(fact(card, "Swap activity")).toBe("In 12 KB/s · out 0 B/s");
    unmount();

    const legacy = makeSummary({ swapTotalBytes: 8 * 1024 ** 3, swapUsedBytes: 3 * 1024 ** 3 });
    render(<HostCard row={makeRow({ summary: legacy })} history={[legacy]} onSwitch={() => {}} />);
    card = screen.getByTestId("host-overview-card");
    expect(fact(card, "Swap")).toBe("3 GB of 8 GB");
    expect(fact(card, "Swap activity")).toBeNull();
  });

  it("draws no trend until it has a few samples", () => {
    const summary = makeSummary();
    render(<HostCard row={makeRow({ summary })} history={[summary]} onSwitch={() => {}} />);
    expect(screen.queryAllByTestId("host-sparkline")).toHaveLength(0);
    expect(screen.getAllByText("Collecting history…")).toHaveLength(2);
  });

  it("leaves metrics the host doesn't report absent instead of zero", () => {
    const summary = makeSummary({
      cpuPercent: null,
      memoryPressure: null,
      swapTotalBytes: null,
      swapUsedBytes: null,
      thermal: null,
      memoryUsedBytes: null,
    });
    render(<HostCard row={makeRow({ summary })} history={[summary]} onSwitch={() => {}} />);
    const card = screen.getByTestId("host-overview-card");
    expect(card.textContent).toContain("CPU not measured");
    expect(card.textContent).toContain("Memory pressure not measured");
    expect(card.textContent).not.toContain("Swap");
    expect(card.textContent).not.toContain("Thermal");
    expect(card.textContent).not.toMatch(/CPU 0%/);
  });

  it("says what the link last saw for an unreachable host and shows no stale numbers", () => {
    const now = Date.now();
    const row = makeRow({
      connection: { status: "unreachable", lastSeenAt: now - 2 * 60 * 60 * 1000, detail: null },
      lastSeenAt: now - 2 * 60 * 60 * 1000,
    });
    render(<HostCard row={row} history={[makeSummary()]} onSwitch={() => {}} />);
    const card = screen.getByTestId("host-overview-card");
    expect(card.getAttribute("data-live")).toBe("false");
    expect(screen.getByTestId("host-overview-status").textContent).toBe("Unreachable");
    expect(card.textContent).toContain("Last seen 2 hours ago");
    expect(screen.queryAllByTestId("host-sparkline")).toHaveLength(0);
    expect(card.textContent).not.toContain("working");
  });

  it("switches to the host on click, in a new window with the modifier", () => {
    const onSwitch = vi.fn();
    render(<HostCard row={makeRow()} history={[]} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to studio-01" }));
    expect(onSwitch).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Switch to studio-01" }), {
      metaKey: true,
      ctrlKey: true,
    });
    expect(onSwitch).toHaveBeenLastCalledWith(true);
  });

  it("lists the host's projects, bounded, each opening on that host", () => {
    const projects = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      name: `project-${String.fromCharCode(104 - i)}`,
      path: `/srv/p${i}`,
    }));
    const onOpenProject = vi.fn();
    const row = makeRow({});
    render(
      <HostCard
        row={row}
        history={[]}
        onSwitch={() => {}}
        projects={projects}
        onOpenProject={onOpenProject}
      />
    );
    const list = screen.getByTestId("host-overview-projects");
    const opens = () => list.querySelectorAll("li button");
    expect(opens()).toHaveLength(6);
    expect(opens()[0]!.textContent).toBe("project-a");
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more projects" }));
    expect(opens()).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: `Open project-a on ${row.name}` }), {
      metaKey: true,
      ctrlKey: true,
    });
    expect(onOpenProject).toHaveBeenCalledWith("p7", true);
  });

  it("says a host has no projects yet, and lists nothing it hasn't read", () => {
    const row = makeRow({});
    const { rerender } = render(
      <HostCard row={row} history={[]} onSwitch={() => {}} projects={[]} />
    );
    expect(
      within(screen.getByTestId("host-overview-projects")).getByText(
        `No projects on ${row.name} yet`
      )
    ).toBeTruthy();
    rerender(<HostCard row={row} history={[]} onSwitch={() => {}} />);
    expect(screen.queryByTestId("host-overview-projects")).toBeNull();
  });
});
