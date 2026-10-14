import { afterEach, describe, expect, it } from "vitest";
import {
  _resetTerminalInputGateForTesting,
  getTerminalInputBlock,
  isHostSwitchPending,
} from "@/services/terminal/inputGate";
import { usePendingHostSwitchStore } from "../pendingHostSwitchStore";

const PENDING = {
  switchId: "s-1",
  hostId: "studio-02",
  hostName: "studio-02",
  projectName: null,
  phase: "connecting",
} as const;

afterEach(() => {
  usePendingHostSwitchStore.getState().setPending(null);
  _resetTerminalInputGateForTesting();
});

describe("pendingHostSwitchStore", () => {
  it("holds typing back from the moment a switch is pending, before any progress shows", () => {
    usePendingHostSwitchStore.getState().setPending(PENDING);
    expect(isHostSwitchPending()).toBe(true);
    expect(getTerminalInputBlock()).toEqual({ kind: "switching", hostName: "studio-02" });
  });

  it("keeps typing held across a phase change and a replacing switch, and lets it go when none is left", () => {
    const store = usePendingHostSwitchStore.getState();
    store.setPending(PENDING);
    store.setPending({ ...PENDING, phase: "opening", projectName: "App" });
    expect(isHostSwitchPending()).toBe(true);
    store.setPending({ ...PENDING, switchId: "s-2", hostId: "studio-03", hostName: "studio-03" });
    expect(getTerminalInputBlock()).toEqual({ kind: "switching", hostName: "studio-03" });
    store.setPending(null);
    expect(isHostSwitchPending()).toBe(false);
    expect(getTerminalInputBlock()).toBeNull();
  });
});
