import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS, getBuiltinSlashCommands } from "../slashCommands.js";

describe("BUILTIN_SLASH_COMMANDS registry", () => {
  it("has no duplicate ids", () => {
    const ids = BUILTIN_SLASH_COMMANDS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no duplicate labels", () => {
    const labels = BUILTIN_SLASH_COMMANDS.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("every entry has at least one supportedAgent", () => {
    for (const entry of BUILTIN_SLASH_COMMANDS) {
      expect(entry.supportedAgents.length).toBeGreaterThan(0);
    }
  });
});

describe("getBuiltinSlashCommands", () => {
  it("returns 33 commands for claude", () => {
    expect(getBuiltinSlashCommands("claude")).toHaveLength(33);
  });

  it("returns 27 commands for gemini", () => {
    expect(getBuiltinSlashCommands("gemini")).toHaveLength(27);
  });

  it("returns 22 commands for codex", () => {
    expect(getBuiltinSlashCommands("codex")).toHaveLength(22);
  });

  it("returns empty array for unsupported agents", () => {
    expect(getBuiltinSlashCommands("opencode")).toEqual([]);
    expect(getBuiltinSlashCommands("cursor")).toEqual([]);
  });

  it("stamps agentId correctly on all returned commands", () => {
    for (const agentId of ["claude", "gemini", "codex"] as const) {
      const commands = getBuiltinSlashCommands(agentId);
      for (const cmd of commands) {
        expect(cmd.agentId).toBe(agentId);
      }
    }
  });

  it("sets scope to built-in on all returned commands", () => {
    const commands = getBuiltinSlashCommands("claude");
    for (const cmd of commands) {
      expect(cmd.scope).toBe("built-in");
    }
  });

  it("applies per-agent description overrides for /init", () => {
    const claudeInit = getBuiltinSlashCommands("claude").find((c) => c.label === "/init");
    const codexInit = getBuiltinSlashCommands("codex").find((c) => c.label === "/init");
    const geminiInit = getBuiltinSlashCommands("gemini").find((c) => c.label === "/init");

    expect(claudeInit?.description).toBe("Initialize project configuration");
    expect(codexInit?.description).toBe("Scaffold AGENTS.md instructions");
    expect(geminiInit?.description).toBe("Initialize project configuration");
  });

  it("applies per-agent description overrides for /model", () => {
    const claudeModel = getBuiltinSlashCommands("claude").find((c) => c.label === "/model");
    const codexModel = getBuiltinSlashCommands("codex").find((c) => c.label === "/model");

    expect(claudeModel?.description).toBe("Switch active AI model");
    expect(codexModel?.description).toBe("Switch model or reasoning settings");
  });

  it("applies per-agent description overrides for /clear", () => {
    const claudeClear = getBuiltinSlashCommands("claude").find((c) => c.label === "/clear");
    const geminiClear = getBuiltinSlashCommands("gemini").find((c) => c.label === "/clear");

    expect(claudeClear?.description).toBe("Reset display and attention buffer");
    expect(geminiClear?.description).toBe("Clear the terminal display");
  });

  it("/compact appears for claude and codex but not gemini", () => {
    expect(getBuiltinSlashCommands("claude").some((c) => c.label === "/compact")).toBe(true);
    expect(getBuiltinSlashCommands("codex").some((c) => c.label === "/compact")).toBe(true);
    expect(getBuiltinSlashCommands("gemini").some((c) => c.label === "/compact")).toBe(false);
  });

  it("/compress appears for gemini only", () => {
    expect(getBuiltinSlashCommands("gemini").some((c) => c.label === "/compress")).toBe(true);
    expect(getBuiltinSlashCommands("claude").some((c) => c.label === "/compress")).toBe(false);
    expect(getBuiltinSlashCommands("codex").some((c) => c.label === "/compress")).toBe(false);
  });

  it("/add-dir appears for claude only", () => {
    expect(getBuiltinSlashCommands("claude").some((c) => c.label === "/add-dir")).toBe(true);
    expect(getBuiltinSlashCommands("gemini").some((c) => c.label === "/add-dir")).toBe(false);
    expect(getBuiltinSlashCommands("codex").some((c) => c.label === "/add-dir")).toBe(false);
  });

  it("does not include kind or sourcePath on returned commands", () => {
    const commands = getBuiltinSlashCommands("claude");
    for (const cmd of commands) {
      expect(cmd).not.toHaveProperty("kind");
      expect(cmd).not.toHaveProperty("sourcePath");
    }
  });

  it("no duplicate labels within any agent's results", () => {
    for (const agentId of ["claude", "gemini", "codex"] as const) {
      const labels = getBuiltinSlashCommands(agentId).map((c) => c.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});
