import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  backupFileStem,
  backupPluginData,
  backupTimestamp,
  PluginDataBackupError,
  type PluginDataBackupPicker,
  type PluginDataBackupSource,
} from "../pluginDataBackup.js";
import type { PluginDatabaseDeclaration } from "../pluginDatabase.js";

// Runs once the snapshot is written and before the backup publishes it — the
// window in which another process can start using the destination.
const { afterSnapshot } = vi.hoisted(() => ({
  afterSnapshot: { run: null as (() => void) | null },
}));
vi.mock("../pluginDatabase.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pluginDatabase.js")>();
  return {
    ...actual,
    openPluginDatabase: async (...args: Parameters<typeof actual.openPluginDatabase>) => {
      const database = await actual.openPluginDatabase(...args);
      const backup = database.backup;
      database.backup = async (destPath) => {
        const result = await backup(destPath);
        const hook = afterSnapshot.run;
        afterSnapshot.run = null;
        hook?.();
        return result;
      };
      return database;
    },
  };
});

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// Local time, so the expected stamp is the one a user in any zone would see.
const NOW = new Date(2026, 8, 26, 14, 5, 9);
const STAMP = "2026-09-26_140509";

let root: string;
let projectRoot: string;
let dataDir: string;
let downloads: string;

const local = (id: string): PluginDatabaseDeclaration => ({
  id,
  location: "local",
  journalMode: "delete",
});
const project = (id: string, dbPath?: string): PluginDatabaseDeclaration => ({
  id,
  location: "project",
  journalMode: "delete",
  ...(dbPath ? { path: dbPath } : {}),
});

function source(
  declarations: PluginDatabaseDeclaration[],
  overrides: Partial<PluginDataBackupSource> = {}
): PluginDataBackupSource {
  return {
    manifestId: "acme.ledger",
    displayName: "Ledger",
    declarations,
    projectRoot,
    dataDir,
    ...overrides,
  };
}

function seed(file: string, rows: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO entries (label) VALUES (?)");
  for (const row of rows) insert.run(row);
  db.close();
}

function readLabels(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT label FROM entries ORDER BY id").all() as { label: string }[]).map(
      (row) => row.label
    );
  } finally {
    db.close();
  }
}

const localDb = (id: string) => path.join(dataDir, "databases", `${id}.db`);

function picker(answers: { file?: string | null; folder?: string | null } = {}) {
  return {
    chooseFile: vi.fn<PluginDataBackupPicker["chooseFile"]>(async () => answers.file ?? null),
    chooseFolder: vi.fn<PluginDataBackupPicker["chooseFolder"]>(async () => answers.folder ?? null),
  };
}

/** Every entry under `dir`, so a test can prove nothing extra was written. */
function listTree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

