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
  it("should return default agent when it matches an available agent", () => {
    const availability: CliAvailability = {
      claude: "ready",
      gemini: "missing",
      codex: "missing",
      opencode: "missing",
    };
    expect(getDefaultAgentId("claude", undefined, availability)).toBe("claude");
  });

  it("should prioritize default agent over default selection", () => {
    const availability: CliAvailability = {
      claude: "ready",
      gemini: "ready",
      codex: "missing",
      opencode: "missing",
    };
    expect(getDefaultAgentId("gemini", "claude", availability)).toBe("gemini");
  });

  it("should fall back to default selection when default agent is not available", () => {
    const availability: CliAvailability = {
      claude: "ready",
      gemini: "missing",
      codex: "missing",
      opencode: "missing",
    };
    expect(getDefaultAgentId("gemini", "claude", availability)).toBe("claude");
  });

  it("should fall back to first available agent when neither default is available", () => {
    const availability: CliAvailability = {
      claude: "ready",
      gemini: "missing",
      codex: "missing",
      opencode: "missing",
    };
    expect(getDefaultAgentId("gemini", "codex", availability)).toBe("claude");
  });

  it("should fall back to first available agent when no defaults", () => {
    const availability: CliAvailability = {
      claude: "missing",
      gemini: "ready",
      codex: "missing",
      opencode: "missing",
    };
    expect(getDefaultAgentId(undefined, undefined, availability)).toBe("gemini");
  });

  it("should return null when no agents are available", () => {
    const availability: CliAvailability = {
      claude: "missing",
      gemini: "missing",
      codex: "missing",
      opencode: "missing",
    };
    expect(getDefaultAgentId(undefined, undefined, availability)).toBeNull();
  });

  it("should prioritize agents in order: claude, gemini, codex, opencode", () => {
    const availability1: CliAvailability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
      opencode: "ready",
    };
    expect(getDefaultAgentId(undefined, undefined, availability1)).toBe("claude");

    const availability2: CliAvailability = {
      claude: "missing",
      gemini: "ready",
      codex: "ready",
      opencode: "ready",
    };
    expect(getDefaultAgentId(undefined, undefined, availability2)).toBe("gemini");

    const availability3: CliAvailability = {
      claude: "missing",
      gemini: "missing",
      codex: "ready",
      opencode: "ready",
    };
    expect(getDefaultAgentId(undefined, undefined, availability3)).toBe("codex");

    const availability4: CliAvailability = {
      claude: "missing",
      gemini: "missing",
      codex: "missing",
      opencode: "ready",
    };
    expect(getDefaultAgentId(undefined, undefined, availability4)).toBe("opencode");
  });

  it("should ignore default agent if it's not a valid agent", () => {
    const availability: CliAvailability = {
      claude: "ready",
      gemini: "missing",
      codex: "missing",
      opencode: "missing",
    };
    expect(getDefaultAgentId("invalid-agent" as any, undefined, availability)).toBe("claude");
  });

  it("should handle terminal and browser in default selection gracefully", () => {
    const availability: CliAvailability = {
      claude: "missing",
      gemini: "ready",
      codex: "missing",
      opencode: "missing",
    };
    expect(getDefaultAgentId(undefined, "terminal", availability)).toBe("gemini");
    expect(getDefaultAgentId(undefined, "browser", availability)).toBe("gemini");
  });
});
