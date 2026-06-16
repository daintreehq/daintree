import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// forgeRpcServer now imports the PluginService singleton to gate impl lookups
// behind implicit activation. The singleton constructor calls `app.getVersion()`
// which is undefined in this test's electron stub — mock the module surface
// before importing forgeRpcServer so the constructor never runs.
// `isPluginScanComplete` is mutable so resolveProvider tests can exercise both
// the pre-scan ("not-ready") and post-scan ("no-match") miss states (#9997).
const pluginServiceMock = vi.hoisted(() => ({
  activatePluginForForgeProvider: vi.fn().mockResolvedValue(undefined),
  isPluginScanComplete: true,
}));
vi.mock("../PluginService.js", () => ({
  pluginService: pluginServiceMock,
}));

import { _resetForgeRpcInFlightForTests, dispatchForgeRpc } from "../forgeRpcServer.js";
import {
  clearForgeProviderImplRegistry,
  clearForgeProviderRegistry,
  registerForgeProviderImpl,
  registerForgeProviders,
} from "../forgeProviderRegistry.js";
import type { ForgeProviderImpl, PR, RepoRef } from "../../../shared/types/forge.js";
import type { WorkspaceHostRequest } from "../../../shared/types/workspace-host.js";

const PLUGIN_ID = "test-plugin";
const CONTRIBUTION_ID = "github";
const NAMESPACED_ID = `${PLUGIN_ID}.${CONTRIBUTION_ID}`;

const repo: RepoRef = { host: "github.com", owner: "owner", repo: "repo", rawData: null };

function makePR(overrides: Partial<PR> = {}): PR {
  return {
    number: 42,
    title: "test",
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: "u",
    baseRef: "main",
    headRef: "feature",
    createdAt: 0,
    updatedAt: 0,
    rawData: null,
    ...overrides,
  };
}

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
  clearForgeProviderRegistry();
  pluginServiceMock.isPluginScanComplete = true;
});

afterEach(() => {
  _resetForgeRpcInFlightForTests();
  clearForgeProviderImplRegistry();
  clearForgeProviderRegistry();
});

