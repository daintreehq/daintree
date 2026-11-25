import { describe, expect, it } from "vitest";
import os from "os";
import path from "path";
import { resolveLaunchCodexHome, usesOwnCodexHome } from "../codexLaunchHome.js";

describe("resolveLaunchCodexHome", () => {
  const fallback = path.join(os.homedir(), ".codex");

  it("names Codex's own home when the env sets none", () => {
    expect(resolveLaunchCodexHome({ PATH: "/usr/bin" })).toBe(fallback);
    expect(resolveLaunchCodexHome({ CODEX_HOME: undefined })).toBe(fallback);
  });

  it("resolves Codex's own home against the HOME the launch set, as Codex does", () => {
    const paneHome = path.resolve(os.tmpdir(), "pane-home");
    const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
    expect(resolveLaunchCodexHome({ [homeVar]: paneHome })).toBe(path.join(paneHome, ".codex"));
    expect(resolveLaunchCodexHome({ [homeVar]: "relative" })).toBe(fallback);
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

describe("usesOwnCodexHome (#18169)", () => {
  const own = path.resolve(os.tmpdir(), "own-codex");
  const base = { PATH: "/usr/bin", CODEX_HOME: own };

  it("takes a launch that sets nothing, or this process's own home, for this one", () => {
    expect(usesOwnCodexHome(undefined, base)).toBe(true);
    expect(usesOwnCodexHome({ OTHER: "x" }, base)).toBe(true);
    expect(usesOwnCodexHome({ CODEX_HOME: `${own}${path.sep}` }, base)).toBe(true);
  });

  it("tells an account's home apart from this one", () => {
    const account = path.resolve(os.tmpdir(), "accounts", "codex-work");
    expect(usesOwnCodexHome({ CODEX_HOME: account }, base)).toBe(false);
  });

  it("never takes a home it can't tell for this one, on either side", () => {
    expect(usesOwnCodexHome({ CODEX_HOME: "accounts/work" }, base)).toBe(false);
    expect(usesOwnCodexHome({ CODEX_HOME: "accounts/work" }, { CODEX_HOME: "accounts/work" })).toBe(
      false
    );
  });
});
