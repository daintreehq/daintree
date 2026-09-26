// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortForward, PortForwardsEvent } from "@shared/types/ipc/portForwards";

vi.mock("../hostList", () => ({
  useHostList: () => ({
    hosts: [{ descriptor: { id: "studio-01", name: "Studio" } }],
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
    expect(await screen.findByText("localhost:5173")).toBeTruthy();
    expect(screen.getByText(/port 5173 on Studio · Dev preview/)).toBeTruthy();
    const detected = await screen.findByRole("list", { name: "Detected ports" });
    expect(detected.textContent).toContain("9229");
    expect(detected.textContent).not.toContain("5173");
  });

  it("forwards a typed port and a detected one, and stops a forward", async () => {
    render(<PortsView hostId="studio-01" />);
    await screen.findByText("localhost:5173");

    fireEvent.change(screen.getByLabelText("Port on the host"), { target: { value: "8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Forward port" }));
    expect(api.forward).toHaveBeenCalledWith({
      hostId: "studio-01",
      remotePort: 8080,
      origin: "manual",
    });

    const detected = await screen.findByRole("list", { name: "Detected ports" });
    fireEvent.click(detected.querySelector("button")!);
    expect(api.forward).toHaveBeenCalledWith({
      hostId: "studio-01",
      remotePort: 9229,
      origin: "detected",
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop forwarding port 5173" }));
    expect(api.stop).toHaveBeenCalledWith({ forwardId: "f1" });
  });

  it("rejects a port out of range without asking main", async () => {
    render(<PortsView hostId="studio-01" />);
    fireEvent.change(screen.getByLabelText("Port on the host"), { target: { value: "70000" } });
    fireEvent.click(screen.getByRole("button", { name: "Forward port" }));
    expect((await screen.findByRole("alert")).textContent).toContain("1 to 65535");
    expect(api.forward).not.toHaveBeenCalled();
  });

  it("follows forward changes pushed from main", async () => {
    render(<PortsView />);
    await screen.findByText("localhost:5173");
    act(() => emit?.({ type: "changed", forwards: [] }));
    expect(screen.queryByText("localhost:5173")).toBeNull();
    expect(api.listHostPorts).not.toHaveBeenCalled();
  });
});
