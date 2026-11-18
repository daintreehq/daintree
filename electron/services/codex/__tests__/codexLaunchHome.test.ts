import { describe, expect, it } from "vitest";
import os from "os";
import path from "path";
import { resolveLaunchCodexHome } from "../codexLaunchHome.js";

describe("resolveLaunchCodexHome", () => {
  const fallback = path.join(os.homedir(), ".codex");

  it("names Codex's own home when the env sets none", () => {
    expect(resolveLaunchCodexHome({ PATH: "/usr/bin" })).toBe(fallback);
    expect(resolveLaunchCodexHome({ CODEX_HOME: undefined })).toBe(fallback);
  });

  it("names Codex's own home for an empty value, which Codex takes as unset", () => {
    expect(resolveLaunchCodexHome({ CODEX_HOME: "" })).toBe(fallback);
  });

  it("names the home an account launch put in the env, normalised", () => {
    const accountHome = path.resolve(os.tmpdir(), "accounts", "codex-work");
    const { sep } = path;
    expect(resolveLaunchCodexHome({ CODEX_HOME: accountHome })).toBe(accountHome);
    expect(
      resolveLaunchCodexHome({ CODEX_HOME: `${accountHome}${sep}..${sep}codex-work${sep}` })
    ).toBe(accountHome);
  });

  it("keeps a value as the pane gets it, untrimmed", () => {
    const spaced = path.resolve(os.tmpdir(), "accounts", "work ");
    expect(resolveLaunchCodexHome({ CODEX_HOME: spaced })).toBe(spaced);
  });

  it("names no home for a relative value, which Codex would resolve against the pane's folder", () => {
    expect(resolveLaunchCodexHome({ CODEX_HOME: "accounts/work" })).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("reads the variable whatever its casing", () => {
    expect(resolveLaunchCodexHome({ codex_home: "C:\\accounts\\work" })).toBe("C:\\accounts\\work");
  });
});
