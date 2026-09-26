import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMockHost } from "../createMockHost.js";

// The mock resolves a database the way the real host does, so a plugin's own
// tests see the same refusals production would give.
let base: string;
let directory: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "mock-host-db-"));
  directory = path.join(base, "databases");
  fs.mkdirSync(directory);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("createMockHost host.db location parity", () => {
  it("refuses a symlinked database file, readonly or not", async () => {
    const elsewhere = path.join(base, "elsewhere.db");
    fs.writeFileSync(elsewhere, "");
    fs.symlinkSync(elsewhere, path.join(directory, "ledger.db"));
    const host = createMockHost({ databases: { directory } });
    await expect(host.db.resolve("ledger", { readonly: true })).rejects.toMatchObject({
      code: "TARGET_IS_SYMLINK",
    });
    await expect(host.db.open("ledger")).rejects.toMatchObject({ code: "TARGET_IS_SYMLINK" });
  });

  it("refuses something at the database's name that is not a regular file", async () => {
    fs.mkdirSync(path.join(directory, "ledger.db"));
    const host = createMockHost({ databases: { directory } });
    await expect(host.db.resolve("ledger", { readonly: true })).rejects.toMatchObject({
      code: "TARGET_UNAVAILABLE",
    });
  });

  it("refuses to reopen through a directory swapped for a link", async () => {
    const host = createMockHost({ databases: { directory } });
    const db = await host.db.open("ledger", { migrations: ["CREATE TABLE t (x INTEGER)"] });
    await db.run("INSERT INTO t VALUES (1)");
    const other = path.join(base, "other");
    fs.mkdirSync(other);
    fs.copyFileSync(path.join(directory, "ledger.db"), path.join(other, "ledger.db"));
    fs.renameSync(directory, `${directory}-moved`);
    fs.symlinkSync(other, directory);
    await expect(db.query("SELECT x FROM t")).rejects.toMatchObject({
      code: "TARGET_UNAVAILABLE",
    });
    await db.close();
  });
});
