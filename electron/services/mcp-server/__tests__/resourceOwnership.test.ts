import { describe, expect, it } from "vitest";
import {
  ResourceOwnershipLedger,
  extractOwnedResources,
  extractOwnedResourcesFromDispatch,
  extractOwnedResourcesFromFailure,
  OWNERSHIP_RECORDING_TOOLS,
} from "../resourceOwnership.js";
import { formatPartialSuccessMessage } from "../../../../shared/utils/partialSuccess.js";
import { MCP_EXTERNAL_TIER_TOOLS } from "../../../../shared/config/mcpExternalTierAllowlist.js";

describe("ResourceOwnershipLedger", () => {
  it("only reports a resource as owned by the session that created it", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("session-a", [{ kind: "terminal", id: "terminal-1" }]);

    expect(ledger.owns("session-a", "terminal", "terminal-1")).toBe(true);
    expect(ledger.owns("session-b", "terminal", "terminal-1")).toBe(false);
  });

  it("distinguishes resource kinds sharing an id string", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("s", [{ kind: "worktree", id: "shared-id" }]);

    expect(ledger.owns("s", "worktree", "shared-id")).toBe(true);
    // A worktree record must not authorize closing a panel that happens to be
    // named the same, or the kind is decoration rather than a boundary.
    expect(ledger.owns("s", "terminal", "shared-id")).toBe(false);
  });

  it("reports an unknown session as owning nothing", () => {
    const ledger = new ResourceOwnershipLedger();
    expect(ledger.owns("never-handshook", "terminal", "terminal-1")).toBe(false);
    expect(ledger.list("never-handshook")).toEqual([]);
  });

  it("refuses to transfer ownership when a second session claims the same id", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("session-a", [{ kind: "terminal", id: "terminal-1" }]);

    // `agent.launch` takes a `requestedId` and `addPanel` honours it without a
    // collision check, so this is a reachable claim — not a hypothetical.
    const added = ledger.record("session-b", [{ kind: "terminal", id: "terminal-1" }]);

    expect(added).toEqual([]);
    expect(ledger.owns("session-b", "terminal", "terminal-1")).toBe(false);
    expect(ledger.owns("session-a", "terminal", "terminal-1")).toBe(true);
  });

  it("keeps the original workspace stamp when the same session re-records an id", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("s", [{ kind: "terminal", id: "terminal-1" }], "ws-a");
    ledger.record("s", [{ kind: "terminal", id: "terminal-1" }], "ws-b");

    expect(ledger.get("s", "terminal", "terminal-1")?.workspaceId).toBe("ws-a");
  });

  it("stamps the dispatched workspace when one was resolved and omits it otherwise", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("s", [{ kind: "terminal", id: "with-ws" }], "ws-a");
    ledger.record("s", [{ kind: "terminal", id: "without-ws" }]);

    expect(ledger.get("s", "terminal", "with-ws")?.workspaceId).toBe("ws-a");
    expect(ledger.get("s", "terminal", "without-ws")).toEqual({
      kind: "terminal",
      id: "without-ws",
    });
  });

  it("ignores empty ids rather than recording an unusable entry", () => {
    const ledger = new ResourceOwnershipLedger();
    expect(ledger.record("s", [{ kind: "terminal", id: "" }])).toEqual([]);
    expect(ledger.list("s")).toEqual([]);
  });

  it("release frees the id for a later session to own", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("session-a", [{ kind: "terminal", id: "terminal-1" }]);
    ledger.release("session-a", "terminal", "terminal-1");

    expect(ledger.owns("session-a", "terminal", "terminal-1")).toBe(false);
    expect(ledger.record("session-b", [{ kind: "terminal", id: "terminal-1" }])).toHaveLength(1);
  });

  it("release by a non-owner leaves the owner's record intact", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("session-a", [{ kind: "terminal", id: "terminal-1" }]);
    ledger.release("session-b", "terminal", "terminal-1");

    expect(ledger.owns("session-a", "terminal", "terminal-1")).toBe(true);
  });

  it("clearSession revokes one session's authority and frees its ids, leaving others alone", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("session-a", [
      { kind: "terminal", id: "terminal-a" },
      { kind: "worktree", id: "/tmp/wt-a" },
    ]);
    ledger.record("session-b", [{ kind: "terminal", id: "terminal-b" }]);

    ledger.clearSession("session-a");

    expect(ledger.list("session-a")).toEqual([]);
    expect(ledger.list("session-b")).toHaveLength(1);
    // The id is genuinely released, not merely hidden — a reconnecting client
    // that recreates the resource must be able to own it again.
    expect(ledger.record("session-c", [{ kind: "terminal", id: "terminal-a" }])).toHaveLength(1);
  });

  it("clear drops every session at once", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("session-a", [{ kind: "terminal", id: "terminal-a" }]);
    ledger.record("session-b", [{ kind: "worktree", id: "/tmp/wt-b" }]);

    ledger.clear();

    expect(ledger.list("session-a")).toEqual([]);
    expect(ledger.list("session-b")).toEqual([]);
    expect(ledger.record("session-c", [{ kind: "terminal", id: "terminal-a" }])).toHaveLength(1);
  });
});

