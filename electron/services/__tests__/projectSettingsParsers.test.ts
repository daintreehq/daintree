import { describe, it, expect } from "vitest";
import {
  parseMcpServers,
  parseTerminalSettings,
  parseNotificationOverrides,
} from "../projectSettingsParsers.js";

describe("parseMcpServers", () => {
  it("returns undefined for null/undefined/non-object", () => {
    expect(parseMcpServers(null)).toBeUndefined();
    expect(parseMcpServers(undefined)).toBeUndefined();
    expect(parseMcpServers("string")).toBeUndefined();
    expect(parseMcpServers(42)).toBeUndefined();
    expect(parseMcpServers([])).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    expect(parseMcpServers({})).toBeUndefined();
  });

  it("parses valid MCP server config", () => {
    const result = parseMcpServers({
      myServer: {
        command: "node",
        args: ["server.js"],
        env: { PORT: "3000" },
        cwd: "/path/to/project",
      },
    });
    expect(result).toEqual({
      myServer: {
        command: "node",
        args: ["server.js"],
        env: { PORT: "3000" },
        cwd: "/path/to/project",
      },
    });
  });

  it("skips entries without a valid command", () => {
    const result = parseMcpServers({
      good: { command: "node" },
      bad: { command: "" },
      worse: { command: 123 },
      missing: {},
    });
    expect(result).toEqual({ good: { command: "node" } });
  });

  it("filters non-string args", () => {
    const result = parseMcpServers({
      server: { command: "node", args: ["valid", 42, true, "also-valid"] },
    });
    expect(result!.server.args).toEqual(["valid", "also-valid"]);
  });

  it("filters non-string env values", () => {
    const result = parseMcpServers({
      server: { command: "node", env: { GOOD: "value", BAD: 42 as unknown } },
    });
    expect(result!.server.env).toEqual({ GOOD: "value" });
  });

  it("trims command and cwd", () => {
    const result = parseMcpServers({
      server: { command: "  node  ", cwd: "  /path  " },
    });
    expect(result!.server.command).toBe("node");
    expect(result!.server.cwd).toBe("/path");
  });
});

describe("parseTerminalSettings", () => {
  it("returns undefined for null/undefined/non-object", () => {
    expect(parseTerminalSettings(null)).toBeUndefined();
    expect(parseTerminalSettings(undefined)).toBeUndefined();
    expect(parseTerminalSettings("string")).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    expect(parseTerminalSettings({})).toBeUndefined();
  });

  it("parses valid terminal settings", () => {
    const result = parseTerminalSettings({
      shell: "/bin/zsh",
      shellArgs: ["-l"],
      defaultWorkingDirectory: "/home/user",
      scrollbackLines: 5000,
    });
    expect(result).toEqual({
      shell: "/bin/zsh",
      shellArgs: ["-l"],
      defaultWorkingDirectory: "/home/user",
      scrollbackLines: 5000,
    });
  });

  it("rejects non-absolute shell path", () => {
    const result = parseTerminalSettings({ shell: "zsh" });
    expect(result).toBeUndefined();
  });

  it("rejects non-absolute defaultWorkingDirectory", () => {
    const result = parseTerminalSettings({ defaultWorkingDirectory: "relative/path" });
    expect(result).toBeUndefined();
  });

  it("filters non-string shellArgs", () => {
    const result = parseTerminalSettings({ shellArgs: ["-l", 42 as unknown, true as unknown] });
    expect(result!.shellArgs).toEqual(["-l"]);
  });
});

describe("parseNotificationOverrides", () => {
  it("returns undefined for null/undefined/non-object", () => {
    expect(parseNotificationOverrides(null)).toBeUndefined();
    expect(parseNotificationOverrides(undefined)).toBeUndefined();
    expect(parseNotificationOverrides("string")).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    expect(parseNotificationOverrides({})).toBeUndefined();
  });

  it("parses valid notification overrides", () => {
    const result = parseNotificationOverrides({
      completedEnabled: true,
      waitingEnabled: false,
      soundEnabled: true,
      soundFile: "chime.wav",
    });
    expect(result).toEqual({
      completedEnabled: true,
      waitingEnabled: false,
      soundEnabled: true,
      soundFile: "chime.wav",
    });
  });

  it("rejects invalid soundFile values", () => {
    const result = parseNotificationOverrides({ soundFile: "malicious.wav" });
    expect(result).toBeUndefined();
  });

  it("clamps waitingEscalationDelayMs to valid range", () => {
    const tooLow = parseNotificationOverrides({ waitingEscalationDelayMs: 1000 });
    expect(tooLow!.waitingEscalationDelayMs).toBe(30_000);

    const tooHigh = parseNotificationOverrides({ waitingEscalationDelayMs: 99_999_999 });
    expect(tooHigh!.waitingEscalationDelayMs).toBe(3_600_000);
  });

  it("ignores non-boolean values for boolean fields", () => {
    const result = parseNotificationOverrides({
      completedEnabled: "yes" as unknown,
      waitingEnabled: 1 as unknown,
    });
    expect(result).toBeUndefined();
  });
});
