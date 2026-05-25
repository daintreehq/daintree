import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForgeRpcInFlightForTests, dispatchForgeRpc } from "../forgeRpcServer.js";
import {
  clearForgeProviderImplRegistry,
  registerForgeProviderImpl,
} from "../forgeProviderRegistry.js";
import type { ForgeProviderImpl, PR, RepoRef } from "../../../shared/types/forge.js";
import type { WorkspaceHostRequest } from "../../../shared/types/workspace-host.js";

const PLUGIN_ID = "test-plugin";
const CONTRIBUTION_ID = "github";
const NAMESPACED_ID = `${PLUGIN_ID}.${CONTRIBUTION_ID}`;

const repo: RepoRef = { host: "github.com", owner: "owner", repo: "repo", rawData: null };

type ForgeRpcResult = Extract<WorkspaceHostRequest, { type: "forge:rpc-result" }>;

function captureSender(): {
  send: (request: WorkspaceHostRequest) => boolean;
  sent: ForgeRpcResult[];
} {
  const sent: ForgeRpcResult[] = [];
  const send = (request: WorkspaceHostRequest): boolean => {
    if (request.type === "forge:rpc-result") {
      sent.push(request);
    }
    return true;
  };
  return { send, sent };
}

function makeImpl(overrides: Partial<ForgeProviderImpl> = {}): ForgeProviderImpl {
  return {
    id: NAMESPACED_ID,
    name: "Test Provider",
    matchHostnames: () => ["github.com"],
    parseRemote: () => repo,
    findPRByBranch: async () => null,
    getPR: async () => null,
    getIssue: async () => null,
    getCIStatus: async () => null,
    ...overrides,
  } as ForgeProviderImpl;
}

beforeEach(() => {
  _resetForgeRpcInFlightForTests();
  clearForgeProviderImplRegistry();
});

afterEach(() => {
  _resetForgeRpcInFlightForTests();
  clearForgeProviderImplRegistry();
});

