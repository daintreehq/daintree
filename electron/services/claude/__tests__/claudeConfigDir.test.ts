import { describe, expect, it } from "vitest";
import os from "os";
import path from "path";
import { resolveLaunchClaudeConfigDir } from "../claudeConfigDir.js";

describe("resolveLaunchClaudeConfigDir", () => {
  it("names the home store when the env sets no override", () => {
    expect(resolveLaunchClaudeConfigDir({ PATH: "/usr/bin" })).toBe(
      path.join(os.homedir(), ".claude")
    );
  });

  it("names the folder an account launch put in the env", () => {
    const accountDir = path.resolve(os.tmpdir(), "accounts", "work");
    expect(resolveLaunchClaudeConfigDir({ CLAUDE_CONFIG_DIR: accountDir })).toBe(accountDir);
  });

  it("normalises the folder it names", () => {
    const accountDir = path.resolve(os.tmpdir(), "accounts", "work");
    expect(
      resolveLaunchClaudeConfigDir({
        CLAUDE_CONFIG_DIR: `  ${path.join(accountDir, "..", "work")}${path.sep}  `,
      })
    ).toBe(accountDir);
  });

  it.each([
    ["empty", ""],
    ["only whitespace", "   "],
    ["relative", "accounts/work"],
  ])("names no store for an override that is %s", (_label, value) => {
    expect(resolveLaunchClaudeConfigDir({ CLAUDE_CONFIG_DIR: value })).toBeUndefined();
  });

  it("treats an unset entry as no override", () => {
    expect(resolveLaunchClaudeConfigDir({ CLAUDE_CONFIG_DIR: undefined })).toBe(
      path.join(os.homedir(), ".claude")
    );
  });

  it.runIf(process.platform === "win32")(
    "reads the override whatever its casing, as Windows applies it",
    () => {
      expect(resolveLaunchClaudeConfigDir({ claude_config_dir: "C:\\accounts\\work" })).toBe(
        "C:\\accounts\\work"
      );
    }
  );

  it.runIf(process.platform !== "win32")("ignores a differently cased name on POSIX", () => {
    expect(resolveLaunchClaudeConfigDir({ claude_config_dir: "/accounts/work" })).toBe(
      path.join(os.homedir(), ".claude")
    );
  });
});
