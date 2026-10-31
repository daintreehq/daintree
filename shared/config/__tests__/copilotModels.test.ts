import { describe, expect, it } from "vitest";
import { getAgentConfig, isRetiredAgentModel } from "../agentRegistry.js";

// Copilot's bundled list is the only source of its model IDs (multi-provider,
// no CLI catalog), and `copilot --model <retired id>` exits with an error. When
// GitHub retires or adds a model this file changes with the registry, so the
// drift is a reviewed edit rather than a silent one.

/**
 * "Supported models" of the Copilot CLI reference, as of 2026-10-31
 * (docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).
 */
const DOCUMENTED_2026_10_31 = [
  "claude-sonnet-5.5",
  "claude-opus-5.5",
  "claude-haiku-5.5",
  "claude-haiku-4.5",
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-5.3-codex",
  "gemini-3.8-flash",
];

function bundledIds(): string[] {
  return (getAgentConfig("copilot")?.models ?? []).map((m) => m.id);
}

describe("copilot bundled models", () => {
  it("matches the models the Copilot CLI documents as supported", () => {
    expect([...bundledIds()].sort()).toEqual([...DOCUMENTED_2026_10_31].sort());
  });

  it("offers no model it declares retired, so a saved offered model is never dropped", () => {
    const retired = bundledIds().filter((id) => isRetiredAgentModel("copilot", id));
    expect(retired).toEqual([]);
  });

  it("dates every retirement it declares", () => {
    for (const [id, retiredOn] of Object.entries(getAgentConfig("copilot")?.retiredModels ?? {})) {
      expect(retiredOn, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(retiredOn)), id).toBe(false);
    }
  });

  it("gives every model a name and label the picker can show", () => {
    for (const m of getAgentConfig("copilot")?.models ?? []) {
      expect(m.name.trim(), m.id).not.toBe("");
      expect(m.shortLabel.trim(), m.id).not.toBe("");
    }
  });
});
