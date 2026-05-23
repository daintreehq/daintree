import { describe, expect, it } from "vitest";
import { resolveAgentLaunchBaseCommand } from "../useAgentLauncher";
import type { AgentCliDetail } from "@shared/types";

function detail(overrides: Partial<AgentCliDetail>): AgentCliDetail {
  return {
    state: "ready",
    resolvedPath: "/opt/bin/claude",
    via: "which",
    ...overrides,
  };
}

const isWindows = process.platform === "win32";

describe("resolveAgentLaunchBaseCommand", () => {
  it("uses the availability-resolved executable path when the CLI is ready", () => {
    expect(
      resolveAgentLaunchBaseCommand("claude", detail({ resolvedPath: "/tmp/bin/claude" }))
    ).toBe("/tmp/bin/claude");
  });

  it("quotes resolved paths that need shell escaping", () => {
    if (isWindows) {
      // On Windows the resolved path is wrapped for PowerShell invocation
      expect(
        resolveAgentLaunchBaseCommand(
          "claude",
          detail({ resolvedPath: "C:\\path\\Daintree Test\\claude.cmd" })
        )
      ).toBe('& "C:\\path\\Daintree Test\\claude.cmd"');
    } else {
      expect(
        resolveAgentLaunchBaseCommand(
          "claude",
          detail({ resolvedPath: "/tmp/Daintree Test/bin/claude" })
        )
      ).toBe("'/tmp/Daintree Test/bin/claude'");
    }
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
});
