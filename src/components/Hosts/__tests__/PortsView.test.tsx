// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortForward, PortForwardsEvent } from "@shared/types/ipc/portForwards";

vi.mock("../hostList", () => ({
  useHostList: () => ({
    // Forwarding picks among connected hosts.
    hosts: [
      { descriptor: { id: "studio-01", name: "Studio" }, connection: { status: "connected" } },
    ],
    localSummary: null,
  }),
}));

import { PortsView } from "../PortsView";

const forwardRow = (overrides: Partial<PortForward> = {}): PortForward => ({
  forwardId: "f1",
  hostId: "studio-01",
  remotePort: 5173,
  localPort: 5173,
  origin: "dev-preview",
  label: null,
  createdAt: 1,
  ...overrides,
});

let emit: ((event: PortForwardsEvent) => void) | null = null;
const api = {
  list: vi.fn(() => Promise.resolve([forwardRow()])),
  forward: vi.fn(() => Promise.resolve(forwardRow({ forwardId: "f2", remotePort: 8080 }))),
  stop: vi.fn(() => Promise.resolve()),
  listHostPorts: vi.fn(() =>
    Promise.resolve([
      { port: 5173, processName: "node", pid: 1 },
      { port: 9229, processName: "node", pid: 2 },
    ])
  ),
  onEvent: vi.fn((callback: (event: PortForwardsEvent) => void) => {
    emit = callback;
    return () => {
      emit = null;
    };
  }),
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { portForwards: api },
  });
});

describe("PortsView", () => {
  it("lists active forwards and offers detected ports that aren't forwarded yet", async () => {
    render(<PortsView hostId="studio-01" />);
    const row = (await screen.findByText("localhost:5173")).closest("tr")!;
    expect(row.textContent).toContain("Studio");
    expect(row.textContent).toContain("Dev preview");
    const detected = await screen.findByRole("table", { name: "Ports listening on Studio" });
    expect(detected.textContent).toContain("9229");
    expect(detected.textContent).not.toContain("5173");
  });

  it("forwards a typed port and a detected one, and stops a forward", async () => {
    render(<PortsView hostId="studio-01" />);
    await screen.findByText("localhost:5173");

    fireEvent.change(screen.getByLabelText("Port on Studio"), { target: { value: "8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Forward port" }));
    expect(api.forward).toHaveBeenCalledWith({
      hostId: "studio-01",
      remotePort: 8080,
      origin: "manual",
    });

    const detected = await screen.findByRole("table", { name: "Ports listening on Studio" });
    fireEvent.click(detected.querySelector("button")!);
    expect(api.forward).toHaveBeenCalledWith({
      hostId: "studio-01",
      remotePort: 9229,
      origin: "detected",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Stop forwarding localhost:5173 from Studio" })
    );
    expect(api.stop).toHaveBeenCalledWith({ forwardId: "f1" });
  });

  it("says a dev preview forward's origin once, and keeps a label that adds something", async () => {
    api.list.mockResolvedValueOnce([
      forwardRow({ label: "Dev preview" }),
      forwardRow({
        forwardId: "f9",
        remotePort: 3000,
        localPort: 3001,
        label: "web",
        origin: "manual",
      }),
    ]);
    render(<PortsView hostId="studio-01" />);
    const row = (await screen.findByText("localhost:5173")).closest("tr")!;
    const originCell = (tr: Element) => tr.querySelectorAll("td")[4]!;
    expect(originCell(row).textContent).toBe("Dev preview");
    const labelled = screen.getByText("localhost:3001").closest("tr")!;
    expect(originCell(labelled).textContent).toBe("web · Forwarded by you");
  });

  it("rejects a port out of range without asking main", async () => {
    render(<PortsView hostId="studio-01" />);
    fireEvent.change(screen.getByLabelText("Port on Studio"), { target: { value: "70000" } });
    fireEvent.click(screen.getByRole("button", { name: "Forward port" }));
    expect((await screen.findByRole("alert")).textContent).toContain("1 to 65535");
    expect(api.forward).not.toHaveBeenCalled();
  });

  it("follows forward changes pushed from main", async () => {
    render(<PortsView />);
    await screen.findByText("localhost:5173");
    act(() => emit?.({ type: "changed", forwards: [] }));
    expect(screen.queryByText("localhost:5173")).toBeNull();
    // With no host of its own, it forwards from the first connected one.
    expect(api.listHostPorts).toHaveBeenCalledWith({ hostId: "studio-01" });
  });
});