describe("extractOwnedResources", () => {
  it("attributes the panel terminal.new reports", () => {
    expect(extractOwnedResources("terminal.new", { terminalId: "terminal-1" })).toEqual([
      { kind: "terminal", id: "terminal-1" },
    ]);
  });

  it("attributes a launched agent's terminal but not the worktree it launched into", () => {
    const drafts = extractOwnedResources("agent.launch", {
      launched: true,
      terminalId: "terminal-1",
      worktreeId: "/tmp/pre-existing-worktree",
    });

    // The session did not create that worktree, so recording it would grant
    // delete authority over someone else's directory.
    expect(drafts).toEqual([{ kind: "terminal", id: "terminal-1" }]);
  });

  it("attributes nothing for a failed agent launch", () => {
    expect(extractOwnedResources("agent.launch", { launched: false, terminalId: null })).toEqual(
      []
    );
    // Belt and braces: a stale id beside `launched: false` still records nothing.
    expect(
      extractOwnedResources("agent.launch", { launched: false, terminalId: "terminal-1" })
    ).toEqual([]);
  });

  it("attributes every child terminal a recipe run started", () => {
    expect(
      extractOwnedResources("recipe.run", {
        spawnedCount: 2,
        failedCount: 1,
        spawnedTerminalIds: ["terminal-1", "terminal-2"],
        failedTerminals: [{ index: 2, reason: "panel limit" }],
      })
    ).toEqual([
      { kind: "terminal", id: "terminal-1" },
      { kind: "terminal", id: "terminal-2" },
    ]);
  });

  it("attributes the worktree and every composite child terminal together", () => {
    expect(
      extractOwnedResources("worktree.createWithRecipe", {
        worktreeId: "/tmp/wt",
        worktreePath: "/tmp/wt",
        branch: "feature/x",
        recipeLaunched: true,
        spawnedTerminalCount: 2,
        spawnedTerminalIds: ["terminal-1", "terminal-2"],
        failedTerminalCount: 0,
      })
    ).toEqual([
      { kind: "worktree", id: "/tmp/wt" },
      { kind: "terminal", id: "terminal-1" },
      { kind: "terminal", id: "terminal-2" },
    ]);
  });

  it("records nothing for actions outside the creation set", () => {
    // `terminal.list` returns panel ids the session did not create; attributing
    // them would turn a listing into a grant.
    expect(
      extractOwnedResources("terminal.list", { terminals: [{ id: "terminal-victim" }] })
    ).toEqual([]);
    expect(extractOwnedResources("worktree.list", { worktreeId: "/tmp/wt" })).toEqual([]);
  });

  it("tolerates malformed results without recording a partial claim", () => {
    expect(extractOwnedResources("terminal.new", null)).toEqual([]);
    expect(extractOwnedResources("terminal.new", "terminal-1")).toEqual([]);
    expect(extractOwnedResources("terminal.new", { terminalId: 42 })).toEqual([]);
    expect(extractOwnedResources("recipe.run", { spawnedTerminalIds: "terminal-1" })).toEqual([]);
    // A mixed array keeps the usable ids and drops the rest rather than
    // failing the whole attribution.
    expect(
      extractOwnedResources("recipe.run", { spawnedTerminalIds: ["terminal-1", 7, "", null] })
    ).toEqual([{ kind: "terminal", id: "terminal-1" }]);
  });
});

