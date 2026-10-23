// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostSettingsSnapshot,
  HostSettingsUpdatePayload,
  HostSettingsUpdateResult,
} from "@shared/types/hostSettings";
import { HostSettingsSection } from "../HostSettingsSection";

const api = {
  read: vi.fn<(payload: { hostId: string }) => Promise<HostSettingsSnapshot>>(),
  update: vi.fn<(payload: HostSettingsUpdatePayload) => Promise<HostSettingsUpdateResult>>(),
};

function snapshot(canopyMode = "unset", idle = false): HostSettingsSnapshot {
  return {
    hostId: "studio-01",
    hostName: "Studio",
    scope: "host",
    instanceId: "launch-1",
    settings: [
      { key: "canopyMode", value: canopyMode, revision: "3" },
      { key: "agentDefaults.defaultAgent", value: "claude", revision: "r-agent" },
      { key: "agentDefaults.assistantAgentId", value: null, revision: "r-assist" },
      { key: "idleTerminalNotify.enabled", value: idle, revision: `r-idle-${idle}` },
      { key: "idleTerminalNotify.thresholdMinutes", value: 60, revision: "r-60" },
    ],
  };
}

const switchNamed = (name: string) => screen.getByRole("switch", { name });

beforeEach(() => {
  api.read.mockReset();
  api.update.mockReset();
  api.read.mockResolvedValue(snapshot());
  Object.defineProperty(window, "electron", {
    value: { hostSettings: api },
    configurable: true,
    writable: true,
  });
});

async function renderSection(connected = true) {
  await act(async () => {
    render(<HostSettingsSection hostId="studio-01" hostName="Studio" connected={connected} />);
  });
}

describe("HostSettingsSection (#14167)", () => {
  it("reads nothing and offers no controls while the host isn't connected", async () => {
    await renderSection(false);
    expect(api.read).not.toHaveBeenCalled();
    expect(screen.getByText(/Connect to Studio/)).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("shows the host's own values, and changes one named key against the revision it showed", async () => {
    api.update.mockResolvedValue({
      hostId: "studio-01",
      hostName: "Studio",
      scope: "host",
      outcome: "applied",
      confirmedBy: "reply",
      instanceId: "launch-1",
      settings: [{ key: "idleTerminalNotify.enabled", value: true, revision: "r-idle-true" }],
    });
    await renderSection();
    expect(switchNamed("Alert about idle terminals").getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(switchNamed("Alert about idle terminals"));
    });
    expect(api.update).toHaveBeenCalledWith({
      hostId: "studio-01",
      patch: { "idleTerminalNotify.enabled": true },
      expect: { instanceId: "launch-1", revisions: { "idleTerminalNotify.enabled": "r-idle-false" } },
    });
    expect(switchNamed("Alert about idle terminals").getAttribute("aria-checked")).toBe("true");
  });

  it("turns Canopy on only after the consequence is stated and agreed to", async () => {
    await renderSection();
    await act(async () => {
      fireEvent.click(switchNamed("Read agent terminals"));
    });
    expect(api.update).not.toHaveBeenCalled();
    expect(screen.getByText("Turn Canopy on for 'Studio'?")).toBeTruthy();
  });

  it("keeps a hidden Canopy from being turned on until it is shown", async () => {
    api.read.mockResolvedValue(snapshot("hidden"));
    await renderSection();
    expect(switchNamed("Show Canopy").getAttribute("aria-checked")).toBe("false");
    expect(switchNamed("Read agent terminals").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Show Canopy to turn it on")).toBeTruthy();
  });

  it("reports a change made on the host meanwhile instead of writing over it", async () => {
    api.update.mockResolvedValue({
      hostId: "studio-01",
      hostName: "Studio",
      scope: "host",
      outcome: "conflict",
      confirmedBy: null,
      instanceId: "launch-1",
      settings: [{ key: "idleTerminalNotify.enabled", value: true, revision: "r-idle-true" }],
    });
    await renderSection();
    await act(async () => {
      fireEvent.click(switchNamed("Alert about idle terminals"));
    });
    expect(screen.getByText(/changed on Studio since it was read/)).toBeTruthy();
    expect(switchNamed("Alert about idle terminals").getAttribute("aria-checked")).toBe("true");
  });

  it("reads the host again when a change went unconfirmed", async () => {
    api.update.mockResolvedValue({
      hostId: "studio-01",
      hostName: "Studio",
      scope: "host",
      outcome: "unconfirmed",
      confirmedBy: null,
      instanceId: null,
      settings: [],
    });
    await renderSection();
    await act(async () => {
      fireEvent.click(switchNamed("Alert about idle terminals"));
    });
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/didn't confirm the change/)).toBeTruthy();
  });

  it("offers a retry when the host can't be read", async () => {
    api.read.mockRejectedValueOnce(new Error("boom"));
    await renderSection();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(switchNamed("Show Canopy")).toBeTruthy();
  });
});
