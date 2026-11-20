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
  it("tells every host as its session opens and on every change, and nothing when nothing changed", async () => {
    const manager = fakeManager();
    const tracking = fakeSource(false);
    const off = installAgentUsageDemandPush(manager, tracking.source);
    const first = await hostHearing();
    const second = await hostHearing();
    manager.opened(first.client);
    manager.opened(second.client);
    // A session announced twice is still told once.
    manager.opened(first.client);
    await waitFor(() => first.heard.length === 1 && second.heard.length === 1);

    tracking.set(true);
    await waitFor(() => first.heard.length === 2 && second.heard.length === 2);
    tracking.set(true);
    tracking.set(false);
    await waitFor(() => first.heard.length === 3 && second.heard.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.heard).toEqual([false, true, false]);
    expect(second.heard).toEqual([false, true, false]);

    off();
    tracking.set(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.heard).toEqual([false, true, false]);
    expect(tracking.listeners.size).toBe(0);
  });

  it("keeps the link up, and keeps saying, when a host from before it refuses the method", async () => {
    const manager = fakeManager();
    const tracking = fakeSource(false);
    const off = installAgentUsageDemandPush(manager, tracking.source);
    const pair = await openSessionPair(dir);
    open.push(pair.host, pair.client);
    const call = vi.spyOn(pair.client, "call");
    // No host handler: the call is answered as an unknown method.
    manager.opened(pair.client);
    await waitFor(() => call.mock.results.length === 1);
    await expect(call.mock.results[0]!.value).rejects.toBeTruthy();
    tracking.set(true);
    await waitFor(() => call.mock.results.length === 2);
    expect(call.mock.calls.map(([method, payload]) => [method, payload])).toEqual([
      [MetricsLinkMethod.AGENT_USAGE_DEMAND, { enabled: false }],
      [MetricsLinkMethod.AGENT_USAGE_DEMAND, { enabled: true }],
    ]);
    expect(pair.client.isOpen).toBe(true);
    off();
  });

  it("sends a value a busy link refused again, and stops once the session closes", async () => {
    vi.useFakeTimers();
    let closeSession: (() => void) | null = null;
    const busy = () => Object.assign(new Error("busy"), { code: "RATE_LIMITED" });
    const call = vi
      .fn<(method: string, payload: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(busy())
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
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AGENT_USAGE_DEMAND_RETRY_MS);
    expect(call.mock.calls.map(([, payload]) => payload)).toEqual([
      { enabled: false },
      { enabled: false },
    ]);

    // Refused again, then the session closes with the retry pending: nothing more is sent.
    tracking.set(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledTimes(3);
    closeSession!();
    await vi.advanceTimersByTimeAsync(AGENT_USAGE_DEMAND_RETRY_MS);
    expect(call).toHaveBeenCalledTimes(3);
    off();
  });
});
