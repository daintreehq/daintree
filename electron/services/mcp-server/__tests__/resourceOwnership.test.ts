import { describe, expect, it } from "vitest";
import {
  ResourceOwnershipLedger,
  extractOwnedResources,
  extractOwnedResourcesFromDispatch,
  extractOwnedResourcesFromFailure,
  OWNERSHIP_RECORDING_TOOLS,
} from "../resourceOwnership.js";
import { formatPartialSuccessMessage } from "../../../../shared/utils/partialSuccess.js";
import { NON_RENDERER_OWNED_TIER_ALLOWLISTS } from "../shared.js";

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

  it("moves the record to the newest creator when an id is reused", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("session-a", [{ kind: "terminal", id: "terminal-1" }]);

    // Ids are reusable — `agent.launch` takes a `requestedId` that `addPanel`
    // honours without a collision check, and a reused id names a REPLACEMENT
    // panel. Keeping A's record would let A close B's live panel; moving it
    // keeps authority pointing at what actually exists.
    ledger.record("session-b", [{ kind: "terminal", id: "terminal-1" }]);

    expect(ledger.owns("session-b", "terminal", "terminal-1")).toBe(true);
    expect(ledger.owns("session-a", "terminal", "terminal-1")).toBe(false);
    // The displaced session is not left holding an empty husk of a record.
    expect(ledger.list("session-a")).toEqual([]);
  });

  it("leaves a displaced session's other resources alone", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("session-a", [
      { kind: "terminal", id: "terminal-1" },
      { kind: "terminal", id: "terminal-keep" },
    ]);

    ledger.record("session-b", [{ kind: "terminal", id: "terminal-1" }]);

    expect(ledger.owns("session-a", "terminal", "terminal-keep")).toBe(true);
    expect(ledger.list("session-a")).toHaveLength(1);
  });

  it("re-stamps the workspace when the same session re-records an id", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("s", [{ kind: "terminal", id: "terminal-1" }], "ws-a");
    ledger.record("s", [{ kind: "terminal", id: "terminal-1" }], "ws-b");

    // The later creation is the live one, so its workspace is the true one.
    expect(ledger.get("s", "terminal", "terminal-1")?.workspaceId).toBe("ws-b");
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

  it("release against an expected record leaves a newer record under the same id alone", () => {
    const ledger = new ResourceOwnershipLedger();
    const [checked] = ledger.record("owner", [{ kind: "terminal", id: "terminal-1" }]);
    // The id is created again before the cleanup that checked the first
    // record completes.
    ledger.record("owner", [{ kind: "terminal", id: "terminal-1" }]);

    ledger.release("owner", "terminal", "terminal-1", checked);
    expect(ledger.owns("owner", "terminal", "terminal-1")).toBe(true);

    const current = ledger.get("owner", "terminal", "terminal-1");
    ledger.release("owner", "terminal", "terminal-1", current);
    expect(ledger.owns("owner", "terminal", "terminal-1")).toBe(false);
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

  it("clearAllSessions drops every session at once", () => {
    const ledger = new ResourceOwnershipLedger();
    ledger.record("session-a", [{ kind: "terminal", id: "terminal-a" }]);
    ledger.record("session-b", [{ kind: "worktree", id: "/tmp/wt-b" }]);

    ledger.clearAllSessions();

    expect(ledger.list("session-a")).toEqual([]);
    expect(ledger.list("session-b")).toEqual([]);
    expect(ledger.record("session-c", [{ kind: "terminal", id: "terminal-a" }])).toHaveLength(1);
  });

  describe("pane bearer principals (#12487)", () => {
    it("treats an unbound session as its own owner", () => {
      const ledger = new ResourceOwnershipLedger();
      expect(ledger.ownerOf("session-a")).toBe("session-a");
      expect(ledger.isPrincipalOwner(ledger.ownerOf("session-a"))).toBe(false);
    });

    it("hands a reconnecting session the records its bearer's earlier session created", () => {
      const ledger = new ResourceOwnershipLedger();
      ledger.bindPrincipal("session-1", "principal-p");
      ledger.record(ledger.ownerOf("session-1"), [{ kind: "terminal", id: "terminal-1" }], "ws-a");

      ledger.clearSession("session-1");
      ledger.bindPrincipal("session-2", "principal-p");

      const owner = ledger.ownerOf("session-2");
      expect(ledger.isPrincipalOwner(owner)).toBe(true);
      expect(ledger.get(owner, "terminal", "terminal-1")).toEqual({
        kind: "terminal",
        id: "terminal-1",
        workspaceId: "ws-a",
      });
      // Nothing is readable under the raw session id — authority sits with the
      // principal, and only a session bound to it reaches it.
      expect(ledger.owns("session-2", "terminal", "terminal-1")).toBe(false);
    });

    it("shares one set of records between two live sessions on the same bearer", () => {
      const ledger = new ResourceOwnershipLedger();
      ledger.bindPrincipal("session-1", "principal-p");
      ledger.bindPrincipal("session-2", "principal-p");

      ledger.record(ledger.ownerOf("session-1"), [{ kind: "terminal", id: "terminal-1" }]);
      ledger.record(ledger.ownerOf("session-2"), [{ kind: "terminal", id: "terminal-2" }]);
      ledger.release(ledger.ownerOf("session-2"), "terminal", "terminal-1");

      expect(ledger.list(ledger.ownerOf("session-1"))).toEqual([
        { kind: "terminal", id: "terminal-2" },
      ]);
      expect(ledger.list(ledger.ownerOf("session-2"))).toEqual(
        ledger.list(ledger.ownerOf("session-1"))
      );
    });

    it("keeps a principal's records when one of its sessions ends", () => {
      const ledger = new ResourceOwnershipLedger();
      ledger.bindPrincipal("session-1", "principal-p");
      ledger.bindPrincipal("session-2", "principal-p");
      ledger.record(ledger.ownerOf("session-1"), [{ kind: "terminal", id: "terminal-1" }]);

      ledger.clearSession("session-1");

      expect(ledger.ownerOf("session-1")).toBe("session-1");
      expect(ledger.owns(ledger.ownerOf("session-2"), "terminal", "terminal-1")).toBe(true);
    });

    it("drops a revoked principal's records and refuses to record under it again", () => {
      const ledger = new ResourceOwnershipLedger();
      ledger.bindPrincipal("session-1", "principal-p");
      const owner = ledger.ownerOf("session-1");
      ledger.record(owner, [{ kind: "terminal", id: "terminal-1" }]);

      ledger.revokePrincipal("principal-p");

      expect(ledger.list(owner)).toEqual([]);
      // A creation admitted before the revocation must not bring it back.
      expect(ledger.record(owner, [{ kind: "terminal", id: "terminal-2" }])).toEqual([]);
      expect(ledger.list(owner)).toEqual([]);
      // The session stays bound to the dead principal rather than falling back
      // to records of its own, so it owns and records nothing until it ends.
      expect(ledger.ownerOf("session-1")).toBe(owner);
      // The ids are freed for whoever creates them next.
      expect(ledger.record("session-2", [{ kind: "terminal", id: "terminal-1" }])).toHaveLength(1);
    });

    it("never lets a relaunch's new principal inherit the old one's records", () => {
      const ledger = new ResourceOwnershipLedger();
      ledger.bindPrincipal("session-1", "principal-old");
      ledger.record(ledger.ownerOf("session-1"), [{ kind: "terminal", id: "terminal-1" }]);

      ledger.bindPrincipal("session-2", "principal-new");

      expect(ledger.owns(ledger.ownerOf("session-2"), "terminal", "terminal-1")).toBe(false);
    });

    it("still gives an id to its newest creator across principals and sessions", () => {
      const ledger = new ResourceOwnershipLedger();
      ledger.bindPrincipal("pane-session", "principal-p");
      const principal = ledger.ownerOf("pane-session");
      ledger.record(principal, [{ kind: "terminal", id: "terminal-1" }]);

      ledger.record("api-session", [{ kind: "terminal", id: "terminal-1" }]);
      expect(ledger.owns(principal, "terminal", "terminal-1")).toBe(false);
      expect(ledger.owns("api-session", "terminal", "terminal-1")).toBe(true);

      // And back again, after the pane's session was replaced.
      ledger.clearSession("pane-session");
      ledger.bindPrincipal("pane-session-2", "principal-p");
      ledger.record(ledger.ownerOf("pane-session-2"), [{ kind: "terminal", id: "terminal-1" }]);
      expect(ledger.owns("api-session", "terminal", "terminal-1")).toBe(false);
      expect(ledger.owns(principal, "terminal", "terminal-1")).toBe(true);
    });

    it("keeps principals' records through clearAllSessions but unbinds every session", () => {
      const ledger = new ResourceOwnershipLedger();
      ledger.bindPrincipal("pane-session", "principal-p");
      const principal = ledger.ownerOf("pane-session");
      ledger.record(principal, [{ kind: "terminal", id: "terminal-pane" }]);
      ledger.record("api-session", [{ kind: "terminal", id: "terminal-api" }]);

      ledger.clearAllSessions();

      expect(ledger.ownerOf("pane-session")).toBe("pane-session");
      expect(ledger.list("api-session")).toEqual([]);
      ledger.bindPrincipal("pane-session-2", "principal-p");
      expect(ledger.owns(ledger.ownerOf("pane-session-2"), "terminal", "terminal-pane")).toBe(true);
    });

    it("cannot be reached by a session whose id spells the principal id", () => {
      const ledger = new ResourceOwnershipLedger();
      ledger.bindPrincipal("pane-session", "principal-p");
      ledger.record(ledger.ownerOf("pane-session"), [{ kind: "terminal", id: "terminal-1" }]);

      expect(ledger.owns("principal-p", "terminal", "terminal-1")).toBe(false);
      expect(ledger.isPrincipalOwner("principal-p")).toBe(false);
    });
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

  it("attributes the issue agent a ladder-tier session opened, not its worktree (#12407)", () => {
    // The worktree the workflow created is deliberately not attributed.
    expect(
      extractOwnedResources("workflow.startWorkOnIssue", {
        worktreeId: "/tmp/wt",
        terminalId: "terminal-2",
        spawnedTerminalCount: 2,
      })
    ).toEqual([{ kind: "terminal", id: "terminal-2" }]);
    expect(
      extractOwnedResources("workflow.startWorkOnIssue", {
        worktreeId: "/tmp/wt",
        terminalId: null,
      })
    ).toEqual([]);
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
  const partialError = {
    // The code is the provenance claim `ActionService` stamps for a thrown
    // `PartialSuccessError`; the message is only the human-readable half.
    code: "PARTIAL_SUCCESS",
    message: formatPartialSuccessMessage("Recipe r1 failed to run: boom", {
      worktreeId: "/tmp/wt",
      worktreePath: "/tmp/wt",
      branch: "feature/x",
      recipeLaunched: false,
      spawnedTerminalCount: 0,
      spawnedTerminalIds: [],
      failedTerminalCount: 0,
    }),
  };

  it("attributes the worktree a half-failed composite already created", () => {
    expect(extractOwnedResourcesFromFailure("worktree.createWithRecipe", partialError)).toEqual([
      { kind: "worktree", id: "/tmp/wt" },
    ]);
  });

  it("attributes nothing when the composite failed before creating anything", () => {
    expect(
      extractOwnedResourcesFromFailure("worktree.createWithRecipe", {
        code: "EXECUTION_ERROR",
        message: "Failed to create worktree: no worktreeId returned from backend",
      })
    ).toEqual([]);
  });

  it("refuses a correctly-shaped payload that lacks the provenance code", () => {
    // The composite calls forge providers and git BEFORE the worktree exists,
    // and `forgeAuditService` rethrows a provider's error unchanged. A provider
    // returning this exact string must not mint an ownership record, so the
    // message shape alone is never enough.
    expect(
      extractOwnedResourcesFromFailure("worktree.createWithRecipe", {
        code: "EXECUTION_ERROR",
        message: partialError.message,
      })
    ).toEqual([]);
    expect(
      extractOwnedResourcesFromFailure("worktree.createWithRecipe", {
        message: partialError.message,
      })
    ).toEqual([]);
  });

  it("refuses a partial payload smuggled through another action's error message", () => {
    // The prefix is only trusted on the composites that actually emit it, so a
    // failure message a caller can influence elsewhere cannot mint ownership.
    expect(extractOwnedResourcesFromFailure("terminal.new", partialError)).toEqual([]);
    expect(extractOwnedResourcesFromFailure("recipe.run", partialError)).toEqual([]);
  });

  it("refuses malformed or embedded partial payloads even with the right code", () => {
    const withCode = (message: string) => ({ code: "PARTIAL_SUCCESS", message });
    expect(
      extractOwnedResourcesFromFailure(
        "worktree.createWithRecipe",
        withCode("PARTIAL_SUCCESS: {not json")
      )
    ).toEqual([]);
    expect(
      extractOwnedResourcesFromFailure("worktree.createWithRecipe", withCode("PARTIAL_SUCCESS: []"))
    ).toEqual([]);
    // Must START with the prefix: a message that merely quotes it is a report
    // about a partial success, not one.
    expect(
      extractOwnedResourcesFromFailure(
        "worktree.createWithRecipe",
        withCode(`the run said PARTIAL_SUCCESS: {"partialResult":{"worktreeId":"/tmp/forged"}}`)
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
          code: "PARTIAL_SUCCESS",
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
  // A manually maintained contract, not a derived one: nothing in the registry
  // marks an action as "creates a resource", so this list is the record of that
  // judgement. Exact set equality rather than a subset check, so REMOVING an
  // extractor fails here too — and so the failure message names the tool.
  const EXPECTED_RECORDING_TOOLS = [
    "terminal.new",
    "agent.launch",
    "workflow.startWorkOnIssue",
    "recipe.run",
    "worktree.createWithRecipe",
  ];

  it("has an extractor for exactly the creation tools we decided to attribute", () => {
    expect([...OWNERSHIP_RECORDING_TOOLS].sort()).toEqual([...EXPECTED_RECORDING_TOOLS].sort());
  });

  it("keeps every attributed tool reachable by a session that is not the assistant", () => {
    // The gap this closes is a caller that can create but not clean up — or,
    // since #12407, not type into what it created — so an attributed tool no
    // such session can reach would mean the ledger is recording for a caller
    // class that can no longer use it.
    for (const id of EXPECTED_RECORDING_TOOLS) {
      expect(
        NON_RENDERER_OWNED_TIER_ALLOWLISTS.external.has(id) ||
          NON_RENDERER_OWNED_TIER_ALLOWLISTS.full.has(id),
        `${id} is attributed but no non-assistant session can call it`
      ).toBe(true);
    }
  });
});
