import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
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

import { addAgentAccount, removeAgentAccount, renameAgentAccount } from "../agentAccounts.js";
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

    expect(savedCodex()).toEqual({
      presetId: "keep-me",
      accounts: [{ ...account, name: "Acme" }, other.account],
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
    const lab = await addAgentAccount({ agentId: "codex", name: "Lab", folder: { kind: "create" } });

    renameAgentAccount("codex", personal.account.id, "Home");
    expect(savedCodex().accounts).toEqual([{ ...personal.account, name: "Home" }, lab.account]);

    broadcastMock.mockClear();
    const before = structuredClone(savedCodex());
    expect(() => renameAgentAccount("codex", account.id, "Back")).toThrow(/isn't saved/);
    expect(savedCodex()).toEqual(before);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("refuses a blank name for a saved account, a missing name, and an agent with no folder account", async () => {
    const { account } = await addAgentAccount({
      agentId: "codex",
      name: "Company",
      folder: { kind: "create" },
    });
    broadcastMock.mockClear();
    const before = structuredClone(savedCodex());

    expect(() => renameAgentAccount("codex", account.id, " \t ")).toThrow(/Give the account a name/);
    expect(() => renameAgentAccount("codex", null, undefined)).toThrow(/Invalid account name/);
    expect(() => renameAgentAccount("codex", "bad id", "Work")).toThrow(/Invalid account/);
    expect(() => renameAgentAccount("cursor", null, "Work")).toThrow(/no accounts/);
    expect(() => renameAgentAccount("__proto__", null, "Work")).toThrow(/Invalid agent/);
    expect(savedCodex()).toEqual(before);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
