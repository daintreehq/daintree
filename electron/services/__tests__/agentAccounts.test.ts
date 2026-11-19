import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeStore = vi.hoisted(() => {
  let data: Record<string, unknown> = {};
  return {
    reset(initial: Record<string, unknown>) {
      data = structuredClone(initial);
    },
    dump: () => data,
    get: vi.fn((key: string, fallback?: unknown) =>
      data[key] === undefined ? fallback : structuredClone(data[key])
    ),
    set: vi.fn((key: string, value: unknown) => {
      if (key === "agentSettings.agents") {
        data.agentSettings = { ...(data.agentSettings as object), agents: structuredClone(value) };
        return;
      }
      data[key] = structuredClone(value);
    }),
  };
});
vi.mock("../../store.js", () => ({ store: fakeStore }));

const broadcastMock = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: broadcastMock }));

import {
  addAgentAccount,
  applyAccountEverywhere,
  listAccountChoicesAwayOnHost,
  removeAgentAccount,
  renameAgentAccount,
} from "../agentAccounts.js";
import { CHANNELS } from "../../ipc/channels.js";

let home: string;

function savedCodex(): Record<string, unknown> {
  const settings = fakeStore.dump().agentSettings as { agents: Record<string, unknown> };
  return settings.agents.codex as Record<string, unknown>;
}

beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(path.join(os.tmpdir(), "daintree-accounts-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  fakeStore.reset({ agentSettings: { agents: { codex: { presetId: "keep-me" } } } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe("addAgentAccount (#16040)", () => {
  it("creates a fresh folder beside the CLI's own, saves the account and tells every view", async () => {
    const { account, settings } = await addAgentAccount({
      agentId: "codex",
      name: "Company",
      folder: { kind: "create" },
    });

    const folder = path.join(home, ".codex-company");
    expect(account).toMatchObject({ name: "Company", configDir: folder });
    expect((await stat(folder)).isDirectory()).toBe(true);
    expect(await readdir(folder)).toEqual([]);
    expect(savedCodex()).toMatchObject({ presetId: "keep-me", accounts: [account] });
    expect(settings.agents.codex?.accounts).toEqual([account]);
    expect(broadcastMock).toHaveBeenCalledWith(
      CHANNELS.AGENT_SETTINGS_CHANGED,
      fakeStore.dump().agentSettings
    );
  });

  it("never takes over a folder that already exists, signed in or empty", async () => {
    const signedIn = path.join(home, ".codex-company");
    await mkdir(signedIn);
    await writeFile(path.join(signedIn, "auth.json"), "{}");
    await mkdir(path.join(home, ".codex-lab"));

    await expect(
      addAgentAccount({ agentId: "codex", name: "Company", folder: { kind: "create" } })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      addAgentAccount({ agentId: "codex", name: "Lab", folder: { kind: "create" } })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await readdir(signedIn)).toEqual(["auth.json"]);
    expect(savedCodex().accounts).toBeUndefined();
  });

  it("points at an existing folder without writing into it", async () => {
    const folder = path.join(home, "elsewhere", "codex-work");
    await mkdir(folder, { recursive: true });

    const { account } = await addAgentAccount({
      agentId: "codex",
      name: "Work",
      folder: { kind: "existing", path: `  ${folder}  ` },
    });

    expect(account.configDir).toBe(folder);
    expect(await readdir(folder)).toEqual([]);
  });

  it("refuses a missing folder, a file, a relative path and a folder another account has", async () => {
    const file = path.join(home, "file");
    await writeFile(file, "");
    const folder = path.join(home, "codex-work");
    await mkdir(folder);
    await addAgentAccount({
      agentId: "codex",
      name: "Work",
      folder: { kind: "existing", path: folder },
    });

    const attempt = (folderPath: string) =>
      addAgentAccount({
        agentId: "codex",
        name: "Again",
        folder: { kind: "existing", path: folderPath },
      });
    await expect(attempt(path.join(home, "missing"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(attempt(file)).rejects.toMatchObject({ code: "NOT_A_DIRECTORY" });
    await expect(attempt("relative/codex")).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(attempt(`${folder}/`)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(savedCodex().accounts as unknown[]).toHaveLength(1);
  });

  it("registers one folder once when two adds of it start together (#17079)", async () => {
    // An account already saved, so each add awaits its folder before writing.
    const other = path.join(home, "codex-other");
    await mkdir(other);
    await addAgentAccount({
      agentId: "codex",
      name: "Other",
      folder: { kind: "existing", path: other },
    });
    const folder = path.join(home, "codex-team");
    await mkdir(folder);
    // Another name for the same folder, which only its real path gives away.
    const alias = path.join(home, "codex-team-link");
    await symlink(folder, alias);

    const results = await Promise.allSettled([
      addAgentAccount({
        agentId: "codex",
        name: "Team",
        folder: { kind: "existing", path: folder },
      }),
      addAgentAccount({
        agentId: "codex",
        name: "Team again",
        folder: { kind: "existing", path: alias },
      }),
    ]);

    // Whichever finishes its checks first is the one saved.
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const saved = (savedCodex().accounts as Array<{ name: string }>).map((a) => a.name);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toBe("Other");
    expect(["Team", "Team again"]).toContain(saved[1]);
  });

  it("refuses to create a folder a saved account already names, its folder since deleted", async () => {
    fakeStore.reset({
      agentSettings: {
        agents: {
          codex: {
            accounts: [
              {
                id: "account-old",
                name: "Old",
                configDir: `${path.join(home, ".codex-company")}/`,
              },
            ],
          },
        },
      },
    });

    await expect(
      addAgentAccount({ agentId: "codex", name: "Company", folder: { kind: "create" } })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect((savedCodex().accounts as unknown[]).length).toBe(1);
  });

  it("still adds after an add before it failed", async () => {
    await mkdir(path.join(home, ".codex-company"));
    const [failed, added] = await Promise.allSettled([
      addAgentAccount({ agentId: "codex", name: "Company", folder: { kind: "create" } }),
      addAgentAccount({ agentId: "codex", name: "Lab", folder: { kind: "create" } }),
    ]);

    expect(failed.status).toBe("rejected");
    expect(added.status).toBe("fulfilled");
    expect((savedCodex().accounts as Array<{ name: string }>).map((a) => a.name)).toEqual(["Lab"]);
  });

  it("refuses an agent whose CLI holds no folder account", async () => {
    await expect(
      addAgentAccount({ agentId: "cursor", name: "Work", folder: { kind: "create" } })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await readdir(home)).toEqual([]);
  });
});

describe("removeAgentAccount (#16040)", () => {
  it("forgets the account and every choice that named it, and leaves its folder", async () => {
    const { account } = await addAgentAccount({
      agentId: "codex",
      name: "Company",
      folder: { kind: "create" },
    });
    const other = await addAgentAccount({
      agentId: "codex",
      name: "Personal",
      folder: { kind: "create" },
    });
    fakeStore.set("agentSettings.agents", {
      codex: {
        ...savedCodex(),
        accountId: account.id,
        worktreeAccounts: { wt1: account.id, wt2: other.account.id, wt3: null },
      },
    });

    broadcastMock.mockClear();

    const settings = removeAgentAccount("codex", account.id);

    // Read back from the store, so a removal that only answered without saving fails.
    expect(savedCodex()).toEqual({
      presetId: "keep-me",
      accounts: [other.account],
      worktreeAccounts: { wt2: other.account.id, wt3: null },
    });
    expect(settings.agents.codex).toEqual(savedCodex());
    expect(broadcastMock).toHaveBeenCalledWith(
      CHANNELS.AGENT_SETTINGS_CHANGED,
      fakeStore.dump().agentSettings
    );
    expect((await stat(account.configDir)).isDirectory()).toBe(true);
  });

  it("clears the pin of every preset that named the account, and no other preset field (#16133)", async () => {
    const { account } = await addAgentAccount({
      agentId: "codex",
      name: "Company",
      folder: { kind: "create" },
    });
    const other = await addAgentAccount({
      agentId: "codex",
      name: "Personal",
      folder: { kind: "create" },
    });
    fakeStore.set("agentSettings.agents", {
      codex: {
        ...savedCodex(),
        customPresets: [
          { id: "work", name: "Work", accountId: account.id, env: { FOO: "1" } },
          { id: "home", name: "Home", accountId: other.account.id },
          { id: "plain", name: "Plain" },
          { id: "review", name: "Review", accountId: account.id },
        ],
      },
    });

    removeAgentAccount("codex", account.id);

    expect(savedCodex().customPresets).toEqual([
      { id: "work", name: "Work", env: { FOO: "1" } },
      { id: "home", name: "Home", accountId: other.account.id },
      { id: "plain", name: "Plain" },
      { id: "review", name: "Review" },
    ]);
  });
});

describe("renameAgentAccount (#17080)", () => {
  it("names the default login, cleaned as an account name is, and clears it on an empty name", () => {
    renameAgentAccount("codex", null, "  Work\nChatGPT  ");
    expect(savedCodex()).toEqual({ presetId: "keep-me", defaultLoginName: "Work ChatGPT" });
    expect(broadcastMock).toHaveBeenCalledWith(
      CHANNELS.AGENT_SETTINGS_CHANGED,
      fakeStore.dump().agentSettings
    );

    const settings = renameAgentAccount("codex", null, "   ");
    expect(savedCodex()).toEqual({ presetId: "keep-me" });
    expect(settings.agents.codex).toEqual(savedCodex());
  });

  it("renames a saved account in place, and every choice that named it keeps naming it", async () => {
    const { account } = await addAgentAccount({
      agentId: "codex",
      name: "Company",
      folder: { kind: "create" },
    });
    const other = await addAgentAccount({
      agentId: "codex",
      name: "Personal",
      folder: { kind: "create" },
    });
    fakeStore.set("agentSettings.agents", {
      codex: {
        ...savedCodex(),
        accountId: account.id,
        worktreeAccounts: { wt1: account.id },
        customPresets: [{ id: "work", name: "Work", accountId: account.id }],
      },
    });

    renameAgentAccount("codex", account.id, "Acme");
    renameAgentAccount("codex", other.account.id, "Home");

    expect(savedCodex()).toEqual({
      presetId: "keep-me",
      accounts: [
        { ...account, name: "Acme" },
        { ...other.account, name: "Home" },
      ],
      accountId: account.id,
      worktreeAccounts: { wt1: account.id },
      customPresets: [{ id: "work", name: "Work", accountId: account.id }],
    });
  });

  it("reads the saved accounts when it runs, so another view's add and remove stand", async () => {
    const { account } = await addAgentAccount({
      agentId: "codex",
      name: "Company",
      folder: { kind: "create" },
    });
    const personal = await addAgentAccount({
      agentId: "codex",
      name: "Personal",
      folder: { kind: "create" },
    });
    // Another view removes Company and adds Lab after this one opened the rename.
    removeAgentAccount("codex", account.id);
    const lab = await addAgentAccount({
      agentId: "codex",
      name: "Lab",
      folder: { kind: "create" },
    });

    renameAgentAccount("codex", personal.account.id, "Home");
    expect(savedCodex().accounts).toEqual([{ ...personal.account, name: "Home" }, lab.account]);

    broadcastMock.mockClear();
    fakeStore.set.mockClear();
    expect(() => renameAgentAccount("codex", account.id, "Back")).toThrow(/isn't saved/);
    expect(fakeStore.set).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("refuses a blank name for a saved account, a missing name, and an agent with no folder account", async () => {
    const { account } = await addAgentAccount({
      agentId: "codex",
      name: "Company",
      folder: { kind: "create" },
    });
    broadcastMock.mockClear();
    fakeStore.set.mockClear();
    const before = structuredClone(savedCodex());

    expect(() => renameAgentAccount("codex", account.id, " \t ")).toThrow(
      /Give the account a name/
    );
    expect(() => renameAgentAccount("codex", undefined, "Work")).toThrow(/Invalid account/);
    expect(() => renameAgentAccount("codex", null, undefined)).toThrow(/Invalid account name/);
    expect(() => renameAgentAccount("codex", "bad id", "Work")).toThrow(/Invalid account/);
    expect(() => renameAgentAccount("cursor", null, "Work")).toThrow(/no accounts/);
    expect(() => renameAgentAccount("__proto__", null, "Work")).toThrow(/Invalid agent/);
    expect(savedCodex()).toEqual(before);
    expect(fakeStore.set).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe("using one account everywhere (#17893)", () => {
  async function twoAccounts() {
    const { account: spent } = await addAgentAccount({
      agentId: "codex",
      name: "Spent",
      folder: { kind: "create" },
    });
    const { account: fresh } = await addAgentAccount({
      agentId: "codex",
      name: "Fresh",
      folder: { kind: "create" },
    });
    return { spent, fresh };
  }

  it("lists every worktree pick and preset pin naming another login, and marks a worktree that's gone", async () => {
    const { spent, fresh } = await twoAccounts();
    // A main checkout's marker is a folder, a linked worktree's a file.
    const kept = path.join(home, "repo-feature");
    await mkdir(path.join(kept, ".git"), { recursive: true });
    const linked = path.join(home, "repo-linked");
    await mkdir(linked);
    await writeFile(path.join(linked, ".git"), "gitdir: /elsewhere\n");
    // Deleted, or its folder reused for something that isn't a checkout.
    const deleted = path.join(home, "repo-old");
    const reused = path.join(home, "repo-reused");
    await mkdir(reused);
    fakeStore.set("agentSettings.agents", {
      codex: {
        ...savedCodex(),
        accountId: spent.id,
        worktreeAccounts: {
          [kept]: spent.id,
          [linked]: spent.id,
          [deleted]: null,
          [reused]: spent.id,
          "relative/key": spent.id,
          [path.join(home, "repo-fresh")]: fresh.id,
        },
        customPresets: [
          { id: "work", name: "Work", accountId: spent.id },
          { id: "home", name: "Home", accountId: fresh.id },
          { id: "plain", name: "Plain" },
          { id: "gone", name: "Gone account", accountId: "account-removed" },
        ],
      },
    });

    const choices = await listAccountChoicesAwayOnHost("codex", fresh.id);

    expect(choices).toEqual({
      worktrees: [
        { worktreeId: kept, accountId: spent.id, gone: false },
        { worktreeId: linked, accountId: spent.id, gone: false },
        { worktreeId: deleted, accountId: null, gone: true },
        { worktreeId: reused, accountId: spent.id, gone: true },
        { worktreeId: "relative/key", accountId: spent.id, gone: true },
      ],
      presets: [
        { presetId: "work", presetName: "Work", accountId: spent.id },
        { presetId: "gone", presetName: "Gone account", accountId: "account-removed" },
      ],
    });
    // The default login as the target: a worktree on it already isn't listed, every pin is.
    const toDefault = await listAccountChoicesAwayOnHost("codex", null);
    expect(toDefault.worktrees.map((choice) => choice.worktreeId)).toEqual([
      kept,
      linked,
      reused,
      "relative/key",
      path.join(home, "repo-fresh"),
    ]);
    expect(toDefault.presets.map((pin) => pin.presetId)).toEqual(["work", "home", "gone"]);
  });

  it("makes the account the default and clears only the choices left ticked, in one write", async () => {
    const { spent, fresh } = await twoAccounts();
    fakeStore.set("agentSettings.agents", {
      codex: {
        ...savedCodex(),
        accountId: spent.id,
        worktreeAccounts: { "/repo/a": spent.id, "/repo/b": null, "/repo/c": spent.id },
        customPresets: [
          { id: "work", name: "Work", accountId: spent.id, env: { FOO: "1" } },
          { id: "review", name: "Review", accountId: spent.id },
        ],
      },
    });
    broadcastMock.mockClear();
    fakeStore.set.mockClear();

    const settings = applyAccountEverywhere({
      agentId: "codex",
      accountId: fresh.id,
      clear: {
        worktrees: [
          { worktreeId: "/repo/a", accountId: spent.id },
          { worktreeId: "/repo/b", accountId: null },
        ],
        presets: [{ presetId: "work", accountId: spent.id }],
      },
    });

    const saved = savedCodex();
    expect(saved.accountId).toBe(fresh.id);
    expect(saved.presetId).toBe("keep-me");
    expect(saved.worktreeAccounts).toEqual({ "/repo/c": spent.id });
    expect(saved.customPresets).toEqual([
      { id: "work", name: "Work", env: { FOO: "1" } },
      { id: "review", name: "Review", accountId: spent.id },
    ]);
    expect(settings.agents.codex).toEqual(saved);
    expect(fakeStore.set).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(
      CHANNELS.AGENT_SETTINGS_CHANGED,
      fakeStore.dump().agentSettings
    );
  });

  it("keeps a choice another view changed after the list was made, and drops an emptied map", async () => {
    const { spent, fresh } = await twoAccounts();
    fakeStore.set("agentSettings.agents", {
      codex: {
        ...savedCodex(),
        worktreeAccounts: { "/repo/a": spent.id, "/repo/b": fresh.id },
        customPresets: [{ id: "work", name: "Work", accountId: fresh.id }],
      },
    });

    // Listed while /repo/b and the preset were on Spent; both have moved since.
    applyAccountEverywhere({
      agentId: "codex",
      accountId: null,
      clear: {
        worktrees: [
          { worktreeId: "/repo/a", accountId: spent.id },
          { worktreeId: "/repo/b", accountId: spent.id },
          { worktreeId: "/repo/never", accountId: spent.id },
        ],
        presets: [
          { presetId: "work", accountId: spent.id },
          { presetId: "deleted", accountId: spent.id },
        ],
      },
    });

    expect(savedCodex().worktreeAccounts).toEqual({ "/repo/b": fresh.id });
    expect(savedCodex().customPresets).toEqual([{ id: "work", name: "Work", accountId: fresh.id }]);
    expect(savedCodex()).not.toHaveProperty("accountId");

    applyAccountEverywhere({
      agentId: "codex",
      accountId: spent.id,
      clear: { worktrees: [{ worktreeId: "/repo/b", accountId: fresh.id }], presets: [] },
    });
    expect(savedCodex().worktreeAccounts).toBeUndefined();
    expect(savedCodex().accountId).toBe(spent.id);
  });

  it("never clears a pin by an id two presets share, listed when the list was made or not", async () => {
    const { spent, fresh } = await twoAccounts();
    fakeStore.set("agentSettings.agents", {
      codex: {
        ...savedCodex(),
        customPresets: [
          { id: "work", name: "Work", accountId: spent.id },
          { id: "work", name: "Work copy", accountId: spent.id },
          { id: "build", name: "Build", accountId: spent.id },
        ],
      },
    });

    const { presets } = await listAccountChoicesAwayOnHost("codex", fresh.id);
    expect(presets).toEqual([
      { presetId: "work", presetName: "Work", accountId: spent.id, sharedId: true },
      { presetId: "build", presetName: "Build", accountId: spent.id },
    ]);

    // Another write puts a preset with Build's id ahead of it after the list was made.
    const saved = savedCodex();
    fakeStore.set("agentSettings.agents", {
      codex: {
        ...saved,
        customPresets: [
          { id: "build", name: "Deploy", accountId: spent.id },
          ...(saved.customPresets as unknown[]),
        ],
      },
    });
    applyAccountEverywhere({
      agentId: "codex",
      accountId: fresh.id,
      clear: {
        worktrees: [],
        presets: [
          { presetId: "work", accountId: spent.id },
          { presetId: "build", accountId: spent.id },
        ],
      },
    });
    expect(
      (savedCodex().customPresets as Array<{ accountId?: string }>).map(
        (preset) => preset.accountId
      )
    ).toEqual([spent.id, spent.id, spent.id, spent.id]);
    expect(savedCodex().accountId).toBe(fresh.id);
  });

  it("refuses a target removed after the list was made, before writing anything", async () => {
    const { spent, fresh } = await twoAccounts();
    fakeStore.set("agentSettings.agents", {
      codex: { ...savedCodex(), accountId: spent.id, worktreeAccounts: { "/repo/a": spent.id } },
    });
    const { worktrees } = await listAccountChoicesAwayOnHost("codex", fresh.id);
    removeAgentAccount("codex", fresh.id);
    const before = structuredClone(savedCodex());
    fakeStore.set.mockClear();

    expect(() =>
      applyAccountEverywhere({
        agentId: "codex",
        accountId: fresh.id,
        clear: { worktrees: worktrees.map(({ gone: _gone, ...choice }) => choice), presets: [] },
      })
    ).toThrow(/isn't saved/);
    expect(savedCodex()).toEqual(before);
    expect(fakeStore.set).not.toHaveBeenCalled();
  });

  it("refuses an account that isn't saved, a malformed request and an agent with no folder account, writing nothing", async () => {
    await twoAccounts();
    broadcastMock.mockClear();
    fakeStore.set.mockClear();
    const before = structuredClone(savedCodex());
    const clear = { worktrees: [], presets: [] };

    expect(() =>
      applyAccountEverywhere({ agentId: "codex", accountId: "account-removed", clear })
    ).toThrow(/isn't saved/);
    expect(() => applyAccountEverywhere({ agentId: "codex", accountId: "bad id", clear })).toThrow(
      /Invalid account/
    );
    expect(() => applyAccountEverywhere({ agentId: "codex", clear })).toThrow(/Invalid account/);
    expect(() => applyAccountEverywhere("codex")).toThrow(/Invalid request/);
    // A malformed row, or a missing list, refuses the whole request: never a smaller clear.
    for (const malformed of [
      undefined,
      { worktrees: [] },
      { presets: [] },
      { worktrees: [{ worktreeId: "/repo/a" }], presets: [] },
      { worktrees: [{ worktreeId: "", accountId: null }], presets: [] },
      { worktrees: [], presets: [{ presetId: "work", accountId: null }] },
      { worktrees: ["/repo/a"], presets: [] },
    ]) {
      expect(() =>
        applyAccountEverywhere({ agentId: "codex", accountId: null, clear: malformed })
      ).toThrow(/Invalid request/);
    }
    // Nothing the list offers names the target already.
    expect(() =>
      applyAccountEverywhere({
        agentId: "codex",
        accountId: null,
        clear: { worktrees: [{ worktreeId: "/repo/a", accountId: null }], presets: [] },
      })
    ).toThrow(/Invalid request/);
    expect(() => applyAccountEverywhere({ agentId: "cursor", accountId: null, clear })).toThrow(
      /no accounts/
    );
    await expect(listAccountChoicesAwayOnHost("codex", "account-removed")).rejects.toThrow(
      /isn't saved/
    );
    expect(savedCodex()).toEqual(before);
    expect(fakeStore.set).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
