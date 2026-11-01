import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsFaults = vi.hoisted(() => ({ rename: null as null | ((src: string) => boolean) }));

vi.mock("../../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/fs.js")>();
  return {
    ...actual,
    resilientRename: async (src: string, dest: string) => {
      if (fsFaults.rename?.(src)) {
        throw Object.assign(new Error("rename refused"), { code: "EACCES" });
      }
      return actual.resilientRename(src, dest);
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

  describe("finishing a deletion that stopped partway", () => {
    it("does nothing, opening no rows, when no deletion began", async () => {
      writeFileSync(keyFile, KEYS);
      const openRows = vi.fn(async () => fakeRows().rows);

      await finishInterruptedErase({ ...deps(fakeRows().rows), openRows });

      expect(openRows).not.toHaveBeenCalled();
      expect(readFileSync(keyFile, "utf8")).toBe(KEYS);
    });

    it("puts the keys back when rows are still stored, since their deletion never committed", async () => {
      writeFileSync(erasingKeyFilePath(keyFile), KEYS);
      const { rows } = fakeRows();

      await finishInterruptedErase(deps(rows));

      expect(readFileSync(keyFile, "utf8")).toBe(KEYS);
      expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
      expect(forgotten).toBe(0);
    });

    it("forgets the relay and removes the keys when no row is left, since the deletion committed", async () => {
      writeFileSync(erasingKeyFilePath(keyFile), KEYS);
      const { rows } = fakeRows(0);

      await finishInterruptedErase(deps(rows));

      expect(existsSync(keyFile)).toBe(false);
      expect(existsSync(erasingKeyFilePath(keyFile))).toBe(false);
      expect(forgotten).toBe(1);
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
