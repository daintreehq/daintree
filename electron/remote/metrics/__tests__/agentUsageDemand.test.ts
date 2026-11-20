import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import {
  AGENT_USAGE_DEMAND_RETRY_MS,
  installAgentUsageDemandPush,
  type AgentUsageDemandSource,
} from "../agentUsageDemand.js";
import { AgentUsageDemandSchema, MetricsLinkMethod } from "../linkMethods.js";

let dir: string;
const open: LinkSession[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const session of open.splice(0)) session.close("test done");
  await removeTempDir(dir);
});

function fakeSource(initial: boolean) {
  let enabled = initial;
  const listeners = new Set<() => void>();
  const source: AgentUsageDemandSource = {
    read: () => enabled,
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listeners,
    set(next: boolean) {
      enabled = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function fakeManager() {
  const listeners = new Set<(hostId: string, session: LinkSession) => void>();
  return {
    onSessionOpened(listener: (hostId: string, session: LinkSession) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    opened(session: LinkSession) {
      for (const listener of listeners) listener("studio", session);
    },
  };
}

/** A real session pair whose host side records every demand it's told. */
async function hostHearing() {
  const pair = await openSessionPair(dir);
  open.push(pair.host, pair.client);
  const heard: boolean[] = [];
  pair.host.registerCallHandler(
    MetricsLinkMethod.AGENT_USAGE_DEMAND,
    AgentUsageDemandSchema,
    ({ enabled }) => {
      heard.push(enabled);
      return null;
    }
  );
  return { ...pair, heard };
}

describe("agent usage demand over a link (#17981)", () => {
  it("tells each host as its session opens and on every change, and nothing when nothing changed", async () => {
    const manager = fakeManager();
    const tracking = fakeSource(false);
    const off = installAgentUsageDemandPush(manager, tracking.source);
    const host = await hostHearing();
    manager.opened(host.client);
    await waitFor(() => host.heard.length === 1);
    expect(host.heard).toEqual([false]);

    tracking.set(true);
    await waitFor(() => host.heard.length === 2);
    tracking.set(true);
    tracking.set(false);
    await waitFor(() => host.heard.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.heard).toEqual([false, true, false]);

    off();
    tracking.set(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.heard).toEqual([false, true, false]);
    expect(tracking.listeners.size).toBe(0);
  });

  it("keeps the link up when a host from before it refuses the method", async () => {
    const manager = fakeManager();
    const tracking = fakeSource(false);
    const off = installAgentUsageDemandPush(manager, tracking.source);
    const pair = await openSessionPair(dir);
    open.push(pair.host, pair.client);
    manager.opened(pair.client);
    tracking.set(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pair.client.isOpen).toBe(true);
    off();
  });

  it("sends the latest value again after a busy link refused it, and stops once the session closes", async () => {
    vi.useFakeTimers();
    let closeSession: (() => void) | null = null;
    const call = vi
      .fn<(method: string, payload: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "RATE_LIMITED" }))
      .mockResolvedValue(null);
    const session = {
      isOpen: true,
      call,
      onClose: (listener: () => void) => {
        closeSession = listener;
        return () => {};
      },
    } as unknown as LinkSession;
    const manager = fakeManager();
    const tracking = fakeSource(false);
    const off = installAgentUsageDemandPush(manager, tracking.source);
    manager.opened(session);
    await vi.advanceTimersByTimeAsync(0);
    tracking.set(true);
    await vi.advanceTimersByTimeAsync(0);
    // The refused `false` is overtaken by `true`, which needs no retry.
    expect(call.mock.calls.map(([, payload]) => payload)).toEqual([
      { enabled: false },
      { enabled: true },
    ]);
    await vi.advanceTimersByTimeAsync(AGENT_USAGE_DEMAND_RETRY_MS);
    expect(call).toHaveBeenCalledTimes(2);

    closeSession!();
    tracking.set(false);
    await vi.advanceTimersByTimeAsync(AGENT_USAGE_DEMAND_RETRY_MS);
    expect(call).toHaveBeenCalledTimes(2);
    off();
  });
});
