import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";
import { parsePartialSuccessMessage } from "../../../../shared/utils/partialSuccess.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { getViewlessHelpBaseManifest } from "../baseManifest.js";
import { createSessionServer } from "../sessionServer.js";
import type { SessionServerDeps } from "../sessionServer.js";
import { SessionStore } from "../sessionStore.js";
import {
  callTool,
  fakeDeps,
  makeManifestEntry,
  seedLiveSession,
  toolErrorPayload,
} from "./helpers/sessionServerFixture.js";

const SOURCE = { kind: "newBranch", branchName: "feature/unit-1", fetchBase: true };
const WORKTREE = "/repo/.worktrees/feature-unit-1";

function manifest(): ActionManifestEntry[] {
  return [
    { ...makeManifestEntry("agent.launchInNewWorktree"), kind: "command" },
    { ...makeManifestEntry("worktree.createWithRecipe"), kind: "command" },
    makeManifestEntry("worktree.waitUntilReady"),
    { ...makeManifestEntry("agent.launch"), kind: "command" },
  ];
}

type Envelopes = Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;

describe("agent.launchInNewWorktree through the session server (#15738)", () => {
  const stores: SessionStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.drain();
      store.grantCache.dispose();
    }
    vi.restoreAllMocks();
  });

  function harness(
    envelopes: Envelopes,
    tier: "core" | "full" | "external" = "core",
    overrides?: Partial<SessionServerDeps>
  ) {
    const store = new SessionStore(() => {});
    stores.push(store);
    seedLiveSession(store, "s-1", tier);
    const dispatchAction = vi.fn((actionId: string, args: Record<string, unknown>) => {
      const envelope = envelopes[actionId];
      const value = typeof envelope === "function" ? envelope(args) : envelope;
      return Promise.resolve(value ?? { result: { ok: true, result: null } });
    });
    const deps = fakeDeps({
      sessionStore: store,
      dispatchAction: dispatchAction as unknown as SessionServerDeps["dispatchAction"],
      requestManifest: vi.fn().mockResolvedValue(manifest()),
      getCachedManifest: vi.fn(() => manifest()),
      ...overrides,
    });
    return { store, deps, dispatchAction, server: createSessionServer("s-1", deps) };
  }

  const created = {
    result: {
      ok: true,
      result: {
        worktreeId: WORKTREE,
        worktreePath: WORKTREE,
        branch: "feature/unit-1",
        requestedBranch: "feature/unit-1",
        effectiveBranch: "feature/unit-1",
        recipeLaunched: false,
        spawnedTerminalCount: 0,
        spawnedTerminalIds: [],
        failedTerminalCount: 0,
        setupState: "running",
        startCommit: "abc123",
      },
    },
  };
  const ready = {
    result: {
      ok: true,
      result: {
        worktreeId: WORKTREE,
        setupState: "ready",
        stage: null,
        error: null,
        timedOut: false,
      },
    },
  };
  const launched = (args: Record<string, unknown>) => ({
    result: {
      ok: true,
      result: {
        launched: true,
        terminalId: args.requestedId,
        location: "grid",
        spawnStatus: null,
        worktreeId: args.worktreeId,
        worktreePath: args.worktreeId,
        branch: "feature/unit-1",
        cwd: args.worktreeId,
        cwdOutsideWorktree: false,
        panelLimit: null,
        reply: null,
      },
    },
  });

  it("creates, waits for setup, then launches into the new worktree, and owns both", async () => {
    const { store, dispatchAction, server } = harness({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": ready,
      "agent.launch": launched,
    });

    const result = await callTool(server, {
      name: "agent.launchInNewWorktree",
      arguments: { source: SOURCE, agentId: "claude", prompt: "Fix it", name: "Unit 1" },
    });

    expect(result.isError).toBeFalsy();
    expect(dispatchAction.mock.calls.map((call) => call[0])).toEqual([
      "worktree.createWithRecipe",
      "worktree.waitUntilReady",
      "agent.launch",
    ]);
    expect(dispatchAction.mock.calls[0]![1]).toEqual({ source: SOURCE });
    expect(dispatchAction.mock.calls[1]![1]).toMatchObject({ worktreeId: WORKTREE });
    const launchArgs = dispatchAction.mock.calls[2]![1];
    expect(launchArgs).toMatchObject({
      agentId: "claude",
      prompt: "Fix it",
      name: "Unit 1",
      worktreeId: WORKTREE,
    });
    expect(launchArgs).not.toHaveProperty("source");
    // The launch step got the id main mints for an MCP launch, as it would alone.
    expect(typeof launchArgs.requestedId).toBe("string");

    const value = result.structuredContent as Record<string, unknown>;
    expect(value.terminalId).toBe(launchArgs.requestedId);
    expect(value.worktreeId).toBe(WORKTREE);
    expect((value.creation as Record<string, unknown>).startCommit).toBe("abc123");
    expect((value.setup as Record<string, unknown>).setupState).toBe("ready");

    expect(store.resourceOwnership.owns("s-1", "worktree", WORKTREE)).toBe(true);
    expect(store.resourceOwnership.owns("s-1", "terminal", String(launchArgs.requestedId))).toBe(
      true
    );
  });

  it("stops before the launch when setup failed, and still owns the worktree", async () => {
    const { store, dispatchAction, server } = harness({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": {
        result: {
          ok: true,
          result: {
            worktreeId: WORKTREE,
            setupState: "failed",
            stage: "setup-script",
            error: "npm ci exited 1",
            timedOut: false,
          },
        },
      },
    });

    const result = await callTool(server, {
      name: "agent.launchInNewWorktree",
      arguments: { source: SOURCE, agentId: "claude" },
    });

    expect(result.isError).toBe(true);
    expect(dispatchAction.mock.calls.map((call) => call[0])).not.toContain("agent.launch");
    const payload = toolErrorPayload(result) as unknown as {
      code: string;
      retriable: boolean;
      message: string;
    };
    expect(payload.code).toBe("PARTIAL_SUCCESS");
    expect(payload.retriable).toBe(false);
    const partial = parsePartialSuccessMessage(payload.message)!.partialResult;
    expect(partial).toMatchObject({
      worktreeId: WORKTREE,
      stoppedAt: "setup",
      error: { code: "SETUP_FAILED" },
    });
    expect(store.resourceOwnership.owns("s-1", "worktree", WORKTREE)).toBe(true);
  });

  it("answers a declined launch with the still-owned worktree, not a bare failure", async () => {
    const { store, server } = harness({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": ready,
      "agent.launch": {
        result: {
          ok: true,
          result: {
            launched: false,
            terminalId: null,
            location: null,
            spawnStatus: "missing-cli",
            worktreeId: WORKTREE,
            worktreePath: WORKTREE,
            branch: "feature/unit-1",
            cwd: null,
            cwdOutsideWorktree: null,
            panelLimit: null,
            reply: null,
          },
        },
      },
    });

    const result = await callTool(server, {
      name: "agent.launchInNewWorktree",
      arguments: { source: SOURCE, agentId: "claude" },
    });

    const payload = toolErrorPayload(result) as unknown as { code: string; message: string };
    expect(payload.code).toBe("PARTIAL_SUCCESS");
    const partial = parsePartialSuccessMessage(payload.message)!.partialResult;
    expect(partial).toMatchObject({
      worktreeId: WORKTREE,
      stoppedAt: "launch",
      error: { code: "LAUNCH_DECLINED" },
      launch: { spawnStatus: "missing-cli" },
    });
    expect(store.resourceOwnership.owns("s-1", "worktree", WORKTREE)).toBe(true);
    expect(store.resourceOwnership.list("s-1").filter((r) => r.kind === "terminal")).toEqual([]);
  });

  it("is listed to a session on a host with no window, where its steps run viewless", () => {
    const entry = getViewlessHelpBaseManifest().find(
      (candidate) => candidate.id === "agent.launchInNewWorktree"
    );
    const properties = (entry?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(["source", "agentId", "setupTimeoutMs", "notify", "model"])
    );
    expect(properties).not.toHaveProperty("worktreeId");
  });

  it("is not on the external tier, where setup can't be waited on", async () => {
    const { dispatchAction, server } = harness({}, "external");

    const result = await callTool(server, {
      name: "agent.launchInNewWorktree",
      arguments: { source: SOURCE, agentId: "claude" },
    });

    expect(result.isError).toBe(true);
    expect(toolErrorPayload(result).code).toBe("TIER_NOT_PERMITTED");
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("refuses a worktreeId before anything is created", async () => {
    const { dispatchAction, server } = harness({});

    await expect(
      callTool(server, {
        name: "agent.launchInNewWorktree",
        arguments: { source: SOURCE, agentId: "claude", worktreeId: "/elsewhere" },
      })
    ).rejects.toThrow(/takes no worktreeId/);
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("refuses a panel id already in use before anything is created", async () => {
    const { dispatchAction, server } = harness({}, "core", {
      isTerminalIdInUse: vi.fn((id: string) => id === "taken"),
    });

    const result = await callTool(server, {
      name: "agent.launchInNewWorktree",
      arguments: { source: SOURCE, agentId: "claude", requestedId: "taken" },
    });

    expect(toolErrorPayload(result).code).toBe("VALIDATION_ERROR");
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("answers a completed duplicate from its first run rather than launching again", async () => {
    const { dispatchAction, server } = harness({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": ready,
      "agent.launch": launched,
    });
    const call = {
      name: "agent.launchInNewWorktree",
      arguments: { source: SOURCE, agentId: "claude", prompt: "Fix it" },
    };

    const first = await callTool(server, call);
    const second = await callTool(server, call);

    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(dispatchAction.mock.calls.filter((c) => c[0] === "agent.launch")).toHaveLength(1);
  });

  it("gives a different call naming the same source a worktree of its own", async () => {
    // Without a create key scoped to the call, the second create would be
    // answered from the first one's cache entry and both agents would share
    // one tree.
    const { dispatchAction, server } = harness({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": ready,
      "agent.launch": launched,
    });

    await callTool(server, {
      name: "agent.launchInNewWorktree",
      arguments: { source: SOURCE, agentId: "claude" },
    });
    await callTool(server, {
      name: "agent.launchInNewWorktree",
      arguments: { source: SOURCE, agentId: "codex" },
    });

    expect(
      dispatchAction.mock.calls.filter((c) => c[0] === "worktree.createWithRecipe")
    ).toHaveLength(2);
  });

  it("reuses the worktree its first try made when the same call is retried after a stop", async () => {
    let launches = 0;
    const { dispatchAction, server } = harness({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": ready,
      "agent.launch": (args: Record<string, unknown>) =>
        ++launches === 1
          ? { result: { ok: false, error: { code: "EXECUTION_ERROR", message: "spawn failed" } } }
          : launched(args),
    });
    const call = {
      name: "agent.launchInNewWorktree",
      arguments: { source: SOURCE, agentId: "claude", prompt: "Fix it" },
    };

    const first = await callTool(server, call);
    const second = await callTool(server, call);

    expect(toolErrorPayload(first).code).toBe("PARTIAL_SUCCESS");
    expect(second.isError).toBeFalsy();
    expect((second.structuredContent as Record<string, unknown>).worktreeId).toBe(WORKTREE);
    expect(
      dispatchAction.mock.calls.filter((c) => c[0] === "worktree.createWithRecipe")
    ).toHaveLength(1);
  });
});
