import Database from "better-sqlite3";
import { build } from "esbuild";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbWorkerOp, DbWorkerResponse } from "../dbWorkerProtocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const AUDIT_RINGS_DDL = `
  CREATE TABLE audit_rings (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    ring text NOT NULL,
    record text NOT NULL,
    created_at integer NOT NULL
  );
`;

let bundleDir: string;
let workerFile: string;

// Bundle the TS worker entry once for the suite — the production bundle is
// emitted by scripts/build-main.mjs; this mirrors it just enough to spawn the
// real thread. better-sqlite3 stays external, pinned to its absolute path so
// the bundle resolves it from os.tmpdir().
beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-db-worker-"));
  workerFile = path.join(bundleDir, "dbMaintenanceWorker.mjs");
  await build({
    entryPoints: [path.resolve(__dirname, "../dbMaintenanceWorker.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: workerFile,
    logLevel: "silent",
    plugins: [
      {
        name: "external-better-sqlite3",
        setup(builder) {
          builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
            path: pathToFileURL(require.resolve("better-sqlite3")).href,
            external: true,
          }));
        },
      },
    ],
  });
});

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

let nextRequestId = 1;

function request(worker: Worker, op: DbWorkerOp, fence = 0): Promise<DbWorkerResponse> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const onMessage = (response: DbWorkerResponse) => {
      if (response.id !== id) return;
      cleanup();
      resolve(response);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.postMessage({ ...op, id, fence });
  });
}

describe("dbMaintenanceWorker (real worker thread)", () => {
  let tmpDir: string;
  let dbPath: string;
  let mainDb: Database.Database;
  let worker: Worker | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-db-worker-db-"));
    dbPath = path.join(tmpDir, "test.db");
    mainDb = new Database(dbPath);
    mainDb.pragma("journal_mode = WAL");
    mainDb.pragma("busy_timeout = 3000");
    mainDb.exec(AUDIT_RINGS_DDL);
    worker = null;
  });

  afterEach(async () => {
    if (worker) {
      const w = worker;
      worker = null;
      await new Promise<void>((resolve) => {
        w.once("exit", () => resolve());
        request(w, { op: "close" }).catch(() => {});
        setTimeout(() => void w.terminate().then(() => resolve()), 2000).unref();
      });
    }
    mainDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function spawn(targetDbPath = dbPath): Worker {
    const w = new Worker(pathToFileURL(workerFile), { workerData: { dbPath: targetDbPath } });
    worker = w;
    return w;
  }

  it("truncates the WAL on checkpoint while the main connection stays open", async () => {
    const insert = mainDb.prepare(
      "INSERT INTO audit_rings (ring, record, created_at) VALUES (?, ?, ?)"
    );
    for (let i = 0; i < 500; i++) {
      insert.run("wal-growth", JSON.stringify({ i }), Date.now());
    }
    const walPath = dbPath + "-wal";
    expect(fs.statSync(walPath).size).toBeGreaterThan(0);

    const w = spawn();
    const response = await request(w, { op: "checkpoint", mode: "TRUNCATE" });
    expect(response.ok).toBe(true);
    expect(fs.statSync(walPath).size).toBe(0);

    // Main connection still fully usable after the worker checkpointed.
    const count = mainDb.prepare("SELECT COUNT(*) AS n FROM audit_rings").get() as { n: number };
    expect(count.n).toBe(500);
  });

  it("writes ring snapshots that the main connection reads back, honoring the trim cap", async () => {
    const w = spawn();
    const records = ["a", "b", "c", "d", "e"].map((v) => JSON.stringify({ v }));
    const first = await request(w, {
      op: "ringWriteAll",
      ring: "testRing",
      records,
      maxRecords: 3,
    });
    expect(first.ok).toBe(true);

    const rows = mainDb
      .prepare("SELECT record FROM audit_rings WHERE ring = ? ORDER BY id ASC")
      .all("testRing") as { record: string }[];
    expect(rows.map((r) => (JSON.parse(r.record) as { v: string }).v)).toEqual(["c", "d", "e"]);

    // Snapshot semantics: a second write replaces the ring entirely.
    const second = await request(w, {
      op: "ringWriteAll",
      ring: "testRing",
      records: [JSON.stringify({ v: "z" })],
      maxRecords: 3,
    });
    expect(second.ok).toBe(true);
    const after = mainDb
      .prepare("SELECT record FROM audit_rings WHERE ring = ? ORDER BY id ASC")
      .all("testRing") as { record: string }[];
    expect(after.map((r) => (JSON.parse(r.record) as { v: string }).v)).toEqual(["z"]);
  });

  it("no-ops a stale queued ring write once the fence has advanced — newer main data survives", async () => {
    const w = spawn();
    // Baseline snapshot applied through the worker at epoch 0.
    const baseline = await request(w, {
      op: "ringWriteAll",
      ring: "fenced",
      records: [JSON.stringify({ v: "worker-old" })],
      maxRecords: 10,
    });
    expect(baseline).toMatchObject({ ok: true, result: true });

    // Main degrades: it advances the fence, then runs its fallback write
    // (the newer snapshot) directly on the main connection.
    mainDb.pragma("user_version = 1");
    mainDb.transaction(() => {
      mainDb.prepare("DELETE FROM audit_rings WHERE ring = ?").run("fenced");
      mainDb
        .prepare("INSERT INTO audit_rings (ring, record, created_at) VALUES (?, ?, ?)")
        .run("fenced", JSON.stringify({ v: "main-newer" }), Date.now());
    })();

    // The stale write — queued before the degrade, stamped with the old epoch —
    // reaches the worker afterwards. It must no-op.
    const stale = await request(
      w,
      {
        op: "ringWriteAll",
        ring: "fenced",
        records: [JSON.stringify({ v: "worker-stale" })],
        maxRecords: 10,
      },
      0
    );
    expect(stale).toMatchObject({ ok: true, result: false });

    const rows = mainDb
      .prepare("SELECT record FROM audit_rings WHERE ring = ? ORDER BY id ASC")
      .all("fenced") as { record: string }[];
    expect(rows.map((r) => (JSON.parse(r.record) as { v: string }).v)).toEqual(["main-newer"]);

    // A fresh write stamped with the advanced epoch applies again.
    const fresh = await request(
      w,
      {
        op: "ringWriteAll",
        ring: "fenced",
        records: [JSON.stringify({ v: "post-fence" })],
        maxRecords: 10,
      },
      1
    );
    expect(fresh).toMatchObject({ ok: true, result: true });
    const after = mainDb
      .prepare("SELECT record FROM audit_rings WHERE ring = ? ORDER BY id ASC")
      .all("fenced") as { record: string }[];
    expect(after.map((r) => (JSON.parse(r.record) as { v: string }).v)).toEqual(["post-fence"]);
  });

  it("no-ops a ring write that lands after a shutdown-drain fence while main holds the write lock", async () => {
    const w = spawn();

    // Emulate the shutdown-drain-timeout sequence with real lock contention:
    // main opens an immediate transaction (holding the write lock), advances
    // the fence, and writes its final synchronous snapshot; the worker's
    // queued write arrives mid-transaction and blocks on its busy_timeout
    // until main commits — then must see the moved fence and no-op.
    mainDb.exec("BEGIN IMMEDIATE");
    mainDb.pragma("user_version = 1");
    mainDb
      .prepare("INSERT INTO audit_rings (ring, record, created_at) VALUES (?, ?, ?)")
      .run("drain", JSON.stringify({ v: "final-flush" }), Date.now());

    const late = request(
      w,
      {
        op: "ringWriteAll",
        ring: "drain",
        records: [JSON.stringify({ v: "late-worker" })],
        maxRecords: 10,
      },
      0
    );
    // Give the worker a moment to start and block on the held write lock.
    await new Promise((resolve) => setTimeout(resolve, 200));
    mainDb.exec("COMMIT");

    expect(await late).toMatchObject({ ok: true, result: false });
    const rows = mainDb
      .prepare("SELECT record FROM audit_rings WHERE ring = ? ORDER BY id ASC")
      .all("drain") as { record: string }[];
    expect(rows.map((r) => (JSON.parse(r.record) as { v: string }).v)).toEqual(["final-flush"]);
  });

  it("reports quick_check ok on a healthy database", async () => {
    const w = spawn();
    const response = await request(w, { op: "quickCheck" });
    expect(response).toMatchObject({ ok: true, result: "ok" });
  });

  it("probes a healthy file at an arbitrary path, not just its own connection", async () => {
    const candidatePath = path.join(tmpDir, "candidate.db");
    const candidate = new Database(candidatePath);
    candidate.exec(AUDIT_RINGS_DDL);
    candidate.close();

    const w = spawn();
    const response = await request(w, { op: "probePath", dbPath: candidatePath });
    expect(response).toMatchObject({ ok: true, result: "ok" });

    // The probe's handle must be closed — a lingering one would block the
    // rename that promotes this file over the live backup on Windows.
    fs.renameSync(candidatePath, path.join(tmpDir, "promoted.db"));
    expect(fs.existsSync(path.join(tmpDir, "promoted.db"))).toBe(true);
  });

  it("reports a non-SQLite candidate as corrupt", async () => {
    const candidatePath = path.join(tmpDir, "garbage.db");
    fs.writeFileSync(candidatePath, "this is not a sqlite database");

    const w = spawn();
    const response = await request(w, { op: "probePath", dbPath: candidatePath });
    expect(response).toMatchObject({ ok: true, result: "corrupt" });
  });

  it("reports a missing candidate as unverifiable, never as clean", async () => {
    const w = spawn();
    const response = await request(w, {
      op: "probePath",
      dbPath: path.join(tmpDir, "does-not-exist.db"),
    });
    // "unknown", not "ok" — an unverifiable file must never be promoted over the
    // good backup, but it is also not evidence that the live DB is corrupt.
    expect(response).toMatchObject({ ok: true, result: "unknown" });
  });

  it("leaves the live database usable after probing an unrelated path", async () => {
    const candidatePath = path.join(tmpDir, "candidate.db");
    fs.writeFileSync(candidatePath, "not a database");

    const w = spawn();
    await request(w, { op: "probePath", dbPath: candidatePath });

    // A corrupt candidate must not poison the worker's own connection.
    const after = await request(w, { op: "quickCheck" });
    expect(after).toMatchObject({ ok: true, result: "ok" });
  });

  it("responds to close and exits without terminate()", async () => {
    const w = spawn();
    const exited = new Promise<number>((resolve) => w.once("exit", resolve));
    const response = await request(w, { op: "close" });
    expect(response.ok).toBe(true);
    await expect(exited).resolves.toBe(0);
    worker = null;
  });

  it("refuses to create a missing database file", async () => {
    const w = new Worker(pathToFileURL(workerFile), {
      workerData: { dbPath: path.join(tmpDir, "missing.db") },
    });
    const outcome = await new Promise<
      { kind: "error"; code?: string } | { kind: "exit"; code: number }
    >((resolve) => {
      w.once("error", (error: Error & { code?: string }) =>
        resolve({ kind: "error", code: error.code })
      );
      w.once("exit", (code) => resolve({ kind: "exit", code }));
    });
    if (outcome.kind === "error") {
      expect(outcome.code).toBe("SQLITE_CANTOPEN");
    } else {
      expect(outcome.code).not.toBe(0);
    }
    expect(fs.existsSync(path.join(tmpDir, "missing.db"))).toBe(false);
  });
});
