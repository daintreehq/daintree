import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import {
  BridgeError,
  MemoryKeyStore,
  PolicyRegistry,
  loadIdentity,
  paneIdentityOf,
  type AttachmentResolver,
  type Identity,
  type QuestionOrigin,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { LIMITS, bytesToBase64Url } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));

import { openDb } from "../../persistence/db.js";
import { DecisionsAttachments } from "../attachmentSpool.js";
import { DaintreeLocalStore } from "../daintreeLocalStore.js";
import { QuestionBridge } from "../questionBridge.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../persistence/migrations"
);

/** Planted in every image, so a test can prove only ciphertext is spooled. */
const SECRET = "SECRET-SCREENSHOT-BYTES";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

let base: string;
let spoolDir: string;
let worktree: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-spool-"));
  spoolDir = path.join(base, "decisions", "spool");
  worktree = path.join(base, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

function spooled(): string[] {
  return fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).sort() : [];
}

function writeImage(name: string, size?: number): void {
  const file = path.join(worktree, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from(SECRET)]));
  if (size !== undefined) fs.truncateSync(file, size);
}

describe("DecisionsAttachments", () => {
  function plant(...names: string[]): void {
    fs.mkdirSync(spoolDir, { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(spoolDir, name), "ciphertext");
  }

  it("sweeps, on opening, every entry and temporary file no pending create names", async () => {
    plant("kept_1", "orphan_1", "kept_1.tmp", "orphan_2.tmp", "not.an.entry");
    fs.mkdirSync(path.join(spoolDir, "dir_entry"));
    const attachments = new DecisionsAttachments({
      dir: spoolDir,
      referenced: async () => new Set(["kept_1"]),
    });
    await attachments.close();
    expect(spooled()).toEqual(["dir_entry", "kept_1", "not.an.entry"]);
  });

  it("deletes nothing when it can't tell which entries are still owed", async () => {
    plant("entry_1", "entry_2.tmp");
    const attachments = new DecisionsAttachments({
      dir: spoolDir,
      referenced: async () => {
        throw new Error("store closed");
      },
    });
    await attachments.close();
    expect(spooled()).toEqual(["entry_1", "entry_2.tmp"]);
  });

  it("never reads the store for a spool that holds nothing", async () => {
    const referenced = vi.fn(async () => new Set<string>());
    const attachments = new DecisionsAttachments({ dir: spoolDir, referenced });
    await attachments.close();
    plant();
    await new DecisionsAttachments({ dir: spoolDir, referenced }).close();
    expect(referenced).not.toHaveBeenCalled();
  });

  it("runs asks one at a time, and sweeps only after one that spooled and failed", async () => {
    const committed = new Set<string>();
    const referenced = vi.fn(async () => new Set(committed));
    const attachments = new DecisionsAttachments({ dir: spoolDir, referenced });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];

    const first = attachments.register(async () => {
      order.push("first:start");
      await attachments.spool.put("first_entry", new Uint8Array([1]));
      await held;
      order.push("first:end");
      throw new BridgeError("attachment_error", "the second image was refused");
    });
    const second = attachments.register(async () => {
      order.push("second");
      return "asked";
    });
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    expect(spooled()).toEqual(["first_entry"]);
    release();

    await expect(first).rejects.toThrow(/second image was refused/);
    await expect(second).resolves.toBe("asked");
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(spooled()).toEqual([]);

    referenced.mockClear();
    await expect(
      attachments.register(async () => {
        throw new Error("nothing spooled");
      })
    ).rejects.toThrow();
    expect(referenced).not.toHaveBeenCalled();
  });

  it("keeps what a failed ask spooled once its create has committed", async () => {
    const committed = new Set<string>();
    const attachments = new DecisionsAttachments({
      dir: spoolDir,
      referenced: async () => new Set(committed),
    });
    await expect(
      attachments.register(async () => {
        await attachments.spool.put("committed_1", new Uint8Array([1]));
        committed.add("committed_1");
        throw new Error("the audit write failed after the commit");
      })
    ).rejects.toThrow(/audit/);
    expect(spooled()).toEqual(["committed_1"]);
  });

  it("keeps the spool private to its owner", async () => {
    const attachments = new DecisionsAttachments({
      dir: spoolDir,
      referenced: async () => new Set(),
    });
    await attachments.register(() => attachments.spool.put("entry_1", new Uint8Array([7])));
    expect(await attachments.spool.get("entry_1")).toEqual(new Uint8Array([7]));
    if (process.platform !== "win32") {
      expect(fs.statSync(spoolDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(spoolDir, "entry_1")).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a symlink in place of its directory", async () => {
    const elsewhere = path.join(base, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.dirname(spoolDir), { recursive: true });
    fs.symlinkSync(elsewhere, spoolDir, "dir");
    const attachments = new DecisionsAttachments({
      dir: spoolDir,
      referenced: async () => new Set(),
    });
    await expect(
      attachments.register(() => attachments.spool.put("entry_1", new Uint8Array([7])))
    ).rejects.toThrow(/expected a real directory/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses asks once closed, after the one it was running has settled", async () => {
    const attachments = new DecisionsAttachments({
      dir: spoolDir,
      referenced: async () => new Set(),
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    let finished = false;
    const running = attachments.register(async () => {
      started = true;
      await held;
      finished = true;
    });
    const queued = attachments.register(async () => "never");
    await vi.waitFor(() => expect(started).toBe(true));
    const closing = attachments.close();
    const late = attachments.register(async () => "never");
    release();
    await closing;
    expect(finished).toBe(true);
    await running;
    await expect(queued).rejects.toMatchObject({ code: "forbidden" });
    await expect(late).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("asking with attachments", () => {
  let sqlite: Database.Database;
  let store: DaintreeLocalStore;
  let identity: Identity;
  let attachments: DecisionsAttachments;
  let resolved: string[];

  const origin = (): QuestionOrigin => ({
    host_id: "host_a",
    pane_id: "pane-1",
    terminal_generation: 1,
    ownership_principal: "principal-1",
    agent_incarnation: "0",
    agent_kind: "claude",
    agent_session_id: null,
    project_id: "p1",
    worktree_id: worktree,
    worktree_root: worktree,
    workflow_gate_id: null,
  });

  beforeEach(async () => {
    sqlite = openDb(path.join(base, "app.db"), migrationsFolder).sqlite;
    store = new DaintreeLocalStore(sqlite);
    const keys = new MemoryKeyStore();
    await keys.save({
      v: 1,
      config: {
        relayOrigin: "https://decisions.example.workers.dev",
        installationId: "inst_12345678",
        deviceId: "dev_12345678",
        label: "Test desktop",
      },
      keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
      epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
      currentEpoch: 1,
    });
    identity = await loadIdentity(keys);
    resolved = [];
    attachments = new DecisionsAttachments({
      dir: spoolDir,
      referenced: () => store.referencedAttachmentIds(),
    });
    const resolver = attachments.resolver;
    // Counts reads, to show what the library refuses before reading anything.
    (attachments as unknown as { resolver: AttachmentResolver }).resolver = {
      resolve: (o, id) => {
        resolved.push(id);
        return resolver.resolve(o, id);
      },
    };
  });

  afterEach(async () => {
    await attachments.close();
    await store.close();
    sqlite.close();
  });

  function bridge(): QuestionBridge {
    return new QuestionBridge({
      source: {
        identity: () => identity,
        live: () => null,
        store,
        policy: new PolicyRegistry(),
        attachments,
      },
      isCurrent: () => true,
    });
  }

  function ask(ids: string[]) {
    return bridge().registerQuestion({
      origin: origin(),
      input: {
        question: "Which layout is right?",
        attachments: ids.map((id) => ({ local_resource_id: id, role: "after" as const })),
      },
    });
  }

  it("spools only ciphertext, one entry per image, named by the question's create", async () => {
    writeImage("shots/before.png");
    writeImage("shots/after.png");
    const asked = await ask(["shots/before.png", "shots/after.png"]);

    const row = await store.getQuestion(asked.questionId);
    expect(row?.attachment_digests).toHaveLength(2);
    const entries = spooled();
    expect(entries).toHaveLength(2);
    expect(new Set(entries)).toEqual(await store.referencedAttachmentIds());
    for (const entry of entries) {
      expect(fs.readFileSync(path.join(spoolDir, entry)).includes(SECRET)).toBe(false);
    }
  });

  it("refuses a ninth image before reading any of them", async () => {
    for (let i = 0; i < 9; i++) writeImage(`shot-${i}.png`);
    const nine = Array.from({ length: 9 }, (_, i) => `shot-${i}.png`);
    await expect(ask(nine)).rejects.toMatchObject({ code: "validation_error" });
    expect(resolved).toEqual([]);
    expect(spooled()).toEqual([]);

    await expect(ask(nine.slice(0, 8))).resolves.toMatchObject({ status: "queued" });
    expect(spooled()).toHaveLength(8);
  });

  it("refuses images past 64 MiB together, and sweeps the ones spooled before it", async () => {
    const each = 17 * 1024 * 1024;
    expect(each * 3).toBeLessThanOrEqual(LIMITS.attachmentTotalBytes);
    expect(each * 4).toBeGreaterThan(LIMITS.attachmentTotalBytes);
    for (let i = 0; i < 4; i++) writeImage(`big-${i}.png`, each);
    await expect(ask(["big-0.png", "big-1.png", "big-2.png", "big-3.png"])).rejects.toMatchObject({
      code: "attachment_error",
      message: expect.stringMatching(/64 MiB in total/),
    });
    expect(spooled()).toEqual([]);
    expect(await store.listQuestions()).toEqual([]);
  }, 60_000);

  it("tells the agent which image was refused and why, and sweeps the ones before it", async () => {
    writeImage("ok.png");
    fs.writeFileSync(path.join(worktree, "fake.png"), `plain text ${SECRET}`);
    const error = (await ask(["ok.png", "fake.png"]).catch((e: unknown) => e)) as BridgeError;
    expect(error).toBeInstanceOf(BridgeError);
    expect(error.code).toBe("attachment_error");
    expect(error.message).toContain('"fake.png"');
    expect(error.message).not.toContain(SECRET);
    expect(resolved).toEqual(["ok.png", "fake.png"]);
    expect(spooled()).toEqual([]);
  });

  it("drops the spool with a question cancelled before it was ever published", async () => {
    writeImage("shot.png");
    const b = bridge();
    const asked = await b.registerQuestion({
      origin: origin(),
      input: { question: "Ship it?", attachments: [{ local_resource_id: "shot.png" }] },
    });
    expect(spooled()).toHaveLength(1);
    await b.cancelQuestion(asked.questionId, paneIdentityOf(origin()));
    expect((await store.getQuestion(asked.questionId))?.local_status).toBe("cancelled");
    expect(spooled()).toEqual([]);
  });
});
