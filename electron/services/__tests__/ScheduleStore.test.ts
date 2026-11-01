import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const fsUtils = vi.hoisted(() => ({ failRename: false }));

vi.mock("../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/fs.js")>();
  return {
    ...actual,
    resilientRename: async (from: string, to: string) => {
      if (fsUtils.failRename) throw Object.assign(new Error("busy"), { code: "EPERM" });
      return actual.resilientRename(from, to);
    },
  };
});

import { ScheduleStore } from "../ScheduleStore.js";
import { SCHEDULES_SCHEMA_VERSION, encodeSchedulesFile } from "../schedulesCodec.js";
import { createSchedule } from "../../../shared/utils/scheduledRuns.js";
import type {
  ScheduleCreateInput,
  SchedulesSnapshot,
} from "../../../shared/types/ipc/schedules.js";
import type { Schedule } from "../../../shared/types/scheduledRuns.js";

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);
const PROMPT = "  Triage the open issues.\nThen stop.  ";

const input: ScheduleCreateInput = {
  name: "  Nightly triage ",
  launch: { agentId: "claude", prompt: PROMPT },
  cron: " 0 2 * * * ",
  timeZone: "europe/london",
};

let root: string;
let clock: number;
let registered: Set<string>;

function newStore(): ScheduleStore {
  return new ScheduleStore(
    root,
    (id) => registered.has(id),
    () => clock
  );
}

function schedulesFile(projectId = PROJECT): string {
  return path.join(root, projectId, "schedules.json");
}