describe("dispatchForgeRpc cross-window singleflight", () => {
  it("coalesces concurrent identical requests from different senders into one provider call", async () => {
    const getPR = vi.fn(async (): Promise<PR | null> => {
      // Deliberately yield so the second dispatch can join while the first is in-flight.
      await new Promise((r) => setTimeout(r, 0));
      return makePR({ number: 42 });
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
    const getPR = vi.fn(async (_: RepoRef, n: number) => makePR({ number: n }));
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
        {
          forgeRequestId: "r1",
          method: "getPR",
          namespacedId: `${PLUGIN_ID}.provider-a`,
          args: [repo, 1],
        },
        send
      ),
      dispatchForgeRpc(
        {
          forgeRequestId: "r2",
          method: "getPR",
          namespacedId: `${PLUGIN_ID}.provider-b`,
          args: [repo, 1],
        },
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
        {
          forgeRequestId: "r1",
          method: "findPRByBranch",
          namespacedId: NAMESPACED_ID,
          args: [repoA, "main"],
        },
        send
      ),
      dispatchForgeRpc(
        {
          forgeRequestId: "r2",
          method: "findPRByBranch",
          namespacedId: NAMESPACED_ID,
          args: [repoB, "main"],
        },
        send
      ),
    ]);

    expect(findPRByBranch).toHaveBeenCalledTimes(1);
  });

  it("provider rejection fans the error to every waiter and evicts the key", async () => {
    const getPR = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(makePR({ number: 1 }));
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

  it("dispatches clearPullRequestCaches to the provider", async () => {
    const clearPullRequestCaches = vi.fn();
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl({ clearPullRequestCaches }));
    const { send, sent } = captureSender();

    await dispatchForgeRpc(
      {
        forgeRequestId: "clear-1",
        method: "clearPullRequestCaches",
        namespacedId: NAMESPACED_ID,
        args: [],
      },
      send
    );

    expect(clearPullRequestCaches).toHaveBeenCalledTimes(1);
    expect(sent[0]).toMatchObject({ forgeRequestId: "clear-1", ok: true, value: null });
  });

  it("waiter whose sender returns false receives an explicit error envelope", async () => {
    const getPR = vi.fn(async () => makePR({ number: 1 }));
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

describe("resolveProvider miss discrimination (#9997)", () => {
  const resolveArgs = [
    {
      remoteUrl: "https://gitlab.com/owner/repo.git",
      forgeProviderOverride: null,
      globalDefaultProviderId: null,
    },
  ];

  function dispatchResolve(send: (request: WorkspaceHostRequest) => boolean): Promise<void> {
    return dispatchForgeRpc(
      { forgeRequestId: "resolve-1", method: "resolveProvider", args: resolveArgs },
      send
    );
  }

  it("returns not-ready when no descriptor matches and the plugin scan is still running", async () => {
    pluginServiceMock.isPluginScanComplete = false;
    const { send, sent } = captureSender();

    await dispatchResolve(send);

    expect(sent[0]).toMatchObject({ ok: true, value: { status: "not-ready" } });
  });

  it("returns no-match when no descriptor matches after the plugin scan settled", async () => {
    const { send, sent } = captureSender();

    await dispatchResolve(send);

    expect(sent[0]).toMatchObject({ ok: true, value: { status: "no-match" } });
  });

  it("returns no-match when the descriptor matched but no impl bound after activation", async () => {
    registerForgeProviders(PLUGIN_ID, [
      { id: CONTRIBUTION_ID, name: "Test Provider", matches: ["gitlab.com"] },
    ]);
    // No registerForgeProviderImpl — activation completes without binding.
    const { send, sent } = captureSender();

    await dispatchResolve(send);

    expect(sent[0]).toMatchObject({ ok: true, value: { status: "no-match" } });
  });

  it("returns the resolved provider with parsed repo when descriptor and impl are present", async () => {
    registerForgeProviders(PLUGIN_ID, [
      { id: CONTRIBUTION_ID, name: "Test Provider", matches: ["gitlab.com"] },
    ]);
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl());
    const { send, sent } = captureSender();

    await dispatchResolve(send);

    expect(sent[0]).toMatchObject({
      ok: true,
      value: { status: "resolved", namespacedId: NAMESPACED_ID, repo: { owner: "owner" } },
    });
  });

  it("stamps projectPath from the opts onto the returned repo (#10563)", async () => {
    registerForgeProviders(PLUGIN_ID, [
      { id: CONTRIBUTION_ID, name: "Test Provider", matches: ["gitlab.com"] },
    ]);
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl());
    const { send, sent } = captureSender();

    await dispatchForgeRpc(
      {
        forgeRequestId: "resolve-path",
        method: "resolveProvider",
        args: [
          {
            remoteUrl: "https://gitlab.com/owner/repo.git",
            forgeProviderOverride: null,
            globalDefaultProviderId: null,
            projectPath: "/repo-worktrees/feature",
          },
        ],
      },
      send
    );

    expect(sent[0]).toMatchObject({
      ok: true,
      value: {
        status: "resolved",
        repo: { owner: "owner", projectPath: "/repo-worktrees/feature" },
      },
    });
  });

  it("leaves repo unchanged when no projectPath is supplied (#10563)", async () => {
    registerForgeProviders(PLUGIN_ID, [
      { id: CONTRIBUTION_ID, name: "Test Provider", matches: ["gitlab.com"] },
    ]);
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl());
    const { send, sent } = captureSender();

    await dispatchResolve(send);

    if (sent[0].ok) {
      expect((sent[0].value as { repo: RepoRef }).repo.projectPath).toBeUndefined();
    }
  });

  it("does not coalesce resolves that differ only by projectPath (#10563)", async () => {
    registerForgeProviders(PLUGIN_ID, [
      { id: CONTRIBUTION_ID, name: "Test Provider", matches: ["gitlab.com"] },
    ]);
    const parseRemote = vi.fn(() => repo);
    registerForgeProviderImpl(PLUGIN_ID, CONTRIBUTION_ID, makeImpl({ parseRemote }));
    const { send, sent } = captureSender();

    const mk = (projectPath: string, forgeRequestId: string) =>
      dispatchForgeRpc(
        {
          forgeRequestId,
          method: "resolveProvider",
          args: [
            {
              remoteUrl: "https://gitlab.com/owner/repo.git",
              forgeProviderOverride: null,
              globalDefaultProviderId: null,
              projectPath,
            },
          ],
        },
        send
      );

    await Promise.all([mk("/repo-a", "ra"), mk("/repo-b", "rb")]);

    // Distinct projectPaths must each produce their own parse rather than sharing
    // one in-flight result, or one worktree would get the other's path.
    expect(parseRemote).toHaveBeenCalledTimes(2);

    // And each request must receive its OWN projectPath back — a fan-out bug that
    // delivered one waiter's result to both would slip past the call-count check.
    const pathFor = (id: string) => {
      const result = sent.find((s) => s.forgeRequestId === id);
      if (!result?.ok) throw new Error(`no ok result for ${id}`);
      return (result.value as { repo: RepoRef }).repo.projectPath;
    };
    expect(pathFor("ra")).toBe("/repo-a");
    expect(pathFor("rb")).toBe("/repo-b");
  });
});
