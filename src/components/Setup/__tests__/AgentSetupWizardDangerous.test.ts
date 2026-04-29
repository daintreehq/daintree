import { describe, expect, it } from "vitest";
import { DEFAULT_DANGEROUS_ARGS } from "@shared/types/agentSettings";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";

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

  it("opencode, kiro, goose, crush, qwen, mistral, kimi, and aider have no DEFAULT_DANGEROUS_ARGS entry", () => {
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("opencode");
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("kiro");
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("goose");
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("crush");
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("qwen");
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("mistral");
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("kimi");
    expect(DEFAULT_DANGEROUS_ARGS).not.toHaveProperty("aider");
  });

  it("gating expression matches expected agents", () => {
    // This mirrors the gating logic in AgentCliStep.tsx:
    // agentsWithDangerousToggle = selectedAgentIds.filter(id => (DEFAULT_DANGEROUS_ARGS[id] ?? "") !== "")
    const agentsWithToggle = BUILT_IN_AGENT_IDS.filter(
      (id) => (DEFAULT_DANGEROUS_ARGS[id] ?? "") !== ""
    );
    const agentsWithoutToggle = BUILT_IN_AGENT_IDS.filter(
      (id) => (DEFAULT_DANGEROUS_ARGS[id] ?? "") === ""
    );

    expect(agentsWithToggle).toEqual(["claude", "gemini", "codex", "cursor", "interpreter", "amp"]);
    expect(agentsWithoutToggle).toEqual([
      "opencode",
      "kiro",
      "copilot",
      "goose",
      "crush",
      "qwen",
      "mistral",
      "kimi",
      "aider",
    ]);
  });

  it("all dangerous args are non-empty strings starting with --", () => {
    for (const [agentId, arg] of Object.entries(DEFAULT_DANGEROUS_ARGS)) {
      expect(arg, `${agentId} dangerous arg`).toMatch(/^--\S+/);
    }
  });
});