function saved<T extends { status: string }>(outcome: T): Extract<T, { status: "saved" }> {
  if (outcome.status !== "saved") throw new Error(`expected saved, got ${outcome.status}`);
  return outcome as Extract<T, { status: "saved" }>;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-schedules-"));
  clock = Date.UTC(2026, 10, 1, 12);
  registered = new Set([PROJECT, OTHER]);
  fsUtils.failRename = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ScheduleStore", () => {
  it("creates a schedule with #15974's defaults, minted id and times, and the prompt verbatim", async () => {
    const store = newStore();

    const { schedule, snapshot } = saved(await store.create(PROJECT, input));

    expect(schedule).toEqual(
      createSchedule({ ...input, id: schedule.id, projectId: PROJECT }, clock)
    );
    expect(schedule.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(schedule.name).toBe("Nightly triage");
    expect(schedule.cadence).toEqual({ cron: "0 2 * * *", timeZone: "Europe/London" });
    expect(schedule.launch.prompt).toBe(PROMPT);
    expect(snapshot.schedules).toEqual([schedule]);
  });

  it("survives a restart: a new store reads what the old one wrote", async () => {
    const first = newStore();
    const a = saved(await first.create(PROJECT, input)).schedule;
    const b = saved(await first.create(PROJECT, { ...input, name: "Second" })).schedule;

    const reopened = await newStore().list(PROJECT);

    expect(reopened.projectId).toBe(PROJECT);
    expect(reopened.schedules).toEqual([a, b]);
    expect(await newStore().get(PROJECT, b.id)).toEqual(b);
    expect((await newStore().list(OTHER)).schedules).toEqual([]);
  });

  it("refuses a bad cadence with its reason and writes nothing", async () => {
    const store = newStore();

    const outcome = await store.create(PROJECT, { ...input, cron: "0 0 30 2 *" });

    expect(outcome.status).toBe("invalid");
    if (outcome.status !== "invalid") return;
    expect(outcome.issues).toHaveLength(1);
    expect(outcome.issues[0]!.path).toBe("cadence.cron");
    expect(outcome.issues[0]!.message).not.toBe("");
    expect(fs.existsSync(schedulesFile())).toBe(false);
  });

  it("never quotes the prompt in an invalid outcome", async () => {
    const outcome = await newStore().create(PROJECT, { ...input, name: " ", cron: "nope" });

    expect(outcome.status).toBe("invalid");
    expect(JSON.stringify(outcome)).not.toContain("Triage");
  });

  it("applies an edit made from the current version and stamps it strictly later", async () => {
    const store = newStore();
    const created = saved(await store.create(PROJECT, input)).schedule;

    const edited = saved(
      await store.update(PROJECT, created.id, created.updatedAt, {
        name: " Renamed ",
        cadence: { cron: "*/15 * * * *", timeZone: "asia/tokyo" },
      })
    ).schedule;

    expect(edited).toEqual({
      ...created,
      name: "Renamed",
      cadence: { cron: "*/15 * * * *", timeZone: "Asia/Tokyo" },
      updatedAt: created.updatedAt + 1,
    });
    expect((await newStore().list(PROJECT)).schedules).toEqual([edited]);
  });

  it("refuses an edit made from an older version as a conflict and keeps the newer one", async () => {
    const store = newStore();
    const created = saved(await store.create(PROJECT, input)).schedule;
    const first = saved(await store.update(PROJECT, created.id, created.updatedAt, { name: "A" }));

    const second = await store.update(PROJECT, created.id, created.updatedAt, { name: "B" });

    expect(second).toEqual({
      status: "conflict",
      schedule: first.schedule,
      snapshot: expect.objectContaining({ schedules: [first.schedule] }),
    });
  });

  it("keeps stamps rising when the clock goes back", async () => {
    const store = newStore();
    const created = saved(await store.create(PROJECT, input)).schedule;
    clock -= 60_000;

    const edited = saved(await store.update(PROJECT, created.id, created.updatedAt, { name: "B" }));

    expect(edited.schedule.updatedAt).toBeGreaterThan(created.updatedAt);
  });

  it("refuses an invalid edit with the field's reason and keeps the stored version", async () => {
    const store = newStore();
    const created = saved(await store.create(PROJECT, input)).schedule;

    const outcome = await store.update(PROJECT, created.id, created.updatedAt, {
      launch: { ...created.launch, prompt: "   " },
    });

    expect(outcome).toEqual({
      status: "invalid",
      issues: [{ path: "launch.prompt", cronField: null, message: expect.any(String) }],
    });
    expect((await store.list(PROJECT)).schedules).toEqual([created]);
  });

  it("answers not-found for an edit or toggle of a deleted schedule", async () => {
    const store = newStore();
    const created = saved(await store.create(PROJECT, input)).schedule;
    await store.remove(PROJECT, created.id);

    expect((await store.update(PROJECT, created.id, created.updatedAt, { name: "B" })).status).toBe(
      "not-found"
    );
    expect((await store.setEnabled(PROJECT, created.id, false)).status).toBe("not-found");
  });

  it("disables and enables a schedule, and a repeat changes nothing", async () => {
    const store = newStore();
    const created = saved(await store.create(PROJECT, input)).schedule;
    const listener = vi.fn();
    store.subscribe(listener);

    const off = saved(await store.setEnabled(PROJECT, created.id, false));
    const again = saved(await store.setEnabled(PROJECT, created.id, false));
    const on = saved(await store.setEnabled(PROJECT, created.id, true));

    expect(off.schedule).toEqual({ ...created, enabled: false, updatedAt: created.updatedAt + 1 });
    expect(again.schedule).toEqual(off.schedule);
    expect(on.schedule.enabled).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect((await newStore().list(PROJECT)).schedules).toEqual([on.schedule]);
  });

  it("deletes a schedule, and deleting it again is the same answer", async () => {
    const store = newStore();
    const a = saved(await store.create(PROJECT, input)).schedule;
    const b = saved(await store.create(PROJECT, { ...input, name: "B" })).schedule;

    const removed = await store.remove(PROJECT, a.id);
    const repeated = await store.remove(PROJECT, a.id);

    expect(removed.snapshot.schedules).toEqual([b]);
    expect(repeated).toEqual({ status: "removed", snapshot: removed.snapshot });
    expect((await newStore().list(PROJECT)).schedules).toEqual([b]);
  });

  it("keeps both of two creates sent at once", async () => {
    const store = newStore();

    const [a, b] = await Promise.all([
      store.create(PROJECT, { ...input, name: "A" }),
      store.create(PROJECT, { ...input, name: "B" }),
    ]);

    const names = (await newStore().list(PROJECT)).schedules.map((schedule) => schedule.name);
    expect(names).toEqual(["A", "B"]);
    expect(saved(b).snapshot.revision).toBeGreaterThan(saved(a).snapshot.revision);
  });

  it("tells listeners each committed change in order, and stops after unsubscribe", async () => {
    const store = newStore();
    const heard: SchedulesSnapshot[] = [];
    const unsubscribe = store.subscribe((snapshot) => heard.push(snapshot));

    const created = saved(await store.create(PROJECT, input)).schedule;
    await store.update(PROJECT, created.id, created.updatedAt, { name: "B" });
    await store.create(PROJECT, { ...input, name: "" });
    await store.remove(PROJECT, created.id);
    unsubscribe();
    await store.create(PROJECT, input);

    expect(heard.map((snapshot) => snapshot.schedules.map((s) => s.name))).toEqual([
      ["Nightly triage"],
      ["B"],
      [],
    ]);
    expect(heard[1]!.revision).toBeGreaterThan(heard[0]!.revision);
    expect(heard[2]!.revision).toBeGreaterThan(heard[1]!.revision);
  });

  it("creates and edits every policy and keeps a replaced prompt exactly as written", async () => {
    const store = newStore();
    const created = saved(
      await store.create(PROJECT, {
        ...input,
        enabled: false,
        policies: { overlap: "replace", precondition: { command: "test -f ready" } },
      })
    ).schedule;
    expect(created.enabled).toBe(false);
    expect(created.policies).toMatchObject({
      overlap: "replace",
      precondition: { command: "test -f ready" },
      missedRuns: "run-once-late",
    });

    const policies = {
      missedRuns: "skip",
      overlap: "start-another",
      precondition: null,
      onDone: "close",
      runWhenClosed: true,
    } as const;
    const launch = {
      agentId: "codex",
      presetId: "fast",
      prompt: "\n  Spaced.\n",
      worktreeId: "/w",
    };
    const edited = saved(
      await store.update(PROJECT, created.id, created.updatedAt, { policies, launch })
    ).schedule;

    expect(edited.policies).toEqual(policies);
    expect(edited.launch).toEqual(launch);
    expect((await newStore().get(PROJECT, created.id))?.launch.prompt).toBe("\n  Spaced.\n");
    expect((await newStore().get(PROJECT, created.id))?.policies).toEqual(policies);
  });

  it("keeps a failing listener from stopping the write or the other listeners", async () => {
    const store = newStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    store.subscribe(() => {
      throw new Error("boom");
    });
    store.subscribe(after);

    const outcome = await store.create(PROJECT, input);

    expect(outcome.status).toBe("saved");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("refuses to write the schedules of a project that isn't registered", async () => {
    const store = newStore();
    registered.delete(PROJECT);

    await expect(store.create(PROJECT, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fs.existsSync(path.join(root, PROJECT))).toBe(false);
  });

  it("never writes for a scratch id or a path", async () => {
    const store = new ScheduleStore(
      root,
      () => true,
      () => clock
    );

    for (const id of ["6f1c1f3e-6c8a-4a39-9a43-1d8f2b9d3c11", "../escape"]) {
      await expect(store.create(id, input)).rejects.toMatchObject({ code: "VALIDATION" });
      expect((await store.list(id)).schedules).toEqual([]);
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  describe("an unreadable file", () => {
    function writeRaw(raw: string): void {
      fs.mkdirSync(path.join(root, PROJECT), { recursive: true });
      fs.writeFileSync(schedulesFile(), raw);
    }

    it("is moved aside whole and read as none, and the next write starts afresh", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const good = createSchedule(
        {
          id: "kept",
          projectId: PROJECT,
          name: "Good",
          launch: { agentId: "claude", prompt: "x" },
        },
        clock
      );
      const bad: Schedule = {
        ...good,
        id: "bad",
        cadence: { cron: "61 * * * *", timeZone: "UTC" },
      };
      const raw = encodeSchedulesFile([good, bad]);
      writeRaw(raw);
      const store = newStore();

      expect((await store.list(PROJECT)).schedules).toEqual([]);
      const aside = fs.readdirSync(path.join(root, PROJECT));
      expect(aside).toHaveLength(1);
      expect(aside[0]).toMatch(/^schedules\.json\.corrupted\.\d+$/);
      expect(fs.readFileSync(path.join(root, PROJECT, aside[0]!), "utf-8")).toBe(raw);

      saved(await store.create(PROJECT, input));
      expect((await newStore().list(PROJECT)).schedules).toHaveLength(1);
    });

    it("from a newer app is kept under a name that says so", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      writeRaw(JSON.stringify({ _schemaVersion: SCHEDULES_SCHEMA_VERSION + 1, schedules: [] }));

      expect((await newStore().list(PROJECT)).schedules).toEqual([]);
      expect(fs.readdirSync(path.join(root, PROJECT))).toEqual([
        `schedules.json.future-v${SCHEDULES_SCHEMA_VERSION + 1}`,
      ]);
    });

    it("that can't be moved aside fails the call and is never written over", async () => {
      writeRaw("{ not json");
      fsUtils.failRename = true;
      const store = newStore();

      await expect(store.list(PROJECT)).rejects.toMatchObject({ code: "PERSIST_FAILED" });
      await expect(store.create(PROJECT, input)).rejects.toMatchObject({ code: "PERSIST_FAILED" });
      expect(fs.readFileSync(schedulesFile(), "utf-8")).toBe("{ not json");

      fsUtils.failRename = false;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await store.create(PROJECT, input)).status).toBe("saved");
    });
  });

  describe("removeProject", () => {
    it("holds every later turn until the caller's files are gone", async () => {
      const checks = vi.fn((id: string) => registered.has(id));
      const store = new ScheduleStore(root, checks, () => clock);
      saved(await store.create(PROJECT, input));
      registered.delete(PROJECT);
      let started: () => void = () => {};
      const removalStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      const removing = store.removeProject(PROJECT, async () => {
        started();
        await released;
        fs.rmSync(path.join(root, PROJECT), { recursive: true, force: true });
      });
      // The same project, added straight back, makes a schedule at once.
      registered.add(PROJECT);
      const again = store.create(PROJECT, { ...input, name: "Again" });
      await removalStarted;
      checks.mockClear();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(checks).not.toHaveBeenCalled();
      release();
      await removing;

      expect((await again).status).toBe("saved");
      const names = (await newStore().list(PROJECT)).schedules.map((s) => s.name);
      expect(names).toEqual(["Again"]);
    });

    it("still tells listeners, and keeps the queue usable, when removing the files fails", async () => {
      const store = newStore();
      const before = saved(await store.create(PROJECT, input)).snapshot.revision;
      const heard: SchedulesSnapshot[] = [];
      store.subscribe((snapshot) => heard.push(snapshot));

      const removal = store.removeProject(PROJECT, async () => {
        throw new Error("EBUSY");
      });
      // Queued behind the failing turn, so it must not inherit the failure.
      const next = store.create(PROJECT, { ...input, name: "Next" });

      await expect(removal).rejects.toThrow("EBUSY");
      expect((await next).status).toBe("saved");
      expect(heard[0]).toEqual({ projectId: PROJECT, schedules: [], revision: before + 1 });
      expect(heard).toHaveLength(2);
    });

    it("deletes the file and tells listeners the project has none", async () => {
      const store = newStore();
      saved(await store.create(PROJECT, input));
      const heard: SchedulesSnapshot[] = [];
      store.subscribe((snapshot) => heard.push(snapshot));

      registered.delete(PROJECT);
      await store.removeProject(PROJECT);

      expect(fs.existsSync(schedulesFile())).toBe(false);
      expect(heard).toEqual([expect.objectContaining({ projectId: PROJECT, schedules: [] })]);
    });

    it("refuses every edit whose turn comes after the row is gone", async () => {
      const store = newStore();
      const created = saved(await store.create(PROJECT, input)).schedule;

      const queued = store.update(PROJECT, created.id, created.updatedAt, { name: "Late" });
      registered.delete(PROJECT);
      const removal = store.removeProject(PROJECT);
      const after = store.create(PROJECT, input);

      await expect(queued).rejects.toMatchObject({ code: "NOT_FOUND" });
      await removal;
      await expect(after).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fs.existsSync(schedulesFile())).toBe(false);
    });

    it("waits out a write already past its check, then deletes what it wrote", async () => {
      const store = new ScheduleStore(
        root,
        (id) => {
          const answer = registered.has(id);
          // The row goes while this create is between its check and its write.
          registered.delete(PROJECT);
          return answer;
        },
        () => clock
      );

      const creating = store.create(PROJECT, input);
      const removal = store.removeProject(PROJECT);

      expect((await creating).status).toBe("saved");
      await removal;
      expect(fs.existsSync(schedulesFile())).toBe(false);
    });
  });
});
