import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePluginDatabaseLocation } from "../pluginDatabase.js";

let tmp: string;
let projectRoot: string;
let dataDir: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-db-resolve-")));
  projectRoot = path.join(tmp, "project");
  dataDir = path.join(tmp, "data", "project__p1__acme.ledger");
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const resolve = (declaration: Parameters<typeof resolvePluginDatabaseLocation>[0]["declaration"]) =>
  resolvePluginDatabaseLocation({ declaration, manifestId: "acme.ledger", projectRoot, dataDir });

describe("resolvePluginDatabaseLocation", () => {
  it("defaults a project database under .daintree/data/<manifestId>/ and creates the directory", async () => {
    const location = await resolve({ id: "ledger", location: "project", journalMode: "delete" });
    expect(location).toEqual({
      id: "ledger",
      location: "project",
      path: path.join(projectRoot, ".daintree/data/acme.ledger/ledger.db"),
      projectRelativePath: ".daintree/data/acme.ledger/ledger.db",
      journalMode: "delete",
    });
    expect(fs.statSync(path.dirname(location.path)).isDirectory()).toBe(true);
  });

  it("honours a declared project path", async () => {
    const location = await resolve({
      id: "ledger",
      location: "project",
      path: "data/finance.db",
      journalMode: "wal",
    });
    expect(location.projectRelativePath).toBe("data/finance.db");
    expect(location.journalMode).toBe("wal");
  });

  it("puts a local database in the plugin data dir", async () => {
    const location = await resolve({ id: "cache", location: "local", journalMode: "delete" });
    expect(location.path).toBe(path.join(fs.realpathSync(dataDir), "databases/cache.db"));
    expect(location.projectRelativePath).toBeNull();
  });

  it("refuses a committed symlinked directory that escapes the project", async () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(projectRoot, "data"));
    await expect(
      resolve({
        id: "ledger",
        location: "project",
        path: "data/sub/finance.db",
        journalMode: "delete",
      })
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(fs.existsSync(path.join(outside, "sub"))).toBe(false);
  });

  it("refuses a symlinked database file", async () => {
    fs.mkdirSync(path.join(projectRoot, "data"));
    fs.writeFileSync(path.join(tmp, "elsewhere.db"), "");
    fs.symlinkSync(path.join(tmp, "elsewhere.db"), path.join(projectRoot, "data/finance.db"));
    await expect(
      resolve({ id: "ledger", location: "project", path: "data/finance.db", journalMode: "delete" })
    ).rejects.toMatchObject({ code: "TARGET_IS_SYMLINK" });
  });

  it("refuses a link that lands the database inside .git, whatever the case", async () => {
    fs.mkdirSync(path.join(projectRoot, ".git"));
    fs.symlinkSync(path.join(projectRoot, ".git"), path.join(projectRoot, "data"));
    await expect(
      resolve({ id: "ledger", location: "project", path: "data/finance.db", journalMode: "delete" })
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(
      resolve({ id: "ledger", location: "project", path: ".GIT/finance.db", journalMode: "delete" })
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("requires a project for a project database", async () => {
    await expect(
      resolvePluginDatabaseLocation({
        declaration: { id: "ledger", location: "project", journalMode: "delete" },
        manifestId: "acme.ledger",
        projectRoot: null,
        dataDir,
      })
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
  });
});
