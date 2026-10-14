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

import { openDb } from "../../../services/persistence/db.js";
import { AssistantExchangeStore } from "../AssistantExchangeStore.js";
import type { ExchangeKey, ReceiverActor, SenderActor } from "../types.js";
import { exchangeWakeSink } from "../wakeSink.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../services/persistence/migrations");

const shell: SenderActor = { kind: "sender", senderId: "shell-a" };
const lane: ReceiverActor = {
  kind: "receiver",
  hostId: "host-1",
  laneId: "lane-assistant",
  enrollmentGeneration: "gen-1",
};
const key: ExchangeKey = { senderId: "shell-a", messageId: "msg-1" };

describe("exchangeWakeSink", () => {
  let tmpDir: string;
  let sqlite: Database.Database;
  let store: AssistantExchangeStore;
  let clock: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-wake-sink-"));
    sqlite = openDb(path.join(tmpDir, "exchange.db"), migrationsFolder).sqlite;
    clock = 1_000_000;
    store = new AssistantExchangeStore(sqlite, { now: () => clock });
    store.create(shell, {
      messageId: "msg-1",
      contextId: "ctx-1",
      referenceTaskIds: [],
      receiver: { hostId: lane.hostId, laneId: lane.laneId, enrollmentGeneration: "gen-1" },
      body: "hello",
    });
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reserves the attempt once, so a second wake for the same exchange is never typed", () => {
    const sink = exchangeWakeSink(store, lane, key);
    expect(sink.beforeType()).toBe(true);
    expect(store.get(lane, key)?.delivery.attemptedAt).toBe(clock);
    expect(exchangeWakeSink(store, lane, key).beforeType()).toBe(false);
  });

  it("refuses to reserve an exchange this lane can't see", () => {
    const other: ReceiverActor = { ...lane, enrollmentGeneration: "gen-2" };
    expect(exchangeWakeSink(store, other, key).beforeType()).toBe(false);
  });

  it("records a typed wake as the wake-typed fact", () => {
    const sink = exchangeWakeSink(store, lane, key);
    sink.beforeType();
    clock += 10;
    sink.report({ kind: "delivered" });
    expect(store.get(lane, key)?.delivery.wakeTypedAt).toBe(clock);
  });

  it("records an ambiguous wake without changing the state", () => {
    const sink = exchangeWakeSink(store, lane, key);
    sink.beforeType();
    sink.report({ kind: "ambiguous", reason: "unconfirmed" });
    const record = store.get(lane, key);
    expect(record?.delivery.ambiguousAt).toBe(clock);
    expect(record?.state).toBe("submitted");
  });

  it.each([
    [{ kind: "held", reason: "typing" }, "wake-held"],
    [{ kind: "held", reason: "expired" }, "wake-expired"],
    [{ kind: "unavailable", reason: "not-enrolled" }, "wake-unavailable"],
  ] as const)("records %o as outcome %s beside the current state", (outcome, code) => {
    exchangeWakeSink(store, lane, key).report(outcome);
    const record = store.get(lane, key);
    expect(record?.outcome).toBe(code);
    expect(record?.state).toBe("submitted");
  });

  it("leaves a finished exchange's outcome alone", () => {
    store.setState(lane, key, "failed", "lane-gone");
    exchangeWakeSink(store, lane, key).report({ kind: "unavailable", reason: "stopped" });
    expect(store.get(lane, key)?.outcome).toBe("lane-gone");
  });
});
