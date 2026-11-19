import { describe, expect, it } from "vitest";
import {
  accountFolderName,
  defaultLoginLabel,
  defaultLoginPhrase,
  describeLaunchAccount,
  isUsableAccountFolder,
  launchAnswer,
  listAgentAccountIdentities,
  keepPaneAccount,
  paneAccountEnv,
  resolveEffectiveAccountId,
  resolveLaunchAccount,
  sanitizeAgentAccounts,
  sanitizeLoginName,
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

describe("defaultLoginLabel and defaultLoginPhrase (#17080)", () => {
  it("falls back to the default login when no usable name is saved", () => {
    for (const name of [undefined, null, "", "   ", "\u0000\n\t", 42, { name: "Work" }]) {
      expect(defaultLoginLabel(name)).toBe("Default login");
      expect(defaultLoginPhrase(name)).toBe("the default login");
    }
  });

  it("keeps the default login beside the name, as an account name is cleaned", () => {
    expect(defaultLoginLabel("  Work\u0007ChatGPT  ")).toBe("Work ChatGPT · default login");
    expect(defaultLoginPhrase("Work")).toBe("Work (the default login)");
    const long = "x".repeat(80);
    expect(defaultLoginLabel(long)).toBe(`${"x".repeat(60)} · default login`);
    expect(defaultLoginPhrase("  Work\u0007Lab ")).toBe("Work Lab (the default login)");
  });

  it("keeps a saved account whose name a login name's cleaning would empty", () => {
    for (const name of ["\u200b", "\u200c\u2067", "\ud800", "\u0085"]) {
      const saved = { id: "a", name, configDir: "/Users/me/.codex-a" };
      expect(sanitizeAgentAccounts([saved])).toEqual([saved]);
      expect(sanitizeLoginName(name)).toBeUndefined();
    }
  });

  it("cleans a login name to the same name a second time, so what a field sends is what's saved", () => {
    for (const raw of [
      "\ud800\ud801",
      `${"x".repeat(59)}😀`,
      " Work\u202e\u00ad ",
      "a\udc00b",
      "Wörk 😀",
    ]) {
      const once = sanitizeLoginName(raw);
      expect(sanitizeLoginName(once)).toBe(once);
    }
    expect(sanitizeLoginName("a\udc00b😀")).toBe("ab😀");
  });

  it("drops marks that would reorder the words beside a name, or leave it looking empty", () => {
    expect(defaultLoginLabel("Work\u202enigol")).toBe("Worknigol · default login");
    expect(defaultLoginLabel("\u200f\u202e\u2066\u00ad\u061c")).toBe("Default login");
    expect(defaultLoginLabel("Work\u0085Lab")).toBe("Work Lab · default login");
  });

  it("never cuts a character in half at the cap, nor leaves a space where it cut", () => {
    expect(defaultLoginLabel(`${"x".repeat(59)}😀tail`)).toBe(`${"x".repeat(59)} · default login`);
    expect(defaultLoginLabel(`${"x".repeat(59)} tail`)).toBe(`${"x".repeat(59)} · default login`);
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

describe("listAgentAccountIdentities (#17079)", () => {
  const COMPANY = { id: "company", name: "Company", configDir: "/Users/me/.claude-company" };
  const PERSONAL = { id: "personal", name: "Personal", configDir: "/Users/me/.claude-personal" };

  it("names each saved account and the default, and never its folder", () => {
    const listed = listAgentAccountIdentities({
      accounts: [COMPANY, PERSONAL, { id: "bad id", name: "x", configDir: "/x" }],
      accountId: "personal",
    });

    expect(listed).toEqual([
      { id: "company", name: "Company", isDefault: false },
      { id: "personal", name: "Personal", isDefault: true },
    ]);
    expect(JSON.stringify(listed)).not.toContain("/Users/me");
  });

  it("marks no account the default when the CLI's own login is", () => {
    expect(listAgentAccountIdentities({ accounts: [COMPANY] })).toEqual([
      { id: "company", name: "Company", isDefault: false },
    ]);
    expect(listAgentAccountIdentities(undefined)).toEqual([]);
  });
});

describe("describeLaunchAccount (#17079)", () => {
  const COMPANY = { id: "company", name: "Company", configDir: "/Users/me/.claude-company" };
  const PERSONAL = { id: "personal", name: "Personal", configDir: "/Users/me/.claude-personal" };
  const entry = {
    accounts: [COMPANY, PERSONAL],
    accountId: "personal",
    worktreeAccounts: { "wt-company": "company", "wt-cli": null },
  };
  const pinned = { id: "work", accountId: "company" };

  it("says the worktree's own pick chose it, the CLI's login included, over a preset's pin", () => {
    expect(describeLaunchAccount(entry, "wt-company", pinned)).toEqual({
      accountId: "company",
      source: "worktree",
    });
    expect(describeLaunchAccount(entry, "wt-cli", pinned)).toEqual({
      accountId: null,
      source: "worktree",
    });
  });

  it("names the preset whose pin chose it, else the agent's default, else the CLI's login", () => {
    expect(describeLaunchAccount(entry, "wt-other", pinned)).toEqual({
      accountId: "company",
      source: "preset",
      presetId: "work",
    });
    expect(describeLaunchAccount(entry, "wt-other", { id: "plain" })).toEqual({
      accountId: "personal",
      source: "agentDefault",
    });
    expect(describeLaunchAccount({ accounts: [COMPANY] }, "wt-other", undefined)).toEqual({
      accountId: null,
      source: "cliDefault",
    });
  });

  it("flags an id whose saved row has an unusable folder, as a launch reads it", () => {
    const broken = { accounts: [{ id: "relative", name: "Rel", configDir: ".claude-rel" }] };
    expect(describeLaunchAccount({ ...broken, accountId: "relative" }, "wt", undefined)).toEqual({
      accountId: "relative",
      source: "agentDefault",
      missing: true,
    });
  });

  it("names no account while presets load, unless the worktree's own pick decides", () => {
    const viaPreset = describeLaunchAccount(entry, "wt-other", pinned);
    expect(launchAnswer(viaPreset, false)).toEqual({ presetsComplete: false });
    expect(launchAnswer(viaPreset, true)).toEqual({ ...viaPreset, presetsComplete: true });
    const viaWorktree = describeLaunchAccount(entry, "wt-company", pinned);
    expect(launchAnswer(viaWorktree, false)).toEqual({ ...viaWorktree, presetsComplete: false });
  });

  it("flags an id no saved account answers to, which a launch refuses", () => {
    expect(
      describeLaunchAccount({ accounts: [COMPANY], accountId: "gone" }, "wt", undefined)
    ).toEqual({ accountId: "gone", source: "agentDefault", missing: true });
  });

  it("reads an inherited worktree key as no pick of its own", () => {
    const inherited = Object.create({ "wt-proto": "company" }) as Record<string, string>;
    expect(
      describeLaunchAccount({ ...entry, worktreeAccounts: inherited }, "wt-proto", undefined)
    ).toEqual({ accountId: "personal", source: "agentDefault" });
  });
});
