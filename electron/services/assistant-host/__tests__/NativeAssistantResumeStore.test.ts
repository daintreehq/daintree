import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent-userdata" } }));

import { NativeAssistantResumeStore } from "../NativeAssistantResumeStore.js";
import { assistantSlotKey } from "../../../../shared/config/assistantSlots.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("NativeAssistantResumeStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-resume-"));
    filePath = path.join(tmpDir, "resume.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeRaw(entries: Record<string, unknown>, version = 1): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify({ version, entries }), "utf-8");
  }

  async function reread(): Promise<NativeAssistantResumeStore> {
    const store = new NativeAssistantResumeStore(filePath);
    await store.load();
    return store;
  }

  it("keeps a lane's conversation across a restart, but never its panel state", async () => {
    const store = await reread();
    await store.set(assistantSlotKey("p1", 1), "ses_a");
    store.markPanelWasOpen(assistantSlotKey("p1", 1), true);
    expect(store.lanesFor("p1")).toEqual([{ slot: 1, panelWasOpen: true }]);
    // Another write AFTER the stamp, so a persist that carried the flag would put it on disk.
    await store.set(assistantSlotKey("p2", 0), "ses_b");

    const restarted = await reread();
    expect(restarted.get(assistantSlotKey("p1", 1))?.resumeSessionId).toBe("ses_a");
    // A restart is an earlier run of the app: its panel must not reopen on its own.
    expect(restarted.lanesFor("p1")).toEqual([{ slot: 1, panelWasOpen: false }]);
    expect(await fs.readFile(filePath, "utf-8")).not.toContain("panelWasOpen");
  });

  it("hands a load that arrives mid-read what the read found", async () => {
    await writeRaw({
      [assistantSlotKey("p1", 0)]: { resumeSessionId: "ses_a", capturedAt: Date.now() },
    });
    const store = new NativeAssistantResumeStore(filePath);

    // Starts on different lanes are not serialized with each other. A second load that
    // resolved before the first read did would see an empty map, and its start would
    // open a new conversation over the recorded one.
    const first = store.load();
    await store.load();
    expect(store.get(assistantSlotKey("p1", 0))?.resumeSessionId).toBe("ses_a");
    await first;
  });

  it("drops entries it cannot trust on read", async () => {
    const now = Date.now();
    await writeRaw({
      [assistantSlotKey("p1", 0)]: { resumeSessionId: "ses_ok", capturedAt: now },
      [assistantSlotKey("p1", 1)]: { resumeSessionId: "ses_stale", capturedAt: now - 15 * DAY_MS },
      [assistantSlotKey("p1", 2)]: { resumeSessionId: "", capturedAt: now },
      // Past the engine's own descriptor limit, which would refuse the whole start.
      [assistantSlotKey("p2", 0)]: { resumeSessionId: "x".repeat(257), capturedAt: now },
      // A future stamp never ages out.
      [assistantSlotKey("p3", 0)]: { resumeSessionId: "ses_future", capturedAt: now + DAY_MS },
      [assistantSlotKey("p4", 9)]: { resumeSessionId: "ses_no_such_lane", capturedAt: now },
      "p5-without-a-slot": { resumeSessionId: "ses_unkeyed", capturedAt: now },
    });

    const store = await reread();
    expect(store.lanesFor("p1")).toEqual([{ slot: 0, panelWasOpen: false }]);
    for (const project of ["p2", "p3", "p4", "p5-without-a-slot"]) {
      expect(store.lanesFor(project)).toEqual([]);
    }
  });

  it("ignores a file written by a version it does not know", async () => {
    await writeRaw(
      { [assistantSlotKey("p1", 0)]: { resumeSessionId: "ses_a", capturedAt: Date.now() } },
      2
    );
    expect((await reread()).get(assistantSlotKey("p1", 0))).toBeNull();
  });

  it("lists one workspace's lanes, lowest first", async () => {
    const store = await reread();
    await store.set(assistantSlotKey("p1", 2), "ses_c");
    // A workspace whose id another one's is a prefix of.
    await store.set(assistantSlotKey("p10", 0), "ses_other");
    await store.set(assistantSlotKey("p1", 0), "ses_a");

    expect(store.lanesFor("p1").map((lane) => lane.slot)).toEqual([0, 2]);
  });

  it("forgets a cleared lane on disk and leaves its siblings", async () => {
    const store = await reread();
    await store.set(assistantSlotKey("p1", 0), "ses_a");
    await store.set(assistantSlotKey("p1", 1), "ses_b");
    await store.clear(assistantSlotKey("p1", 0));

    expect((await reread()).lanesFor("p1")).toEqual([{ slot: 1, panelWasOpen: false }]);
  });

  it("lands writes in the order they were asked for", async () => {
    const store = await reread();
    // Not awaited in between: a clear queued behind a set must be what reaches disk.
    const set = store.set(assistantSlotKey("p1", 0), "ses_a");
    const clear = store.clear(assistantSlotKey("p1", 0));
    await Promise.all([set, clear]);

    expect((await reread()).get(assistantSlotKey("p1", 0))).toBeNull();
  });

  it("stamps panel state only on a lane that has a conversation", async () => {
    const store = await reread();
    store.markPanelWasOpen(assistantSlotKey("p1", 0), true);
    expect(store.lanesFor("p1")).toEqual([]);
  });
});
