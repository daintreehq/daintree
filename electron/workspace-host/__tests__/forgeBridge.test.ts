import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForgeBridge } from "../forgeBridge.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import type { RepoRef } from "../../../shared/types/forge.js";

const repo: RepoRef = { host: "github.com", owner: "owner", repo: "repo", rawData: null };

type ForgeRpcEvent = Extract<WorkspaceHostEvent, { type: "forge:rpc" }>;

function isForgeRpc(event: WorkspaceHostEvent): event is ForgeRpcEvent {
  return event.type === "forge:rpc";
}

describe("ForgeBridge in-flight dedup", () => {
  let events: ForgeRpcEvent[];
  let bridge: ForgeBridge;

  beforeEach(() => {
    events = [];
    bridge = new ForgeBridge((event) => {
      if (isForgeRpc(event)) events.push(event);
    });
  });

  afterEach(() => {
    // Reject any still-pending calls so their 30s RPC timers are cleared and
    // don't leak across tests.
    bridge.dispose();
  });

  it("coalesces concurrent identical calls into one forge:rpc event", async () => {
    const a = bridge.getPR("ns", repo, 1);
    const b = bridge.getPR("ns", repo, 1);

    expect(events).toHaveLength(1);

    bridge.handleResult({
      forgeRequestId: events[0].forgeRequestId,
      ok: true,
      value: { number: 1 },
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ number: 1 });
    expect(rb).toEqual({ number: 1 });
  });

  it("sends separate events when args differ", () => {
    // Never settled — afterEach dispose() rejects them, so swallow.
    void bridge.getPR("ns", repo, 1).catch(() => {});
    void bridge.getPR("ns", repo, 2).catch(() => {});

    expect(events).toHaveLength(2);
  });

  it("sends separate events when namespacedId differs", () => {
    void bridge.getPR("ns-a", repo, 1).catch(() => {});
    void bridge.getPR("ns-b", repo, 1).catch(() => {});

    expect(events).toHaveLength(2);
  });

  it("evicts on rejection so a retry sends a fresh event", async () => {
    const first = bridge.getPR("ns", repo, 1);
    expect(events).toHaveLength(1);

    bridge.handleResult({ forgeRequestId: events[0].forgeRequestId, ok: false, error: "boom" });
    await expect(first).rejects.toThrow("boom");

    const retry = bridge.getPR("ns", repo, 1);
    expect(events).toHaveLength(2);

    bridge.handleResult({
      forgeRequestId: events[1].forgeRequestId,
      ok: true,
      value: { number: 1 },
    });
    await expect(retry).resolves.toEqual({ number: 1 });
  });

  it("evicts on success so a later identical call refetches", async () => {
    const first = bridge.getPR("ns", repo, 1);
    bridge.handleResult({
      forgeRequestId: events[0].forgeRequestId,
      ok: true,
      value: { number: 1 },
    });
    await first;

    void bridge.getPR("ns", repo, 1).catch(() => {});
    expect(events).toHaveLength(2);
  });

  it("sends provider PR cache clear over forge RPC", async () => {
    const request = bridge.clearPullRequestCaches("ns");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: "clearPullRequestCaches",
      namespacedId: "ns",
      args: [],
    });

    bridge.handleResult({
      forgeRequestId: events[0].forgeRequestId,
      ok: true,
      value: null,
    });

    await expect(request).resolves.toBeUndefined();
  });

  it("dispose rejects deduped concurrent callers", async () => {
    const a = bridge.getPR("ns", repo, 1);
    const b = bridge.getPR("ns", repo, 1);
    expect(events).toHaveLength(1);

    bridge.dispose();

    await expect(a).rejects.toThrow(/disposed/);
    await expect(b).rejects.toThrow(/disposed/);
  });
});
