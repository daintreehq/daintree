import { describe, it, expect } from "vitest";
import { PROJECT_EXPLANATION_PROMPT, getDefaultAgentId } from "../projectExplanationPrompt";
import type { CliAvailability } from "@shared/types";

describe("PROJECT_EXPLANATION_PROMPT", () => {
  it("should contain key sections", () => {
    expect(PROJECT_EXPLANATION_PROMPT).toContain("Project Name & Purpose");
    expect(PROJECT_EXPLANATION_PROMPT).toContain("Tech Stack");
    expect(PROJECT_EXPLANATION_PROMPT).toContain("Architecture");
    expect(PROJECT_EXPLANATION_PROMPT).toContain("Quick Start");
  });

  it("should be a non-empty string", () => {
    expect(PROJECT_EXPLANATION_PROMPT).toBeTruthy();
    expect(typeof PROJECT_EXPLANATION_PROMPT).toBe("string");
    expect(PROJECT_EXPLANATION_PROMPT.length).toBeGreaterThan(0);
  });
});

describe("getDefaultAgentId", () => {
  it("should return default selection when it matches an available agent", () => {
    const availability: CliAvailability = {
      claude: true,
      gemini: false,
      codex: false,
      opencode: false,
    };
    expect(getDefaultAgentId("claude", availability)).toBe("claude");
  });

  it("should fall back to first available agent when default selection is not available", () => {
    const availability: CliAvailability = {
      claude: true,
      gemini: false,
      codex: false,
      opencode: false,
    };
    expect(getDefaultAgentId("gemini", availability)).toBe("claude");
  });

  it("should fall back to first available agent when no default selection", () => {
    const availability: CliAvailability = {
      claude: false,
      gemini: true,
      codex: false,
      opencode: false,
    };
    expect(getDefaultAgentId(undefined, availability)).toBe("gemini");
  });

  it("should return null when no agents are available", () => {
    const availability: CliAvailability = {
      claude: false,
      gemini: false,
      codex: false,
      opencode: false,
    };
    expect(getDefaultAgentId(undefined, availability)).toBeNull();
  });

  it("should prioritize agents in order: claude, gemini, codex, opencode", () => {
    const availability1: CliAvailability = {
      claude: true,
      gemini: true,
      codex: true,
      opencode: true,
    };
    expect(getDefaultAgentId(undefined, availability1)).toBe("claude");

    const availability2: CliAvailability = {
      claude: false,
      gemini: true,
      codex: true,
      opencode: true,
    };
    expect(getDefaultAgentId(undefined, availability2)).toBe("gemini");

    const availability3: CliAvailability = {
      claude: false,
      gemini: false,
      codex: true,
      opencode: true,
    };
    expect(getDefaultAgentId(undefined, availability3)).toBe("codex");

    const availability4: CliAvailability = {
      claude: false,
      gemini: false,
      codex: false,
      opencode: true,
    };
    expect(getDefaultAgentId(undefined, availability4)).toBe("opencode");
  });

  it("should ignore default selection if it's not a valid agent", () => {
    const availability: CliAvailability = {
      claude: true,
      gemini: false,
      codex: false,
      opencode: false,
    };
    expect(getDefaultAgentId("invalid-agent", availability)).toBe("claude");
  });

  it("should handle terminal and browser in default selection gracefully", () => {
    const availability: CliAvailability = {
      claude: false,
      gemini: true,
      codex: false,
      opencode: false,
    };
    expect(getDefaultAgentId("terminal", availability)).toBe("gemini");
    expect(getDefaultAgentId("browser", availability)).toBe("gemini");
  });
});
