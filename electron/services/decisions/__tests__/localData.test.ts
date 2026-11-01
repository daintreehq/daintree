import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every rename and directory sync, in order, beside the rows' own steps.
const fsFaults = vi.hoisted(() => ({
  rename: null as null | ((src: string) => boolean),
  /** Fails the directory syncs whose 1-based call numbers it picks. */
  syncFailOn: null as null | ((call: number) => boolean),
  syncCalls: 0,
  log: [] as string[],
}));

vi.mock("../../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/fs.js")>();
  return {
    ...actual,
    resilientRename: async (src: string, dest: string) => {
      if (fsFaults.rename?.(src)) {
        throw Object.assign(new Error("rename refused"), { code: "EACCES" });
      }
      await actual.resilientRename(src, dest);
      fsFaults.log.push(`rename ${src.endsWith(".erasing") ? "back" : "aside"}`);
    },
    syncParentDirectory: async () => {
      fsFaults.syncCalls += 1;
      if (fsFaults.syncFailOn?.(fsFaults.syncCalls)) {
        throw Object.assign(new Error("fsync failed"), { code: "EIO" });
      }
      fsFaults.log.push("sync");
    },
  };
});

import {
  eraseLocalDecisionsData,
  erasingKeyFilePath,
  finishInterruptedErase,
  type DecisionsRows,
  type LocalEraseDeps,
} from "../localData.js";

const KEYS = '{"v":1,"protection":"keychain","ciphertext":"sealed"}';

/** Rows held in memory: `erase` deletes them all, or throws and keeps them. */
function fakeRows(count = 3) {
  const state = { count, failErase: null as null | Error };
  const rows: DecisionsRows = {
    erase: vi.fn(() => {
      fsFaults.log.push("erase rows");
      if (state.failErase) throw state.failErase;
      state.count = 0;
    }),
    exist: vi.fn(() => state.count > 0),
  };
  return { rows, state };
}