describe("extractOwnedResourcesFromFailure", () => {
  const partialMessage = formatPartialSuccessMessage("Recipe r1 failed to run: boom", {
    worktreeId: "/tmp/wt",
    worktreePath: "/tmp/wt",
    branch: "feature/x",
    recipeLaunched: false,
    spawnedTerminalCount: 0,
    spawnedTerminalIds: [],
    failedTerminalCount: 0,
  });

  it("attributes the worktree a half-failed composite already created", () => {
    expect(extractOwnedResourcesFromFailure("worktree.createWithRecipe", partialMessage)).toEqual([
      { kind: "worktree", id: "/tmp/wt" },
    ]);
  });

  it("attributes nothing when the composite failed before creating anything", () => {
    expect(
      extractOwnedResourcesFromFailure(
        "worktree.createWithRecipe",
        "Failed to create worktree: no worktreeId returned from backend"
      )
    ).toEqual([]);
  });

  it("refuses a partial payload smuggled through another action's error message", () => {
    // The prefix is only trusted on the composites that actually emit it, so a
    // failure message a caller can influence elsewhere cannot mint ownership.
    expect(extractOwnedResourcesFromFailure("terminal.new", partialMessage)).toEqual([]);
    expect(extractOwnedResourcesFromFailure("recipe.run", partialMessage)).toEqual([]);
  });

  it("refuses malformed or embedded partial payloads", () => {
    expect(
      extractOwnedResourcesFromFailure("worktree.createWithRecipe", "PARTIAL_SUCCESS: {not json")
    ).toEqual([]);
    expect(
      extractOwnedResourcesFromFailure("worktree.createWithRecipe", "PARTIAL_SUCCESS: []")
    ).toEqual([]);
    // Must START with the prefix: a message that merely quotes it is a report
    // about a partial success, not one.
    expect(
      extractOwnedResourcesFromFailure(
        "worktree.createWithRecipe",
        `the run said PARTIAL_SUCCESS: {"partialResult":{"worktreeId":"/tmp/forged"}}`
      )
    ).toEqual([]);
  });
});

describe("extractOwnedResourcesFromDispatch", () => {
  it("reads the success leg of an ok envelope", () => {
    expect(
      extractOwnedResourcesFromDispatch("terminal.new", {
        ok: true,
        result: { terminalId: "terminal-1" },
      })
    ).toEqual([{ kind: "terminal", id: "terminal-1" }]);
  });

  it("reads the partial payload off a failed envelope", () => {
    // `ActionService.dispatch` flattens every renderer throw into
    // `{ ok: false, error: { code, message } }`, so the PARTIAL_SUCCESS payload
    // arrives on this leg rather than as a thrown error in main.
    expect(
      extractOwnedResourcesFromDispatch("worktree.createWithRecipe", {
        ok: false,
        error: {
          code: "EXECUTION_ERROR",
          message: formatPartialSuccessMessage("recipe blew up", { worktreeId: "/tmp/wt" }),
        },
      })
    ).toEqual([{ kind: "worktree", id: "/tmp/wt" }]);
  });

  it("records nothing for an ordinary failure", () => {
    expect(
      extractOwnedResourcesFromDispatch("terminal.new", {
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "no worktree available" },
      })
    ).toEqual([]);
  });
});

describe("ownership recording coverage", () => {
  it("covers every creation tool an external session can reach", () => {
    // The gap this issue closes is a caller that can create but not clean up.
    // Any future creation tool added to the external surface without an
    // extractor reopens it silently, so the set is pinned here.
    const externalCreationTools = [
      "terminal.new",
      "agent.launch",
      "recipe.run",
      "worktree.createWithRecipe",
    ];
    for (const id of externalCreationTools) {
      expect(MCP_EXTERNAL_TIER_TOOLS as readonly string[]).toContain(id);
      expect(OWNERSHIP_RECORDING_TOOLS).toContain(id);
    }
  });
});
