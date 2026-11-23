import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUsageSnapshot } from "../../../../shared/types/ipc/agentUsage.js";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

const fakeStore = vi.hoisted(() => {
  let data: Record<string, unknown> = {};
  return {
    reset(initial: Record<string, unknown>) {
      data = { ...initial };
    },
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  };
});
vi.mock("../../../store.js", () => ({ store: fakeStore }));

const broadcast = vi.hoisted(() => vi.fn());
vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  broadcastToRenderer: broadcast,
}));

const readouts = vi.hoisted(() => ({
  follow: vi.fn((_followerId: number): AgentUsageSnapshot => ({ readouts: [], revision: 1 })),
  unfollow: vi.fn(),
}));
vi.mock("../../../services/agentUsage/AgentUsageReadouts.js", () => ({
  getAgentUsageReadouts: () => readouts,
}));
vi.mock("../../../window/webContentsDestroyed.js", () => ({
  onWebContentsDestroyed: () => () => {},
}));

import { agentUsageNamespace, registerAgentUsageHandlers } from "../agentUsage.js";
import {
  _resetAgentUsageTrackingForTests,
  isAgentUsageTrackingEnabled,
  setAgentUsageTracking,
} from "../../../services/agentUsage/AgentUsageTracking.js";
import { CHANNELS } from "../../channels.js";

type Sender = {
  id: number;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};

function sender(id: number): Sender {
  return { id, on: vi.fn(), removeListener: vi.fn() };
}

const setFollowing = agentUsageNamespace.ops.setFollowing.handler as unknown as (
  ctx: { event: { sender: Sender } },
  payload: { following: boolean }
) => Promise<AgentUsageSnapshot | null>;
const getTracking = agentUsageNamespace.ops.getTracking.handler as unknown as () => Promise<{
  enabled: boolean;
  revision: number;
}>;
const setTracking = agentUsageNamespace.ops.setTracking.handler as unknown as (payload: {
  enabled: boolean;
}) => Promise<{ enabled: boolean; revision: number }>;

let unregister: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  fakeStore.reset({});
  _resetAgentUsageTrackingForTests();
  unregister = registerAgentUsageHandlers();
});

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("agent usage tracking switch (#17981)", () => {
  it("reads as on until it is turned off, then as off", async () => {
    expect(isAgentUsageTrackingEnabled()).toBe(true);
    await expect(getTracking()).resolves.toEqual({ enabled: true, revision: 0 });
    await setTracking({ enabled: false });
    expect(isAgentUsageTrackingEnabled()).toBe(false);
    await expect(getTracking()).resolves.toEqual({ enabled: false, revision: 1 });
  });

  it("stores and pushes a change, and treats a repeat as no change", async () => {
    await expect(setTracking({ enabled: false })).resolves.toEqual({
      enabled: false,
      revision: 1,
    });
    expect(fakeStore.set).toHaveBeenCalledWith("agentUsageTrackingEnabled", false);
    expect(broadcast).toHaveBeenCalledWith(CHANNELS.AGENT_USAGE_TRACKING_CHANGED, {
      enabled: false,
      revision: 1,
    });
    broadcast.mockClear();
    await expect(setTracking({ enabled: false })).resolves.toEqual({
      enabled: false,
      revision: 1,
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(fakeStore.set).toHaveBeenCalledTimes(1);
  });

  it("refuses a value that isn't on or off, at the IPC boundary and in the service", () => {
    const schema = agentUsageNamespace.ops.setTracking.schema;
    expect(schema.safeParse({ enabled: "off" }).success).toBe(false);
    expect(schema.safeParse({ enabled: false, extra: true }).success).toBe(false);
    expect(schema.safeParse({ enabled: false }).success).toBe(true);
    expect(() => setAgentUsageTracking("off" as unknown as boolean)).toThrow();
    expect(fakeStore.set).not.toHaveBeenCalled();
  });

  it("refuses a follow while off, before watching the view or the agents", async () => {
    fakeStore.reset({ agentUsageTrackingEnabled: false });
    const view = sender(7);
    await expect(setFollowing({ event: { sender: view } }, { following: true })).resolves.toBe(
      null
    );
    expect(readouts.follow).not.toHaveBeenCalled();
    expect(view.on).not.toHaveBeenCalled();
  });

  it("turning off releases every following view before any view hears of it", async () => {
    const a = sender(1);
    const b = sender(2);
    await setFollowing({ event: { sender: a } }, { following: true });
    await setFollowing({ event: { sender: b } }, { following: true });
    expect(readouts.follow).toHaveBeenCalledTimes(2);

    await setTracking({ enabled: false });
    expect(readouts.unfollow.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    // Every listener a follow put on its view comes off with it.
    for (const view of [a, b]) {
      expect(view.on).toHaveBeenCalled();
      expect(view.removeListener.mock.calls).toEqual(view.on.mock.calls);
    }
    const lastRelease = Math.max(...readouts.unfollow.mock.invocationCallOrder);
    expect(broadcast.mock.invocationCallOrder[0]).toBeGreaterThan(lastRelease);

    // A view's own release arriving late has nothing left to give back.
    await setFollowing({ event: { sender: a } }, { following: false });
    expect(readouts.unfollow).toHaveBeenCalledTimes(2);
  });

  it("follows again once turned back on, without a restart", async () => {
    const view = sender(3);
    await setFollowing({ event: { sender: view } }, { following: true });
    await setTracking({ enabled: false });
    expect(readouts.unfollow).toHaveBeenCalledWith(3);
    await expect(setFollowing({ event: { sender: view } }, { following: true })).resolves.toBe(
      null
    );
    await setTracking({ enabled: true });
    await expect(setFollowing({ event: { sender: view } }, { following: true })).resolves.toEqual({
      readouts: [],
      revision: 1,
    });
    expect(readouts.follow.mock.calls.map(([id]) => id)).toEqual([3, 3]);
  });
});
