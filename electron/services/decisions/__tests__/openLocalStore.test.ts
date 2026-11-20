import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getSharedDb: vi.fn(),
  getSharedSqlite: vi.fn(),
}));

vi.mock("../../persistence/db.js", () => ({
  ...db,
  withDiskRecovery: <T>(_sqlite: unknown, fn: () => T): T => fn(),
}));

import { STORE_FORMAT, STORE_FORMAT_KEY, StoreFormatError } from "@daintreehq/decisions-client";
import { DaintreeLocalStore } from "../daintreeLocalStore.js";
import { openDecisionsLocalStore } from "../openLocalStore.js";

describe("openDecisionsLocalStore", () => {
  beforeEach(() => {
    db.getSharedDb.mockReset();
    db.getSharedSqlite.mockReset();
  });

  it("never opens the app database for a lifetime that ended while it loaded", async () => {
    let cancelled = false;
    const opening = openDecisionsLocalStore(() => cancelled);
    cancelled = true;

    expect(await opening).toBeNull();
    expect(db.getSharedDb).not.toHaveBeenCalled();
    expect(db.getSharedSqlite).not.toHaveBeenCalled();
  });

  it("opens the shared database and builds the store over its connection", async () => {
    const sqlite = {
      prepare: vi.fn(() => ({
        get: (key: string) =>
          key === STORE_FORMAT_KEY ? undefined : { value: "from the shared connection" },
      })),
    };
    db.getSharedSqlite.mockReturnValue(sqlite);

    const store = await openDecisionsLocalStore(() => false);

    expect(db.getSharedDb).toHaveBeenCalledTimes(1);
    expect(store).toBeInstanceOf(DaintreeLocalStore);
    expect(await store!.getMeta("k")).toBe("from the shared connection");
  });

  it.each([
    ["a newer client's format", String(STORE_FORMAT + 1)],
    ["a marker that is no format", "two"],
  ])(
    "refuses a store holding %s, before anything reads it (0.9.0, #17939)",
    async (_label, raw) => {
      const prepare = vi.fn(() => ({
        get: (key: string) => (key === STORE_FORMAT_KEY ? { value: raw } : undefined),
      }));
      db.getSharedSqlite.mockReturnValue({ prepare });

      await expect(openDecisionsLocalStore(() => false)).rejects.toBeInstanceOf(StoreFormatError);
      expect(prepare).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ["no marker, as 0.8.0 left it", undefined],
    ["the format before formats were marked", "0"],
    ["0.9.0's own format", String(STORE_FORMAT)],
  ])("opens a store with %s", async (_label, raw) => {
    db.getSharedSqlite.mockReturnValue({
      prepare: () => ({
        get: (key: string) =>
          key === STORE_FORMAT_KEY && raw !== undefined ? { value: raw } : undefined,
      }),
    });

    expect(await openDecisionsLocalStore(() => false)).toBeInstanceOf(DaintreeLocalStore);
  });

  it("fails rather than run without a database", async () => {
    db.getSharedSqlite.mockReturnValue(null);

    await expect(openDecisionsLocalStore(() => false)).rejects.toThrow("app database");
  });
});
