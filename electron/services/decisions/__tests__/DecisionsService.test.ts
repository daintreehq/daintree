import { describe, expect, it, vi } from "vitest";
import { DecisionsService } from "../DecisionsService.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";
import type {
  DecisionsSettings,
  DecisionsStatusEvent,
} from "../../../../shared/types/decisions.js";

function on(overrides: Partial<DecisionsSettings> = {}): DecisionsSettings {
  return { ...defaultDecisionsSettings(), enabled: true, ...overrides };
}

function recordStates(service: DecisionsService): string[] {
  const states: string[] = [];
  service.onStatusChanged((event: DecisionsStatusEvent) => states.push(event.status.state));
  return states;
}

describe("DecisionsService", () => {
  it("is off until started, and on without a relay is not connected", async () => {
    const service = new DecisionsService();
    expect(service.getStatus()).toEqual({ state: "off" });

    await service.start(on());

    expect(service.getStatus()).toEqual({ state: "not-connected" });
    expect(service.getSettings()?.enabled).toBe(true);
  });

  it("starts nothing for settings that are off", async () => {
    const service = new DecisionsService();
    const states = recordStates(service);

    await service.start(defaultDecisionsSettings());

    expect(service.getStatus().state).toBe("off");
    expect(service.getSettings()).toBeNull();
    expect(states).toEqual([]);
  });

  it("reports each change once, and a repeat start is no change", async () => {
    const service = new DecisionsService();
    const states = recordStates(service);

    await service.start(on());
    await service.start(on({ proxyAllowlisted: true }));
    await service.stop();
    await service.stop();

    expect(states).toEqual(["not-connected", "off"]);
  });

  it("carries the newest settings when started again while running", async () => {
    const service = new DecisionsService();
    await service.start(on());
    await service.start(on({ relayOrigin: "https://relay.example.com" }));

    expect(service.getSettings()?.relayOrigin).toBe("https://relay.example.com");
  });

  it("can start again after a stop, and keeps its listeners across it", async () => {
    const service = new DecisionsService();
    const states = recordStates(service);

    await service.start(on());
    await service.stop();
    await service.start(on());

    expect(service.getStatus().state).toBe("not-connected");
    expect(states).toEqual(["not-connected", "off", "not-connected"]);
  });

  it("runs transitions in the order asked, without waiting between calls", async () => {
    const service = new DecisionsService();
    const states = recordStates(service);

    const steps = [service.start(on()), service.stop(), service.start(on())];
    await Promise.all(steps);

    expect(states).toEqual(["not-connected", "off", "not-connected"]);
  });

  it("refuses a start still queued when dispose is asked, and every start after", async () => {
    const service = new DecisionsService();
    const states = recordStates(service);

    const queued = service.start(on());
    const disposing = service.dispose();
    await Promise.all([queued, disposing]);
    await service.start(on());

    expect(service.getStatus().state).toBe("off");
    expect(states).toEqual([]);
  });

  it("reports off once on dispose, then drops its listeners", async () => {
    const service = new DecisionsService();
    const states = recordStates(service);
    await service.start(on());

    await service.dispose();
    await service.dispose();

    expect(states).toEqual(["not-connected", "off"]);
  });

  it("stops telling a listener that unsubscribed", async () => {
    const service = new DecisionsService();
    const listener = vi.fn();
    const off = service.onStatusChanged(listener);
    off();
    off();

    await service.start(on());

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps telling the others when one listener throws", async () => {
    const service = new DecisionsService();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    service.onStatusChanged(() => {
      throw new Error("listener broke");
    });
    const states = recordStates(service);

    await service.start(on());

    expect(states).toEqual(["not-connected"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("hands status out as a copy, never its own record", async () => {
    const service = new DecisionsService();
    const read = service.getStatus();
    read.state = "connected";

    expect(service.getStatus().state).toBe("off");
  });

  it("binds every published Decisions library", () => {
    const { libraries } = new DecisionsService();

    expect(typeof libraries.protocol.PROTOCOL_VERSION).toBe("number");
    expect(typeof libraries.client.RelaySocket).toBe("function");
    expect(Object.keys(libraries.crypto).length).toBeGreaterThan(0);
    expect(Object.keys(libraries.model).length).toBeGreaterThan(0);
  });

  it("forgets the lifetime's settings on stop and on dispose", async () => {
    const service = new DecisionsService();
    await service.start(on());
    await service.stop();
    expect(service.getSettings()).toBeNull();

    await service.start(on());
    await service.dispose();
    expect(service.getSettings()).toBeNull();
  });

  it("runs the next transition after one that failed", async () => {
    const service = new DecisionsService();
    const unreadable = {
      ...on(),
      get enabled(): boolean {
        throw new Error("unreadable settings");
      },
    } as DecisionsSettings;

    await expect(service.start(unreadable)).rejects.toThrow("unreadable settings");
    await service.start(on());

    expect(service.getStatus().state).toBe("not-connected");
  });
});
