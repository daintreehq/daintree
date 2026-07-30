// @vitest-environment node
/**
 * Tests resolveAgentLaunchKind from useAgentLauncher.ts — the classifier that
 * stops an unresolvable agent id from degrading into a plain shell terminal
 * (#11498). It returns the kind (rather than asserting) so the hook's call site
 * is load-bearing; these tests cover the classification itself, and the hook
 * cannot drop the call without breaking its own `isAgent`.
 */
import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@shared/config/actionIds";
import { resolveAgentLaunchKind } from "../useAgentLauncher";

const NEWLINE = String.fromCharCode(10);
const CARRIAGE_RETURN = String.fromCharCode(13);

/** Grab the error a rejected id produces, so one throw can be inspected. */
function launchError(agentId: string): Error {
  try {
    resolveAgentLaunchKind(agentId, false);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error(`Expected '${agentId}' to be rejected`);
}

describe("resolveAgentLaunchKind", () => {
  it("classifies any id the registry resolved as an agent", () => {
    // The helper only sees the resolved flag, so built-in, user, and plugin ids
    // are indistinguishable here by design — the effective registry decides.
    expect(resolveAgentLaunchKind("claude", true)).toBe("agent");
    expect(resolveAgentLaunchKind("acme-plugin-agent", true)).toBe("agent");
  });

  it("classifies 'terminal' as a plain terminal even though it is unregistered", () => {
    expect(resolveAgentLaunchKind("terminal", false)).toBe("terminal");
  });

  it("prefers the agent kind when something registered the 'terminal' id", () => {
    // Plugin/user registries only reserve built-in agent ids, so "terminal" is
    // registerable. Resolving it as an agent preserves the pre-#11498 behavior.
    expect(resolveAgentLaunchKind("terminal", true)).toBe("agent");
  });

  it("rejects an unregistered id, naming the id it was given (#11498)", () => {
    const agentId = "clyde-the-agent";
    expect(launchError(agentId).message).toContain(agentId);
  });

  it("rejects a near-miss of the plain-terminal id rather than falling through", () => {
    expect(() => resolveAgentLaunchKind("Terminal", false)).toThrow();
    expect(() => resolveAgentLaunchKind(" terminal ", false)).toThrow();
  });

  it("fails closed for panel kinds that must be handled before this classifier", () => {
    // browser/dev-preview return from their own branches earlier in launchAgent.
    // Reaching this classifier means one was bypassed — rejecting beats falling
    // through to the generic terminal branch that #11498 was about.
    expect(() => resolveAgentLaunchKind("browser", false)).toThrow();
    expect(() => resolveAgentLaunchKind("dev-preview", false)).toThrow();
  });

  it("names only real dispatchable actions as recovery paths", () => {
    // The message crosses to MCP clients as the sole recovery hint, so every
    // action-shaped token in it has to be something a client can actually call.
    const suggested = launchError("nope").message.match(/\b[a-z]+\.[a-zA-Z]+\b/g) ?? [];
    expect(suggested.length).toBeGreaterThan(0);
    for (const actionId of suggested) {
      expect(BUILT_IN_ACTION_IDS).toContain(actionId);
    }
  });

  it("keeps an untrusted id printable and bounded in the error", () => {
    // Ids reach here straight from an MCP caller, so a newline could forge a log
    // line and an unbounded id would bloat the error crossing the boundary.
    const message = launchError(`bad${NEWLINE}ID${"x".repeat(500)}`).message;
    expect(message.includes(NEWLINE)).toBe(false);
    expect(message.includes(CARRIAGE_RETURN)).toBe(false);
    expect(message.length).toBeLessThan(300);
  });
});
