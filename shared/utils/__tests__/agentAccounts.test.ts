import { describe, expect, it } from "vitest";
import {
  accountFolderName,
  isUsableAccountFolder,
  keepPaneAccount,
  paneAccountEnv,
  resolveEffectiveAccountId,
  resolveLaunchAccount,
  sanitizeAgentAccounts,
  withAccountEnv,
} from "../agentAccounts.js";

describe("sanitizeAgentAccounts", () => {
  it("keeps the first well-formed entry of each id and drops the rest", () => {
    expect(
      sanitizeAgentAccounts([
        { id: "a", name: "  Company  ", configDir: "/Users/me/.codex-company" },
        { id: "a", name: "Duplicate", configDir: "/Users/me/.codex-dup" },
        { id: "b", name: "", configDir: "/Users/me/.codex-b" },
        { id: "c", name: "Relative", configDir: ".codex-c" },
        { id: "d", name: "Injected", configDir: "/Users/me/$(rm -rf ~)" },
        { id: "bad id", name: "Spaces", configDir: "/Users/me/.codex-e" },
        { id: "f", name: "Windows", configDir: "C:\\Users\\me\\.codex-f" },
        null,
        "nope",
      ])
    ).toEqual([
      { id: "a", name: "Company", configDir: "/Users/me/.codex-company" },
      { id: "f", name: "Windows", configDir: "C:\\Users\\me\\.codex-f" },
    ]);
    expect(sanitizeAgentAccounts({ not: "an array" })).toEqual([]);
  });
});

describe("isUsableAccountFolder", () => {
  it.each([
    ["/Users/me/.codex-company", true],
    ["C:/Users/me/.codex", true],
    ["\\\\server\\share\\codex", true],
    ["\\profiles\\work", false],
    ["relative/folder", false],
    ["/Users/me/a;b", false],
    ["/Users/me/line\nbreak", false],
  ])("%s → %s", (value, usable) => {
    expect(isUsableAccountFolder(value)).toBe(usable);
  });
});

describe("resolveEffectiveAccountId", () => {
  const entry = { accountId: "agent", worktreeAccounts: { wt1: "scoped", wt2: null } };

  it("takes the caller's choice, then the worktree's, then the agent's", () => {
    expect(resolveEffectiveAccountId(entry, "wt1", "requested")).toBe("requested");
    expect(resolveEffectiveAccountId(entry, "wt1", null)).toBeNull();
    expect(resolveEffectiveAccountId(entry, "wt1")).toBe("scoped");
    expect(resolveEffectiveAccountId(entry, "wt2")).toBeNull();
    expect(resolveEffectiveAccountId(entry, "wt3")).toBe("agent");
    expect(resolveEffectiveAccountId(entry, null)).toBe("agent");
    expect(resolveEffectiveAccountId(undefined, "wt1")).toBeNull();
  });

  it("puts a preset's pin under the launch's and the worktree's choice, over the agent's (#16133)", () => {
    expect(resolveEffectiveAccountId(entry, "wt1", "requested", "pinned")).toBe("requested");
    expect(resolveEffectiveAccountId(entry, "wt1", null, "pinned")).toBeNull();
    expect(resolveEffectiveAccountId(entry, "wt1", undefined, "pinned")).toBe("scoped");
    // A worktree that chose the default login keeps it over the pin.
    expect(resolveEffectiveAccountId(entry, "wt2", undefined, "pinned")).toBeNull();
    expect(resolveEffectiveAccountId(entry, "wt3", undefined, "pinned")).toBe("pinned");
    expect(resolveEffectiveAccountId(entry, null, undefined, "pinned")).toBe("pinned");
    expect(resolveEffectiveAccountId({}, null, undefined, "pinned")).toBe("pinned");
    expect(resolveEffectiveAccountId(entry, "wt3", undefined, undefined)).toBe("agent");
  });
});

describe("resolveLaunchAccount", () => {
  const accounts = [{ id: "company", name: "Company", configDir: "/Users/me/.codex-company" }];

  it("names the variable the agent's registry declares", () => {
    expect(resolveLaunchAccount("codex", { accounts, accountId: "company" }, null)).toEqual({
      kind: "account",
      account: accounts[0],
      envVar: "CODEX_HOME",
    });
  });

  it("reports an id with no account behind it", () => {
    expect(resolveLaunchAccount("codex", { accounts, accountId: "gone" }, null)).toEqual({
      kind: "missing",
      accountId: "gone",
    });
  });

  it("launches on a preset's pin, and refuses one no account answers to", () => {
    const pinned = resolveLaunchAccount(
      "codex",
      { accounts, accountId: "gone" },
      null,
      undefined,
      "company"
    );
    expect(pinned).toEqual({ kind: "account", account: accounts[0], envVar: "CODEX_HOME" });
    expect(
      resolveLaunchAccount("codex", { accounts, accountId: "company" }, null, undefined, "gone")
    ).toEqual({ kind: "missing", accountId: "gone" });
  });

  it("is the default login for an agent with no folder accounts", () => {
    expect(resolveLaunchAccount("aider", { accounts, accountId: "company" }, null)).toEqual({
      kind: "default",
    });
  });
});

describe("withAccountEnv", () => {
  it("replaces every spelling of the variable and keeps the rest", () => {
    expect(
      withAccountEnv({ codex_home: "/old", OTHER: "1" }, "CODEX_HOME", "/Users/me/.codex-b")
    ).toEqual({ OTHER: "1", CODEX_HOME: "/Users/me/.codex-b" });
    expect(withAccountEnv(undefined, "CODEX_HOME", "/x")).toEqual({ CODEX_HOME: "/x" });
  });
});

describe("paneAccountEnv / keepPaneAccount", () => {
  const pane = {
    agentAccountId: "company",
    env: { codex_home: "/Users/me/.codex-company", FOO: "bar" },
  };

  it("reads the folder a pane launched on back from its captured env", () => {
    expect(paneAccountEnv("codex", pane)).toEqual({ CODEX_HOME: "/Users/me/.codex-company" });
  });

  it("has nothing for a pane on the default login or with no captured folder", () => {
    expect(paneAccountEnv("codex", { env: pane.env })).toBeUndefined();
    expect(paneAccountEnv("codex", { agentAccountId: "company", env: {} })).toBeUndefined();
    expect(paneAccountEnv("aider", pane)).toBeUndefined();
  });

  it("lays the pane's folder over a relaunch's env, whatever the preset now sets", () => {
    expect(keepPaneAccount({ CODEX_HOME: "/preset", A: "1" }, "codex", pane)).toEqual({
      A: "1",
      CODEX_HOME: "/Users/me/.codex-company",
    });
    const untouched = { A: "1" };
    expect(keepPaneAccount(untouched, "codex", { env: pane.env })).toBe(untouched);
  });
});

describe("accountFolderName", () => {
  it.each([
    [".codex", "Company", ".codex-company"],
    [".claude", "  Work — ACME Inc.  ", ".claude-work-acme-inc"],
    [".kimi-code", "Café", ".kimi-code-cafe"],
    [".codex", "!!!", undefined],
  ])("%s + %s → %s", (defaultDir, name, expected) => {
    expect(accountFolderName(defaultDir, name)).toBe(expected);
  });
});
