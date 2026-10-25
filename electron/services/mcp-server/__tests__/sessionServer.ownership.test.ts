import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";
import { formatPartialSuccessMessage } from "../../../../shared/utils/partialSuccess.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer } from "../sessionServer.js";
import type { SessionServerDeps } from "../sessionServer.js";
import type { McpSessionOrigin } from "../../../../shared/types/ipc/mcpServer.js";
import { SessionStore as RealSessionStore } from "../sessionStore.js";
import { relayOwnershipPrincipal } from "../resourceOwnership.js";
import type { AgentLastMessageResult } from "../../../../shared/types/agentLastMessage.js";
import { encodeMessageCursor } from "../../claude/ClaudeMessageCursor.js";
import { SESSION_GONE, CONFIRMATION_REQUIRED_CODE } from "../shared.js";
import { RendererBridgeUnavailableError } from "../rendererBridge.js";
import {
  toolErrorPayload,
  fakeDeps,
  makeMockTransport,
  callTool,
  listTools,
  seedLiveSession,
  makeManifestEntry,
} from "./helpers/sessionServerFixture.js";

// #11909 — the cleanup tools are an authorization boundary, so the cases below
// are the boundary's edges rather than its happy path: another session's id, a
// forged id, an id the user owns, a half-created composite, and a session whose
// authority has been revoked.
describe("session-scoped resource ownership (#11909)", () => {
  const liveStores: RealSessionStore[] = [];

  function makeStore(): RealSessionStore {
    const store = new RealSessionStore(() => {});
    liveStores.push(store);
    return store;
  }

  afterEach(() => {
    while (liveStores.length > 0) {
      const store = liveStores.pop()!;
      store.drain();
      store.grantCache.dispose();
    }
    vi.restoreAllMocks();
  });

  function ownedManifest(): ActionManifestEntry[] {
    return [
      makeManifestEntry("terminal.new"),
      { ...makeManifestEntry("terminal.closeOwned"), kind: "command", danger: "safe" as const },
      { ...makeManifestEntry("terminal.revealOwned"), kind: "command", danger: "safe" as const },
      { ...makeManifestEntry("terminal.placeOwned"), kind: "command", danger: "safe" as const },
      {
        ...makeManifestEntry("terminal.interruptOwned"),
        kind: "command",
        danger: "safe" as const,
      },
      // With an outputSchema, so the submission receipt is checked on the
      // structuredContent block the owned tool advertises, not only the text.
      {
        ...makeManifestEntry("terminal.sendCommandOwned"),
        kind: "command",
        danger: "safe" as const,
        outputSchema: {
          type: "object",
          properties: { sent: { type: "boolean" }, submissionToken: { type: "string" } },
        },
      },
      {
        ...makeManifestEntry("terminal.injectOwned"),
        kind: "command",
        danger: "safe" as const,
      },
      {
        ...makeManifestEntry("worktree.deleteOwned"),
        kind: "command",
        danger: "confirm" as const,
      },
      {
        ...makeManifestEntry("terminal.restartOnPresetOwned"),
        kind: "command",
        danger: "confirm" as const,
      },
      makeManifestEntry("worktree.createWithRecipe"),
      makeManifestEntry("recipe.run"),
      makeManifestEntry("agent.launch"),
      // With an outputSchema, so an `owned` listing exercises the
      // structuredContent block as well as the JSON text body — the two read
      // one `outcome.value`, and a filter applied to only one of them would
      // otherwise go unnoticed here.
      {
        ...makeManifestEntry("terminal.list"),
        outputSchema: { type: "object", properties: { terminals: { type: "array" } } },
      },
    ];
  }

  /** A store + deps pair whose dispatch returns whatever the test queues up. */
  function harness(
    sessionId: string,
    envelopes: Record<string, unknown>,
    overrides?: Partial<SessionServerDeps>
  ) {
    const store = makeStore();
    seedLiveSession(store, sessionId, "external");
    store.sessionOriginMap.set(sessionId, "external");
    const dispatchAction = vi.fn().mockImplementation((actionId: string) => {
      const envelope = envelopes[actionId];
      if (envelope === undefined) return Promise.resolve({ result: { ok: true, result: null } });
      return Promise.resolve(envelope);
    });
    const deps = fakeDeps({
      sessionStore: store,
      dispatchAction,
      requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
      getCachedManifest: vi.fn(() => ownedManifest()),
      ...overrides,
    });
    return { store, deps, dispatchAction, server: createSessionServer(sessionId, deps) };
  }

  function errorText(result: { content: unknown }): string {
    return JSON.stringify(result.content);
  }

  function payloadOf<T>(res: { content: unknown }): T {
    return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as T;
  }

  describe("recording from trusted results", () => {
    it("records the terminal a direct terminal.new created", async () => {
      const { store, server } = harness("s-new", {
        "terminal.new": {
          result: { ok: true, result: { terminalId: "terminal-1" } },
          dispatchedWorkspace: { kind: "project", workspaceId: "ws-a", workspacePath: "/tmp/a" },
        },
      });

      await callTool(server, { name: "terminal.new", arguments: {} });

      expect(store.resourceOwnership.owns("s-new", "terminal", "terminal-1")).toBe(true);
      expect(store.resourceOwnership.get("s-new", "terminal", "terminal-1")?.workspaceId).toBe(
        "ws-a"
      );
    });

    it("records every composite child terminal and the worktree together", async () => {
      const { store, server } = harness("s-composite", {
        "worktree.createWithRecipe": {
          result: {
            ok: true,
            result: {
              worktreeId: "/tmp/wt",
              worktreePath: "/tmp/wt",
              branch: "feature/x",
              recipeLaunched: true,
              spawnedTerminalCount: 2,
              spawnedTerminalIds: ["terminal-1", "terminal-2"],
              failedTerminalCount: 0,
            },
          },
        },
      });

      await callTool(server, {
        name: "worktree.createWithRecipe",
        arguments: { branchName: "x", recipeId: "r1" },
      });

      expect(store.resourceOwnership.owns("s-composite", "worktree", "/tmp/wt")).toBe(true);
      expect(store.resourceOwnership.owns("s-composite", "terminal", "terminal-1")).toBe(true);
      expect(store.resourceOwnership.owns("s-composite", "terminal", "terminal-2")).toBe(true);
    });

    it("reports a partial composite failure as non-retriable", async () => {
      // Before #11909 this arrived as `EXECUTION_ERROR`, which the retriable
      // set includes — so a conductor was being told to try again, and a retry
      // of a composite that already made a worktree makes a SECOND one. The
      // provenance code carries the honest answer: the call is not repeatable.
      const { server } = harness("s-retriable", {
        "worktree.createWithRecipe": {
          result: {
            ok: false,
            error: {
              code: "PARTIAL_SUCCESS",
              message: formatPartialSuccessMessage("recipe blew up", {
                worktreeId: "/tmp/wt-retriable",
              }),
            },
          },
        },
      });

      const result = await callTool(server, {
        name: "worktree.createWithRecipe",
        arguments: { branchName: "x", recipeId: "r1" },
      });

      const payload = payloadOf<{ retriable: boolean; code: string }>(result);
      expect(payload.code).toBe("PARTIAL_SUCCESS");
      expect(payload.retriable).toBe(false);
    });

    it("records the worktree a partially-failed composite left behind", async () => {
      // The caller has to be able to clean up the mess its own call made, and
      // the failure arrives as `ok: false` because ActionService flattens the
      // renderer throw — so the ledger reads the failure leg too.
      const { store, server } = harness("s-partial", {
        "worktree.createWithRecipe": {
          result: {
            ok: false,
            error: {
              code: "PARTIAL_SUCCESS",
              message: formatPartialSuccessMessage("Recipe r1 failed to run: boom", {
                worktreeId: "/tmp/wt-partial",
                worktreePath: "/tmp/wt-partial",
                branch: "feature/x",
              }),
            },
          },
        },
      });

      const result = await callTool(server, {
        name: "worktree.createWithRecipe",
        arguments: { branchName: "x", recipeId: "r1" },
      });

      expect(result.isError).toBe(true);
      expect(store.resourceOwnership.owns("s-partial", "worktree", "/tmp/wt-partial")).toBe(true);
    });

    it("records nothing when a create fails outright", async () => {
      const { store, server } = harness("s-failed", {
        "terminal.new": {
          result: { ok: false, error: { code: "EXECUTION_ERROR", message: "no worktree" } },
        },
      });

      await callTool(server, { name: "terminal.new", arguments: {} });

      expect(store.resourceOwnership.list("s-failed")).toEqual([]);
    });

    it("records the terminal a launched agent reports, but not its worktree", async () => {
      const { store, server } = harness("s-agent", {
        "agent.launch": {
          result: {
            ok: true,
            result: {
              launched: true,
              terminalId: "terminal-agent",
              worktreeId: "/tmp/pre-existing",
              worktreePath: "/tmp/pre-existing",
            },
          },
        },
      });

      await callTool(server, { name: "agent.launch", arguments: { agentId: "claude" } });

      expect(store.resourceOwnership.owns("s-agent", "terminal", "terminal-agent")).toBe(true);
      // The agent launched INTO that worktree; the session did not create it,
      // so recording it would grant delete authority over someone else's tree.
      expect(store.resourceOwnership.owns("s-agent", "worktree", "/tmp/pre-existing")).toBe(false);
    });

    it("records every terminal a recipe run started", async () => {
      const { store, server } = harness("s-recipe", {
        "recipe.run": {
          result: {
            ok: true,
            result: {
              spawnedCount: 2,
              failedCount: 1,
              spawnedTerminalIds: ["terminal-1", "terminal-2"],
              failedTerminals: [{ index: 2, reason: "panel limit" }],
            },
          },
        },
      });

      await callTool(server, { name: "recipe.run", arguments: { recipeId: "r1" } });

      expect(store.resourceOwnership.owns("s-recipe", "terminal", "terminal-1")).toBe(true);
      expect(store.resourceOwnership.owns("s-recipe", "terminal", "terminal-2")).toBe(true);
      // The dropped terminal has no id, so nothing is attributed for it.
      expect(store.resourceOwnership.list("s-recipe")).toHaveLength(2);
    });

    it("refuses a partial payload that did not come from a PartialSuccessError", async () => {
      // The composite calls forge providers and git BEFORE the worktree exists,
      // and those failures rethrow the provider's message unchanged. A provider
      // returning a string shaped like a partial result must not mint an
      // ownership record for a worktree nothing created — provenance is the
      // error CODE, which only an in-repo `PartialSuccessError` earns.
      const { store, server } = harness("s-forged-partial", {
        "worktree.createWithRecipe": {
          result: {
            ok: false,
            error: {
              code: "EXECUTION_ERROR",
              message: formatPartialSuccessMessage("upstream said so", {
                worktreeId: "/tmp/victim",
              }),
            },
          },
        },
      });

      await callTool(server, {
        name: "worktree.createWithRecipe",
        arguments: { branchName: "x", pullRequestNumber: 1 },
      });

      expect(store.resourceOwnership.owns("s-forged-partial", "worktree", "/tmp/victim")).toBe(
        false
      );
    });

    it("records nothing for a listing, so enumerated ids never become authority", async () => {
      const { store, server } = harness("s-list", {
        "terminal.list": {
          result: { ok: true, result: { terminals: [{ id: "terminal-users-own" }] } },
        },
      });

      await callTool(server, { name: "terminal.list", arguments: {} });

      expect(store.resourceOwnership.owns("s-list", "terminal", "terminal-users-own")).toBe(false);
    });
  });

  describe("terminal.closeOwned", () => {
    it("closes a terminal the session created and delegates to the real terminal.close", async () => {
      const { store, server, dispatchAction } = harness("s-close", {
        "terminal.close": { result: { ok: true, result: { closedIds: ["terminal-1"] } } },
      });
      store.resourceOwnership.record("s-close", [{ kind: "terminal", id: "terminal-1" }]);

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      // Delegation, not reimplementation: trash/recovery and the "reports the
      // exact panel closed" contract come from the shipped action.
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.close",
        { terminalId: "terminal-1" },
        expect.anything()
      );
      // Authority is released once the panel is genuinely gone.
      expect(store.resourceOwnership.owns("s-close", "terminal", "terminal-1")).toBe(false);
    });

    it("keeps authority when the delegated close reports nothing closed", async () => {
      const { store, server } = harness("s-noop", {
        "terminal.close": { result: { ok: true, result: { closedIds: [] } } },
      });
      store.resourceOwnership.record("s-noop", [{ kind: "terminal", id: "terminal-1" }]);

      await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      // A no-op close must not revoke the session's authority over a panel that
      // is still running.
      expect(store.resourceOwnership.owns("s-noop", "terminal", "terminal-1")).toBe(true);
    });

    // #14474: a close trashes the panel and its agent runs on through the
    // grace, so a caller reading `closedIds` must also be told the process is
    // still there, through `closeMany` from a relayed host call as well.
    it("says what the host saw of each closed panel's process, item by item in a closeMany", async () => {
      const manifest = [
        ...ownedManifest(),
        { ...makeManifestEntry("terminal.closeMany"), kind: "command", danger: "safe" as const },
      ];
      const readClosedPanelProcess = vi.fn(async (terminalId: string) => ({
        terminalId,
        exited: false,
        trashExpiresAt: 1_700_000_020_000,
      }));
      const { store, server } = harness(
        "s-close-many",
        {},
        {
          requestManifest: vi.fn().mockResolvedValue(manifest),
          getCachedManifest: vi.fn(() => manifest),
          readClosedPanelProcess,
          dispatchAction: vi.fn(async (_id: string, args: unknown) => ({
            result: {
              ok: true as const,
              result: { closedIds: [(args as { terminalId: string }).terminalId] },
            },
          })),
        }
      );
      // `terminal.closeMany` sits above the `external` tier.
      seedLiveSession(store, "s-close-many", "core");
      store.resourceOwnership.record("s-close-many", [
        { kind: "terminal", id: "terminal-1" },
        { kind: "terminal", id: "terminal-2" },
      ]);

      const result = await callTool(server, {
        name: "terminal.closeMany",
        arguments: { terminalIds: ["terminal-1", "terminal-2"] },
      });

      expect(payloadOf(result)).toEqual({
        results: [
          {
            target: "terminal-1",
            ok: true,
            result: {
              closedIds: ["terminal-1"],
              processes: [
                { terminalId: "terminal-1", exited: false, trashExpiresAt: 1_700_000_020_000 },
              ],
            },
          },
          {
            target: "terminal-2",
            ok: true,
            result: {
              closedIds: ["terminal-2"],
              processes: [
                { terminalId: "terminal-2", exited: false, trashExpiresAt: 1_700_000_020_000 },
              ],
            },
          },
        ],
      });
      // Read after the close, never instead of it: ownership still follows the
      // panel, so a closed one is released.
      expect(store.resourceOwnership.owns("s-close-many", "terminal", "terminal-1")).toBe(false);
    });

    it("reads nothing for a close that closed nothing", async () => {
      const readClosedPanelProcess = vi.fn();
      const { store, server } = harness(
        "s-noop-read",
        { "terminal.close": { result: { ok: true, result: { closedIds: [] } } } },
        { readClosedPanelProcess }
      );
      store.resourceOwnership.record("s-noop-read", [{ kind: "terminal", id: "terminal-1" }]);

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(readClosedPanelProcess).not.toHaveBeenCalled();
      expect(payloadOf<{ processes: unknown[] }>(result).processes).toEqual([]);
    });

    it("refuses another session's terminal without dispatching", async () => {
      const { store, server, dispatchAction } = harness("session-b", {});
      store.resourceOwnership.record("session-a", [{ kind: "terminal", id: "terminal-a" }]);

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-a" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      // The acceptance criterion: refused BEFORE renderer mutation.
      expect(dispatchAction).not.toHaveBeenCalled();
      expect(store.resourceOwnership.owns("session-a", "terminal", "terminal-a")).toBe(true);
    });

    it("refuses a forged id with the same error as an unowned one", async () => {
      // One code, one message: distinguishing "no such panel" from "not yours"
      // would let a caller enumerate the view it was never granted.
      const { server, dispatchAction } = harness("s-forged", {});

      const unknown = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-does-not-exist" },
      });

      expect(unknown.isError).toBe(true);
      expect(errorText(unknown)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("refuses a worktree id passed as a terminal id", async () => {
      // Kind is part of the key, so owning the worktree grants no authority
      // over a panel that happens to share its id string.
      const { store, server, dispatchAction } = harness("s-kind", {});
      store.resourceOwnership.record("s-kind", [{ kind: "worktree", id: "/tmp/wt" }]);

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "/tmp/wt" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("rejects a blank id as a validation error rather than an ownership one", async () => {
      const { server, dispatchAction } = harness("s-blank", {});

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "   " },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("VALIDATION_ERROR");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("loses authority when the session is revoked, without closing anything", async () => {
      const { store, server, dispatchAction } = harness("s-revoked", {
        "terminal.close": { result: { ok: true, result: { closedIds: ["terminal-1"] } } },
      });
      store.resourceOwnership.record("s-revoked", [{ kind: "terminal", id: "terminal-1" }]);

      store.revokeSession("s-revoked");

      // Revocation clears the authority record and dispatches nothing:
      // disconnect is not a decision to destroy the user's terminals.
      expect(store.resourceOwnership.list("s-revoked")).toEqual([]);
      expect(dispatchAction).not.toHaveBeenCalled();

      // And the terminal stays un-closable by the dead session — the liveness
      // gate refuses the call before ownership is even consulted.
      const refused = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });
      expect(refused.isError).toBe(true);
      expect(errorText(refused)).toContain(SESSION_GONE);
      expect(dispatchAction).not.toHaveBeenCalled();
    });
  });

  describe("terminal.interruptOwned (#12338)", () => {
    const INTERRUPT_RESULT = {
      terminalId: "terminal-1",
      agentId: "claude",
      agentStateAtDispatch: "working",
      status: "requested",
    };

    function interruptHarness(sessionId: string) {
      const h = harness(sessionId, {
        "terminal.interrupt": { result: { ok: true, result: INTERRUPT_RESULT } },
        "terminal.close": { result: { ok: true, result: { closedIds: ["terminal-1"] } } },
      });
      h.store.resourceOwnership.record(sessionId, [{ kind: "terminal", id: "terminal-1" }]);
      return h;
    }

    it("delegates to the renderer interrupt with only the id", async () => {
      const { server, dispatchAction } = interruptHarness("s-interrupt");

      const result = await callTool(server, {
        name: "terminal.interruptOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.interrupt",
        { terminalId: "terminal-1" },
        expect.anything()
      );
      expect(payloadOf<{ status: string }>(result).status).toBe("requested");
    });

    // Rebuilding the arguments is what keeps this one operation rather than the
    // general signal API it was deliberately not made into: a caller cannot
    // smuggle a key sequence, a signal number or a second target through it.
    it("strips anything the caller sent beyond the id", async () => {
      const { server, dispatchAction } = interruptHarness("s-interrupt-strip");

      await callTool(server, {
        name: "terminal.interruptOwned",
        arguments: {
          terminalId: "terminal-1",
          signal: "SIGKILL",
          keySequence: "\u0003",
          confirmed: true,
        },
      });

      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.interrupt",
        { terminalId: "terminal-1" },
        expect.anything()
      );
    });

    it("refuses a panel the session did not create, without dispatching", async () => {
      const { store, server, dispatchAction } = interruptHarness("s-interrupt-foreign");
      store.resourceOwnership.record("other-session", [
        { kind: "terminal", id: "terminal-theirs" },
      ]);

      const result = await callTool(server, {
        name: "terminal.interruptOwned",
        arguments: { terminalId: "terminal-theirs" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    // The half that separates this from the cleanup tools: a stop is not an
    // end, so the session keeps the authority to stop the panel again — and to
    // close it afterwards, which is the point of having a non-destructive stop.
    it("keeps ownership, so the panel can be interrupted again and then closed", async () => {
      const { store, server, dispatchAction } = interruptHarness("s-interrupt-twice");
      const args = { name: "terminal.interruptOwned", arguments: { terminalId: "terminal-1" } };

      const first = await callTool(server, args);
      const second = await callTool(server, args);

      expect(first.isError).toBeUndefined();
      expect(second.isError).toBeUndefined();
      // Counted, not inferred from two successes: a dedup entry would serve the
      // second call from cache and leave the agent running with both calls green.
      expect(
        dispatchAction.mock.calls.filter((c: unknown[]) => c[0] === "terminal.interrupt")
      ).toHaveLength(2);

      // The point of retaining the record: the stop did not spend the session's
      // authority, so the close it was a step toward still works.
      const closed = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(closed.isError).toBeUndefined();
      expect(store.resourceOwnership.owns("s-interrupt-twice", "terminal", "terminal-1")).toBe(
        false
      );
    });

    // Guards `releasesOwnership: false` itself. Without it the entry would fall
    // through to the release path, and the structural `closedIds` check is a
    // separate guard that would mask the flag being wrong.
    it("retains ownership even if the delegate claims the panel closed", async () => {
      const { store, server } = harness("s-interrupt-claims-closed", {
        "terminal.interrupt": {
          result: { ok: true, result: { ...INTERRUPT_RESULT, closedIds: ["terminal-1"] } },
        },
      });
      store.resourceOwnership.record("s-interrupt-claims-closed", [
        { kind: "terminal", id: "terminal-1" },
      ]);

      const result = await callTool(server, {
        name: "terminal.interruptOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      expect(
        store.resourceOwnership.owns("s-interrupt-claims-closed", "terminal", "terminal-1")
      ).toBe(true);
    });

    // A refusal is the delegate declining to write keystrokes, not the panel
    // going away — so the session keeps it and can close it instead.
    it("keeps ownership when the delegate refuses the target", async () => {
      const { store, server } = harness("s-interrupt-refused", {
        "terminal.interrupt": {
          result: {
            ok: false,
            error: { code: "EXECUTION_ERROR", message: "advertises Ctrl+C as its interrupt" },
          },
        },
      });
      store.resourceOwnership.record("s-interrupt-refused", [
        { kind: "terminal", id: "terminal-1" },
      ]);

      const result = await callTool(server, {
        name: "terminal.interruptOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("Ctrl+C");
      expect(store.resourceOwnership.owns("s-interrupt-refused", "terminal", "terminal-1")).toBe(
        true
      );
    });

    it("rejects a missing id before anything reaches the renderer", async () => {
      const { server, dispatchAction } = interruptHarness("s-interrupt-noid");

      const result = await callTool(server, {
        name: "terminal.interruptOwned",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("VALIDATION_ERROR");
      expect(dispatchAction).not.toHaveBeenCalled();
    });
  });
  describe("terminal.restartOnPresetOwned (#14369)", () => {
    const RESTART_RESULT = {
      terminalId: "terminal-1",
      agentPresetId: "work",
      agentSessionIdCleared: true,
    };

    function restartHarness(sessionId: string) {
      const h = harness(sessionId, {
        "terminal.restartOnPreset": { result: { ok: true, result: RESTART_RESULT } },
        "terminal.close": { result: { ok: true, result: { closedIds: ["terminal-1"] } } },
      });
      h.store.resourceOwnership.record(sessionId, [{ kind: "terminal", id: "terminal-1" }]);
      return h;
    }

    // `confirmed` is the one argument that must never cross: the delegate
    // reads it as the user's approval, so forwarding it would let the model
    // approve its own restart.
    it("delegates with only the id and preset, unconfirmed", async () => {
      const { server, dispatchAction } = restartHarness("s-restart");

      const result = await callTool(server, {
        name: "terminal.restartOnPresetOwned",
        arguments: { terminalId: "terminal-1", presetId: "work", confirmed: true },
      });

      expect(result.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.restartOnPreset",
        { presetId: "work", terminalId: "terminal-1" },
        false
      );
      expect(payloadOf<typeof RESTART_RESULT>(result)).toEqual(RESTART_RESULT);
    });

    // The pane survives a restart, so the session keeps the authority to brief
    // it again and to close it afterwards.
    it("keeps ownership, so the restarted panel can still be closed", async () => {
      const { store, server } = restartHarness("s-restart-keeps");

      await callTool(server, {
        name: "terminal.restartOnPresetOwned",
        arguments: { terminalId: "terminal-1", presetId: "work" },
      });
      expect(store.resourceOwnership.owns("s-restart-keeps", "terminal", "terminal-1")).toBe(true);

      const closed = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(closed.isError).toBeUndefined();
      expect(store.resourceOwnership.owns("s-restart-keeps", "terminal", "terminal-1")).toBe(false);
    });

    it("keeps ownership when the restart fails", async () => {
      const { store, server } = harness("s-restart-failed", {
        "terminal.restartOnPreset": {
          result: {
            ok: false,
            error: { code: "EXECUTION_ERROR", message: "preset not found" },
          },
        },
      });
      store.resourceOwnership.record("s-restart-failed", [{ kind: "terminal", id: "terminal-1" }]);

      const result = await callTool(server, {
        name: "terminal.restartOnPresetOwned",
        arguments: { terminalId: "terminal-1", presetId: "gone" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("preset not found");
      expect(store.resourceOwnership.owns("s-restart-failed", "terminal", "terminal-1")).toBe(true);
    });

    it("refuses a panel the session did not create, without dispatching", async () => {
      const { store, server, dispatchAction } = restartHarness("s-restart-foreign");
      store.resourceOwnership.record("other-session", [
        { kind: "terminal", id: "terminal-theirs" },
      ]);

      const result = await callTool(server, {
        name: "terminal.restartOnPresetOwned",
        arguments: { terminalId: "terminal-theirs", presetId: "work" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });
  });
  describe("terminal.placeOwned (#13662)", () => {
    const PLACE_RESULT = { terminalId: "terminal-1", location: "background", transitioned: true };

    function placeHarness(sessionId: string) {
      const h = harness(sessionId, {
        "terminal.placeOwned": { result: { ok: true, result: PLACE_RESULT } },
      });
      h.store.resourceOwnership.record(sessionId, [{ kind: "terminal", id: "terminal-1" }]);
      return h;
    }

    // The renderer definition is the placement itself, so the gate dispatches
    // the same id back — with only the id and destination, so nothing the
    // caller adds (a focus flag, a confirmation) reaches it.
    it("dispatches itself with only the id and destination", async () => {
      const { server, dispatchAction } = placeHarness("s-place");

      const result = await callTool(server, {
        name: "terminal.placeOwned",
        arguments: { terminalId: "terminal-1", location: "background", focus: true },
      });

      expect(result.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.placeOwned",
        { terminalId: "terminal-1", location: "background" },
        expect.anything()
      );
      expect(payloadOf<{ location: string }>(result).location).toBe("background");
    });

    it("refuses a panel the session did not create, without dispatching", async () => {
      const { store, server, dispatchAction } = placeHarness("s-place-foreign");
      store.resourceOwnership.record("other-session", [
        { kind: "terminal", id: "terminal-theirs" },
      ]);

      const result = await callTool(server, {
        name: "terminal.placeOwned",
        arguments: { terminalId: "terminal-theirs", location: "background" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    // Parking a seat is not the end of it: the session brings it back later,
    // so each identical call must reach the renderer rather than being served
    // from a dedup entry, and the record has to survive the placement.
    it("redispatches an identical placement and keeps ownership", async () => {
      const { store, server, dispatchAction } = placeHarness("s-place-twice");
      const args = {
        name: "terminal.placeOwned",
        arguments: { terminalId: "terminal-1", location: "background" },
      };

      const first = await callTool(server, args);
      const second = await callTool(server, args);

      expect(first.isError).toBeUndefined();
      expect(second.isError).toBeUndefined();
      expect(
        dispatchAction.mock.calls.filter((c: unknown[]) => c[0] === "terminal.placeOwned")
      ).toHaveLength(2);
      expect(store.resourceOwnership.owns("s-place-twice", "terminal", "terminal-1")).toBe(true);
    });

    // A placement receipt names no closed panels, so it cannot show on its own
    // that the entry keeps its record; a receipt shaped like a close would
    // release it under `releasesOwnership: true`.
    it("keeps the record even when the result looks like a close", async () => {
      const { store, server } = harness("s-place-release", {
        "terminal.placeOwned": { result: { ok: true, result: { closedIds: ["terminal-1"] } } },
      });
      store.resourceOwnership.record("s-place-release", [{ kind: "terminal", id: "terminal-1" }]);

      await callTool(server, {
        name: "terminal.placeOwned",
        arguments: { terminalId: "terminal-1", location: "grid" },
      });

      expect(store.resourceOwnership.owns("s-place-release", "terminal", "terminal-1")).toBe(true);
    });
  });

  describe("terminal.readLastMessageOwned (#12479)", () => {
    const READ_RESULT: AgentLastMessageResult = {
      status: "ok",
      provider: "claude",
      message: {
        id: "msg_1",
        text: "Verdict: ship it.",
        truncated: false,
        recordedAt: 1,
        stopReason: "end_turn",
        nextCursor: null,
      },
      unansweredToolUses: [],
      newerRecordsFollow: false,
      fileUpdatedAt: 1,
    };

    function readHarness(
      sessionId: string,
      read: SessionServerDeps["handleTerminalReadLastMessageOwned"] = () =>
        Promise.resolve(READ_RESULT)
    ) {
      const handleTerminalReadLastMessageOwned = vi.fn(read);
      const h = harness(sessionId, {}, { handleTerminalReadLastMessageOwned });
      h.store.resourceOwnership.record(sessionId, [{ kind: "terminal", id: "terminal-1" }]);
      return { ...h, handleTerminalReadLastMessageOwned };
    }

    it("runs in main on the checked id and the call's signal, never reaching a renderer", async () => {
      const { server, deps, dispatchAction, handleTerminalReadLastMessageOwned } =
        readHarness("s-read");

      const result = await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(READ_RESULT);
      expect(payloadOf(result)).toEqual(READ_RESULT);
      expect(handleTerminalReadLastMessageOwned).toHaveBeenCalledWith(
        "terminal-1",
        {},
        expect.any(AbortSignal)
      );
      expect(dispatchAction).not.toHaveBeenCalled();
      expect(deps.requestManifest).not.toHaveBeenCalled();
    });

    // How much of which message is the caller's to choose (#12496), and the
    // only thing beyond the id that reaches the executor.
    it("forwards the read options it validated", async () => {
      const { server, handleTerminalReadLastMessageOwned } = readHarness("s-read-options");
      const cursor = encodeMessageCursor("msg_1", "Text before the page.", 5);

      await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-1", maxBytes: 49152, messageIndex: 2 },
      });
      await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-1", cursor, path: "/etc/passwd" },
      });

      expect(handleTerminalReadLastMessageOwned.mock.calls.map((call) => call[1])).toEqual([
        { maxBytes: 49152, messageIndex: 2 },
        { cursor },
      ]);
    });

    // Nothing else validates a main-executed call, so an out-of-contract value
    // is refused here rather than read with.
    it("refuses read options out of contract, without reading, and audits the refusal", async () => {
      const { server, deps, handleTerminalReadLastMessageOwned } = readHarness("s-read-invalid");

      for (const extra of [
        { maxBytes: 1_000_000 },
        { messageIndex: -1 },
        { cursor: "made-up" },
        { cursor: encodeMessageCursor("msg_1", "Text.", 2), messageIndex: 0 },
      ]) {
        const result = await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "terminal-1", ...extra },
        });
        expect(result.isError).toBe(true);
        expect(toolErrorPayload(result).code).toBe("VALIDATION_ERROR");
      }

      expect(handleTerminalReadLastMessageOwned).not.toHaveBeenCalled();
      expect(deps.appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: {
            kind: "result",
            value: expect.objectContaining({
              ok: false,
              error: expect.objectContaining({ code: "VALIDATION_ERROR" }),
            }),
          },
        })
      );
    });

    // Ownership is decided first, so a malformed request for someone else's
    // panel learns nothing more than a well-formed one would.
    it("refuses a panel the session did not create before looking at its options", async () => {
      const { server, handleTerminalReadLastMessageOwned } = readHarness("s-read-foreign-options");

      const result = await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-theirs", maxBytes: "lots" },
      });

      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(errorText(result)).not.toContain("maxBytes");
      expect(handleTerminalReadLastMessageOwned).not.toHaveBeenCalled();
    });

    it("refuses a call that names no panel", async () => {
      const { server, handleTerminalReadLastMessageOwned } = readHarness("s-read-blank");

      const result = await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "  " },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("VALIDATION_ERROR");
      expect(handleTerminalReadLastMessageOwned).not.toHaveBeenCalled();
    });

    it("keeps ownership, so the panel can be read again", async () => {
      const { store, server, handleTerminalReadLastMessageOwned } = readHarness("s-read-twice");
      const args = {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-1" },
      };

      expect((await callTool(server, args)).isError).toBeUndefined();
      expect((await callTool(server, args)).isError).toBeUndefined();

      expect(handleTerminalReadLastMessageOwned).toHaveBeenCalledTimes(2);
      expect(store.resourceOwnership.owns("s-read-twice", "terminal", "terminal-1")).toBe(true);
    });

    // An unavailable answer is still an answer — the caller asked and was told
    // why not — so it is a structured success, not a tool error.
    it("returns an unavailable answer as a structured result", async () => {
      const unavailable: AgentLastMessageResult = {
        status: "unavailable",
        reason: "store-unknown",
      };
      const { server } = readHarness("s-read-unavailable", () => Promise.resolve(unavailable));

      const result = await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(unavailable);
    });

    it("audits a read once, as the result the executor returned", async () => {
      const { server, deps } = readHarness("s-read-audit");

      await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(deps.appendAuditRecord).toHaveBeenCalledTimes(1);
      expect(deps.appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          toolId: "terminal.readLastMessageOwned",
          outcome: { kind: "result", value: { ok: true, result: READ_RESULT } },
        })
      );
    });

    // Ownership records carry the workspace the panel was created in, and a
    // session rebound elsewhere is refused before anything is read.
    it("refuses a panel recorded under another workspace, without reading", async () => {
      const { store, server, handleTerminalReadLastMessageOwned } = readHarness("s-read-rebound");
      store.resourceOwnership.record(
        "s-read-rebound",
        [{ kind: "terminal", id: "terminal-a" }],
        "ws-a"
      );
      store.sessionWorkspaceMap.set("s-read-rebound", "ws-b");

      const result = await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-a" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(handleTerminalReadLastMessageOwned).not.toHaveBeenCalled();
    });

    it("slides a native grant that covered the read, as the delegated owned tools do", async () => {
      const { store, server } = readHarness("s-read-grant");
      const grant = store.grantCache.issueNativeGrant({
        sessionId: "s-read-grant",
        actorId: "help-1",
        actorType: "help-session",
        allowedTools: ["terminal.readLastMessageOwned"],
        maxUses: 3,
      });
      const refresh = vi.spyOn(store.grantCache, "refreshNativeGrant");

      const result = await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      expect(refresh).toHaveBeenCalledWith(grant.id);
    });

    it("reports a failed read as an execution error, audited as a throw", async () => {
      const { server, deps } = readHarness("s-read-throw", () =>
        Promise.reject(new Error("pty host unavailable"))
      );

      const result = await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("EXECUTION_ERROR");
      expect(deps.appendAuditRecord).toHaveBeenCalledTimes(1);
      expect(deps.appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: expect.objectContaining({ kind: "throw" }) })
      );
    });

    // Daintree's own assistant already types into every pane in its view, so it
    // reads by that view as well as by the ledger (#12883, #13439).
    describe("from Daintree's own assistant (#12883)", () => {
      function assistantReadHarness(sessionId: string, inView: (terminalId: string) => boolean) {
        const isTerminalInPinnedWorkspace = vi.fn(async (id: string) => inView(id));
        const h = readHarness(sessionId);
        // The assistant's own tier, not the external one the harness seeds:
        // the external allowlist admits this tool too, so it would prove nothing.
        h.store.sessionTierMap.set(sessionId, "core");
        h.store.sessionOriginMap.set(sessionId, "help");
        const deps = { ...h.deps, isTerminalInPinnedWorkspace };
        return {
          ...h,
          deps,
          isTerminalInPinnedWorkspace,
          server: createSessionServer(sessionId, deps),
        };
      }

      it("reads a pane the user started in its pinned view, without claiming it", async () => {
        const { store, server, handleTerminalReadLastMessageOwned, isTerminalInPinnedWorkspace } =
          assistantReadHarness("s-assist", (id) => id === "user-pane");

        const result = await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "user-pane", maxBytes: 4096 },
        });

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual(READ_RESULT);
        expect(isTerminalInPinnedWorkspace).toHaveBeenCalledWith("user-pane");
        expect(handleTerminalReadLastMessageOwned).toHaveBeenCalledWith(
          "user-pane",
          { maxBytes: 4096 },
          expect.any(AbortSignal)
        );
        expect(store.resourceOwnership.owns("s-assist", "terminal", "user-pane")).toBe(false);
      });

      it("is refused a pane outside its pinned view, without reading", async () => {
        const { server, deps, handleTerminalReadLastMessageOwned } = assistantReadHarness(
          "s-assist-foreign",
          () => false
        );

        const result = await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "elsewhere" },
        });

        expect(result.isError).toBe(true);
        expect(toolErrorPayload(result).code).toBe("RESOURCE_NOT_OWNED");
        expect(errorText(result)).toContain("project this assistant is open in");
        expect(handleTerminalReadLastMessageOwned).not.toHaveBeenCalled();
        expect(deps.appendAuditRecord).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: {
              kind: "result",
              value: expect.objectContaining({
                ok: false,
                error: expect.objectContaining({ code: "RESOURCE_NOT_OWNED" }),
              }),
            },
          })
        );
      });

      // A help session was refused the panes it had launched while the view
      // check answered no (#13439). Its own panes are the ledger's, as every
      // session's are, and the view is never asked about them.
      it("reads a pane it created even when the view check refuses", async () => {
        const { server, handleTerminalReadLastMessageOwned, isTerminalInPinnedWorkspace } =
          assistantReadHarness("s-assist-owned", () => false);

        const result = await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "terminal-1" },
        });

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual(READ_RESULT);
        expect(handleTerminalReadLastMessageOwned).toHaveBeenCalledWith(
          "terminal-1",
          {},
          expect.any(AbortSignal)
        );
        expect(isTerminalInPinnedWorkspace).not.toHaveBeenCalled();
      });

      // A hand-over is a grant to a pane, and the tool accepts one, but it never
      // admits the assistant's read: only creation or the view does.
      it("never admits a handed-over pane that the view check refuses", async () => {
        const { store, server, handleTerminalReadLastMessageOwned, isTerminalInPinnedWorkspace } =
          assistantReadHarness("s-assist-handed", () => false);
        store.resourceOwnership.bindPrincipal("s-assist-handed", "principal-help");
        expect(
          store.terminalAdoption.adopt({
            terminalId: "handed-pane",
            orchestratorPaneId: "orchestrator-pane",
            principalId: "principal-help",
          }).ok
        ).toBe(true);

        const result = await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "handed-pane" },
        });

        expect(toolErrorPayload(result).code).toBe("RESOURCE_NOT_OWNED");
        expect(isTerminalInPinnedWorkspace).toHaveBeenCalledWith("handed-pane");
        expect(handleTerminalReadLastMessageOwned).not.toHaveBeenCalled();
      });

      it("refuses a pane it did not create when the view check is not wired", async () => {
        const { store, server, handleTerminalReadLastMessageOwned } =
          readHarness("s-assist-unwired");
        store.sessionOriginMap.set("s-assist-unwired", "help");

        const refused = await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "user-pane" },
        });
        const owned = await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "terminal-1" },
        });

        expect(toolErrorPayload(refused).code).toBe("RESOURCE_NOT_OWNED");
        expect(owned.isError).toBeUndefined();
        expect(handleTerminalReadLastMessageOwned).toHaveBeenCalledTimes(1);
        expect(handleTerminalReadLastMessageOwned).toHaveBeenCalledWith(
          "terminal-1",
          {},
          expect.any(AbortSignal)
        );
      });

      it("decides the view before looking at the options", async () => {
        const { server, handleTerminalReadLastMessageOwned } = assistantReadHarness(
          "s-assist-foreign-options",
          () => false
        );

        const result = await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "elsewhere", maxBytes: "lots" },
        });

        expect(toolErrorPayload(result).code).toBe("RESOURCE_NOT_OWNED");
        expect(errorText(result)).not.toContain("maxBytes");
        expect(handleTerminalReadLastMessageOwned).not.toHaveBeenCalled();
      });

      // An agent pane's bearer is an external origin: the ledger still decides,
      // however the view check would answer.
      it("never consults the view for an agent pane's session", async () => {
        const isTerminalInPinnedWorkspace = vi.fn(async () => true);
        const { deps, handleTerminalReadLastMessageOwned } = readHarness("s-pane-read");
        const server = createSessionServer("s-pane-read", {
          ...deps,
          isTerminalInPinnedWorkspace,
        });

        const refused = await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "user-pane" },
        });
        const owned = await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "terminal-1" },
        });

        expect(toolErrorPayload(refused).code).toBe("RESOURCE_NOT_OWNED");
        expect(owned.isError).toBeUndefined();
        expect(isTerminalInPinnedWorkspace).not.toHaveBeenCalled();
        expect(handleTerminalReadLastMessageOwned).toHaveBeenCalledTimes(1);
      });

      // Only the read reads by view; the assistant's other owned tools keep the
      // ledger.
      it("keeps the ledger for the assistant's other owned tools", async () => {
        const { server, dispatchAction, isTerminalInPinnedWorkspace } = assistantReadHarness(
          "s-assist-interrupt",
          () => true
        );

        const result = await callTool(server, {
          name: "terminal.interruptOwned",
          arguments: { terminalId: "user-pane" },
        });

        expect(toolErrorPayload(result).code).toBe("RESOURCE_NOT_OWNED");
        expect(isTerminalInPinnedWorkspace).not.toHaveBeenCalled();
        expect(dispatchAction).not.toHaveBeenCalled();
      });
    });
  });

  describe("owned terminal input (#12407)", () => {
    const SUBMIT_RESULT = {
      sent: true,
      terminalId: "terminal-1",
      command: "ls",
      submissionToken: "token-1",
      message: "Submission queued.",
    };

    function inputHarness(sessionId: string) {
      const h = harness(sessionId, {
        "terminal.sendCommand": { result: { ok: true, result: SUBMIT_RESULT } },
        "terminal.inject": { result: { ok: true, result: undefined } },
      });
      h.store.resourceOwnership.record(sessionId, [{ kind: "terminal", id: "terminal-1" }]);
      return h;
    }

    it("submits to a terminal the session created with only the id and the text", async () => {
      const { server, dispatchAction } = inputHarness("s-submit");

      const result = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-1", command: "npm test\nnpm run lint" },
      });

      expect(result.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.sendCommand",
        { terminalId: "terminal-1", command: "npm test\nnpm run lint" },
        expect.anything()
      );
      expect(result.structuredContent).toMatchObject({ sent: true, submissionToken: "token-1" });
    });

    // The rebuilt arguments are the enforcement: whatever else the caller
    // sends, the delegate sees the checked id and the text, so no extra field
    // can retarget the submission or pre-approve anything.
    it("strips every other argument, including ones that name another target", async () => {
      const { server, dispatchAction } = inputHarness("s-submit-strip");

      await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: {
          terminalId: "terminal-1",
          command: "ls",
          id: "user-shell",
          terminalIds: ["user-shell"],
          worktreeId: "/tmp/other",
          confirmed: true,
        },
      });

      expect(dispatchAction).toHaveBeenCalledTimes(1);
      const [actionId, delegated, confirmed] = dispatchAction.mock.calls[0]!;
      expect(actionId).toBe("terminal.sendCommand");
      expect(delegated).toStrictEqual({ terminalId: "terminal-1", command: "ls" });
      // A caller's `confirmed` is an argument like any other, not an approval.
      expect(confirmed).toBe(false);
    });

    // #12488: whether to ask for a handback is the one other field it carries.
    it("forwards a handback request alongside the text", async () => {
      const { server, dispatchAction } = inputHarness("s-submit-handback");

      await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-1", command: "fix it", handback: true },
      });

      const delegated = dispatchAction.mock.calls[0]![1] as Record<string, unknown>;
      expect(delegated).toStrictEqual({
        terminalId: "terminal-1",
        command: "fix it",
        handback: true,
      });
    });

    // An absent field is left absent rather than forwarded as `undefined`, so
    // the delegate's own schema is what rejects the missing text.
    it("forwards nothing for a field the caller left out", async () => {
      const { server, dispatchAction } = inputHarness("s-submit-nocommand");

      await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-1" },
      });

      const delegated = dispatchAction.mock.calls[0]![1] as Record<string, unknown>;
      expect(delegated).toStrictEqual({ terminalId: "terminal-1" });
      expect(Object.hasOwn(delegated, "command")).toBe(false);
    });

    it("injects into a terminal the session created with only the id", async () => {
      const { server, dispatchAction } = inputHarness("s-inject");

      const result = await callTool(server, {
        name: "terminal.injectOwned",
        arguments: { terminalId: "terminal-1", worktreeId: "/tmp/other", text: "rm -rf /" },
      });

      expect(result.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.inject",
        { terminalId: "terminal-1" },
        expect.anything()
      );
    });

    it.each(["terminal.sendCommandOwned", "terminal.injectOwned"])(
      "%s refuses the user's terminal and another session's, without dispatching",
      async (tool) => {
        const { store, server, dispatchAction } = inputHarness(`s-foreign-${tool}`);
        store.resourceOwnership.record("other-session", [
          { kind: "terminal", id: "terminal-theirs" },
        ]);

        for (const terminalId of ["terminal-theirs", "user-shell"]) {
          const result = await callTool(server, {
            name: tool,
            arguments: { terminalId, command: "ls" },
          });
          expect(result.isError).toBe(true);
          expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
        }
        expect(dispatchAction).not.toHaveBeenCalled();
      }
    );

    it.each(["terminal.sendCommandOwned", "terminal.injectOwned"])(
      "%s rejects a missing id before anything reaches the renderer",
      async (tool) => {
        const { server, dispatchAction } = inputHarness(`s-noid-${tool}`);

        const result = await callTool(server, { name: tool, arguments: { command: "ls" } });

        expect(result.isError).toBe(true);
        expect(errorText(result)).toContain("VALIDATION_ERROR");
        expect(dispatchAction).not.toHaveBeenCalled();
      }
    );

    // Submitting is not a claim the panel stopped existing, and a repeat is a
    // second submission rather than a replay to absorb.
    it.each([
      ["terminal.sendCommandOwned", "terminal.sendCommand"],
      ["terminal.injectOwned", "terminal.inject"],
    ])("%s keeps ownership and dispatches a repeat again", async (tool, delegate) => {
      const sessionId = `s-twice-${tool}`;
      // The delegate claims the panel closed, so only `releasesOwnership: false`
      // keeps the record — the structural `closedIds` check would otherwise
      // mask a wrong flag, as it does for the interrupt above.
      const { store, server, dispatchAction } = harness(sessionId, {
        [delegate]: {
          result: { ok: true, result: { ...SUBMIT_RESULT, closedIds: ["terminal-1"] } },
        },
      });
      store.resourceOwnership.record(sessionId, [{ kind: "terminal", id: "terminal-1" }]);
      const args = { name: tool, arguments: { terminalId: "terminal-1", command: "ls" } };

      expect((await callTool(server, args)).isError).toBeUndefined();
      expect((await callTool(server, args)).isError).toBeUndefined();

      expect(dispatchAction.mock.calls.filter((c: unknown[]) => c[0] === delegate)).toHaveLength(2);
      expect(store.resourceOwnership.owns(sessionId, "terminal", "terminal-1")).toBe(true);
    });

    it("reaches a terminal the session opened through terminal.new", async () => {
      const { server, dispatchAction } = harness("s-new-then-submit", {
        "terminal.new": { result: { ok: true, result: { terminalId: "terminal-9" } } },
        "terminal.sendCommand": { result: { ok: true, result: SUBMIT_RESULT } },
      });

      await callTool(server, { name: "terminal.new", arguments: {} });
      const result = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-9", command: "ls" },
      });

      expect(result.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.sendCommand",
        { terminalId: "terminal-9", command: "ls" },
        expect.anything()
      );
    });
  });

  describe("terminal.revealOwned (#12315)", () => {
    /**
     * A reveal harness with the bridge's reveal route wired. One dep, because
     * the dispatch and the window raise have to land on the same window and the
     * bridge is the only thing that can resolve it once.
     */
    function revealHarness(
      sessionId: string,
      envelopes: Record<string, unknown>,
      overrides?: Partial<SessionServerDeps>
    ) {
      const revealOwnedRun = vi
        .fn()
        .mockImplementation((_workspaceId: string | undefined, actionId: string) =>
          Promise.resolve({
            envelope: envelopes[actionId] ?? { result: { ok: true, result: null } },
            raised: true,
          })
        );
      const h = harness(sessionId, envelopes, { revealOwnedRun, ...overrides });
      return { ...h, revealOwnedRun };
    }

    it("delegates to pilot.openRun under the delegate's own name for the id", async () => {
      // `pilot.openRun` is the shipped operation — switch the workspace, then
      // carry a one-shot focus intent the incoming view applies once hydrated —
      // and it spells the id `runId` where the public tool spells it
      // `terminalId`. Arguments are rebuilt, not forwarded, so without that
      // rename the id would simply not arrive.
      const { store, server, revealOwnedRun } = revealHarness("s-reveal", {
        "pilot.openRun": { result: { ok: true, result: null } },
      });
      store.resourceOwnership.record("s-reveal", [{ kind: "terminal", id: "terminal-1" }], "ws-a");

      const result = await callTool(server, {
        name: "terminal.revealOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      expect(revealOwnedRun).toHaveBeenCalledWith(
        "ws-a",
        "pilot.openRun",
        { runId: "terminal-1", workspaceId: "ws-a" },
        expect.anything()
      );
    });

    it("carries the destination from the ledger, so an unbound session still lands", async () => {
      // An unbound session's dispatches follow the active view. Create a
      // terminal in B, let the user switch to A, then reveal: without the
      // recorded workspace the reveal would look for B's panel inside A.
      const { store, server, revealOwnedRun } = revealHarness("s-reveal-unbound", {
        "pilot.openRun": { result: { ok: true, result: null } },
      });
      store.resourceOwnership.record(
        "s-reveal-unbound",
        [{ kind: "terminal", id: "terminal-1" }],
        "ws-b"
      );

      await callTool(server, {
        name: "terminal.revealOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(revealOwnedRun).toHaveBeenCalledWith(
        "ws-b",
        "pilot.openRun",
        expect.objectContaining({ workspaceId: "ws-b" }),
        expect.anything()
      );
    });

    it("keeps the session's authority over a panel it revealed", async () => {
      // The one owned tool that does not release. The delegate deliberately
      // returns a close-shaped payload naming the panel: the release guard
      // downstream keys on exactly that shape, so this fails if the
      // non-releasing policy is dropped and only that guard is left standing.
      const { store, server } = revealHarness("s-reveal-keep", {
        "pilot.openRun": { result: { ok: true, result: { closedIds: ["terminal-1"] } } },
      });
      store.resourceOwnership.record("s-reveal-keep", [{ kind: "terminal", id: "terminal-1" }]);

      await callTool(server, {
        name: "terminal.revealOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(store.resourceOwnership.owns("s-reveal-keep", "terminal", "terminal-1")).toBe(true);
    });

    it("reveals the same panel twice, because the user may have moved away since", async () => {
      const { store, server, revealOwnedRun } = revealHarness("s-reveal-twice", {
        "pilot.openRun": { result: { ok: true, result: null } },
      });
      store.resourceOwnership.record("s-reveal-twice", [{ kind: "terminal", id: "terminal-1" }]);

      const args = { name: "terminal.revealOwned", arguments: { terminalId: "terminal-1" } };
      const first = await callTool(server, args);
      const second = await callTool(server, args);

      expect(first.isError).toBeUndefined();
      expect(second.isError).toBeUndefined();
      expect(revealOwnedRun).toHaveBeenCalledTimes(2);
    });

    it("refuses a panel the session did not create, without dispatching", async () => {
      // The boundary the whole tool rests on: a client may be taken to what it
      // made, which is no escalation over having made it, and to nothing else.
      // `terminal.list` hands out the user's own shells and other clients'
      // agents, so an id from a listing confers nothing.
      const { store, server, revealOwnedRun } = revealHarness("s-reveal-foreign", {});
      store.resourceOwnership.record("other-session", [
        { kind: "terminal", id: "terminal-theirs" },
      ]);

      const result = await callTool(server, {
        name: "terminal.revealOwned",
        arguments: { terminalId: "terminal-theirs" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(revealOwnedRun).not.toHaveBeenCalled();
      expect(store.resourceOwnership.owns("other-session", "terminal", "terminal-theirs")).toBe(
        true
      );
    });

    it("strips anything the caller sent beyond the id", async () => {
      // Rebuilding is the enforcement. A caller-supplied `workspaceId` would be
      // a destination chosen by the client rather than by the ledger, which is
      // the one thing the ownership check cannot vouch for.
      const { store, server, revealOwnedRun } = revealHarness("s-reveal-forge", {
        "pilot.openRun": { result: { ok: true, result: null } },
      });
      store.resourceOwnership.record(
        "s-reveal-forge",
        [{ kind: "terminal", id: "terminal-1" }],
        "ws-a"
      );

      await callTool(server, {
        name: "terminal.revealOwned",
        arguments: { terminalId: "terminal-1", workspaceId: "ws-somewhere-else" },
      });

      expect(revealOwnedRun).toHaveBeenCalledWith(
        "ws-a",
        "pilot.openRun",
        { runId: "terminal-1", workspaceId: "ws-a" },
        expect.anything()
      );
    });

    it("routes through the bridge, which owns the window the switch lands in", async () => {
      // Dispatch and raise are one call because they must agree on one window.
      // Resolving it twice is not the same as resolving it once: the user can
      // focus another window while the dispatch is in flight, and a second
      // lookup would raise a window the switch never touched.
      const { store, server, revealOwnedRun, dispatchAction } = revealHarness("s-reveal-window", {
        "pilot.openRun": { result: { ok: true, result: null } },
      });
      store.resourceOwnership.record("s-reveal-window", [{ kind: "terminal", id: "terminal-1" }]);

      await callTool(server, {
        name: "terminal.revealOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(revealOwnedRun).toHaveBeenCalled();
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "pilot.openRun",
        expect.anything(),
        expect.anything()
      );
    });

    it("reports an error when no window could be brought forward", async () => {
      // The tool's whole promise is that the user ends up looking at the panel.
      // A client told "revealed" when nothing came forward has no way to fall
      // back to telling the user where to go themselves.
      const { store, server } = revealHarness(
        "s-reveal-noraise",
        { "pilot.openRun": { result: { ok: true, result: null } } },
        {
          revealOwnedRun: vi.fn(() =>
            Promise.resolve({
              envelope: { result: { ok: true as const, result: null } },
              raised: false,
            })
          ),
        }
      );
      store.resourceOwnership.record("s-reveal-noraise", [{ kind: "terminal", id: "terminal-1" }]);

      const result = await callTool(server, {
        name: "terminal.revealOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("window");
      // Still the session's panel: a reveal the user missed is not a disposal.
      expect(store.resourceOwnership.owns("s-reveal-noraise", "terminal", "terminal-1")).toBe(true);
    });

    it("raises no window when the reveal itself failed, and says so", async () => {
      // A run can exit between the client reading it and asking to be taken to
      // it. Pulling the user across for nothing is worse than not moving them.
      const { store, server } = revealHarness("s-reveal-failed", {
        "pilot.openRun": {
          result: { ok: false, error: { code: "EXECUTION_ERROR", message: "run is gone" } },
        },
      });
      store.resourceOwnership.record("s-reveal-failed", [{ kind: "terminal", id: "terminal-1" }]);

      const result = await callTool(server, {
        name: "terminal.revealOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBe(true);
      expect(store.resourceOwnership.owns("s-reveal-failed", "terminal", "terminal-1")).toBe(true);
    });

    it("falls back to this session's own dispatch when no active-view route is wired", async () => {
      // A fixture without the route must still reveal rather than fail closed:
      // the fallback is the ordinary dispatch, which for an unbound session is
      // the active view anyway.
      const { store, server, dispatchAction } = harness("s-reveal-no-route", {
        "pilot.openRun": { result: { ok: true, result: null } },
      });
      store.resourceOwnership.record("s-reveal-no-route", [{ kind: "terminal", id: "terminal-1" }]);

      const result = await callTool(server, {
        name: "terminal.revealOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "pilot.openRun",
        expect.objectContaining({ runId: "terminal-1" }),
        expect.anything()
      );
    });
  });

  describe("worktree.deleteOwned", () => {
    it("delegates to worktree.delete so the real D2 preview and confirmation fire", async () => {
      const { store, server, dispatchAction } = harness("s-del", {
        "worktree.delete": { result: { ok: true, result: null } },
      });
      store.resourceOwnership.record("s-del", [{ kind: "worktree", id: "/tmp/wt" }]);

      const result = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/wt" },
      });

      expect(result.isError).toBeUndefined();
      // The literal action id matters: `resolveMcpConfirmPreviewTarget` matches
      // on "worktree.delete" to build the tracked/untracked file preview.
      //
      // The third argument is asserted as `false`, not `expect.anything()`:
      // that flag is what tells the renderer the dispatch is already approved,
      // so a lenient matcher here would pass just as happily if authorizing
      // ownership had silently pre-confirmed the delete and skipped the dialog.
      expect(dispatchAction).toHaveBeenCalledWith(
        "worktree.delete",
        { worktreeId: "/tmp/wt" },
        false
      );
      expect(store.resourceOwnership.owns("s-del", "worktree", "/tmp/wt")).toBe(false);
    });

    // The confirmation fires on the delegated call, so that is where the skip
    // preference has to land — and ownership must still be checked first (#12874).
    it("carries the skip preference to the delegated worktree.delete for a help session", async () => {
      const { store, server, dispatchAction } = harness(
        "s-skip",
        { "worktree.delete": { result: { ok: true, result: null } } },
        { readAssistantConfirmationsSkipped: () => true }
      );
      store.sessionOriginMap.set("s-skip", "help");
      store.resourceOwnership.record("s-skip", [{ kind: "worktree", id: "/tmp/wt" }]);

      const result = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/wt" },
      });

      expect(result.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "worktree.delete",
        { worktreeId: "/tmp/wt" },
        true,
        "skip-preference"
      );
    });

    it("still refuses a worktree the session does not own under the skip preference (#12874)", async () => {
      const { store, server, dispatchAction } = harness(
        "s-skip-unowned",
        { "worktree.delete": { result: { ok: true, result: null } } },
        { readAssistantConfirmationsSkipped: () => true }
      );
      store.sessionOriginMap.set("s-skip-unowned", "help");

      const result = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/wt" },
      });

      expect(result.isError).toBe(true);
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "worktree.delete",
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "worktree.delete",
        expect.anything(),
        expect.anything()
      );
    });

    it("strips force, deleteBranch and closeTerminals from the delegated call", async () => {
      // The narrow tool omits them from its schema, but the renderer validates
      // against `worktree.delete`, which still accepts them — so rebuilding the
      // args here is the actual enforcement.
      const { store, server, dispatchAction } = harness("s-strip", {
        "worktree.delete": { result: { ok: true, result: null } },
      });
      store.resourceOwnership.record("s-strip", [{ kind: "worktree", id: "/tmp/wt" }]);

      await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: {
          worktreeId: "/tmp/wt",
          force: true,
          deleteBranch: true,
          closeTerminals: true,
        },
      });

      expect(dispatchAction).toHaveBeenCalledWith(
        "worktree.delete",
        { worktreeId: "/tmp/wt" },
        false
      );
    });

    it("reports CONFIRMATION_REQUIRED when no window can show the dialog", async () => {
      // Owning the worktree is not approval. With no renderer to raise the
      // native dialog the delegated dispatch throws, and the caller must get
      // the machine-readable "needs a human I can't reach" answer rather than a
      // generic execution error — and must keep its ownership for the retry.
      const { store } = harness("s-nowindow", {});
      store.resourceOwnership.record("s-nowindow", [{ kind: "worktree", id: "/tmp/wt" }]);
      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction: vi.fn().mockRejectedValue(new RendererBridgeUnavailableError()),
        requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
        getCachedManifest: vi.fn(() => ownedManifest()),
      });
      const windowless = createSessionServer("s-nowindow", deps);

      const result = await callTool(windowless, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/wt" },
      });

      expect(result.isError).toBe(true);
      const text = errorText(result);
      expect(text).toContain(CONFIRMATION_REQUIRED_CODE);
      expect(text).toContain("unavailable");
      expect(store.resourceOwnership.owns("s-nowindow", "worktree", "/tmp/wt")).toBe(true);
    });

    it("refuses a worktree the session did not create without dispatching", async () => {
      const { server, dispatchAction } = harness("s-unowned-wt", {});

      const result = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/users-own-worktree" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("keeps authority when the delegated delete fails", async () => {
      // A refused dirty-worktree delete must leave the caller able to retry
      // after committing, rather than stranding the worktree unownable.
      const { store, server } = harness("s-dirty", {
        "worktree.delete": {
          result: {
            ok: false,
            error: { code: "EXECUTION_ERROR", message: "worktree has uncommitted changes" },
          },
        },
      });
      store.resourceOwnership.record("s-dirty", [{ kind: "worktree", id: "/tmp/wt" }]);

      const result = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/wt" },
      });

      expect(result.isError).toBe(true);
      expect(store.resourceOwnership.owns("s-dirty", "worktree", "/tmp/wt")).toBe(true);
    });
  });

  describe("confirmation-unavailable / workspace-bound sessions", () => {
    function boundHarness(sessionId: string) {
      const store = makeStore();
      seedLiveSession(store, sessionId, "external");
      store.sessionOriginMap.set(sessionId, "external");
      store.sessionWorkspaceMap.set(sessionId, "ws-a");
      const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction,
        workspaceBinding: { kind: "project", workspaceId: "ws-a", workspacePath: "/tmp/a" },
        requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
        getCachedManifest: vi.fn(() => ownedManifest()),
      });
      return { store, dispatchAction, server: createSessionServer(sessionId, deps) };
    }

    it("withholds worktree.deleteOwned from a bound session's tools/list but keeps closeOwned", async () => {
      const { server } = boundHarness("s-bound-list");
      await server.connect(makeMockTransport());

      const names = (await listTools(server)).tools.map((t) => t.name);

      // `danger: "confirm"` alone drives this — no hand-written id list.
      expect(names).not.toContain("worktree.deleteOwned");
      // The safe half stays reachable: it needs no dialog.
      expect(names).toContain("terminal.closeOwned");
    });

    it("refuses a bound session's direct worktree.deleteOwned call even when it owns the worktree", async () => {
      const { store, server, dispatchAction } = boundHarness("s-bound-call");
      store.resourceOwnership.record("s-bound-call", [{ kind: "worktree", id: "/tmp/wt" }], "ws-a");

      const result = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/wt" },
      });

      // Discovery and direct-call authorization agree: owning the worktree is
      // not enough when nobody can be shown the confirmation.
      expect(result.isError).toBe(true);
      expect(dispatchAction).not.toHaveBeenCalled();
    });
  });

  // Acceptance criterion: `tools/list`, `actions.search`, `actions.getSchema`,
  // `mcp.surface` and the direct `tools/call` gate must expose the SAME
  // effective cleanup surface. They are five separate code paths, so a
  // regression can hide in any one of them — #11582 is the precedent for a
  // tool that was listed by one and refused by another.
  describe("effective cleanup surface agreement", () => {
    function surfaceDeps(sessionId: string) {
      const store = makeStore();
      seedLiveSession(store, sessionId, "external");
      store.sessionOriginMap.set(sessionId, "external");
      store.sessionWorkspaceMap.set(sessionId, "ws-a");
      const manifest = [
        ...ownedManifest(),
        makeManifestEntry("mcp.surface"),
        makeManifestEntry("actions.search"),
        makeManifestEntry("actions.getSchema"),
        makeManifestEntry("terminal.list"),
      ];
      return {
        store,
        deps: fakeDeps({
          sessionStore: store,
          workspaceBinding: { kind: "project", workspaceId: "ws-a", workspacePath: "/tmp/a" },
          requestManifest: vi.fn().mockResolvedValue(manifest),
          getCachedManifest: vi.fn(() => manifest),
          dispatchAction: vi.fn((actionId: string) => {
            // The renderer answers with the UNFILTERED registry; narrowing to
            // the session's effective surface is main's job, and that narrowing
            // is exactly what this suite is checking.
            if (actionId === "actions.search") {
              return Promise.resolve({
                result: {
                  ok: true as const,
                  result: {
                    totalMatches: manifest.length,
                    results: manifest,
                  },
                },
              });
            }
            if (actionId === "actions.getSchema") {
              return Promise.resolve({
                result: {
                  ok: true as const,
                  result: { ok: true, entry: makeManifestEntry("worktree.deleteOwned") },
                },
              });
            }
            return Promise.resolve({ result: { ok: true as const, result: null } });
          }),
        }),
      };
    }

    it("agrees across all five surfaces for a workspace-bound external session", async () => {
      // `terminal.closeOwned` is `danger: "safe"` and stays; `worktree.deleteOwned`
      // is confirm-gated and no human is watching the bound view, so every
      // surface must withhold or refuse it.
      const { deps } = surfaceDeps("s-surface");
      const server = createSessionServer("s-surface", deps);
      await server.connect(makeMockTransport());

      const listed = (await listTools(server)).tools.map((t) => t.name);
      expect(listed).toContain("terminal.closeOwned");
      expect(listed).not.toContain("worktree.deleteOwned");

      const searched = payloadOf<{ results: Array<{ id: string }> }>(
        await callTool(server, { name: "actions.search", arguments: { query: "owned" } })
      ).results.map((r) => r.id);
      expect(searched).toContain("terminal.closeOwned");
      expect(searched).not.toContain("worktree.deleteOwned");

      const surfaced = (
        (await callTool(server, { name: "mcp.surface" })) as {
          structuredContent: { tools: Array<{ id: string }> };
        }
      ).structuredContent.tools.map((t) => t.id);
      expect(surfaced).toContain("terminal.closeOwned");
      expect(surfaced).not.toContain("worktree.deleteOwned");

      // `actions.getSchema` deliberately collapses a withheld id onto the same
      // "no action found" shape an unknown id gets, rather than a distinct
      // error that would confirm the id exists while offering no way to reach
      // it. Agreement here means "does not hand back the schema", not "raises
      // a different error from the other four surfaces".
      const schema = payloadOf<{ ok: boolean; error?: { code: string }; entry: unknown }>(
        await callTool(server, {
          name: "actions.getSchema",
          arguments: { actionId: "worktree.deleteOwned" },
        })
      );
      expect(schema.ok).toBe(false);
      expect(schema.error?.code).toBe("NOT_FOUND");
      expect(schema.entry).toBeNull();

      const called = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/wt" },
      });
      expect(called.isError).toBe(true);
    });

    it("lists both tools for an unbound external session", async () => {
      // The counterpart assertion, so the test above cannot pass merely by the
      // tools being absent from the manifest. Scoped to `tools/list` on
      // purpose: the four other surfaces are only interesting when something
      // is being withheld, which is the bound case above.
      const store = makeStore();
      seedLiveSession(store, "s-unbound-surface", "external");
      store.sessionOriginMap.set("s-unbound-surface", "external");
      const manifest = [...ownedManifest(), makeManifestEntry("mcp.surface")];
      const server = createSessionServer(
        "s-unbound-surface",
        fakeDeps({
          sessionStore: store,
          requestManifest: vi.fn().mockResolvedValue(manifest),
          getCachedManifest: vi.fn(() => manifest),
        })
      );
      await server.connect(makeMockTransport());

      const listed = (await listTools(server)).tools.map((t) => t.name);
      expect(listed).toContain("terminal.closeOwned");
      expect(listed).toContain("worktree.deleteOwned");
    });
  });

  describe("workspace rebinding", () => {
    it("refuses cleanup of a resource created in a different workspace", async () => {
      const store = makeStore();
      seedLiveSession(store, "s-rebound", "external");
      store.sessionOriginMap.set("s-rebound", "external");
      store.sessionWorkspaceMap.set("s-rebound", "ws-b");
      // Recorded while the dispatch landed on ws-a.
      store.resourceOwnership.record("s-rebound", [{ kind: "terminal", id: "terminal-1" }], "ws-a");
      const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
      const server = createSessionServer(
        "s-rebound",
        fakeDeps({
          sessionStore: store,
          dispatchAction,
          workspaceBinding: { kind: "project", workspaceId: "ws-b", workspacePath: "/tmp/b" },
          requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
          getCachedManifest: vi.fn(() => ownedManifest()),
        })
      );

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("allows cleanup when the creating dispatch could not resolve a workspace", async () => {
      // The mismatch check is defence in depth over globally-unique ids, so it
      // fails OPEN — an unresolved workspace must not strand the caller's own
      // cleanup.
      const store = makeStore();
      seedLiveSession(store, "s-nows", "external");
      store.sessionOriginMap.set("s-nows", "external");
      store.sessionWorkspaceMap.set("s-nows", "ws-b");
      store.resourceOwnership.record("s-nows", [{ kind: "terminal", id: "terminal-1" }]);
      const dispatchAction = vi
        .fn()
        .mockResolvedValue({ result: { ok: true, result: { closedIds: ["terminal-1"] } } });
      const server = createSessionServer(
        "s-nows",
        fakeDeps({
          sessionStore: store,
          dispatchAction,
          requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
          getCachedManifest: vi.fn(() => ownedManifest()),
        })
      );

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.close",
        { terminalId: "terminal-1" },
        expect.anything()
      );
    });
  });

  describe("terminal.list owned filter (#12308)", () => {
    /** A view holding one panel this session made and two it did not. */
    const LISTING = {
      result: {
        ok: true,
        result: {
          terminals: [
            { id: "terminal-mine", title: "our agent" },
            { id: "terminal-users-own", title: "the user's shell" },
            { id: "terminal-other-session", title: "another client's agent" },
          ],
          panelLimit: {
            count: 3,
            softWarningLimit: 12,
            confirmationLimit: 20,
            hardLimit: 32,
            tier: "ok",
          },
        },
      },
    };

    function listedIds(result: { content: unknown }): string[] {
      return payloadOf<{ terminals: Array<{ id: string }> }>(result).terminals.map((t) => t.id);
    }

    function structuredOf(result: unknown): Record<string, unknown> | undefined {
      return (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    }

    it("returns only what this session created, and consumes the flag before dispatch", async () => {
      const appendAuditRecord = vi.fn();
      const { store, server, dispatchAction } = harness(
        "s-owned",
        { "terminal.list": LISTING },
        { appendAuditRecord }
      );
      store.resourceOwnership.record("s-owned", [{ kind: "terminal", id: "terminal-mine" }]);

      const result = await callTool(server, {
        name: "terminal.list",
        arguments: { owned: true, location: "grid", worktreeId: "wt-1" },
      });

      expect(listedIds(result)).toEqual(["terminal-mine"]);
      // Text body and structuredContent read one filtered value; a filter
      // reaching only one of them would leak the full listing to the other.
      // The panel limit stays project-wide: it is what a launch is judged on,
      // not a count of this caller's own rows.
      expect(structuredOf(result)).toEqual({
        terminals: [{ id: "terminal-mine", title: "our agent" }],
        panelLimit: LISTING.result.result.panelLimit,
      });
      // The strip is half of one mechanism, not a tidy-up: the renderer
      // refuses any `owned` it receives, so forwarding it would fail the very
      // calls the filter exists to serve. Every other argument survives.
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.list",
        { location: "grid", worktreeId: "wt-1" },
        expect.anything()
      );
      // The audit record reports what the caller asked for, not the rewritten
      // copy — the rewrite is an implementation detail of serving the request.
      expect(appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          toolId: "terminal.list",
          args: { owned: true, location: "grid", worktreeId: "wt-1" },
        })
      );
    });

    it("lists everything when owned is false or omitted", async () => {
      const { store, server, dispatchAction } = harness("s-unowned", { "terminal.list": LISTING });
      store.resourceOwnership.record("s-unowned", [{ kind: "terminal", id: "terminal-mine" }]);

      const explicit = await callTool(server, {
        name: "terminal.list",
        arguments: { owned: false },
      });
      const omitted = await callTool(server, { name: "terminal.list", arguments: {} });

      // `false` means "do not narrow", never "the ones I did not create".
      expect(listedIds(explicit)).toEqual([
        "terminal-mine",
        "terminal-users-own",
        "terminal-other-session",
      ]);
      expect(listedIds(omitted)).toEqual(listedIds(explicit));
      // Consumed in both directions — the renderer cannot honour either value.
      expect(dispatchAction).toHaveBeenNthCalledWith(1, "terminal.list", {}, expect.anything());
    });

    it("scopes ownership to the session, so a reconnected client sees none of its old panels", async () => {
      const { store, deps, server } = harness("s-before", { "terminal.list": LISTING });
      store.resourceOwnership.record("s-before", [{ kind: "terminal", id: "terminal-mine" }]);

      // A reconnect is a new session id over the same live panels, and #12308
      // deliberately does not carry the ledger across one: the honest answer
      // is an empty list, which is what lets a client report what it left
      // behind instead of guessing.
      seedLiveSession(store, "s-after", "external");
      store.sessionOriginMap.set("s-after", "external");
      const reconnected = createSessionServer("s-after", deps);

      const before = await callTool(server, {
        name: "terminal.list",
        arguments: { owned: true },
      });
      const after = await callTool(reconnected, {
        name: "terminal.list",
        arguments: { owned: true },
      });

      expect(listedIds(before)).toEqual(["terminal-mine"]);
      expect(listedIds(after)).toEqual([]);
    });

    it("does not read a worktree record as terminal ownership", async () => {
      const { store, server } = harness("s-kind", { "terminal.list": LISTING });
      // The ledger keys on kind as well as id, and a listing must not inherit
      // authority granted over a different taxonomy.
      store.resourceOwnership.record("s-kind", [{ kind: "worktree", id: "terminal-mine" }]);

      const result = await callTool(server, { name: "terminal.list", arguments: { owned: true } });

      expect(listedIds(result)).toEqual([]);
    });

    it("never manufactures a row for a record whose panel is gone", async () => {
      const { store, server } = harness("s-stale", { "terminal.list": LISTING });
      store.resourceOwnership.record("s-stale", [
        { kind: "terminal", id: "terminal-mine" },
        { kind: "terminal", id: "terminal-the-user-closed" },
      ]);

      const result = await callTool(server, { name: "terminal.list", arguments: { owned: true } });

      // The listing says what exists; the ledger only says who created it.
      expect(listedIds(result)).toEqual(["terminal-mine"]);
    });

    it("leaves a non-boolean owned in place for the renderer's own validation", async () => {
      const { server, dispatchAction } = harness("s-bad-arg", { "terminal.list": LISTING });

      await callTool(server, { name: "terminal.list", arguments: { owned: "yes" } });

      // Consuming it would launder an out-of-contract request into a legal one
      // and answer it with the unfiltered list.
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.list",
        { owned: "yes" },
        expect.anything()
      );
    });

    it("passes a failed listing through untouched", async () => {
      const { store, server } = harness("s-fail", {
        "terminal.list": {
          result: { ok: false, error: { code: "EXECUTION_ERROR", message: "renderer said no" } },
        },
      });
      store.resourceOwnership.record("s-fail", [{ kind: "terminal", id: "terminal-mine" }]);

      const result = await callTool(server, { name: "terminal.list", arguments: { owned: true } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("renderer said no");
      expect(errorText(result)).toContain("EXECUTION_ERROR");
    });

    it("fails the call on a payload shape it cannot read, rather than reporting nothing owned", async () => {
      const { store, server } = harness("s-shape", {
        "terminal.list": { result: { ok: true, result: { terminals: "not-an-array" } } },
      });
      store.resourceOwnership.record("s-shape", [{ kind: "terminal", id: "terminal-mine" }]);

      const result = await callTool(server, { name: "terminal.list", arguments: { owned: true } });

      // An empty list is a substantive answer here — it is what a client acts
      // on when it decides it left nothing behind — so an unreadable listing
      // must not be able to produce one.
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESULT_VALIDATION_ERROR");
    });

    it("filters a listing whose ownership came from a real creation over HTTP", async () => {
      // Every other case seeds the ledger by hand. This one drives the whole
      // round trip — create, then list owned — so the recording hook's
      // liveness guard, which checks SSE and HTTP session membership
      // separately, cannot start recognising only one transport unnoticed.
      const store = makeStore();
      seedLiveSession(store, "s-http", "external", "http");
      store.sessionOriginMap.set("s-http", "external");
      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction: vi.fn().mockImplementation((actionId: string) => {
          if (actionId === "terminal.new") {
            return Promise.resolve({
              result: { ok: true, result: { terminalId: "terminal-new" } },
            });
          }
          return Promise.resolve({
            result: {
              ok: true,
              result: { terminals: [{ id: "terminal-new" }, { id: "terminal-users-own" }] },
            },
          });
        }),
        requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
        getCachedManifest: vi.fn(() => ownedManifest()),
      });
      const server = createSessionServer("s-http", deps);

      await callTool(server, { name: "terminal.new", arguments: {} });
      const result = await callTool(server, { name: "terminal.list", arguments: { owned: true } });

      expect(listedIds(result)).toEqual(["terminal-new"]);
    });
  });

  // #12487 — a pane bearer's records belong to its principal, so a pane whose
  // session is replaced (reconnect, idle reap, server restart) still acts on
  // the agents it launched through the next session on the same bearer.
  describe("pane bearer across a session replacement (#12487)", () => {
    const PRINCIPAL = "principal-pane";

    /** A live pane session bound to PRINCIPAL, as the handshake would leave it. */
    function paneSession(
      store: RealSessionStore,
      sessionId: string,
      dispatchAction: SessionServerDeps["dispatchAction"],
      principal: string = PRINCIPAL
    ) {
      seedLiveSession(store, sessionId, "full");
      store.sessionOriginMap.set(sessionId, "external");
      store.resourceOwnership.bindPrincipal(sessionId, principal);
      return createSessionServer(
        sessionId,
        fakeDeps({
          sessionStore: store,
          dispatchAction,
          requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
          getCachedManifest: vi.fn(() => ownedManifest()),
        })
      );
    }

    function listedIds(result: { content: unknown }): string[] {
      return payloadOf<{ terminals: Array<{ id: string }> }>(result).terminals.map((t) => t.id);
    }

    function routedDispatch() {
      return vi.fn().mockImplementation((actionId: string) => {
        if (actionId === "terminal.new") {
          return Promise.resolve({ result: { ok: true, result: { terminalId: "terminal-1" } } });
        }
        if (actionId === "terminal.list") {
          return Promise.resolve({
            result: {
              ok: true,
              result: { terminals: [{ id: "terminal-1" }, { id: "terminal-users-own" }] },
            },
          });
        }
        if (actionId === "terminal.close") {
          return Promise.resolve({ result: { ok: true, result: { closedIds: ["terminal-1"] } } });
        }
        return Promise.resolve({ result: { ok: true, result: null } });
      });
    }

    /** Hold `terminal.new` until the test releases it. */
    function heldCreation() {
      let release: (() => void) | undefined;
      const dispatchAction = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ result: { ok: true, result: { terminalId: "terminal-1" } } });
          })
      );
      return {
        dispatchAction,
        async started() {
          for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
          expect(release).toBeTypeOf("function");
        },
        release: () => release!(),
      };
    }

    it("lists and acts on what the previous session launched, and the two agree", async () => {
      const store = makeStore();
      const dispatchAction = routedDispatch();
      const first = paneSession(store, "s-pane-1", dispatchAction);
      await callTool(first, { name: "terminal.new", arguments: {} });

      store.revokeSession("s-pane-1");
      const second = paneSession(store, "s-pane-2", dispatchAction);

      const listed = await callTool(second, {
        name: "terminal.list",
        arguments: { owned: true },
      });
      expect(listedIds(listed)).toEqual(["terminal-1"]);

      const closed = await callTool(second, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });
      expect(closed.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.close",
        { terminalId: "terminal-1" },
        expect.anything()
      );
      // Released under the principal, so no session on this bearer holds it.
      expect(store.resourceOwnership.list(store.resourceOwnership.ownerOf("s-pane-2"))).toEqual([]);
    });

    it("survives a server drain, which revokes no pane bearer", async () => {
      const store = makeStore();
      const dispatchAction = routedDispatch();
      const first = paneSession(store, "s-pane-1", dispatchAction);
      await callTool(first, { name: "terminal.new", arguments: {} });

      store.drain();
      const second = paneSession(store, "s-pane-2", dispatchAction);

      const listed = await callTool(second, {
        name: "terminal.list",
        arguments: { owned: true },
      });
      expect(listedIds(listed)).toEqual(["terminal-1"]);
    });

    it("records a creation that completes after the session that asked for it dropped", async () => {
      const store = makeStore();
      const held = heldCreation();
      const first = paneSession(store, "s-pane-1", held.dispatchAction);
      const inFlight = callTool(first, { name: "terminal.new", arguments: {} });
      await held.started();

      store.revokeSession("s-pane-1");
      held.release();
      await inFlight;

      paneSession(store, "s-pane-2", routedDispatch());
      expect(
        store.resourceOwnership.owns(
          store.resourceOwnership.ownerOf("s-pane-2"),
          "terminal",
          "terminal-1"
        )
      ).toBe(true);
    });

    it("records nothing for a creation whose bearer was revoked while it was in flight", async () => {
      const store = makeStore();
      const held = heldCreation();
      const first = paneSession(store, "s-pane-1", held.dispatchAction);
      const inFlight = callTool(first, { name: "terminal.new", arguments: {} });
      await held.started();

      store.resourceOwnership.revokePrincipal(PRINCIPAL);
      held.release();
      await inFlight;

      expect(store.resourceOwnership.list(store.resourceOwnership.ownerOf("s-pane-1"))).toEqual([]);
      // The id is free: nothing the relaunched pane's new bearer can see.
      paneSession(store, "s-pane-2", routedDispatch(), "principal-relaunched");
      expect(
        store.resourceOwnership.owns(
          store.resourceOwnership.ownerOf("s-pane-2"),
          "terminal",
          "terminal-1"
        )
      ).toBe(false);
    });

    it("lists exactly what the owned tools accept, workspace check included", async () => {
      const store = makeStore();
      const dispatchAction = vi.fn().mockImplementation((actionId: string) =>
        Promise.resolve(
          actionId === "terminal.list"
            ? {
                result: {
                  ok: true,
                  result: { terminals: [{ id: "terminal-elsewhere" }, { id: "terminal-here" }] },
                },
              }
            : { result: { ok: true, result: { closedIds: ["terminal-elsewhere"] } } }
        )
      );
      const server = paneSession(store, "s-pane", dispatchAction);
      store.sessionWorkspaceMap.set("s-pane", "ws-here");
      const owner = store.resourceOwnership.ownerOf("s-pane");
      store.resourceOwnership.record(
        owner,
        [{ kind: "terminal", id: "terminal-elsewhere" }],
        "ws-x"
      );
      store.resourceOwnership.record(owner, [{ kind: "terminal", id: "terminal-here" }], "ws-here");

      const listed = await callTool(server, {
        name: "terminal.list",
        arguments: { owned: true },
      });
      const refused = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-elsewhere" },
      });

      expect(listedIds(listed)).toEqual(["terminal-here"]);
      expect(refused.isError).toBe(true);
      expect(errorText(refused)).toContain("RESOURCE_NOT_OWNED");
    });

    it("keeps a record the same bearer re-created while a close was in flight", async () => {
      const store = makeStore();
      let releaseClose: (() => void) | undefined;
      const dispatchAction = vi.fn().mockImplementation((actionId: string) => {
        if (actionId === "terminal.close") {
          return new Promise((resolve) => {
            releaseClose = () =>
              resolve({ result: { ok: true, result: { closedIds: ["terminal-1"] } } });
          });
        }
        return Promise.resolve({ result: { ok: true, result: { terminalId: "terminal-1" } } });
      });
      const first = paneSession(store, "s-pane-1", dispatchAction);
      const second = paneSession(store, "s-pane-2", dispatchAction);
      await callTool(first, { name: "terminal.new", arguments: {} });

      const closing = callTool(first, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });
      for (let i = 0; i < 50 && !releaseClose; i++) await Promise.resolve();
      // The other session on this bearer creates a panel under the same id
      // before the close reports back.
      await callTool(second, {
        name: "terminal.new",
        arguments: { spawnedBy: { kind: "user" } },
      });
      releaseClose!();
      await closing;

      expect(
        store.resourceOwnership.owns(
          store.resourceOwnership.ownerOf("s-pane-2"),
          "terminal",
          "terminal-1"
        )
      ).toBe(true);
    });

    it("still drops an api-key session's creation that completes after it ended", async () => {
      const store = makeStore();
      const held = heldCreation();
      seedLiveSession(store, "s-api", "external");
      store.sessionOriginMap.set("s-api", "external");
      const server = createSessionServer(
        "s-api",
        fakeDeps({
          sessionStore: store,
          dispatchAction: held.dispatchAction,
          requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
          getCachedManifest: vi.fn(() => ownedManifest()),
        })
      );
      const inFlight = callTool(server, { name: "terminal.new", arguments: {} });
      await held.started();

      store.revokeSession("s-api");
      held.release();
      await inFlight;

      expect(store.resourceOwnership.list("s-api")).toEqual([]);
    });
  });

  // #12490 — a terminal the user handed to an orchestrating pane is driven
  // through the non-destructive `*Owned` tools as if the pane had launched it,
  // and never through the cleanup ones.
  describe("terminals the user handed over (#12490)", () => {
    const PRINCIPAL = "principal-orchestrator";

    function orchestratorSession(
      store: RealSessionStore,
      sessionId: string,
      dispatchAction: SessionServerDeps["dispatchAction"],
      principal: string = PRINCIPAL
    ) {
      seedLiveSession(store, sessionId, "full");
      store.sessionOriginMap.set(sessionId, "external");
      store.resourceOwnership.bindPrincipal(sessionId, principal);
      return createSessionServer(
        sessionId,
        fakeDeps({
          sessionStore: store,
          dispatchAction,
          requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
          getCachedManifest: vi.fn(() => ownedManifest()),
        })
      );
    }

    function handOver(store: RealSessionStore, terminalId: string, principal = PRINCIPAL) {
      const outcome = store.terminalAdoption.adopt({
        terminalId,
        orchestratorPaneId: "orchestrator-pane",
        principalId: principal,
        workspaceId: "ws-a",
      });
      expect(outcome.ok).toBe(true);
    }

    function listingDispatch() {
      return vi.fn().mockImplementation((actionId: string) => {
        if (actionId === "terminal.list") {
          return Promise.resolve({
            result: {
              ok: true,
              result: { terminals: [{ id: "terminal-handed" }, { id: "terminal-users-own" }] },
            },
          });
        }
        if (actionId === "terminal.close") {
          return Promise.resolve({
            result: { ok: true, result: { closedIds: ["terminal-handed"] } },
          });
        }
        return Promise.resolve({ result: { ok: true, result: null } });
      });
    }

    it("submits to, interrupts and injects into a handed-over terminal", async () => {
      const store = makeStore();
      const dispatchAction = listingDispatch();
      const server = orchestratorSession(store, "s-orch", dispatchAction);
      handOver(store, "terminal-handed");

      const sent = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-handed", command: "1" },
      });
      const interrupted = await callTool(server, {
        name: "terminal.interruptOwned",
        arguments: { terminalId: "terminal-handed" },
      });
      const injected = await callTool(server, {
        name: "terminal.injectOwned",
        arguments: { terminalId: "terminal-handed" },
      });

      expect(sent.isError).toBeUndefined();
      expect(interrupted.isError).toBeUndefined();
      expect(injected.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.sendCommand",
        { command: "1", terminalId: "terminal-handed" },
        expect.anything()
      );
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.interrupt",
        { terminalId: "terminal-handed" },
        expect.anything()
      );
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.inject",
        { terminalId: "terminal-handed" },
        expect.anything()
      );
    });

    it("reads a handed-over agent's last message", async () => {
      const store = makeStore();
      seedLiveSession(store, "s-orch", "full");
      store.sessionOriginMap.set("s-orch", "external");
      store.resourceOwnership.bindPrincipal("s-orch", PRINCIPAL);
      handOver(store, "terminal-handed");
      const handleTerminalReadLastMessageOwned = vi
        .fn()
        .mockResolvedValue({ status: "unavailable", reason: "no-message" });
      const server = createSessionServer(
        "s-orch",
        fakeDeps({
          sessionStore: store,
          handleTerminalReadLastMessageOwned,
          requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
          getCachedManifest: vi.fn(() => ownedManifest()),
        })
      );

      const result = await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-handed" },
      });

      expect(result.isError).toBeUndefined();
      expect(handleTerminalReadLastMessageOwned).toHaveBeenCalledWith(
        "terminal-handed",
        {},
        expect.any(AbortSignal)
      );

      // Paging (#12496) reaches an adopted terminal exactly as it reaches an
      // owned one: the adoption gate runs before the options are validated.
      const paged = await callTool(server, {
        name: "terminal.readLastMessageOwned",
        arguments: { terminalId: "terminal-handed", maxBytes: 49152, messageIndex: 2 },
      });

      expect(paged.isError).toBeUndefined();
      expect(handleTerminalReadLastMessageOwned).toHaveBeenLastCalledWith(
        "terminal-handed",
        { maxBytes: 49152, messageIndex: 2 },
        expect.any(AbortSignal)
      );
    });

    it("reveals a handed-over terminal in the workspace it lives in", async () => {
      const store = makeStore();
      const revealOwnedRun = vi.fn().mockResolvedValue({
        envelope: { result: { ok: true, result: null } },
        raised: true,
      });
      seedLiveSession(store, "s-orch", "full");
      store.sessionOriginMap.set("s-orch", "external");
      store.resourceOwnership.bindPrincipal("s-orch", PRINCIPAL);
      handOver(store, "terminal-handed");
      const server = createSessionServer(
        "s-orch",
        fakeDeps({
          sessionStore: store,
          revealOwnedRun,
          requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
          getCachedManifest: vi.fn(() => ownedManifest()),
        })
      );

      const result = await callTool(server, {
        name: "terminal.revealOwned",
        arguments: { terminalId: "terminal-handed" },
      });

      expect(result.isError).toBeUndefined();
      expect(revealOwnedRun).toHaveBeenCalledWith(
        "ws-a",
        "pilot.openRun",
        { runId: "terminal-handed", workspaceId: "ws-a" },
        expect.anything()
      );
    });

    // A restart ends the conversation as surely as a close does (#14369).
    it("never restarts a handed-over terminal on another preset", async () => {
      const store = makeStore();
      const dispatchAction = listingDispatch();
      const server = orchestratorSession(store, "s-orch", dispatchAction);
      handOver(store, "terminal-handed");

      const result = await callTool(server, {
        name: "terminal.restartOnPresetOwned",
        arguments: { terminalId: "terminal-handed", presetId: "work" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "terminal.restartOnPreset",
        expect.anything(),
        expect.anything()
      );
    });

    it("never closes a handed-over terminal", async () => {
      const store = makeStore();
      const dispatchAction = listingDispatch();
      const server = orchestratorSession(store, "s-orch", dispatchAction);
      handOver(store, "terminal-handed");

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-handed" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "terminal.close",
        expect.anything(),
        expect.anything()
      );
    });

    // #14161 — the global assistant's host.call session in a project is bound
    // to its local relay principal, which is what its hand-over is held by:
    // input, interrupt and reading, never the close.
    it("gives the global assistant's session in a project only the non-destructive standing", async () => {
      const store = makeStore();
      const dispatchAction = listingDispatch();
      const principal = relayOwnershipPrincipal("local", "help-global");
      const server = orchestratorSession(store, "s-global-relay", dispatchAction, principal);
      handOver(store, "terminal-handed", principal);
      const otherRun = orchestratorSession(
        store,
        "s-other-relay",
        dispatchAction,
        relayOwnershipPrincipal("local", "help-global-2")
      );

      const sent = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-handed", command: "go" },
      });
      const interrupted = await callTool(server, {
        name: "terminal.interruptOwned",
        arguments: { terminalId: "terminal-handed" },
      });
      const closed = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-handed" },
      });
      const replacement = await callTool(otherRun, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-handed", command: "go" },
      });

      expect(sent.isError).toBeUndefined();
      expect(interrupted.isError).toBeUndefined();
      expect(errorText(closed)).toContain("RESOURCE_NOT_OWNED");
      expect(errorText(replacement)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).toHaveBeenCalledTimes(2);
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "terminal.close",
        expect.anything(),
        expect.anything()
      );
    });

    // #12980 — a pane refused by a tool that takes a hand-over is told how the
    // user grants one, in words that never depend on the refused id.
    describe("the hand-over hint on a refusal (#12980)", () => {
      const HINT = "right-click it, choose 'Hand to orchestrator', and select this agent's pane";
      const GRANT_PATH = { grantPath: "context-menu:hand-to-orchestrator" };

      function refusalPayload(result: { content: unknown }) {
        return payloadOf<{ code: string; message: string; details?: unknown }>(result);
      }

      it.each([
        ["terminal.sendCommandOwned", { command: "1" }],
        ["terminal.interruptOwned", {}],
        ["terminal.injectOwned", {}],
        ["terminal.revealOwned", {}],
        ["terminal.placeOwned", { location: "dock" }],
        ["terminal.readLastMessageOwned", {}],
      ])("names the grant path when %s refuses a pane", async (name, extra) => {
        const store = makeStore();
        const dispatchAction = listingDispatch();
        const server = orchestratorSession(store, "s-orch", dispatchAction);

        const result = await callTool(server, {
          name,
          arguments: { terminalId: "terminal-users-own", ...extra },
        });

        expect(result.isError).toBe(true);
        const payload = refusalPayload(result);
        expect(payload.code).toBe("RESOURCE_NOT_OWNED");
        expect(payload.message).toContain(HINT);
        expect(payload.details).toEqual(GRANT_PATH);
        expect(dispatchAction).not.toHaveBeenCalled();
      });

      it("reads byte-for-byte the same for an unknown id, another pane's and another session's", async () => {
        const store = makeStore();
        const dispatchAction = listingDispatch();
        const server = orchestratorSession(store, "s-orch", dispatchAction);
        orchestratorSession(store, "s-other", dispatchAction, "principal-other");
        seedLiveSession(store, "s-api", "full");
        // One id throughout: the message names it, so only its state may vary.
        const refusalFor = async () =>
          errorText(
            await callTool(server, {
              name: "terminal.sendCommandOwned",
              arguments: { terminalId: "terminal-x", command: "1" },
            })
          );

        const unknown = await refusalFor();
        handOver(store, "terminal-x", "principal-other");
        const otherPanes = await refusalFor();
        store.terminalAdoption.revokePrincipal("principal-other");
        store.resourceOwnership.record("s-api", [{ kind: "terminal", id: "terminal-x" }]);
        const otherSessions = await refusalFor();

        expect(otherPanes).toBe(unknown);
        expect(otherSessions).toBe(unknown);
        expect(unknown).toContain("context-menu:hand-to-orchestrator");
      });

      it("is not given to a session no pane bearer bound", async () => {
        const store = makeStore();
        seedLiveSession(store, "s-api", "full");
        store.sessionOriginMap.set("s-api", "external");
        const server = createSessionServer(
          "s-api",
          fakeDeps({
            sessionStore: store,
            dispatchAction: listingDispatch(),
            requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
            getCachedManifest: vi.fn(() => ownedManifest()),
          })
        );

        const payload = refusalPayload(
          await callTool(server, {
            name: "terminal.sendCommandOwned",
            arguments: { terminalId: "terminal-users-own", command: "1" },
          })
        );

        expect(payload.code).toBe("RESOURCE_NOT_OWNED");
        expect(payload.message).not.toContain("Hand to orchestrator");
        expect(payload.details).toBeUndefined();
      });

      it.each([
        ["terminal.closeOwned", { terminalId: "terminal-users-own" }],
        ["worktree.deleteOwned", { worktreeId: "/repo/worktrees/users-own" }],
      ])("is not given by %s, which a hand-over never satisfies", async (name, args) => {
        const store = makeStore();
        const server = orchestratorSession(store, "s-orch", listingDispatch());

        const payload = refusalPayload(await callTool(server, { name, arguments: args }));

        expect(payload.code).toBe("RESOURCE_NOT_OWNED");
        expect(payload.message).not.toContain("Hand to orchestrator");
        expect(payload.details).toBeUndefined();
      });

      it.each([
        ["help", "terminal.interruptOwned"],
        ["help", "terminal.readLastMessageOwned"],
      ] as const)(
        "is not given to Daintree's own assistant (%s origin, %s)",
        async (origin, name) => {
          const store = makeStore();
          const server = orchestratorSession(store, "s-help", listingDispatch());
          store.sessionOriginMap.set("s-help", origin);

          const payload = refusalPayload(
            await callTool(server, { name, arguments: { terminalId: "terminal-users-own" } })
          );

          expect(payload.code).toBe("RESOURCE_NOT_OWNED");
          expect(payload.message).not.toContain("Hand to orchestrator");
          expect(payload.details).toBeUndefined();
        }
      );
    });

    it("lists handed-over terminals as ones the pane can drive", async () => {
      const store = makeStore();
      const server = orchestratorSession(store, "s-orch", listingDispatch());
      handOver(store, "terminal-handed");

      const result = await callTool(server, { name: "terminal.list", arguments: { owned: true } });

      expect(
        payloadOf<{ terminals: Array<{ id: string }> }>(result).terminals.map((t) => t.id)
      ).toEqual(["terminal-handed"]);
    });

    it("survives a reconnect on the same bearer", async () => {
      const store = makeStore();
      const dispatchAction = listingDispatch();
      orchestratorSession(store, "s-orch-1", dispatchAction);
      handOver(store, "terminal-handed");

      store.revokeSession("s-orch-1");
      const second = orchestratorSession(store, "s-orch-2", dispatchAction);
      const result = await callTool(second, {
        name: "terminal.interruptOwned",
        arguments: { terminalId: "terminal-handed" },
      });

      expect(result.isError).toBeUndefined();
    });

    it("refuses another pane, and the pane once its bearer is revoked", async () => {
      const store = makeStore();
      const dispatchAction = listingDispatch();
      const other = orchestratorSession(store, "s-other", dispatchAction, "principal-other");
      const orchestrator = orchestratorSession(store, "s-orch", dispatchAction);
      handOver(store, "terminal-handed");

      const byOther = await callTool(other, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-handed", command: "1" },
      });
      expect(byOther.isError).toBe(true);
      expect(errorText(byOther)).toContain("RESOURCE_NOT_OWNED");

      store.resourceOwnership.revokePrincipal(PRINCIPAL);
      store.terminalAdoption.revokePrincipal(PRINCIPAL);
      const afterRevoke = await callTool(orchestrator, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-handed", command: "1" },
      });
      expect(afterRevoke.isError).toBe(true);
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "terminal.sendCommand",
        expect.anything(),
        expect.anything()
      );
    });

    it("sends nothing when the user takes the terminal back while the call waits", async () => {
      const store = makeStore();
      const dispatchAction = listingDispatch();
      seedLiveSession(store, "s-orch", "full");
      store.sessionOriginMap.set("s-orch", "external");
      store.resourceOwnership.bindPrincipal("s-orch", PRINCIPAL);
      handOver(store, "terminal-handed");
      const server = createSessionServer(
        "s-orch",
        fakeDeps({
          sessionStore: store,
          dispatchAction,
          // No cached manifest, so the call waits on a fetch after the gate —
          // the window a take-back can land in.
          getCachedManifest: vi.fn(() => null),
          requestManifest: vi.fn().mockImplementation(async () => {
            store.terminalAdoption.release("terminal-handed");
            return ownedManifest();
          }),
        })
      );

      const result = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-handed", command: "1" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "terminal.sendCommand",
        expect.anything(),
        expect.anything()
      );
    });

    it("refuses input and drops the terminal from the listing once the user takes it back", async () => {
      const store = makeStore();
      const dispatchAction = listingDispatch();
      const server = orchestratorSession(store, "s-orch", dispatchAction);
      handOver(store, "terminal-handed");

      store.terminalAdoption.release("terminal-handed");
      const sent = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-handed", command: "1" },
      });
      const interrupted = await callTool(server, {
        name: "terminal.interruptOwned",
        arguments: { terminalId: "terminal-handed" },
      });
      const listed = await callTool(server, { name: "terminal.list", arguments: { owned: true } });

      expect(errorText(sent)).toContain("RESOURCE_NOT_OWNED");
      expect(errorText(interrupted)).toContain("RESOURCE_NOT_OWNED");
      expect(payloadOf<{ terminals: unknown[] }>(listed).terminals).toEqual([]);
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "terminal.sendCommand",
        expect.anything(),
        expect.anything()
      );
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "terminal.interrupt",
        expect.anything(),
        expect.anything()
      );
    });

    it("does not carry a call across a take-back and a fresh hand-over", async () => {
      const store = makeStore();
      const dispatchAction = listingDispatch();
      seedLiveSession(store, "s-orch", "full");
      store.sessionOriginMap.set("s-orch", "external");
      store.resourceOwnership.bindPrincipal("s-orch", PRINCIPAL);
      handOver(store, "terminal-handed");
      const server = createSessionServer(
        "s-orch",
        fakeDeps({
          sessionStore: store,
          dispatchAction,
          getCachedManifest: vi.fn(() => null),
          requestManifest: vi.fn().mockImplementation(async () => {
            // The consent the call was admitted under ends, and a new one
            // begins, while it waits.
            store.terminalAdoption.release("terminal-handed");
            handOver(store, "terminal-handed");
            return ownedManifest();
          }),
        })
      );

      const result = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-handed", command: "1" },
      });

      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "terminal.sendCommand",
        expect.anything(),
        expect.anything()
      );
    });

    it("ends the hand-over when a creation reuses the id", async () => {
      const store = makeStore();
      const dispatchAction = vi.fn().mockResolvedValue({
        result: { ok: true, result: { terminalId: "terminal-handed" } },
      });
      const server = orchestratorSession(store, "s-other", dispatchAction, "principal-other");
      handOver(store, "terminal-handed");

      await callTool(server, { name: "terminal.new", arguments: {} });

      // The id now names the creator's new terminal: one driver, not two.
      expect(store.terminalAdoption.getForTerminal("terminal-handed")).toBeUndefined();
      expect(
        store.resourceOwnership.owns(
          store.resourceOwnership.ownerOf("s-other"),
          "terminal",
          "terminal-handed"
        )
      ).toBe(true);
    });

    it("never matches an api-key session, which has no pane to hand anything to", async () => {
      const store = makeStore();
      const dispatchAction = listingDispatch();
      seedLiveSession(store, "s-api", "external");
      store.sessionOriginMap.set("s-api", "external");
      handOver(store, "terminal-handed");
      const server = createSessionServer(
        "s-api",
        fakeDeps({
          sessionStore: store,
          dispatchAction,
          requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
          getCachedManifest: vi.fn(() => ownedManifest()),
        })
      );

      const result = await callTool(server, {
        name: "terminal.sendCommandOwned",
        arguments: { terminalId: "terminal-handed", command: "1" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalledWith(
        "terminal.sendCommand",
        expect.anything(),
        expect.anything()
      );
    });
  });
});

