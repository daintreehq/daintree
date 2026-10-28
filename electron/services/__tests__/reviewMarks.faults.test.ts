import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { ReviewPoint } from "../../../shared/types/reviewPoint.js";

const faults = vi.hoisted(() => ({ mode: "none" as "none" | "after-rename" | "before-rename" }));

vi.mock("../../utils/fs.js", async (importActual) => {
  const actual = await importActual<typeof import("../../utils/fs.js")>();
  return {
    ...actual,
    // Directory sync failing after the rename, or the write failing outright.
    resilientAtomicWriteFile: async (
      ...args: Parameters<typeof actual.resilientAtomicWriteFile>
    ) => {
      const isIndex = args[0].endsWith("review-marks.json");
      if (isIndex && faults.mode === "before-rename") throw new Error("ENOSPC");
      await actual.resilientAtomicWriteFile(...args);
      if (isIndex && faults.mode === "after-rename") throw new Error("EIO syncing directory");
    },
  };
});

import { ReviewMarkStore } from "../reviewMarks.js";

const PROJECT = "a".repeat(64);
const WT_1 = path.resolve("/repos/alpha/feature-1");
const C1 = "1".repeat(40);

function point(capturedAt = 1_000): ReviewPoint {
  return {
    version: 1,
    capturedAt,
    worktreePath: WT_1,
    gitDir: "/repos/alpha/.git/worktrees/feature-1",
    commonDir: "/repos/alpha/.git",
    objectFormat: "sha1",
    head: { kind: "branch", branch: "feature-1", commit: C1 },
    base: { requested: { kind: "branch", branch: "main" }, ref: null, tip: null, mergeBases: [] },
    entries: [],
    incomplete: null,
  };
}

const allow = () => {};
let root: string;
let store: ReviewMarkStore;

async function indexText(): Promise<string> {
  return fs.readFile(path.join(root, PROJECT, "review-marks.json"), "utf8");
}

beforeEach(async () => {
  faults.mode = "none";
  root = await fs.mkdtemp(path.join(os.tmpdir(), "review-marks-faults-"));
  store = new ReviewMarkStore(root, { now: () => 0 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("ReviewMarkStore when writing the index fails", () => {
  it("counts a write that failed after it landed as written", async () => {
    faults.mode = "after-rename";
    const saved = await store.save(PROJECT, WT_1, point(), 0, allow);
    expect(saved.status).toBe("saved");
    faults.mode = "none";
    expect((await store.get(PROJECT, WT_1))?.point).toEqual(point());
  });

  it("still asks the guard about a write that failed after it landed, and puts it back", async () => {
    await store.save(PROJECT, WT_1, point(), 0, allow);
    const before = await indexText();
    faults.mode = "after-rename";
    let asked = 0;
    const handedOver = () => {
      if (++asked > 1) throw new Error("driven elsewhere");
    };
    await expect(store.save(PROJECT, WT_1, point(2_000), 1, handedOver)).rejects.toThrow(
      "driven elsewhere"
    );
    faults.mode = "none";
    expect(await indexText()).toBe(before);
    expect((await store.get(PROJECT, WT_1))?.point.capturedAt).toBe(1_000);
  });

  it("leaves the index as it was when the write never landed", async () => {
    await store.save(PROJECT, WT_1, point(), 0, allow);
    const before = await indexText();
    faults.mode = "before-rename";
    await expect(store.clear(PROJECT, WT_1, 1, allow)).rejects.toThrow("ENOSPC");
    faults.mode = "none";
    expect(await indexText()).toBe(before);
    expect((await store.read(PROJECT)).marks[WT_1]).toBeDefined();
  });
});
