import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_TRACKED_FILES,
  MAX_WATCHED_DIRECTORIES,
  SourceTracker,
  type SourceChange,
} from "../sourceTracker.js";

const revision = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

function tracker(initial: Record<string, string | null> = {}, unchanged = false) {
  const disk = new Map(Object.entries(initial));
  const listeners = new Map<string, (changedPath: string) => void>();
  const disposed: string[] = [];
  const changes: SourceChange[] = [];
  const warn = vi.fn();
  // An `unchanged` disk holds, for any file it was not told about, the bytes it was read at.
  const readRevision = vi.fn(async (file: string) =>
    disk.has(file) ? disk.get(file)! : unchanged ? revision(1) : null
  );
  const subject = new SourceTracker({
    watch: (directory, onChange) => {
      if (directory.includes("unwatchable")) throw new Error("EACCES");
      listeners.set(directory, onChange);
      return () => disposed.push(directory);
    },
    readRevision,
    push: (change) => changes.push(change),
    warn,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { subject, disk, listeners, disposed, changes, warn, readRevision, settle };
}

const file = (name: string) => path.join("/repo", "src", name);
const ref = (name: string) => ({ workspaceId: "ws", path: `src/${name}` });

describe("SourceTracker", () => {
  it("watches each parent directory once and reports only a revision it does not hold", async () => {
    const t = tracker({ [file("A.svelte")]: revision(1), [file("B.svelte")]: revision(2) });
    t.subject.observe(file("A.svelte"), ref("A.svelte"), revision(1));
    t.subject.observe(file("B.svelte"), ref("B.svelte"), revision(2));
    expect([...t.listeners.keys()]).toEqual([path.join("/repo", "src")]);
    await t.settle();
    expect(t.changes).toEqual([]);

    t.listeners.get(path.join("/repo", "src"))!(file("A.svelte"));
    await t.settle();
    expect(t.changes).toEqual([]);

    t.disk.set(file("A.svelte"), revision(3));
    t.listeners.get(path.join("/repo", "src"))!(file("A.svelte"));
    await t.settle();
    expect(t.changes).toEqual([{ file: ref("A.svelte"), revision: revision(3) }]);
  });

  it("reconciles a change that landed between the read and the watch", async () => {
    const t = tracker({ [file("A.svelte")]: revision(2) });
    t.subject.observe(file("A.svelte"), ref("A.svelte"), revision(1));
    await t.settle();
    expect(t.changes).toEqual([{ file: ref("A.svelte"), revision: revision(2) }]);
  });

  it("rechecks every file in a directory when the event names no file", async () => {
    const t = tracker({ [file("A.svelte")]: revision(1), [file("B.svelte")]: revision(1) });
    t.subject.observe(file("A.svelte"), ref("A.svelte"), revision(1));
    t.subject.observe(file("B.svelte"), ref("B.svelte"), revision(1));
    await t.settle();
    t.disk.set(file("B.svelte"), null);
    t.listeners.get(path.join("/repo", "src"))!(path.join("/repo", "src"));
    await t.settle();
    expect(t.changes).toEqual([{ file: ref("B.svelte"), revision: null }]);
  });

  it("collapses a burst into one read and one follow-up that lands on the final state", async () => {
    const t = tracker({ [file("A.svelte")]: revision(1) });
    t.subject.observe(file("A.svelte"), ref("A.svelte"), revision(1));
    await t.settle();

    t.readRevision.mockClear();
    // Hold the first read open while the file changes again underneath it.
    const held: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    t.readRevision.mockImplementation(async (path: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const seen = t.disk.get(path) ?? null;
      await new Promise<void>((resolve) => held.push(resolve));
      inFlight -= 1;
      return seen;
    });
    const notify = t.listeners.get(path.join("/repo", "src"))!;
    t.disk.set(file("A.svelte"), revision(5));
    notify(file("A.svelte"));
    t.disk.set(file("A.svelte"), revision(6));
    notify(file("A.svelte"));
    notify(file("A.svelte"));
    held.shift()!();
    await vi.waitFor(() => expect(held).toHaveLength(1));
    held.shift()!();
    await t.settle();

    expect(t.readRevision).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(t.changes).toEqual([
      { file: ref("A.svelte"), revision: revision(5) },
      { file: ref("A.svelte"), revision: revision(6) },
    ]);
  });

  it("makes room for a new directory past the directory cap by closing the least recently read", async () => {
    const t = tracker({}, true);
    const at = (index: number) => path.join("/repo", `d${index}`, "x.svelte");
    for (let index = 0; index < MAX_WATCHED_DIRECTORIES; index++) {
      t.subject.observe(at(index), ref(`d${index}/x.svelte`), revision(1));
    }
    await t.settle();
    const oldest = t.listeners.get(path.dirname(at(0)))!;
    t.readRevision.mockClear();

    const newest = path.join("/repo", "past", "x.svelte");
    t.disk.set(newest, revision(1));
    t.subject.observe(newest, ref("past/x.svelte"), revision(1));
    expect(t.subject.usage()).toEqual({
      files: MAX_WATCHED_DIRECTORIES,
      directories: MAX_WATCHED_DIRECTORIES,
    });
    expect(t.listeners.has(path.dirname(newest))).toBe(true);
    expect(t.disposed).toEqual([path.dirname(at(0))]);
    await t.settle();
    expect(t.readRevision).toHaveBeenCalledWith(newest);

    t.disk.set(newest, revision(2));
    t.listeners.get(path.dirname(newest))!(newest);
    await t.settle();
    expect(t.changes).toEqual([{ file: ref("past/x.svelte"), revision: revision(2) }]);

    // The closed watch's late events find nothing to recheck.
    t.readRevision.mockClear();
    t.disk.set(at(0), revision(9));
    oldest(at(0));
    oldest(path.dirname(at(0)));
    await t.settle();
    expect(t.readRevision).not.toHaveBeenCalled();
    expect(t.changes).toHaveLength(1);
  });

  it("reconciles the newest file past the file cap and stops tracking the least recently read", async () => {
    const t = tracker({}, true);
    const at = (index: number) => file(`f${index}.svelte`);
    for (let index = 0; index <= MAX_TRACKED_FILES; index++) {
      t.subject.observe(at(index), ref(`f${index}.svelte`), revision(1));
    }
    await t.settle();
    expect(t.subject.usage()).toEqual({ files: MAX_TRACKED_FILES, directories: 1 });
    expect(t.readRevision).toHaveBeenCalledTimes(MAX_TRACKED_FILES + 1);
    expect(t.readRevision).toHaveBeenLastCalledWith(at(MAX_TRACKED_FILES));
    // The directory still holds tracked files, so its watch stays open.
    expect(t.disposed).toEqual([]);

    t.readRevision.mockClear();
    t.listeners.get(path.join("/repo", "src"))!(at(0));
    await t.settle();
    expect(t.readRevision).not.toHaveBeenCalled();
  });

  it("keeps a file a resolve read again ahead of ones read since", async () => {
    const t = tracker();
    const at = (index: number) => path.join("/repo", `d${index}`, "x.svelte");
    for (let index = 0; index < MAX_WATCHED_DIRECTORIES; index++) {
      t.subject.observe(at(index), ref(`d${index}/x.svelte`), revision(1));
    }
    t.subject.observe(at(0), ref("d0/x.svelte"), revision(1));
    t.subject.observe(at(MAX_WATCHED_DIRECTORIES), ref("past/x.svelte"), revision(1));
    expect(t.disposed).toEqual([path.dirname(at(1))]);
  });

  it("tracks a file given up and read again afresh, deaf to its old watch", async () => {
    const t = tracker({}, true);
    const at = (index: number) => path.join("/repo", `d${index}`, "x.svelte");
    t.disk.set(at(0), revision(1));
    for (let index = 0; index <= MAX_WATCHED_DIRECTORIES; index++) {
      t.subject.observe(at(index), ref(`d${index}/x.svelte`), revision(1));
    }
    await t.settle();
    const closed = t.listeners.get(path.dirname(at(0)))!;
    expect(t.disposed).toEqual([path.dirname(at(0))]);

    // Read again at a revision the disk has already moved past.
    t.disk.set(at(0), revision(3));
    t.subject.observe(at(0), ref("d0/x.svelte"), revision(2));
    await t.settle();
    expect(t.changes).toEqual([{ file: ref("d0/x.svelte"), revision: revision(3) }]);
    expect(t.listeners.get(path.dirname(at(0)))).not.toBe(closed);

    t.readRevision.mockClear();
    closed(at(0));
    await t.settle();
    expect(t.readRevision).not.toHaveBeenCalled();

    // Each watch given up is closed once, and dispose closes only what is open.
    t.subject.dispose();
    const counts = new Map<string, number>();
    for (const directory of t.disposed) counts.set(directory, (counts.get(directory) ?? 0) + 1);
    expect(t.disposed).toHaveLength(MAX_WATCHED_DIRECTORIES + 2);
    expect(counts.get(path.dirname(at(0)))).toBe(2);
    expect(counts.get(path.dirname(at(1)))).toBe(1);
    expect([...counts.values()].every((count) => count <= 2)).toBe(true);
  });

  it("ignores a read that lands after its file was given up", async () => {
    const t = tracker();
    const at = (index: number) => path.join("/repo", `d${index}`, "x.svelte");
    const held: Array<() => void> = [];
    t.readRevision.mockImplementation(async (file: string) => {
      await new Promise<void>((resolve) => held.push(resolve));
      return file === at(0) ? revision(7) : revision(1);
    });
    for (let index = 0; index <= MAX_WATCHED_DIRECTORIES; index++) {
      t.subject.observe(at(index), ref(`d${index}/x.svelte`), revision(1));
    }
    for (const release of held.splice(0)) release();
    await t.settle();
    expect(t.changes).toEqual([]);
  });

  it("ranks the files the view holds ahead of everything else, in its order", async () => {
    const t = tracker();
    const at = (index: number) => path.join("/repo", `d${index}`, "x.svelte");
    t.subject.hold([ref("d0/x.svelte").path]);
    for (let index = 0; index <= MAX_WATCHED_DIRECTORIES; index++) {
      t.subject.observe(at(index), ref(`d${index}/x.svelte`), revision(1));
    }
    expect(t.disposed).toEqual([path.dirname(at(1))]);

    // A new list replaces the old: d0 is now the least recently read.
    t.subject.hold([]);
    t.subject.observe(at(MAX_WATCHED_DIRECTORIES + 1), ref("next/x.svelte"), revision(1));
    expect(t.disposed).toEqual([path.dirname(at(1)), path.dirname(at(0))]);
  });

  it("fills the directory cap from the top of the held list when it alone is past it", async () => {
    const t = tracker();
    const count = MAX_WATCHED_DIRECTORIES + 6;
    const at = (index: number) => path.join("/repo", `d${index}`, "x.svelte");
    const rel = (index: number) => `d${index}/x.svelte`;
    // The selected element's own file is first in the list but read first, so
    // recency alone would give it up.
    t.subject.hold(Array.from({ length: count }, (_, index) => ref(rel(index)).path));
    for (let index = 0; index < count; index++) {
      t.subject.observe(at(index), ref(rel(index)), revision(1));
    }
    expect(t.subject.usage()).toEqual({
      files: MAX_WATCHED_DIRECTORIES,
      directories: MAX_WATCHED_DIRECTORIES,
    });
    const open = new Set(t.listeners.keys());
    for (const directory of t.disposed) open.delete(directory);
    expect(open.has(path.dirname(at(0)))).toBe(true);
    expect(open.has(path.dirname(at(count - 1)))).toBe(false);
  });

  it("fills the file cap from the top of the held list when it alone is past it", async () => {
    const t = tracker();
    const count = MAX_TRACKED_FILES + 20;
    const at = (index: number) => path.join("/repo", `d${index % 8}`, `f${index}.svelte`);
    const rel = (index: number) => `d${index % 8}/f${index}.svelte`;
    t.subject.hold(Array.from({ length: count }, (_, index) => ref(rel(index)).path));
    for (let index = 0; index < count; index++) {
      t.subject.observe(at(index), ref(rel(index)), revision(1));
    }
    await t.settle();
    expect(t.subject.usage()).toEqual({ files: MAX_TRACKED_FILES, directories: 8 });

    t.readRevision.mockClear();
    t.listeners.get(path.dirname(at(0)))!(at(0));
    t.listeners.get(path.dirname(at(count - 1)))!(at(count - 1));
    await t.settle();
    expect(t.readRevision.mock.calls).toEqual([[at(0)]]);
  });

  it("brings back a held file it gave up, checked against the revision it last read", async () => {
    const t = tracker({}, true);
    const at = (index: number) => path.join("/repo", `d${index}`, "x.svelte");
    for (let index = 0; index <= MAX_WATCHED_DIRECTORIES; index++) {
      t.subject.observe(at(index), ref(`d${index}/x.svelte`), revision(1));
    }
    await t.settle();
    expect(t.disposed).toEqual([path.dirname(at(0))]);

    // Edited while nothing watched it.
    t.disk.set(at(0), revision(2));
    t.subject.hold([ref("d0/x.svelte").path]);
    expect(t.subject.usage()).toEqual({
      files: MAX_WATCHED_DIRECTORIES,
      directories: MAX_WATCHED_DIRECTORIES,
    });
    expect(t.disposed).toEqual([path.dirname(at(0)), path.dirname(at(1))]);
    await t.settle();
    expect(t.changes).toEqual([{ file: ref("d0/x.svelte"), revision: revision(2) }]);

    // Holding it again changes nothing that is already in place.
    t.readRevision.mockClear();
    t.subject.hold([ref("d0/x.svelte").path]);
    await t.settle();
    expect(t.readRevision).not.toHaveBeenCalled();
  });

  it("tracks a new selection's file once held, though held files filled the caps when it was read", async () => {
    const t = tracker({}, true);
    const at = (index: number) => path.join("/repo", `d${index}`, "x.svelte");
    const pinned = Array.from(
      { length: MAX_WATCHED_DIRECTORIES },
      (_, index) => ref(`d${index}/x.svelte`).path
    );
    t.subject.hold(pinned);
    for (let index = 0; index < MAX_WATCHED_DIRECTORIES; index++) {
      t.subject.observe(at(index), ref(`d${index}/x.svelte`), revision(1));
    }
    const selected = path.join("/repo", "selected", "x.svelte");
    t.subject.observe(selected, ref("selected/x.svelte"), revision(1));
    expect(t.listeners.has(path.dirname(selected))).toBe(false);

    t.subject.hold([ref("selected/x.svelte").path, ...pinned]);
    expect(t.subject.usage()).toEqual({
      files: MAX_WATCHED_DIRECTORIES,
      directories: MAX_WATCHED_DIRECTORIES,
    });
    expect(t.listeners.has(path.dirname(selected))).toBe(true);
    expect(t.disposed).toEqual([path.dirname(at(MAX_WATCHED_DIRECTORIES - 1))]);
    await t.settle();
    t.disk.set(selected, revision(2));
    t.listeners.get(path.dirname(selected))!(selected);
    await t.settle();
    expect(t.changes).toEqual([{ file: ref("selected/x.svelte"), revision: revision(2) }]);
  });

  it("survives a watch that fails", () => {
    const failing = tracker();
    failing.subject.observe(
      path.join("/repo", "unwatchable", "x.svelte"),
      ref("x.svelte"),
      revision(1)
    );
    expect(failing.warn).toHaveBeenCalledWith("source watch failed", expect.anything());
    expect(failing.subject.usage()).toEqual({ files: 1, directories: 1 });
  });

  it("closes its watches on dispose and reports nothing after", async () => {
    const t = tracker({ [file("A.svelte")]: revision(1) });
    t.subject.observe(file("A.svelte"), ref("A.svelte"), revision(1));
    await t.settle();
    t.subject.dispose();
    t.subject.dispose();
    expect(t.disposed).toEqual([path.join("/repo", "src")]);
    t.disk.set(file("A.svelte"), revision(2));
    t.listeners.get(path.join("/repo", "src"))!(file("A.svelte"));
    await t.settle();
    expect(t.changes).toEqual([]);
  });
});
