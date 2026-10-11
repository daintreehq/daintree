// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { HostModeEvent, HostModeStatus } from "@shared/types/ipc/hostMode";

const supported = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/remoteHosts", () => ({ isRemoteHostSupported: () => supported.value }));

import { AttachedMachinesIndicator } from "../AttachedMachinesIndicator";

function status(overrides: Partial<HostModeStatus> = {}): HostModeStatus {
  return {
    supported: true,
    enabled: true,
    startAtLogin: true,
    socketPath: "/tmp/host.sock",
    listening: true,
    attachedClients: [],
    rows: [],
    ...overrides,
  };
}

const machine = (name: string, driving: string[] = []) => ({
  clientId: `id-${name}`,
  clientName: name,
  connectedAt: Date.now() - 60_000,
  drivingProjectIds: driving,
});

let push: ((event: HostModeEvent) => void) | null = null;
let getStatus: ReturnType<typeof vi.fn>;

beforeEach(() => {
  supported.value = true;
  push = null;
  getStatus = vi.fn(async () => status());
  Object.defineProperty(window, "electron", {
    value: {
      hostMode: {
        getStatus,
        onEvent: (callback: (event: HostModeEvent) => void) => {
          push = callback;
          return () => {
            push = null;
          };
        },
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
});

const pill = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-testid='attached-machines-indicator']");

describe("AttachedMachinesIndicator", () => {
  it("appears while another machine is attached and goes when it disconnects", async () => {
    getStatus.mockResolvedValue(status({ attachedClients: [machine("greg-mbp", ["p1"])] }));
    const { container } = render(<AttachedMachinesIndicator />);
    await act(async () => {});
    expect(pill(container)?.textContent).toBe("In use from greg-mbp");

    act(() => push?.({ type: "status-changed", status: status({ attachedClients: [] }) }));
    expect(pill(container)).toBeNull();
  });

  it("counts several machines and says nothing while Host mode isn't listening", async () => {
    getStatus.mockResolvedValue(
      status({ attachedClients: [machine("greg-mbp"), machine("studio-02")] })
    );
    const { container } = render(<AttachedMachinesIndicator />);
    await act(async () => {});
    expect(pill(container)?.textContent).toBe("In use from 2 machines");

    act(() =>
      push?.({
        type: "status-changed",
        status: status({ listening: false, attachedClients: [machine("greg-mbp")] }),
      })
    );
    expect(pill(container)).toBeNull();
  });

  it("never lets the first status read, answered late, undo a newer push", async () => {
    let answer: (value: HostModeStatus) => void = () => {};
    getStatus.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { container } = render(<AttachedMachinesIndicator />);
    await act(async () => {});
    act(() => push?.({ type: "status-changed", status: status({ attachedClients: [] }) }));
    await act(async () => answer(status({ attachedClients: [machine("greg-mbp")] })));
    expect(pill(container)).toBeNull();
  });

  it("never shows in a window running on another host, and asks nothing there", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    getStatus.mockResolvedValue(status({ attachedClients: [machine("greg-mbp")] }));
    const { container } = render(<AttachedMachinesIndicator />);
    await act(async () => {});
    expect(pill(container)).toBeNull();
    expect(getStatus).not.toHaveBeenCalled();
  });
});
