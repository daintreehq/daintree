import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/logger.js")>();
  return {
    ...actual,
    logWarn: vi.fn((...args: Parameters<typeof actual.logWarn>) => logWarn(...args)),
  };
});

import { openDb } from "../../persistence/db.js";
import { resetWritesSuppressedForTesting, setWritesSuppressed } from "../../diskPressureState.js";
import { DaintreeLocalStore } from "../daintreeLocalStore.js";
import { DecisionsService } from "../DecisionsService.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";
import { DISK_FULL_RESTART_DELAYS_MS } from "../storageRecovery.js";
import type { RelayConnectionOptions } from "../relayConnection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

const RELAY = {
  relayOrigin: "https://relay.example.com",
  installationId: "inst_12345678",
  deviceId: "dev_12345678",
};

const event = (seq: number) => ({
  seq,
  event_id: `e${seq}`,
  event_type: "decision.answered",
  json: "{}",
  received_at: 1,
  processed_at: null,
});

let dir: string;
let sqlite: Database.Database;
/** Every service a test made, disposed before the database closes, however the test ended. */
const services: DecisionsService[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-decisions-recovery-"));
  sqlite = openDb(path.join(dir, "app.db"), migrationsFolder).sqlite;
  logWarn.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  resetWritesSuppressedForTesting();
  await Promise.all(services.splice(0).map((made) => made.dispose()));
  if (sqlite.open) sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A service over real stores on one database, its connections recorded and never run. */
function service(checkDiskSpace?: () => Promise<boolean | null>) {
  const made: RelayConnectionOptions[] = [];
  const running = new DecisionsService({
    openStore: async () => new DaintreeLocalStore(sqlite),
    keyFilePath: () => path.join(dir, "keys.bin"),
    connect: (options) => {
      made.push(options);
      return { start: () => {}, stop: () => {} };
    },
    ...(checkDiskSpace ? { checkDiskSpace } : {}),
  });
  services.push(running);
  return { running, made };
}

describe("DecisionsService over real stores, after a disk-space fault (#16605)", () => {
  it("never lets the old store record a refused step as done, and the fresh one still has it to apply", async () => {
    const { running, made } = service();
    await running.start({ ...defaultDecisionsSettings(), enabled: true, ...RELAY });
    const old = running.getStore()!;
    await old.insertEvent(event(1));

    // The library applies the event's answer under pressure, and is refused.
    setWritesSuppressed(true);
    await expect(old.updateQuestion("q1", { local_status: "open" })).rejects.toMatchObject({
      reason: "disk-pressure",
    });
    setWritesSuppressed(false);
    // Its next step marks the event processed: the old store still refuses it.
    await expect(old.markEventProcessed(1, 5)).rejects.toMatchObject({ reason: "disk-pressure" });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("stopped taking writes"),
      expect.objectContaining({ reason: "disk-pressure" })
    );

    expect(await running.diskSpaceRecovered()).toBe(true);

    const fresh = running.getStore()!;
    expect(fresh).not.toBe(old);
    expect(made).toHaveLength(2);
    // Nothing was recorded as done: the fresh store's connection gets the event to apply again.
    expect((await fresh.unprocessedEvents(10)).map((e) => e.seq)).toEqual([1]);
    await fresh.markEventProcessed(1, 5);
    expect(await fresh.unprocessedEvents(10)).toEqual([]);
    await expect(old.setMeta("late", "1")).rejects.toMatchObject({ reason: "closed" });
  });

  it("replaces a store the database ran out of room for, once free space reads fine", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const checks: string[] = [];
    const { running, made } = service(async () => {
      checks.push("check");
      return true;
    });
    await running.start({ ...defaultDecisionsSettings(), enabled: true, ...RELAY });
    const old = running.getStore()!;
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const pages = Number(sqlite.pragma("page_count", { simple: true }));
    sqlite.pragma(`max_page_count = ${pages}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(old.setMeta("big", "x".repeat(64 * 1024))).rejects.toMatchObject({
      reason: "disk-full",
    });
    sqlite.pragma(`max_page_count = ${pages * 1000}`);
    await vi.advanceTimersByTimeAsync(DISK_FULL_RESTART_DELAYS_MS[0]!);

    // Detached (null) mid-restart isn't replaced yet: wait for the fresh store and its connection.
    await vi.waitFor(() => {
      expect(running.getStore()).not.toBeNull();
      expect(running.getStore()).not.toBe(old);
      expect(made).toHaveLength(2);
    });
    expect(checks).toEqual(["check"]);
    const fresh = running.getStore()!;
    await fresh.setMeta("small", "1");
    expect(await fresh.getMeta("small")).toBe("1");
    warn.mockRestore();
  });

  it("keeps a store stopped by any other database failure stopped", async () => {
    const { running, made } = service(async () => true);
    await running.start({ ...defaultDecisionsSettings(), enabled: true, ...RELAY });
    const old = running.getStore()!;
    sqlite.function("refuse_with_io_error", () => {
      throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR_WRITE" });
    });
    sqlite.exec(`CREATE TRIGGER io_probe BEFORE INSERT ON decisions_meta
      WHEN NEW.key = 'broken' BEGIN SELECT refuse_with_io_error(); END`);

    await expect(old.setMeta("broken", "1")).rejects.toMatchObject({ reason: "storage-fault" });

    expect(await running.diskSpaceRecovered()).toBe(false);
    expect(running.getStore()).toBe(old);
    expect(made).toHaveLength(1);
  });
});
