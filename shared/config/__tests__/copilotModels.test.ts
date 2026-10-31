import { describe, expect, it } from "vitest";
import { getAgentConfig } from "../agentRegistry.js";

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

/** Retired IDs with the day GitHub's changelog deprecated them. */
const RETIRED: Record<string, string> = {
  "gemini-3-pro-preview": "2026-03-26",
  "gpt-5.2": "2026-06-05",
  "gemini-2.5-pro": "2026-07-31",
  "gemini-3.1-pro-preview": "2026-09-01",
  "claude-opus-4.5": "2026-09-01",
  "claude-opus-4.6": "2026-09-01",
  "claude-sonnet-4.5": "2026-09-01",
  // Individual annual-plan subscribers keep it, but the CLI reference doesn't
  // list it, so the picker doesn't offer it.
  "claude-sonnet-4.6": "2026-09-01",
  "gpt-5.4": "2026-10-19",
  "gpt-5.4-mini": "2026-10-19",
  "gpt-5-mini": "2026-10-19",
};

function bundledIds(): string[] {
  return (getAgentConfig("copilot")?.models ?? []).map((m) => m.id);
}

describe("copilot bundled models", () => {
  it("matches the models the Copilot CLI documents as supported", () => {
    expect([...bundledIds()].sort()).toEqual([...DOCUMENTED_2026_10_31].sort());
  });

  it("offers no model GitHub has retired", () => {
    const retired = bundledIds().filter((id) => id in RETIRED);
    expect(retired).toEqual([]);
  });

  it("gives every model a name and label the picker can show", () => {
    for (const m of getAgentConfig("copilot")?.models ?? []) {
      expect(m.name.trim(), m.id).not.toBe("");
      expect(m.shortLabel.trim(), m.id).not.toBe("");
    }
  });
});
