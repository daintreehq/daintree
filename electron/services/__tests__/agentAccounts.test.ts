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

import { addAgentAccount, removeAgentAccount } from "../agentAccounts.js";
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

  it("never takes over a folder that already exists, even an empty one", async () => {
    const folder = path.join(home, ".codex-company");
    await mkdir(folder);
    await writeFile(path.join(folder, "auth.json"), "{}");

    await expect(
      addAgentAccount({ agentId: "codex", name: "Company", folder: { kind: "create" } })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await readdir(folder)).toEqual(["auth.json"]);
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

    const settings = removeAgentAccount("codex", account.id);

    expect(settings.agents.codex).toMatchObject({
      presetId: "keep-me",
      accounts: [other.account],
      worktreeAccounts: { wt2: other.account.id, wt3: null },
    });
    expect(settings.agents.codex?.accountId).toBeUndefined();
    expect((await stat(account.configDir)).isDirectory()).toBe(true);
  });
});
