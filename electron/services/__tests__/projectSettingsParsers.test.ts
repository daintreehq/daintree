import { describe, it, expect } from "vitest";
import { parseTerminalSettings, parseNotificationOverrides } from "../projectSettingsParsers.js";

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

  it("parses valid notification overrides with per-event sound fields", () => {
    const result = parseNotificationOverrides({
      completedEnabled: true,
      waitingEnabled: false,
      soundEnabled: true,
      completedSoundFile: "chime.wav",
      waitingSoundFile: "waiting.wav",
      escalationSoundFile: "ping.wav",
    });
    expect(result).toEqual({
      completedEnabled: true,
      waitingEnabled: false,
      soundEnabled: true,
      completedSoundFile: "chime.wav",
      waitingSoundFile: "waiting.wav",
      escalationSoundFile: "ping.wav",
    });
  });

  it("maps legacy soundFile to completedSoundFile for backwards compat", () => {
    const result = parseNotificationOverrides({ soundFile: "chime.wav" });
    expect(result).toEqual({ completedSoundFile: "chime.wav" });
  });

  it("prefers completedSoundFile over legacy soundFile", () => {
    const result = parseNotificationOverrides({
      completedSoundFile: "ping.wav",
      soundFile: "chime.wav",
    });
    expect(result).toEqual({ completedSoundFile: "ping.wav" });
  });

  it("rejects invalid sound file values", () => {
    const result = parseNotificationOverrides({ completedSoundFile: "malicious.wav" });
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
