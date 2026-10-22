// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DeviceAnswerEvent, DeviceAnswerStatus } from "@shared/types/ipc/deviceAnswer";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getStatus: vi.fn(),
    setEnabled: vi.fn(),
    createPairingCode: vi.fn(),
    cancelPairingCode: vi.fn(),
    revokeDevice: vi.fn(),
    onEvent: vi.fn(),
  },
}));

vi.mock("@/clients/deviceAnswerClient", () => ({ deviceAnswerClient: clientMock }));

import DeviceAnswerGroup from "../DeviceAnswerGroup";
import { TooltipProvider } from "@/components/ui/tooltip";

function makeStatus(overrides: Partial<DeviceAnswerStatus> = {}): DeviceAnswerStatus {
  return {
    enabled: false,
    listening: false,
    port: 7421,
    tailnetHost: null,
    error: null,
    pairing: null,
    devices: [],
    recentAnswers: [],
    ...overrides,
  };
}

let push: ((event: DeviceAnswerEvent) => void) | null = null;

function renderGroup(status: DeviceAnswerStatus) {
  clientMock.getStatus.mockResolvedValue(status);
  clientMock.onEvent.mockImplementation((cb: (event: DeviceAnswerEvent) => void) => {
    push = cb;
    return () => {
      push = null;
    };
  });
  return render(
    <TooltipProvider>
      <DeviceAnswerGroup />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  push = null;
});

describe("DeviceAnswerGroup", () => {
  it("turns on from the switch and keeps pairing disabled while off", async () => {
    clientMock.setEnabled.mockResolvedValue(makeStatus({ enabled: true, listening: true }));
    renderGroup(makeStatus());
    const pair = await screen.findByRole("button", { name: "Show pairing code" });
    expect(pair.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(clientMock.setEnabled).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show pairing code" }).hasAttribute("disabled")
      ).toBe(false)
    );
  });

  it("shows the pairing code with what pairing allows, and the device once it pairs", async () => {
    const on = makeStatus({ enabled: true, listening: true });
    clientMock.createPairingCode.mockResolvedValue({
      ...on,
      pairing: { code: "ABCD-EFGH", expiresAt: Date.now() + 120_000 },
    });
    renderGroup(on);
    expect(await screen.findByText(/can pick the options those screens show/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Show pairing code" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByText(/Expires in 2:00|Expires in 1:59/)).toBeTruthy();

    act(() => {
      push?.({
        type: "status-changed",
        status: {
          ...on,
          devices: [{ id: "d1", name: "Greg's phone", pairedAt: Date.now(), lastSeenAt: null }],
        },
      });
    });
    expect(await screen.findByText("Greg's phone")).toBeTruthy();
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
  });

  it("removes a device only after the confirm names it", async () => {
    const status = makeStatus({
      enabled: true,
      listening: true,
      devices: [{ id: "d1", name: "Greg's phone", pairedAt: Date.now(), lastSeenAt: null }],
    });
    clientMock.revokeDevice.mockResolvedValue(makeStatus({ enabled: true, listening: true }));
    renderGroup(status);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Greg's phone" }));
    expect(clientMock.revokeDevice).not.toHaveBeenCalled();
    expect(await screen.findByText("Remove 'Greg's phone'?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove device" }));
    await waitFor(() => expect(clientMock.revokeDevice).toHaveBeenCalledWith("d1"));
  });

  it("says why the listener isn't up on the port row", async () => {
    renderGroup(
      makeStatus({
        enabled: true,
        listening: false,
        error: "Port 7421 is in use by another app. Choose another port.",
      })
    );
    expect(await screen.findByText(/Port 7421 is in use/)).toBeTruthy();
  });

  it("lists recent answers by device and option", async () => {
    renderGroup(
      makeStatus({
        enabled: true,
        listening: true,
        recentAnswers: [
          {
            at: Date.now(),
            deviceId: "d1",
            deviceName: "Greg's phone",
            runId: "r1",
            label: "Yes",
            outcome: "answered",
          },
          {
            at: Date.now(),
            deviceId: "d1",
            deviceName: "Greg's phone",
            runId: "r1",
            hostId: "studio-03",
            hostName: "studio-03",
            label: "No",
            outcome: "answered",
          },
        ],
      })
    );
    expect(await screen.findByText("Greg's phone picked “Yes”")).toBeTruthy();
    // The same run id on a connected host is another run, named by its host.
    expect(await screen.findByText("Greg's phone picked “No” on studio-03")).toBeTruthy();
  });
});
