import { afterEach, describe, expect, it } from "vitest";
import {
  ASSISTANT_HANDOFF_MAX_LENGTH,
  AssistantHandoffPromptSchema,
  handoffFitsLaunchCommand,
  isSendableHandoff,
  isUsableHandoff,
} from "../assistantHandoff";
import { setAgentCommandDialectResolver } from "../shellEscape";

afterEach(() => setAgentCommandDialectResolver(null));

describe("assistant hand-offs (#18140)", () => {
  it("carries line breaks and tabs, and no other control character", () => {
    expect(isSendableHandoff("Continue:\r\n- tests pass\n\tdocs next")).toBe(true);
    for (const text of ["go\u001b[2J", "go\rnow", "go\u0000", "go\u007f"]) {
      expect(isSendableHandoff(text)).toBe(false);
      expect(AssistantHandoffPromptSchema.safeParse(text).success).toBe(false);
    }
  });

  it("refuses a blank hand-off, one read as an option, and one past the cap", () => {
    setAgentCommandDialectResolver(() => "posix");
    expect(isUsableHandoff("Continue from here")).toBe(true);
    for (const text of ["", " \t\n", "-p go", "  --yolo"])
      expect(isUsableHandoff(text)).toBe(false);
    expect(isUsableHandoff("a".repeat(ASSISTANT_HANDOFF_MAX_LENGTH))).toBe(true);
    expect(isUsableHandoff("a".repeat(ASSISTANT_HANDOFF_MAX_LENGTH + 1))).toBe(false);
  });

  it("refuses on Windows a hand-off its launch command couldn't carry, and nowhere else", () => {
    const long = "word ".repeat(2_000);
    setAgentCommandDialectResolver(() => "posix");
    expect(handoffFitsLaunchCommand(long)).toBe(true);

    setAgentCommandDialectResolver(() => "windows");
    expect(handoffFitsLaunchCommand("word ".repeat(1_000))).toBe(true);
    expect(handoffFitsLaunchCommand(long)).toBe(false);
    expect(isUsableHandoff(long)).toBe(false);
    // Quoting doubles each apostrophe, twice over, so fewer of them fit.
    expect(handoffFitsLaunchCommand("'".repeat(2_000))).toBe(false);
  });
});
