import { describe, it, expect } from "vitest";
import { buildResumeCommand, buildAgentLaunchFlags } from "../agentSettings.js";

describe("buildResumeCommand", () => {
  it("builds claude resume command with --resume flag", () => {
    expect(buildResumeCommand("claude", "abc-123")).toBe("claude --resume abc-123");
  });

  it("builds gemini resume command with --resume flag", () => {
    expect(buildResumeCommand("gemini", "abc-123")).toBe("gemini --resume abc-123");
  });

  it("builds codex resume command with subcommand (no dash)", () => {
    const cmd = buildResumeCommand("codex", "abc-123");
    expect(cmd).toBe("codex resume abc-123");
    expect(cmd).not.toContain("--resume");
  });

  it("builds opencode resume command with -s flag", () => {
    expect(buildResumeCommand("opencode", "ses_abc")).toBe("opencode -s ses_abc");
  });

  it("returns undefined for unknown agent", () => {
    expect(buildResumeCommand("unknown-agent", "abc")).toBeUndefined();
  });

  it("returns undefined for agent without resume config", () => {
    // User-defined agents without resume config should return undefined
    expect(buildResumeCommand("my-custom-agent", "abc")).toBeUndefined();
  });

  it("escapes session IDs with special characters", () => {
    const cmd = buildResumeCommand("claude", "id with spaces");
    expect(cmd).toBeDefined();
    expect(cmd).toContain("--resume");
    // The session ID should be shell-escaped
    expect(cmd).not.toBe("claude --resume id with spaces");
  });

  it("prepends launch flags before resume args for claude", () => {
    const cmd = buildResumeCommand("claude", "sess-123", ["--dangerously-skip-permissions"]);
    expect(cmd).toBe("claude --dangerously-skip-permissions --resume sess-123");
  });

  it("prepends launch flags before resume args for codex", () => {
    const cmd = buildResumeCommand("codex", "sess-456", [
      "--no-alt-screen",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(cmd).toBe(
      "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume sess-456"
    );
  });

  it("prepends launch flags before resume args for gemini", () => {
    const cmd = buildResumeCommand("gemini", "sess-789", ["--yolo"]);
    expect(cmd).toBe("gemini --yolo --resume sess-789");
  });

  it("handles empty launch flags array like no flags", () => {
    expect(buildResumeCommand("claude", "abc-123", [])).toBe("claude --resume abc-123");
  });

  it("handles undefined launch flags like no flags", () => {
    expect(buildResumeCommand("claude", "abc-123", undefined)).toBe("claude --resume abc-123");
  });

  it("escapes non-flag launch flag values", () => {
    const cmd = buildResumeCommand("claude", "abc-123", [
      "--dangerously-skip-permissions",
      "some value",
    ]);
    expect(cmd).toBeDefined();
    expect(cmd).toContain("--dangerously-skip-permissions");
    // Non-flag value should be shell-escaped
    expect(cmd).not.toContain(" some value ");
  });
});

describe("buildAgentLaunchFlags", () => {
  it("returns empty array for default settings with no dangerous mode", () => {
    const flags = buildAgentLaunchFlags({}, "claude");
    expect(flags).toEqual([]);
  });

  it("includes dangerous args when enabled", () => {
    const flags = buildAgentLaunchFlags(
      { dangerousEnabled: true, dangerousArgs: "--dangerously-skip-permissions" },
      "claude"
    );
    expect(flags).toContain("--dangerously-skip-permissions");
  });

  it("includes custom flags", () => {
    const flags = buildAgentLaunchFlags({ customFlags: "--verbose --debug" }, "claude");
    expect(flags).toContain("--verbose");
    expect(flags).toContain("--debug");
  });

  it("includes inline mode flag for codex when enabled", () => {
    const flags = buildAgentLaunchFlags({ inlineMode: true }, "codex");
    expect(flags).toContain("--no-alt-screen");
  });

  it("includes inline mode flag for codex by default (inlineMode not explicitly false)", () => {
    const flags = buildAgentLaunchFlags({}, "codex");
    expect(flags).toContain("--no-alt-screen");
  });

  it("excludes inline mode flag when inlineMode is false", () => {
    const flags = buildAgentLaunchFlags({ inlineMode: false }, "codex");
    expect(flags).not.toContain("--no-alt-screen");
  });

  it("does not include clipboard directory", () => {
    const flags = buildAgentLaunchFlags({ shareClipboardDirectory: true }, "gemini");
    expect(flags).not.toContain("--include-directories");
  });

  it("combines dangerous args, custom flags, and inline mode", () => {
    const flags = buildAgentLaunchFlags(
      {
        dangerousEnabled: true,
        dangerousArgs: "--dangerously-bypass-approvals-and-sandbox",
        customFlags: "--verbose",
        inlineMode: true,
      },
      "codex"
    );
    expect(flags).toContain("--no-alt-screen");
    expect(flags).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(flags).toContain("--verbose");
  });
});
