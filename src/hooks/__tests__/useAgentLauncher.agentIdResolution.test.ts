// @vitest-environment node
/**
 * Tests assertKnownAgentId from useAgentLauncher.ts — the guard that stops an
 * unresolvable agent id from degrading into a plain shell terminal (#11498).
 * Extracted so the reject-unknown-id contract is guarded at the source:
 * restoring the silent fallback must fail a test here, not only show up as a
 * mystery terminal at runtime. The hook calls it immediately after
 * `isRegisteredAgent`, before any settings init or panel creation — that wiring
 * is covered by the ActionService propagation test in
 * agentActions.adversarial.test.ts, same as resolveLaunchWorktree's.
 */
import { describe, expect, it } from "vitest";
import { assertKnownAgentId } from "../useAgentLauncher";

describe("assertKnownAgentId", () => {
  it("accepts a registered built-in agent id", () => {
    expect(() => assertKnownAgentId("claude", true)).not.toThrow();
  });

  it("accepts a dynamically registered plugin/user agent id", () => {
    // Plugin ids are unknown at schema-definition time; the effective registry
    // is what makes them valid, so the guard trusts the resolved flag.
    expect(() => assertKnownAgentId("acme-agent", true)).not.toThrow();
  });

  it("accepts 'terminal' even though it is not a registered agent", () => {
    expect(() => assertKnownAgentId("terminal", false)).not.toThrow();
  });

  it("throws on an unregistered id and names it (#11498)", () => {
    expect(() => assertKnownAgentId("claudee", false)).toThrow("Unknown agent ID 'claudee'");
  });

  it("offers both recovery paths so an MCP client can self-correct", () => {
    expect(() => assertKnownAgentId("nope", false)).toThrow("agent.listAvailable");
    expect(() => assertKnownAgentId("nope", false)).toThrow("terminal.new");
  });

  it("fails closed for browser/dev-preview, which must be handled before this guard", () => {
    // Their dedicated panel branches return earlier in launchAgent. Reaching
    // the guard means one was bypassed — better to throw than to fall through
    // to the generic terminal branch that #11498 was about.
    expect(() => assertKnownAgentId("browser", false)).toThrow("Unknown agent ID 'browser'");
    expect(() => assertKnownAgentId("dev-preview", false)).toThrow(
      "Unknown agent ID 'dev-preview'"
    );
  });
});