describe("local Decisions data deletion", () => {
  let dir: string;
  let keyFile: string;
  let forgotten: number;
  let forgetFails: boolean;

  function deps(rows: DecisionsRows): LocalEraseDeps {
    return {
      keyFilePath: keyFile,
      openRows: async () => rows,
      forgetIdentity: () => {
        if (forgetFails) throw new Error("settings unwritable");
        forgotten += 1;
      },
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decisions-local-data-"));
    keyFile = join(dir, "keys.bin");
    forgotten = 0;
    forgetFails = false;
    fsFaults.rename = null;
    fsFaults.syncFailOn = null;
    fsFaults.syncCalls = 0;
    fsFaults.log = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes the rows, the keys and the relay record", async () => {
    writeFileSync(keyFile, KEYS);
    const { rows, state } = fakeRows();

    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({ result: "deleted" });

    expect(state.count).toBe(0);
    expect(existsSync(keyFile)).toBe(false);
    expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
    expect(forgotten).toBe(1);
  });

  it("makes the keys' move durable before the rows go, and their removal durable after", async () => {
    writeFileSync(keyFile, KEYS);

    await eraseLocalDecisionsData(deps(fakeRows().rows));

    // The first sync makes any earlier deletion's removal durable before this one starts.
    expect(fsFaults.log).toEqual(["sync", "rename aside", "sync", "erase rows", "sync"]);
  });

  it("makes an earlier deletion's removal durable before a retry reports deleted", async () => {
    writeFileSync(keyFile, KEYS);
    const { rows } = fakeRows();
    // Calls: the check for an earlier deletion, the move aside, the removal.
    fsFaults.syncFailOn = (call) => call === 3;
    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({
      result: "incomplete",
      erased: true,
    });
    expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);

    fsFaults.syncFailOn = () => true;
    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({
      result: "incomplete",
      erased: true,
    });

    fsFaults.syncFailOn = null;
    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({ result: "deleted" });
  });

  it("says it can't tell whether the history is gone when the rows can't be read", async () => {
    writeFileSync(erasingKeyFilePath(keyFile), KEYS);
    const unreadable: LocalEraseDeps = {
      ...deps(fakeRows().rows),
      openRows: async () => {
        throw new Error("The app database isn't open");
      },
    };

    await expect(eraseLocalDecisionsData(unreadable)).resolves.toEqual({
      result: "incomplete",
      erased: null,
    });
    expect(existsSync(erasingKeyFilePath(keyFile))).toBe(true);
  });

  it("puts the keys back, deleting nothing, when their move can't be made durable", async () => {
    writeFileSync(keyFile, KEYS);
    // Calls: the check for an earlier deletion, then the move aside.
    fsFaults.syncFailOn = (call) => call === 2;
    const { rows, state } = fakeRows();

    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({
      result: "failed",
      reason: "keys",
    });
    expect(rows.erase).not.toHaveBeenCalled();
    expect(state.count).toBe(3);
    expect(readFileSync(keyFile, "utf8")).toBe(KEYS);
    expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);

    fsFaults.syncFailOn = null;
    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({ result: "deleted" });
  });

  it("deletes the rows and the relay record when there are no keys", async () => {
    const { rows, state } = fakeRows();

    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({ result: "deleted" });

    expect(state.count).toBe(0);
    expect(forgotten).toBe(1);
  });

  it("changes nothing when the keys can't be moved aside", async () => {
    writeFileSync(keyFile, KEYS);
    fsFaults.rename = (src) => src === keyFile;
    const { rows, state } = fakeRows();

    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({
      result: "failed",
      reason: "keys",
    });

    expect(rows.erase).not.toHaveBeenCalled();
    expect(state.count).toBe(3);
    expect(readFileSync(keyFile, "utf8")).toBe(KEYS);
    expect(forgotten).toBe(0);
  });

  it("puts the keys back when the rows can't be deleted, and says why", async () => {
    writeFileSync(keyFile, KEYS);
    const { rows, state } = fakeRows();
    state.failErase = Object.assign(new Error("disk is full"), {
      name: "DecisionsStoreUnavailableError",
      reason: "disk-pressure",
    });

    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({
      result: "failed",
      reason: "disk-pressure",
    });

    expect(state.count).toBe(3);
    expect(readFileSync(keyFile, "utf8")).toBe(KEYS);
    expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
    expect(forgotten).toBe(0);
  });

  it("reads any other refusal to delete the rows as the database's", async () => {
    const { rows, state } = fakeRows();
    state.failErase = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });

    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({
      result: "failed",
      reason: "storage",
    });
    expect(forgotten).toBe(0);
  });

  it("says the deletion didn't finish when the keys can't go back, and the next start puts them back", async () => {
    writeFileSync(keyFile, KEYS);
    const { rows, state } = fakeRows();
    state.failErase = new Error("database is locked");
    fsFaults.rename = (src) => src === erasingKeyFilePath(keyFile);

    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({
      result: "incomplete",
      erased: false,
    });
    expect(existsSync(keyFile)).toBe(false);

    fsFaults.rename = null;
    await finishInterruptedErase(deps(rows));

    expect(readFileSync(keyFile, "utf8")).toBe(KEYS);
    expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
    expect(state.count).toBe(3);
    expect(forgotten).toBe(0);
  });

  it("says the deletion didn't finish when the relay record can't be forgotten, and the next start finishes it", async () => {
    writeFileSync(keyFile, KEYS);
    const { rows, state } = fakeRows();
    forgetFails = true;

    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({
      result: "incomplete",
      erased: true,
    });
    expect(state.count).toBe(0);
    expect(existsSync(erasingKeyFilePath(keyFile))).toBe(true);

    forgetFails = false;
    await finishInterruptedErase(deps(rows));

    expect(forgotten).toBe(1);
    expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
    expect(existsSync(keyFile)).toBe(false);
  });

  it("stays unfinished, never claiming nothing was deleted, while the relay record still can't be forgotten", async () => {
    writeFileSync(keyFile, KEYS);
    const { rows } = fakeRows();
    forgetFails = true;
    await eraseLocalDecisionsData(deps(rows));

    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({
      result: "incomplete",
      erased: true,
    });
    expect(existsSync(erasingKeyFilePath(keyFile))).toBe(true);
    expect(existsSync(keyFile)).toBe(false);
  });

  it("reports deleted when finishing an earlier committed deletion leaves nothing to delete", async () => {
    writeFileSync(erasingKeyFilePath(keyFile), KEYS);
    const { rows, state } = fakeRows(0);
    state.failErase = new Error("database is locked");

    await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({ result: "deleted" });

    expect(rows.erase).not.toHaveBeenCalled();
    expect(forgotten).toBe(1);
    expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
  });

  describe("finishing a deletion that stopped partway", () => {
    it("does nothing, opening no rows, when no deletion began", async () => {
      writeFileSync(keyFile, KEYS);
      const openRows = vi.fn(async () => fakeRows().rows);

      await expect(finishInterruptedErase({ ...deps(fakeRows().rows), openRows })).resolves.toBe(
        "none"
      );

      expect(openRows).not.toHaveBeenCalled();
      expect(readFileSync(keyFile, "utf8")).toBe(KEYS);
    });

    it("puts the keys back when rows are still stored, since their deletion never committed", async () => {
      writeFileSync(erasingKeyFilePath(keyFile), KEYS);
      const { rows } = fakeRows();

      await expect(finishInterruptedErase(deps(rows))).resolves.toBe("restored");

      expect(readFileSync(keyFile, "utf8")).toBe(KEYS);
      expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
      expect(forgotten).toBe(0);
      expect(fsFaults.log).toEqual(["rename back"]);
    });

    it("forgets the relay and removes the keys when no row is left, since the deletion committed", async () => {
      writeFileSync(erasingKeyFilePath(keyFile), KEYS);
      const { rows } = fakeRows(0);

      await expect(finishInterruptedErase(deps(rows))).resolves.toBe("finished");

      expect(existsSync(keyFile)).toBe(false);
      expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
      expect(forgotten).toBe(1);
      // The removal is durable before any store can open and write a row.
      expect(fsFaults.log).toEqual(["sync"]);
    });

    it("drops the set-aside keys, keeping the relay record, once new keys have been sealed", async () => {
      const newer = '{"v":1,"protection":"keychain","ciphertext":"newer"}';
      writeFileSync(erasingKeyFilePath(keyFile), KEYS);
      writeFileSync(keyFile, newer);
      const { rows } = fakeRows(0);

      await finishInterruptedErase(deps(rows));

      expect(readFileSync(keyFile, "utf8")).toBe(newer);
      expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
      expect(forgotten).toBe(0);
    });

    it("is finished first by the next deletion", async () => {
      writeFileSync(erasingKeyFilePath(keyFile), KEYS);
      const { rows, state } = fakeRows();

      await expect(eraseLocalDecisionsData(deps(rows))).resolves.toEqual({ result: "deleted" });

      expect(state.count).toBe(0);
      expect(existsSync(keyFile)).toBe(false);
      expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
      expect(forgotten).toBe(1);
    });
  });
});
