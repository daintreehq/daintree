import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getSharedDb: vi.fn(),
  getSharedSqlite: vi.fn(),
}));

vi.mock("../../persistence/db.js", () => ({
  ...db,
  withDiskRecovery: <T>(_sqlite: unknown, fn: () => T): T => fn(),
}));

import { DaintreeLocalStore } from "../daintreeLocalStore.js";
import { openDecisionsLocalStore } from "../openLocalStore.js";

describe("openDecisionsLocalStore", () => {
  beforeEach(() => {
    db.getSharedDb.mockReset();
    db.getSharedSqlite.mockReset();
  });

  it("never opens the app database for a lifetime that ended while it loaded", async () => {
    expect(await openDecisionsLocalStore(() => true)).toBeNull();

    expect(db.getSharedDb).not.toHaveBeenCalled();
    expect(db.getSharedSqlite).not.toHaveBeenCalled();
  });

  it("opens the shared database and builds the store over its connection", async () => {
    const sqlite = { open: true };
    db.getSharedSqlite.mockReturnValue(sqlite);

    const store = await openDecisionsLocalStore(() => false);

    expect(db.getSharedDb).toHaveBeenCalledTimes(1);
    expect(store).toBeInstanceOf(DaintreeLocalStore);
  });

  it("fails rather than run without a database", async () => {
    db.getSharedSqlite.mockReturnValue(null);

    await expect(openDecisionsLocalStore(() => false)).rejects.toThrow("app database");
  });
});
