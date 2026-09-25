// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentLaunchBaseCommand } from "@/utils/agentLaunchCommand";
import type { AgentCliDetail } from "@shared/types";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
  isWindows: () => false,
  isLinux: () => false,
}));

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

describe("a leading ~ launching on a Linux host from a macOS client", () => {
  afterEach(() => {
    _resetHostPlatformForTests();
    delete window.__DAINTREE_HOST_ID__;
  });

  function remoteLinuxHost(homeDir: string | null) {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    setHostPlatformInfo({ platform: "linux", homeDir, tmpDir: "/tmp" });
  }

  it("expands the tilde with the host's home before quoting", () => {
    remoteLinuxHost("/home/greg");
    expect(resolveAgentLaunchBaseCommand("claude", detail({ resolvedPath: "~/bin/claude" }))).toBe(
      "/home/greg/bin/claude"
    );
  });

  it("quotes the expanded path when it holds spaces or apostrophes", () => {
    remoteLinuxHost("/home/o'neil");
    expect(
      resolveAgentLaunchBaseCommand("claude", detail({ resolvedPath: "~/my tools/claude" }))
    ).toBe(String.raw`'/home/o'\''neil/my tools/claude'`);
  });

  it("leaves the tilde to the host's shell when its home isn't known yet", () => {
    remoteLinuxHost(null);
    expect(
      resolveAgentLaunchBaseCommand("claude", detail({ resolvedPath: "~/my tools/claude" }))
    ).toBe(`~/'my tools/claude'`);
  });

  it("never expands another user's home or a tilde mid-path", () => {
    remoteLinuxHost("/home/greg");
    expect(resolveAgentLaunchBaseCommand("claude", detail({ resolvedPath: "~bob/claude" }))).toBe(
      "'~bob/claude'"
    );
    expect(resolveAgentLaunchBaseCommand("claude", detail({ resolvedPath: "/opt/~/claude" }))).toBe(
      "'/opt/~/claude'"
    );
  });

  it("builds a local window's command exactly as before", () => {
    setHostPlatformInfo({ platform: "darwin", homeDir: "/Users/greg", tmpDir: "/tmp" });
    expect(resolveAgentLaunchBaseCommand("claude", detail({ resolvedPath: "~/bin/claude" }))).toBe(
      "'~/bin/claude'"
    );
  });
});
