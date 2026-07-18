import { describe, expect, it } from "vitest";
import { resolveAgentLaunchBaseCommand } from "@/utils/agentLaunchCommand";
import type { AgentCliDetail } from "@shared/types";

function detail(overrides: Partial<AgentCliDetail>): AgentCliDetail {
  return {
    state: "ready",
    resolvedPath: "/opt/bin/claude",
    via: "which",
    ...overrides,
  };
}

describe("resolveAgentLaunchBaseCommand", () => {
  it("uses the availability-resolved executable path when the CLI is ready", () => {
    expect(
      resolveAgentLaunchBaseCommand("claude", detail({ resolvedPath: "/tmp/bin/claude" }), "posix")
    ).toBe("/tmp/bin/claude");
  });

  it("quotes resolved paths that need shell escaping", () => {
    expect(
      resolveAgentLaunchBaseCommand(
        "claude",
        detail({ resolvedPath: "/tmp/Daintree Test/bin/claude" }),
        "posix"
      )
    ).toBe("'/tmp/Daintree Test/bin/claude'");
  });

  it("uses PowerShell call syntax for resolved Windows executable paths", () => {
    expect(
      resolveAgentLaunchBaseCommand(
        "claude",
        detail({ resolvedPath: String.raw`C:\npm\prefix\claude.cmd` }),
        "windows"
      )
    ).toBe(String.raw`& 'C:\npm\prefix\claude.cmd'`);
  });

  it("escapes single quotes in resolved Windows executable paths", () => {
    expect(
      resolveAgentLaunchBaseCommand(
        "claude",
        detail({ resolvedPath: String.raw`C:\Tools\Daintree's Bin\claude.cmd` }),
        "windows"
      )
    ).toBe(String.raw`& 'C:\Tools\Daintree''s Bin\claude.cmd'`);
  });

  it("falls back to the registry command when the detail is missing or not ready", () => {
    expect(resolveAgentLaunchBaseCommand("claude", undefined)).toBe("claude");
    expect(
      resolveAgentLaunchBaseCommand(
        "claude",
        detail({ state: "missing", resolvedPath: null, via: null })
      )
    ).toBe("claude");
  });

  it("passes a bare PATH registry command through unchanged (built-in agents)", () => {
    // No separator => not a path => never quoted, preserving existing behavior.
    expect(resolveAgentLaunchBaseCommand("acme-cli", undefined, "posix")).toBe("acme-cli");
  });

  it("quotes a plugin-contributed absolute command path with spaces (#10560)", () => {
    // A ./-relative manifest command resolves to an absolute path that may live
    // under a spaced dir (e.g. macOS "Application Support"); it must be quoted so
    // the space doesn't split the spawned command string.
    expect(
      resolveAgentLaunchBaseCommand(
        "/Users/x/Application Support/Daintree/plugins/acme/bin/agent",
        undefined,
        "posix"
      )
    ).toBe("'/Users/x/Application Support/Daintree/plugins/acme/bin/agent'");
  });

  it("leaves a space-free absolute command path unquoted (#10560)", () => {
    expect(resolveAgentLaunchBaseCommand("/plugins/acme/bin/agent", undefined, "posix")).toBe(
      "/plugins/acme/bin/agent"
    );
  });

  it("uses PowerShell call syntax for a plugin-contributed Windows command path (#10560)", () => {
    expect(
      resolveAgentLaunchBaseCommand(String.raw`C:\plugins\acme\bin\agent.cmd`, undefined, "windows")
    ).toBe(String.raw`& 'C:\plugins\acme\bin\agent.cmd'`);
  });
});
