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
    expect(card.textContent).toContain("Memory pressure normal");
    expect(card.textContent).toContain("1 working · 2 waiting · 3 idle (observed)");
    expect(fact(card, "Link")).toBe("12 ms");
    expect(fact(card, "Driving")).toBe("Driven from greg-mbp");
    expect(screen.getAllByTestId("host-sparkline")).toHaveLength(2);
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
