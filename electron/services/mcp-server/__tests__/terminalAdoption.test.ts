import { describe, expect, it, vi } from "vitest";
import { TerminalAdoptionLedger } from "../terminalAdoption.js";
import { ResourceOwnershipLedger, principalOwnerKey } from "../resourceOwnership.js";

describe("TerminalAdoptionLedger (#12490)", () => {
  it("gives the pane's own sessions authority, matched by the owner the ownership ledger resolves", () => {
    const ownership = new ResourceOwnershipLedger();
    ownership.bindPrincipal("s-pane", "principal-a");
    const adoption = new TerminalAdoptionLedger();

    adoption.adopt({
      terminalId: "terminal-1",
      orchestratorPaneId: "pane-a",
      principalId: "principal-a",
      workspaceId: "ws-a",
      now: 1_000,
    });

    expect(adoption.get(ownership.ownerOf("s-pane"), "terminal-1")).toEqual({
      terminalId: "terminal-1",
      orchestratorPaneId: "pane-a",
      workspaceId: "ws-a",
      adoptedAt: 1_000,
    });
    // An unbound session is its own owner, which no principal key can equal.
    expect(adoption.get(ownership.ownerOf("s-api"), "terminal-1")).toBeUndefined();
    expect(adoption.get("principal-a", "terminal-1")).toBeUndefined();
  });

  it("refuses a second pane rather than moving the terminal to it", () => {
    const adoption = new TerminalAdoptionLedger();
    adoption.adopt({ terminalId: "terminal-1", orchestratorPaneId: "pane-a", principalId: "a" });

    const second = adoption.adopt({
      terminalId: "terminal-1",
      orchestratorPaneId: "pane-b",
      principalId: "b",
    });

    expect(second).toEqual({ ok: false, heldByPaneId: "pane-a" });
    expect(adoption.getForTerminal("terminal-1")?.orchestratorPaneId).toBe("pane-a");
  });

  it("is idempotent for the pane already holding the terminal", () => {
    const adoption = new TerminalAdoptionLedger();
    const listener = vi.fn();
    adoption.onChange(listener);
    const first = adoption.adopt({
      terminalId: "terminal-1",
      orchestratorPaneId: "pane-a",
      principalId: "a",
    });

    const again = adoption.adopt({
      terminalId: "terminal-1",
      orchestratorPaneId: "pane-a",
      principalId: "a",
    });

    expect(again).toEqual(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops everything a revoked bearer held and nothing else", () => {
    const adoption = new TerminalAdoptionLedger();
    adoption.adopt({ terminalId: "terminal-1", orchestratorPaneId: "pane-a", principalId: "a" });
    adoption.adopt({ terminalId: "terminal-2", orchestratorPaneId: "pane-a", principalId: "a" });
    adoption.adopt({ terminalId: "terminal-3", orchestratorPaneId: "pane-b", principalId: "b" });
    const listener = vi.fn();
    adoption.onChange(listener);

    adoption.revokePrincipal("a");

    expect(adoption.list().map((record) => record.terminalId)).toEqual(["terminal-3"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("lets a relaunched pane be handed the terminal once the old bearer is revoked", () => {
    const adoption = new TerminalAdoptionLedger();
    adoption.adopt({ terminalId: "terminal-1", orchestratorPaneId: "pane-a", principalId: "old" });
    adoption.revokePrincipal("old");

    const relaunched = adoption.adopt({
      terminalId: "terminal-1",
      orchestratorPaneId: "pane-a",
      principalId: "new",
    });

    expect(relaunched.ok).toBe(true);
    expect(adoption.get(principalOwnerKey("old"), "terminal-1")).toBeUndefined();
  });

  it("releases one terminal and reports whether anything was held", () => {
    const adoption = new TerminalAdoptionLedger();
    const listener = vi.fn();
    adoption.onChange(listener);
    adoption.adopt({ terminalId: "terminal-1", orchestratorPaneId: "pane-a", principalId: "a" });

    expect(adoption.release("terminal-1")).toBe(true);
    expect(adoption.release("terminal-1")).toBe(false);
    expect(adoption.list()).toEqual([]);
    // One change for the adoption, one for the release; the no-op is silent.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps notifying the other listeners when one throws", () => {
    const adoption = new TerminalAdoptionLedger();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    adoption.onChange(() => {
      throw new Error("boom");
    });
    const off = adoption.onChange(healthy);

    adoption.adopt({ terminalId: "terminal-1", orchestratorPaneId: "pane-a", principalId: "a" });
    off();
    adoption.release("terminal-1");

    expect(healthy).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("ResourceOwnershipLedger.creatorOf (#12490)", () => {
  it("names whoever holds the record, and nobody once it is released", () => {
    const ownership = new ResourceOwnershipLedger();
    ownership.bindPrincipal("s-pane", "principal-a");
    const owner = ownership.ownerOf("s-pane");
    ownership.record(owner, [{ kind: "terminal", id: "terminal-1" }]);

    expect(ownership.creatorOf("terminal", "terminal-1")).toBe(owner);
    expect(ownership.creatorOf("worktree", "terminal-1")).toBeUndefined();

    ownership.revokePrincipal("principal-a");
    expect(ownership.creatorOf("terminal", "terminal-1")).toBeUndefined();
  });
});
