import { describe, expect, it } from "vitest";
import { stripCommandArgs } from "../stripCommandArgs.js";

const CLAUDE_AUTO = ["--permission-mode", "auto"];

describe("stripCommandArgs", () => {
  it("removes an option and its value however the command spelled them", () => {
    for (const command of [
      "claude --permission-mode auto --model opus",
      "claude --permission-mode 'auto' --model opus",
      'claude --permission-mode "auto" --model opus',
      "claude --permission-mode=auto --model opus",
    ]) {
      expect(stripCommandArgs(command, CLAUDE_AUTO), command).toBe("claude --model opus");
    }
  });

  it("removes a lone flag with any =value after it, every time it appears", () => {
    expect(
      stripCommandArgs("codex --approve-for-me -c a=b --approve-for-me=true", ["--approve-for-me"])
    ).toBe("codex -c a=b");
  });

  it("leaves a quoted prompt that mentions the option untouched", () => {
    const command = "claude --model opus 'Explain --permission-mode auto to me'";
    expect(stripCommandArgs(command, CLAUDE_AUTO)).toBe(command);
  });

  it("leaves another value of the same option alone", () => {
    const command = "claude --permission-mode plan";
    expect(stripCommandArgs(command, CLAUDE_AUTO)).toBe(command);
  });

  it("returns the command unchanged when there is nothing to strip", () => {
    expect(stripCommandArgs("claude  --model opus", [])).toBe("claude  --model opus");
  });
});
