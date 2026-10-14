import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const broadcastToRenderer = vi.hoisted(() => vi.fn());
const running = vi.hoisted(() => new Map<string, { sessionId: string; terminalId: string }>());

vi.mock("../../../ipc/utils.js", () => ({ broadcastToRenderer }));
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    getRunningLaneSession: (projectId: string, slot: number) =>
      running.get(`${projectId}:${slot}`) ?? null,
    addSessionEndedListener: () => () => {},
  },
}));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => ({ getLiveGeneration: () => 1 }),
}));

import { CHANNELS } from "../../../ipc/channels.js";
import { getRemoteService } from "../../runtime.js";
import { installAssistantMessagingPolicy } from "../install.js";

describe("installAssistantMessagingPolicy", () => {
  let hosts: string[];
  let hostListeners: Set<() => void>;
  let uninstall: (() => void) | null = null;

  const install = () =>
    (uninstall = installAssistantMessagingPolicy({
      isHostMessagingEnabled: () => false,
      hasHosts: () => hosts.length > 0,
      onHostsChanged: (listener) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    }));
  const hostsChanged = () => {
    for (const listener of [...hostListeners]) listener();
  };
  const pushes = () =>
    broadcastToRenderer.mock.calls
      .filter(([channel]) => channel === CHANNELS.ASSISTANT_MESSAGING_CHANGED)
      .map(([, event]) => (event as { revision: number }).revision);

  beforeEach(() => {
    broadcastToRenderer.mockClear();
    running.clear();
    hosts = [];
    hostListeners = new Set();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("pushes once on install, so a view that read it as missing reads it again", () => {
    install();
    expect(pushes()).toEqual([1]);
    expect(getRemoteService("assistantMessagingSurface")?.revision()).toBe(1);
  });

  it("pushes a fresh revision on every policy change", () => {
    install();
    getRemoteService("assistantMessagingPolicy")!.setPaused(true);
    running.set("proj:0", { sessionId: "s1", terminalId: "t1" });
    getRemoteService("assistantMessagingPolicy")!.enroll(
      { projectId: "proj", slot: 0 },
      { kind: "local" }
    );
    expect(pushes()).toEqual([1, 2, 3]);
  });

  it("pushes only when the first host arrives or the last one goes", () => {
    install();
    expect(getRemoteService("assistantMessagingSurface")?.hasHosts()).toBe(false);
    hosts = ["a"];
    hostsChanged();
    hosts = ["a", "b"];
    hostsChanged();
    hosts = [];
    hostsChanged();
    expect(pushes()).toEqual([1, 2, 3]);
  });

  it("unregisters both services and stops listening on teardown", () => {
    install();
    uninstall!();
    uninstall = null;
    expect(getRemoteService("assistantMessagingPolicy")).toBeUndefined();
    expect(getRemoteService("assistantMessagingSurface")).toBeUndefined();
    expect(hostListeners.size).toBe(0);
    hosts = ["a"];
    hostsChanged();
    expect(pushes()).toEqual([1]);
  });
});