describe("dispatchForgeRpc cross-window singleflight", () => {
  it("coalesces concurrent identical requests from different senders into one provider call", async () => {
    const getPR = vi.fn(async (): Promise<PR | null> => {
      // Deliberately yield so the second dispatch can join while the first is in-flight.
      await new Promise((r) => setTimeout(r, 0));
      return { number: 42, title: "test", url: "u", state: "open", providerId: NAMESPACED_ID } as PR;
    });
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl({ getPR }));

    const a = captureSender();
    const b = captureSender();

    const pA = dispatchForgeRpc(
      { forgeRequestId: "req-a", method: "getPR", namespacedId: NAMESPACED_ID, args: [repo, 42] },
      a.send
    );
    const pB = dispatchForgeRpc(
      { forgeRequestId: "req-b", method: "getPR", namespacedId: NAMESPACED_ID, args: [repo, 42] },
      b.send
    );

    await Promise.all([pA, pB]);

    expect(getPR).toHaveBeenCalledTimes(1);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(a.sent[0]).toMatchObject({ forgeRequestId: "req-a", ok: true });
    expect(b.sent[0]).toMatchObject({ forgeRequestId: "req-b", ok: true });
    if (a.sent[0].ok) expect((a.sent[0].value as PR).number).toBe(42);
    if (b.sent[0].ok) expect((b.sent[0].value as PR).number).toBe(42);
  });

  it("differing args produce independent upstream calls", async () => {
    const getPR = vi.fn(async (_: RepoRef, n: number) => ({
      number: n,
      title: "t",
      url: "u",
      state: "open" as const,
      providerId: NAMESPACED_ID,
    }));
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl({ getPR }));

    const { send } = captureSender();
    await Promise.all([
      dispatchForgeRpc(
        { forgeRequestId: "req-1", method: "getPR", namespacedId: NAMESPACED_ID, args: [repo, 1] },
        send
      ),
      dispatchForgeRpc(
        { forgeRequestId: "req-2", method: "getPR", namespacedId: NAMESPACED_ID, args: [repo, 2] },
        send
      ),
    ]);

    expect(getPR).toHaveBeenCalledTimes(2);
  });

  it("differing namespacedId produces independent upstream calls", async () => {
    const implA = makeImpl({ getPR: vi.fn(async () => null) });
    const implB = makeImpl({ getPR: vi.fn(async () => null) });
    registerForgeProviderImpl(PLUGIN_ID, "provider-a", implA);
    registerForgeProviderImpl(PLUGIN_ID, "provider-b", implB);

    const { send } = captureSender();
    await Promise.all([
      dispatchForgeRpc(
        { forgeRequestId: "r1", method: "getPR", namespacedId: `${PLUGIN_ID}.provider-a`, args: [repo, 1] },
        send
      ),
      dispatchForgeRpc(
        { forgeRequestId: "r2", method: "getPR", namespacedId: `${PLUGIN_ID}.provider-b`, args: [repo, 1] },
        send
      ),
    ]);

    expect(implA.getPR).toHaveBeenCalledTimes(1);
    expect(implB.getPR).toHaveBeenCalledTimes(1);
  });

  it("argument key order does not matter (safe-stable-stringify)", async () => {
    // resolveProvider takes an options object whose property order can vary
    // between callers; ensure the singleflight key is stable.
    const findPRByBranch = vi.fn(async () => null);
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl({ findPRByBranch }));

    const repoA: RepoRef = { host: "github.com", owner: "o", repo: "r", rawData: null };
    const repoB: RepoRef = { rawData: null, repo: "r", owner: "o", host: "github.com" };

    const { send } = captureSender();
    await Promise.all([
      dispatchForgeRpc(
        { forgeRequestId: "r1", method: "findPRByBranch", namespacedId: NAMESPACED_ID, args: [repoA, "main"] },
        send
      ),
      dispatchForgeRpc(
        { forgeRequestId: "r2", method: "findPRByBranch", namespacedId: NAMESPACED_ID, args: [repoB, "main"] },
        send
      ),
    ]);

    expect(findPRByBranch).toHaveBeenCalledTimes(1);
  });

  it("provider rejection fans the error to every waiter and evicts the key", async () => {
    const getPR = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ number: 1, title: "t", url: "u", state: "open", providerId: NAMESPACED_ID });
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl({ getPR }));

    const a = captureSender();
    const b = captureSender();

    await Promise.all([
      dispatchForgeRpc(
        { forgeRequestId: "r1", method: "getPR", namespacedId: NAMESPACED_ID, args: [repo, 1] },
        a.send
      ),
      dispatchForgeRpc(
        { forgeRequestId: "r2", method: "getPR", namespacedId: NAMESPACED_ID, args: [repo, 1] },
        b.send
      ),
    ]);

    expect(a.sent[0]).toMatchObject({ forgeRequestId: "r1", ok: false });
    expect(b.sent[0]).toMatchObject({ forgeRequestId: "r2", ok: false });
    if (!a.sent[0].ok) expect(a.sent[0].error).toContain("boom");
    if (!b.sent[0].ok) expect(b.sent[0].error).toContain("boom");

    // A follow-up call with the same key should hit the provider again,
    // not stay parked behind the failed entry.
    const c = captureSender();
    await dispatchForgeRpc(
      { forgeRequestId: "r3", method: "getPR", namespacedId: NAMESPACED_ID, args: [repo, 1] },
      c.send
    );
    expect(getPR).toHaveBeenCalledTimes(2);
    expect(c.sent[0]).toMatchObject({ forgeRequestId: "r3", ok: true });
  });

  it("sequential identical calls do not coalesce (entry evicted on settlement)", async () => {
    const getPR = vi.fn(async () => null);
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl({ getPR }));
    const { send } = captureSender();

    await dispatchForgeRpc(
      { forgeRequestId: "r1", method: "getPR", namespacedId: NAMESPACED_ID, args: [repo, 1] },
      send
    );
    await dispatchForgeRpc(
      { forgeRequestId: "r2", method: "getPR", namespacedId: NAMESPACED_ID, args: [repo, 1] },
      send
    );
    expect(getPR).toHaveBeenCalledTimes(2);
  });

  it("waiter whose sender returns false receives an explicit error envelope", async () => {
    const getPR = vi.fn(async () => ({
      number: 1,
      title: "t",
      url: "u",
      state: "open" as const,
      providerId: NAMESPACED_ID,
    }));
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl({ getPR }));

    const sent: ForgeRpcResult[] = [];
    let firstCall = true;
    const send = (request: WorkspaceHostRequest): boolean => {
      if (request.type === "forge:rpc-result") {
        sent.push(request);
        // First send returns false to simulate a non-cloneable result or
        // child-gone failure; the fan-out should follow up with an error
        // envelope so the waiter doesn't hang.
        if (firstCall) {
          firstCall = false;
          return false;
        }
      }
      return true;
    };

    await dispatchForgeRpc(
      { forgeRequestId: "r1", method: "getPR", namespacedId: NAMESPACED_ID, args: [repo, 1] },
      send
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ forgeRequestId: "r1", ok: true });
    expect(sent[1]).toMatchObject({ forgeRequestId: "r1", ok: false });
    if (!sent[1].ok) {
      expect(sent[1].error).toContain("could not be delivered");
    }
  });
});
