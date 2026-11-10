import { describe, expect, it } from "vitest";
import { rebaseAgentLaunchCommand } from "../agentLaunchCommand.js";

describe("rebaseAgentLaunchCommand (#16399)", () => {
  const base = "/opt/chosen/claude";

  it.each([
    ["a bare registry command", "claude --model opus", "/opt/chosen/claude --model opus"],
    ["a resolved path", "/usr/local/bin/claude --resume s-1", "/opt/chosen/claude --resume s-1"],
    [
      "a quoted path with a space and an escaped quote",
      "'/Users/o'\\''brien/my tools/claude' --model opus",
      "/opt/chosen/claude --model opus",
    ],
    [
      "a home-relative path",
      "~/'my tools'/claude -p 'hi there'",
      "/opt/chosen/claude -p 'hi there'",
    ],
    ["the executable alone", "'/old copy/claude'", "/opt/chosen/claude"],
    [
      "PowerShell's call form",
      "& 'C:\\Tools\\claude.cmd' --model opus",
      "/opt/chosen/claude --model opus",
    ],
    [
      "PowerShell's call form with a doubled quote",
      "& 'C:\\O''Brien\\claude.exe' -p 'x'",
      "/opt/chosen/claude -p 'x'",
    ],
    ["a Windows wrapper in any case", "& 'C:\\npm\\CLAUDE.CMD'", "/opt/chosen/claude"],
  ])(
    "starts %s with the given executable, keeping the rest verbatim",
    (_label, command, expected) => {
      expect(rebaseAgentLaunchCommand(command, "claude", base)).toBe(expected);
    }
  );

  it.each([
    ["a wrapper", "ccr code --model opus"],
    ["a launcher that runs the agent", "npx claude --model opus"],
    ["another agent", "/usr/local/bin/codex --model o3"],
    ["a name that only starts like the agent", "/usr/local/bin/claude-dev --x"],
    ["an unterminated quote", "'/usr/local/bin/claude --x"],
    ["a double-quoted executable Daintree never writes", '"/usr/local/bin/claude" --x'],
    ["PowerShell's form left open", "& 'C:\\Tools\\claude.cmd --x"],
    ["PowerShell's form run into the next word", "& 'C:\\Tools\\claude.cmd'--x"],
    ["nothing at all", ""],
  ])("leaves %s alone", (_label, command) => {
    expect(rebaseAgentLaunchCommand(command, "claude", base)).toBe(command);
  });

  it("rewrites an absolute plugin command only where it names that very file", () => {
    const registry = "/plugins/acme/bin/agent";
    expect(rebaseAgentLaunchCommand("/plugins/acme/bin/agent --x", registry, "/new/agent")).toBe(
      "/new/agent --x"
    );
    expect(rebaseAgentLaunchCommand("/elsewhere/agent --x", registry, "/new/agent")).toBe(
      "/elsewhere/agent --x"
    );
  });
});