beforeEach(async () => {
  root = await fsp.realpath(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-backup-")));
  projectRoot = path.join(root, "project");
  dataDir = path.join(root, "plugin-data", "acme.ledger");
  downloads = path.join(root, "Downloads");
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(downloads);
});

afterEach(() => {
  afterSnapshot.run = null;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("backupPluginData", () => {
  it("reports no data, asks nothing and creates nothing when no database exists yet", async () => {
    const pick = picker({ file: path.join(downloads, "x.db"), folder: downloads });
    const outcome = await backupPluginData(
      source([local("ledger"), project("notes"), project("board", "data/board.db")]),
      pick,
      { downloadsDir: downloads, now: NOW }
    );

    expect(outcome).toEqual({ status: "no-data", pluginName: "Ledger" });
    expect(pick.chooseFile).not.toHaveBeenCalled();
    expect(pick.chooseFolder).not.toHaveBeenCalled();
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(listTree(projectRoot)).toEqual([]);
    expect(listTree(downloads)).toEqual([]);
  });

  it("skips a project database for a plugin with no project instead of failing", async () => {
    seed(localDb("cache"), ["a"]);
    const target = path.join(downloads, "cache.db");
    const outcome = await backupPluginData(
      source([project("notes"), local("cache")], { projectRoot: null }),
      picker({ file: target }),
      { downloadsDir: downloads, now: NOW }
    );

    expect(outcome).toEqual({ status: "saved", pluginName: "Ledger", paths: [target] });
  });

  it("snapshots one database to the chosen file, defaulting to a timestamped name in Downloads", async () => {
    seed(localDb("ledger"), ["rent", "coffee", "books"]);
    const target = path.join(downloads, "chosen.db");
    const pick = picker({ file: target });

    const outcome = await backupPluginData(source([local("ledger"), local("unused")]), pick, {
      downloadsDir: downloads,
      now: NOW,
    });

    expect(pick.chooseFile).toHaveBeenCalledWith(
      path.join(downloads, `acme.ledger-ledger-${STAMP}.db`)
    );
    expect(pick.chooseFolder).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "saved", pluginName: "Ledger", paths: [target] });
    expect(readLabels(target)).toEqual(["rent", "coffee", "books"]);
    // The staging directory is gone once the snapshot is renamed into place.
    expect(listTree(downloads)).toEqual(["chosen.db"]);
    expect(readLabels(localDb("ledger"))).toEqual(["rent", "coffee", "books"]);
  });

  it("publishes a whole snapshot, never a partial copy, on a disk without hard links", async () => {
    seed(localDb("ledger"), ["rent", "coffee"]);
    const target = path.join(downloads, "chosen.db");
    const link = vi
      .spyOn(fsp, "link")
      .mockRejectedValue(Object.assign(new Error("no links here"), { code: "EPERM" }));
    try {
      const outcome = await backupPluginData(source([local("ledger")]), picker({ file: target }), {
        downloadsDir: downloads,
        now: NOW,
      });
      expect(outcome).toEqual({ status: "saved", pluginName: "Ledger", paths: [target] });
    } finally {
      link.mockRestore();
    }
    expect(readLabels(target)).toEqual(["rent", "coffee"]);
    expect(listTree(downloads)).toEqual(["chosen.db"]);
  });

  it("copies only committed rows while another connection is mid-transaction", async () => {
    const live = localDb("ledger");
    seed(live, ["rent"]);
    const writer = new DatabaseSync(live);
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("INSERT INTO entries (label) VALUES ('pending')");
    const target = path.join(downloads, "snapshot.db");
    try {
      await backupPluginData(source([local("ledger")]), picker({ file: target }), {
        downloadsDir: downloads,
        now: NOW,
      });
    } finally {
      writer.exec("COMMIT");
      writer.close();
    }

    expect(readLabels(target)).toEqual(["rent"]);
    expect(readLabels(live)).toEqual(["rent", "pending"]);
  });

  it("includes commits still in a WAL database's log, and leaves the source in WAL mode", async () => {
    const live = localDb("ledger");
    fs.mkdirSync(path.dirname(live), { recursive: true });
    const writer = new DatabaseSync(live);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    writer.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
    writer.exec("INSERT INTO entries (label) VALUES ('rent'), ('coffee')");
    // Committed but not checkpointed: the rows live only in the -wal file.
    expect(fs.statSync(`${live}-wal`).size).toBeGreaterThan(0);
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("INSERT INTO entries (label) VALUES ('pending')");
    const target = path.join(downloads, "wal-copy.db");
    try {
      await backupPluginData(
        source([{ id: "ledger", location: "local", journalMode: "wal" }]),
        picker({ file: target }),
        { downloadsDir: downloads, now: NOW }
      );
    } finally {
      writer.exec("COMMIT");
    }

    expect(readLabels(target)).toEqual(["rent", "coffee"]);
    const copy = new DatabaseSync(target, { readOnly: true });
    expect(copy.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    copy.close();
    expect(writer.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    writer.close();
  });

  it("copies a project database from where the manifest puts it", async () => {
    seed(path.join(projectRoot, "data", "board.db"), ["todo"]);
    const target = path.join(downloads, "board.db");

    await backupPluginData(source([project("board", "data/board.db")]), picker({ file: target }), {
      downloadsDir: downloads,
      now: NOW,
    });

    expect(readLabels(target)).toEqual(["todo"]);
  });

  it("returns cancelled and writes nothing when the dialog is dismissed", async () => {
    seed(localDb("ledger"), ["rent"]);
    const outcome = await backupPluginData(source([local("ledger")]), picker({ file: null }), {
      downloadsDir: downloads,
      now: NOW,
    });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(listTree(downloads)).toEqual([]);
  });

  it("writes one timestamped file per existing database into the chosen folder", async () => {
    seed(localDb("ledger"), ["rent"]);
    seed(localDb("budget"), ["food", "travel"]);
    const folder = path.join(downloads, "backups");
    fs.mkdirSync(folder);
    const pick = picker({ folder });

    const outcome = await backupPluginData(
      source([local("ledger"), local("never-created"), local("budget")], {
        manifestId: "@acme/ledger",
      }),
      pick,
      { downloadsDir: downloads, now: NOW }
    );

    expect(pick.chooseFolder).toHaveBeenCalledWith(downloads);
    expect(pick.chooseFile).not.toHaveBeenCalled();
    const ledgerCopy = path.join(folder, `acme-ledger-ledger-${STAMP}.db`);
    const budgetCopy = path.join(folder, `acme-ledger-budget-${STAMP}.db`);
    expect(outcome).toEqual({
      status: "saved",
      pluginName: "Ledger",
      paths: [ledgerCopy, budgetCopy],
    });
    expect(readLabels(ledgerCopy)).toEqual(["rent"]);
    expect(readLabels(budgetCopy)).toEqual(["food", "travel"]);
    expect(listTree(folder)).toEqual([path.basename(budgetCopy), path.basename(ledgerCopy)].sort());
  });

  it("returns cancelled when the folder dialog is dismissed", async () => {
    seed(localDb("ledger"), ["rent"]);
    seed(localDb("budget"), ["food"]);
    const outcome = await backupPluginData(
      source([local("ledger"), local("budget")]),
      picker({ folder: null }),
      { downloadsDir: downloads, now: NOW }
    );

    expect(outcome).toEqual({ status: "cancelled" });
    expect(listTree(downloads)).toEqual([]);
  });

  it("refuses to write the backup over the database itself", async () => {
    const live = localDb("ledger");
    seed(live, ["rent", "coffee"]);

    const attempt = backupPluginData(source([local("ledger")]), picker({ file: live }), {
      downloadsDir: downloads,
      now: NOW,
    });

    await expect(attempt).rejects.toBeInstanceOf(PluginDataBackupError);
    await expect(attempt).rejects.toMatchObject({ code: "DESTINATION_IS_SOURCE" });
    expect(readLabels(live)).toEqual(["rent", "coffee"]);
    expect(fs.readdirSync(path.dirname(live))).toEqual(["ledger.db"]);
  });

  it("refuses the database itself under another name, such as a hard link", async () => {
    const live = localDb("ledger");
    seed(live, ["rent"]);
    const alias = path.join(downloads, "alias.db");
    fs.linkSync(live, alias);

    await expect(
      backupPluginData(source([local("ledger")]), picker({ file: alias }), {
        downloadsDir: downloads,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "DESTINATION_IS_SOURCE" });
    expect(readLabels(live)).toEqual(["rent"]);
  });

  it("never replaces a file already in the chosen folder, and says how far it got", async () => {
    seed(localDb("ledger"), ["rent"]);
    seed(localDb("budget"), ["food"]);
    const clash = path.join(downloads, `acme.ledger-budget-${STAMP}.db`);
    fs.writeFileSync(clash, "not a database");

    const attempt = backupPluginData(
      source([local("ledger"), local("budget")]),
      picker({ folder: downloads }),
      { downloadsDir: downloads, now: NOW }
    );

    await expect(attempt).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
    await expect(attempt).rejects.toThrow(/1 of 2 databases were saved/);
    expect(fs.readFileSync(clash, "utf8")).toBe("not a database");
    expect(readLabels(path.join(downloads, `acme.ledger-ledger-${STAMP}.db`))).toEqual(["rent"]);
  });

  it("won't write where a leftover journal would be replayed into the copy", async () => {
    seed(localDb("ledger"), ["rent"]);
    const target = path.join(downloads, "old.db");
    fs.writeFileSync(target, "previous backup");
    fs.writeFileSync(`${target}-wal`, "stale log");

    await expect(
      backupPluginData(source([local("ledger")]), picker({ file: target }), {
        downloadsDir: downloads,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "DESTINATION_HAS_JOURNAL" });
    expect(fs.readFileSync(target, "utf8")).toBe("previous backup");
    expect(listTree(downloads)).toEqual(["old.db", "old.db-wal"]);
  });

  it("won't write over a database with a hot journal from an unfinished transaction", async () => {
    seed(localDb("ledger"), ["rent"]);
    const target = path.join(downloads, "old.db");
    seed(target, ["previous backup"]);
    const writer = new DatabaseSync(target);
    writer.exec("BEGIN IMMEDIATE; UPDATE entries SET label = 'half-written'");
    try {
      expect(fs.existsSync(`${target}-journal`)).toBe(true);
      await expect(
        backupPluginData(source([local("ledger")]), picker({ file: target }), {
          downloadsDir: downloads,
          now: NOW,
        })
      ).rejects.toMatchObject({ code: "DESTINATION_HAS_JOURNAL" });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    expect(readLabels(target)).toEqual(["previous backup"]);
  });

  it("refuses the database's own journal names as the destination", async () => {
    const live = localDb("ledger");
    seed(live, ["rent"]);
    for (const suffix of ["-journal", "-wal"]) {
      await expect(
        backupPluginData(source([local("ledger")]), picker({ file: `${live}${suffix}` }), {
          downloadsDir: downloads,
          now: NOW,
        })
      ).rejects.toMatchObject({ code: "DESTINATION_IS_SOURCE" });
    }
    expect(fs.readdirSync(path.dirname(live))).toEqual(["ledger.db"]);
  });

  it("refuses another database's journal name as the destination", async () => {
    seed(localDb("ledger"), ["rent"]);
    const target = path.join(downloads, "other.db-wal");
    fs.writeFileSync(target, "another database's log");
    await expect(
      backupPluginData(source([local("ledger")]), picker({ file: target }), {
        downloadsDir: downloads,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "DESTINATION_IS_JOURNAL" });
    expect(fs.readFileSync(target, "utf8")).toBe("another database's log");
  });

  it("won't publish over a file that appeared at the destination during the snapshot", async () => {
    seed(localDb("ledger"), ["rent"]);
    const target = path.join(downloads, "new.db");
    afterSnapshot.run = () => fs.writeFileSync(target, "someone else's file");

    await expect(
      backupPluginData(source([local("ledger")]), picker({ file: target }), {
        downloadsDir: downloads,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
    expect(fs.readFileSync(target, "utf8")).toBe("someone else's file");
    expect(listTree(downloads)).toEqual(["new.db"]);
  });

  it("won't replace a destination another process started using during the snapshot", async () => {
    seed(localDb("ledger"), ["rent"]);
    const target = path.join(downloads, "old.db");
    seed(target, ["previous backup"]);
    let other: InstanceType<typeof DatabaseSync> | null = null;
    afterSnapshot.run = () => {
      other = new DatabaseSync(target);
      other.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      other.exec("INSERT INTO entries (label) VALUES ('new work')");
    };

    try {
      await expect(
        backupPluginData(source([local("ledger")]), picker({ file: target }), {
          downloadsDir: downloads,
          now: NOW,
        })
      ).rejects.toMatchObject({ code: "DESTINATION_HAS_JOURNAL" });
    } finally {
      (other as InstanceType<typeof DatabaseSync> | null)?.close();
    }
    expect(readLabels(target)).toEqual(["previous backup", "new work"]);
  });

  it("won't replace a destination that was swapped for another file during the snapshot", async () => {
    seed(localDb("ledger"), ["rent"]);
    const target = path.join(downloads, "old.db");
    fs.writeFileSync(target, "previous backup");
    afterSnapshot.run = () => {
      fs.writeFileSync(`${target}.next`, "a newer file");
      fs.renameSync(`${target}.next`, target);
    };

    await expect(
      backupPluginData(source([local("ledger")]), picker({ file: target }), {
        downloadsDir: downloads,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
    expect(fs.readFileSync(target, "utf8")).toBe("a newer file");
  });

  it("replaces a file the save dialog already agreed to replace", async () => {
    seed(localDb("ledger"), ["rent"]);
    const target = path.join(downloads, "old.db");
    fs.writeFileSync(target, "previous backup");

    await backupPluginData(source([local("ledger")]), picker({ file: target }), {
      downloadsDir: downloads,
      now: NOW,
    });

    expect(readLabels(target)).toEqual(["rent"]);
    expect(listTree(downloads)).toEqual(["old.db"]);
  });

  it("re-proves where the source is after the dialog, refusing a directory swapped for a link", async () => {
    seed(localDb("ledger"), ["rent"]);
    const outside = path.join(root, "outside");
    seed(path.join(outside, "ledger.db"), ["not this plugin's"]);
    const databasesDir = path.dirname(localDb("ledger"));
    const target = path.join(downloads, "copy.db");
    const swapping: PluginDataBackupPicker = {
      chooseFile: async () => {
        fs.renameSync(databasesDir, `${databasesDir}-moved`);
        fs.symlinkSync(outside, databasesDir);
        return target;
      },
      chooseFolder: async () => null,
    };

    await expect(
      backupPluginData(source([local("ledger")]), swapping, { downloadsDir: downloads, now: NOW })
    ).rejects.toThrow(/isn't a plain file where Ledger keeps it/);
    expect(listTree(downloads)).toEqual([]);
  });

  it("fails without copying anything when a database file is a symlink", async () => {
    const elsewhere = path.join(root, "elsewhere.db");
    seed(elsewhere, ["secret"]);
    fs.mkdirSync(path.join(dataDir, "databases"), { recursive: true });
    fs.symlinkSync(elsewhere, localDb("ledger"));
    const pick = picker({ file: path.join(downloads, "x.db") });

    await expect(
      backupPluginData(source([local("ledger")]), pick, { downloadsDir: downloads, now: NOW })
    ).rejects.toThrow(/Database "ledger" isn't a plain file where Ledger keeps it/);
    expect(pick.chooseFile).not.toHaveBeenCalled();
    expect(listTree(downloads)).toEqual([]);
  });
});

describe("backup file naming", () => {
  it("stamps local time sortably and without characters a file name can't hold", () => {
    expect(backupTimestamp(NOW)).toBe(STAMP);
    expect(backupTimestamp(new Date(2027, 0, 2, 3, 4, 5))).toBe("2027-01-02_030405");
  });

  it("flattens a manifest id into a single file-name segment", () => {
    expect(backupFileStem("acme.ledger")).toBe("acme.ledger");
    expect(backupFileStem("@acme/ledger")).toBe("acme-ledger");
    expect(backupFileStem("../..")).toBe("plugin");
  });
});
