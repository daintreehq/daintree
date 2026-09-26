// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HostCard } from "../HostCard";
import { makeRow, makeSummary } from "./fixtures";

describe("HostCard", () => {
  it("shows a connected host's load, observed agents, version, link and driver", () => {
    const summary = makeSummary({
      driver: {
        leaseId: 1,
        endpointId: "e",
        clientId: "c",
        clientName: "greg-mbp",
        isHostLocal: false,
        acquiredAt: 1,
      },
      agentClis: [{ agentId: "claude", version: "2.1.0" }],
    });
    render(<HostCard row={makeRow({ summary })} history={[summary]} onSwitch={() => {}} />);
    const card = screen.getByTestId("host-overview-card");
    expect(card.textContent).toContain("CPU 20%");
    expect(card.textContent).toContain("Memory normal");
    expect(card.textContent).toContain("1 working · 2 waiting · 3 idle (observed)");
    expect(card.textContent).toContain("0.38.0");
    expect(card.textContent).toContain("12 ms link");
    expect(card.textContent).toContain("Driven from greg-mbp");
    expect(card.textContent).toContain("2.1.0");
    expect(screen.getAllByTestId("host-sparkline")).toHaveLength(2);
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
    expect(card.textContent).toContain("Memory not measured");
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
    expect(screen.getByTestId("host-overview-status").textContent).toMatch(
      /^Unreachable · last seen 2 hours ago$/
    );
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
    const buttons = list.querySelectorAll("button");
    expect(buttons).toHaveLength(6);
    expect(buttons[0]!.textContent).toBe("project-a");
    expect(list.textContent).toContain("and 2 more");
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
    expect(screen.getByTestId("host-overview-projects").textContent).toBe(
      `No projects on ${row.name} yet.`
    );
    rerender(<HostCard row={row} history={[]} onSwitch={() => {}} />);
    expect(screen.queryByTestId("host-overview-projects")).toBeNull();
  });
});
