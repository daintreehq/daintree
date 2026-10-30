import { describe, it, expect } from "vitest";
import { launchEnv } from "./install-local.mjs";

describe("launchEnv", () => {
  it("drops the Claude session markers of an agent running the install", () => {
    const env = launchEnv({
      PATH: "/usr/bin",
      HOME: "/Users/u",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "75d39610-ed78-48db-a1d1-1dc2a12ddc6d",
      CLAUDE_PID: "85234",
      AI_AGENT: "claude-code",
    });

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/u" });
  });

  it("keeps the user's own Claude Code configuration", () => {
    const env = { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "20000" };

    expect(launchEnv(env)).toEqual(env);
  });
});
