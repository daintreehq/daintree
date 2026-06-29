import { describe, expect, it } from "vitest";
import { DEFAULT_DANGEROUS_ARGS } from "@shared/types/agentSettings";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";

/**
 * Tests for the skip-permissions toggle gating logic.
 * The toggle should only appear for agents that have a DEFAULT_DANGEROUS_ARGS entry.
 */
describe("Skip permissions toggle gating", () => {
  it("DEFAULT_DANGEROUS_ARGS has entries for claude, gemini, codex, cursor, interpreter, amp", () => {
    expect(DEFAULT_DANGEROUS_ARGS).toHaveProperty("claude", "--dangerously-skip-permissions");
    expect(DEFAULT_DANGEROUS_ARGS).toHaveProperty("gemini", "--yolo");
    expect(DEFAULT_DANGEROUS_ARGS).toHaveProperty(
      "codex",
      "--dangerously-bypass-approvals-and-sandbox"
    );
    expect(DEFAULT_DANGEROUS_ARGS).toHaveProperty("cursor", "--force");
    expect(DEFAULT_DANGEROUS_ARGS).toHaveProperty("interpreter", "--auto_run");
    expect(DEFAULT_DANGEROUS_ARGS).toHaveProperty("amp", "--dangerously-allow-all");
  });

  it("opencode, goose, mistral, and copilot have no DEFAULT_DANGEROUS_ARGS entry", () => {
    // opencode: --dangerously-skip-permissions exists only on the run
    // subcommand, not the TUI launch. mistral routes auto-approve through
    // the --agent presets. copilot opts out via supports.permissionBypass.
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("opencode");
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("goose");
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("mistral");
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("copilot");
  });

  it("gating expression matches expected agents", () => {
    // This mirrors the gating logic in AgentCliStep.tsx, which operates on the
    // wizard's selectable agents (LAUNCHABLE_AGENT_IDS). Assistant-only agents
    // never reach the wizard, so they're excluded from the gating universe.
    // agentsWithDangerousToggle = selectedAgentIds.filter(id => (DEFAULT_DANGEROUS_ARGS[id] ?? "") !== "")
    const agentsWithToggle = LAUNCHABLE_AGENT_IDS.filter(
      (id) => (DEFAULT_DANGEROUS_ARGS[id] ?? "") !== ""
    );
    const agentsWithoutToggle = LAUNCHABLE_AGENT_IDS.filter(
      (id) => (DEFAULT_DANGEROUS_ARGS[id] ?? "") === ""
    );

    expect(agentsWithToggle).toEqual([
      "claude",
      "aider",
      "gemini",
      "antigravity",
      "codex",
      "grok",
      "cursor",
      "amp",
      "crush",
      "qwen",
      "kimi",
      "interpreter",
      "kiro",
    ]);
    expect(agentsWithoutToggle).toEqual(["opencode", "copilot", "goose", "mistral"]);
  });

  it("all dangerous args are non-empty strings starting with --", () => {
    for (const [agentId, arg] of Object.entries(DEFAULT_DANGEROUS_ARGS)) {
      expect(arg, `${agentId} dangerous arg`).toMatch(/^--\S+/);
    }
  });
});