// #12987 — an api-key client's ownership is held by its MCP session, so it is
// told as much on a refusal and alongside what it creates.
describe("session-scoped ownership note for api-key callers (#12987)", () => {
  const NOTE = "only owns what it creates in the current MCP session";
  const PANE_HINT = "Hand to orchestrator";
  const liveStores: RealSessionStore[] = [];

  afterEach(() => {
    while (liveStores.length > 0) {
      const store = liveStores.pop()!;
      store.drain();
      store.grantCache.dispose();
    }
    vi.restoreAllMocks();
  });

  function manifest(): ActionManifestEntry[] {
    const owned = (id: string) => ({
      ...makeManifestEntry(id),
      kind: "command" as const,
      danger: "safe" as const,
    });
    return [
      owned("terminal.closeOwned"),
      owned("terminal.revealOwned"),
      owned("terminal.placeOwned"),
      owned("terminal.interruptOwned"),
      owned("terminal.sendCommandOwned"),
      owned("terminal.injectOwned"),
      owned("terminal.sendKeysOwned"),
      { ...owned("worktree.deleteOwned"), danger: "confirm" as const },
      makeManifestEntry("agent.launch"),
      {
        ...makeManifestEntry("terminal.list"),
        outputSchema: { type: "object", properties: { terminals: { type: "array" } } },
      },
    ];
  }

  function launchDispatch() {
    return vi.fn().mockImplementation((actionId: string, args: unknown) => {
      if (actionId === "agent.launch") {
        const agentId = (args as { agentId: string }).agentId;
        return Promise.resolve({
          result: {
            ok: true,
            result: { launched: true, terminalId: `t-${agentId}`, spawnStatus: null },
          },
        });
      }
      if (actionId === "terminal.list") {
        return Promise.resolve({
          result: { ok: true, result: { terminals: [{ id: "t-claude" }, { id: "t-users" }] } },
        });
      }
      return Promise.resolve({ result: { ok: true, result: null } });
    });
  }

  /**
   * A session on the given origin, bound to `principal` when one is named —
   * a pane or help bearer — and otherwise session-scoped, as an api key is.
   */
  function session(
    sessionId: string,
    options: {
      principal?: string;
      origin?: McpSessionOrigin;
      store?: RealSessionStore;
      overrides?: Partial<SessionServerDeps>;
    } = {}
  ) {
    const store = options.store ?? new RealSessionStore(() => {});
    if (options.store === undefined) liveStores.push(store);
    seedLiveSession(store, sessionId, "full");
    store.sessionOriginMap.set(sessionId, options.origin ?? "external");
    if (options.principal !== undefined) {
      store.resourceOwnership.bindPrincipal(sessionId, options.principal);
    }
    const dispatchAction = launchDispatch();
    const server = createSessionServer(
      sessionId,
      fakeDeps({
        sessionStore: store,
        dispatchAction,
        requestManifest: vi.fn().mockResolvedValue(manifest()),
        getCachedManifest: vi.fn(() => manifest()),
        handleTerminalReadLastMessageOwned: vi
          .fn()
          .mockResolvedValue({ status: "unavailable", reason: "no-message" }),
        ...options.overrides,
      })
    );
    return { store, server, dispatchAction };
  }

  type Result = { content: unknown; isError?: boolean; structuredContent?: unknown };

  function texts(result: Result): string[] {
    return (result.content as Array<{ type: string; text: string }>).map((block) => block.text);
  }

  function refusal(result: Result) {
    return JSON.parse(texts(result)[0]!) as { code: string; message: string; details?: unknown };
  }

  const OWNED_CALLS: Array<[string, Record<string, unknown>]> = [
    ["terminal.closeOwned", { terminalId: "t-users" }],
    ["terminal.revealOwned", { terminalId: "t-users" }],
    ["terminal.placeOwned", { terminalId: "t-users", location: "background" }],
    ["terminal.interruptOwned", { terminalId: "t-users" }],
    ["terminal.sendCommandOwned", { terminalId: "t-users", command: "1" }],
    ["terminal.injectOwned", { terminalId: "t-users" }],
    ["terminal.sendKeysOwned", { terminalId: "t-users", keys: ["enter"] }],
    ["terminal.readLastMessageOwned", { terminalId: "t-users" }],
    ["worktree.deleteOwned", { worktreeId: "/repo/worktrees/users" }],
  ];

  describe("on a refusal", () => {
    it.each(OWNED_CALLS)("is appended when %s refuses an api-key caller", async (name, args) => {
      const { server, dispatchAction } = session("s-api");

      const result = await callTool(server, { name, arguments: args });

      expect(result.isError).toBe(true);
      const payload = refusal(result);
      expect(payload.code).toBe("RESOURCE_NOT_OWNED");
      expect(payload.message).toContain(NOTE);
      expect(payload.message).toContain("30 minutes without MCP calls");
      expect(payload.message).not.toContain(PANE_HINT);
      expect(payload.details).toBeUndefined();
      expect(texts(result)).toHaveLength(1);
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("leaves a pane's hand-over hint and grant path as they were", async () => {
      const { server } = session("s-pane", { principal: "principal-pane" });

      const payload = refusal(
        await callTool(server, {
          name: "terminal.sendCommandOwned",
          arguments: { terminalId: "t-users", command: "1" },
        })
      );

      expect(payload.message).toContain(PANE_HINT);
      expect(payload.message).not.toContain(NOTE);
      expect(payload.details).toEqual({ grantPath: "context-menu:hand-to-orchestrator" });
    });

    it.each([
      ["terminal.interruptOwned", { terminalId: "t-users" }],
      ["terminal.readLastMessageOwned", { terminalId: "t-users" }],
    ])("is not given by %s to a help session", async (name, args) => {
      const { server } = session("s-help", { principal: "help\u0000h-1", origin: "help" });

      const result = await callTool(server, { name, arguments: args });

      expect(result.isError).toBe(true);
      expect(refusal(result).code).toBe("RESOURCE_NOT_OWNED");
      expect(refusal(result).message).not.toContain(NOTE);
    });

    it("is given to a help session no bearer bound, whose records are session-scoped too", async () => {
      const { server } = session("s-unbound", { origin: "help" });

      const payload = refusal(
        await callTool(server, {
          name: "terminal.interruptOwned",
          arguments: { terminalId: "t-users" },
        })
      );

      expect(payload.code).toBe("RESOURCE_NOT_OWNED");
      expect(payload.message).toContain(NOTE);
      expect(payload.details).toBeUndefined();
    });

    it("is not given on the assistant's view-scoped read, which is not a ledger miss", async () => {
      const { server } = session("s-unbound", { origin: "help" });

      const payload = refusal(
        await callTool(server, {
          name: "terminal.readLastMessageOwned",
          arguments: { terminalId: "t-users" },
        })
      );

      expect(payload.code).toBe("RESOURCE_NOT_OWNED");
      expect(payload.message).toContain("is in the project this assistant is open in");
      expect(payload.message).not.toContain(NOTE);
    });

    it("reads byte-for-byte the same for an unknown id, another session's and an earlier session's", async () => {
      const store = new RealSessionStore(() => {});
      liveStores.push(store);
      const { server } = session("s-api", { store });
      session("s-other", { store });
      const refusalFor = async () =>
        JSON.stringify(
          (
            await callTool(server, {
              name: "terminal.sendCommandOwned",
              arguments: { terminalId: "t-x", command: "1" },
            })
          ).content
        );

      const unknown = await refusalFor();
      store.resourceOwnership.record("s-other", [{ kind: "terminal", id: "t-x" }]);
      const anotherSessions = await refusalFor();
      session("s-earlier", { store });
      store.resourceOwnership.record("s-earlier", [{ kind: "terminal", id: "t-x" }]);
      store.revokeSession("s-earlier");
      const earlierSessions = await refusalFor();

      expect(anotherSessions).toBe(unknown);
      expect(earlierSessions).toBe(unknown);
      expect(unknown).toContain(NOTE);
    });
  });

  describe("alongside what it creates", () => {
    it("follows a launch as its own text block, leaving the result untouched", async () => {
      const { server } = session("s-api");

      const result = await callTool(server, {
        name: "agent.launch",
        arguments: { agentId: "claude", prompt: "go" },
      });

      expect(result.isError).toBeUndefined();
      const [first, ...rest] = texts(result);
      expect(JSON.parse(first!)).toMatchObject({ terminalId: "t-claude" });
      expect(rest).toHaveLength(1);
      expect(rest[0]).toContain(NOTE);
    });

    it("follows a batch launch once, not once per item", async () => {
      const { server } = session("s-api");

      const result = await callTool(server, {
        name: "agent.launchMany",
        arguments: { agentIds: ["claude", "codex"], prompt: "go" },
      });

      const blocks = texts(result);
      expect(blocks.filter((text) => text.includes(NOTE))).toHaveLength(1);
      expect(blocks[blocks.length - 1]).toContain(NOTE);
      expect(result.structuredContent).toMatchObject({
        results: [
          { target: "claude", ok: true, result: { terminalId: "t-claude" } },
          { target: "codex", ok: true, result: { terminalId: "t-codex" } },
        ],
      });
    });

    it("follows a waited launch after its reply", async () => {
      const wait = vi.fn(() => ({
        bind: vi.fn(),
        cancel: vi.fn(),
        promise: Promise.resolve({
          terminalId: "t-claude",
          outcome: "handback" as const,
          reply: { text: "Fact: honey", lineCount: 1, truncated: false },
        }),
      }));
      const { server } = session("s-api", { overrides: { replyWaiter: { wait } } });

      const result = await callTool(server, {
        name: "agent.launch",
        arguments: { agentId: "claude", prompt: "go", waitForReply: true },
      });

      const [first, note] = texts(result);
      expect(JSON.parse(first!)).toMatchObject({ reply: { outcome: "handback" } });
      expect(note).toContain(NOTE);
      expect(texts(result)).toHaveLength(2);
    });

    it("comes back once with a deduplicated launch", async () => {
      const { server, dispatchAction } = session("s-api");
      const args = { agentId: "claude", prompt: "go", requestKey: "k-1" };

      const first = await callTool(server, { name: "agent.launch", arguments: args });
      const again = await callTool(server, { name: "agent.launch", arguments: args });

      expect(dispatchAction).toHaveBeenCalledTimes(1);
      expect(texts(again)).toEqual(texts(first));
      expect(texts(again).filter((text) => text.includes(NOTE))).toHaveLength(1);
    });

    it("comes once to a duplicate sharing the launch still in flight", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const dispatchAction = vi.fn().mockImplementation(async () => {
        await gate;
        return {
          result: {
            ok: true,
            result: { launched: true, terminalId: "t-claude", spawnStatus: null },
          },
        };
      });
      const { server } = session("s-api", { overrides: { dispatchAction } });
      const args = { agentId: "claude", prompt: "go", requestKey: "k-2" };

      const first = callTool(server, { name: "agent.launch", arguments: args });
      const shared = callTool(server, { name: "agent.launch", arguments: args });
      release();
      const [a, b] = await Promise.all([first, shared]);

      expect(dispatchAction).toHaveBeenCalledTimes(1);
      expect(texts(b)).toEqual(texts(a));
      expect(texts(b).filter((text) => text.includes(NOTE))).toHaveLength(1);
    });

    it("follows an owned listing, but not an unfiltered one", async () => {
      const { server } = session("s-api");
      await callTool(server, { name: "agent.launch", arguments: { agentId: "claude" } });

      const owned = await callTool(server, { name: "terminal.list", arguments: { owned: true } });
      const all = await callTool(server, { name: "terminal.list", arguments: {} });

      expect(texts(owned)).toHaveLength(2);
      expect(texts(owned)[1]).toContain(NOTE);
      expect(owned.structuredContent).toEqual({ terminals: [{ id: "t-claude" }] });
      expect(texts(all)).toHaveLength(1);
    });

    it("is left off a failed launch", async () => {
      const { server } = session("s-api", {
        overrides: {
          dispatchAction: vi.fn().mockResolvedValue({
            result: { ok: false, error: { code: "EXECUTION_ERROR", message: "no such agent" } },
          }),
        },
      });

      const result = await callTool(server, {
        name: "agent.launch",
        arguments: { agentId: "nope", prompt: "go" },
      });

      expect(result.isError).toBe(true);
      expect(refusal(result).message).toContain("no such agent");
      expect(JSON.stringify(result.content)).not.toContain(NOTE);
    });

    it.each([
      ["a pane bearer", { principal: "principal-pane" }],
      ["a help session", { principal: "help\u0000h-1", origin: "help" }],
    ] as const)("is not given to %s", async (_label, options) => {
      const { server } = session("s-bound", options);

      const launched = await callTool(server, {
        name: "agent.launch",
        arguments: { agentId: "claude", prompt: "go" },
      });
      const listed = await callTool(server, { name: "terminal.list", arguments: { owned: true } });

      expect(launched.isError).toBeUndefined();
      expect(JSON.parse(texts(launched)[0]!)).toMatchObject({ terminalId: "t-claude" });
      expect(listed.isError).toBeUndefined();
      expect(listed.structuredContent).toEqual({ terminals: [{ id: "t-claude" }] });
      expect(texts(launched)).toHaveLength(1);
      expect(texts(listed)).toHaveLength(1);
    });
  });
});
