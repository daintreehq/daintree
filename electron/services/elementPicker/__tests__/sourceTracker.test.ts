import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_TRACKED_FILES,
  MAX_WATCHED_DIRECTORIES,
  SourceTracker,
  type SourceChange,
} from "../sourceTracker.js";

const revision = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

function tracker(initial: Record<string, string | null> = {}) {
  const disk = new Map(Object.entries(initial));
  const listeners = new Map<string, (changedPath: string) => void>();
  const disposed: string[] = [];
  const changes: SourceChange[] = [];
  const warn = vi.fn();
  const readRevision = vi.fn(async (file: string) => disk.get(file) ?? null);
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

  it("stops tracking past the directory cap and survives a watch that fails", async () => {
    const t = tracker();
    for (let index = 0; index < MAX_WATCHED_DIRECTORIES; index++) {
      t.subject.observe(path.join("/repo", `d${index}`, "x.svelte"), ref("x.svelte"), revision(1));
    }
    t.subject.observe(path.join("/repo", "past", "x.svelte"), ref("x.svelte"), revision(1));
    expect(t.listeners.has(path.join("/repo", "past"))).toBe(false);

    const files = tracker();
    for (let index = 0; index < MAX_TRACKED_FILES + 1; index++) {
      files.subject.observe(
        path.join("/repo", "src", `f${index}.svelte`),
        ref(`f${index}.svelte`),
        revision(1)
      );
    }
    await files.settle();
    // One reconcile read per tracked file: the one past the cap is never read.
    expect(files.readRevision).toHaveBeenCalledTimes(MAX_TRACKED_FILES);

    const failing = tracker();
    failing.subject.observe(
      path.join("/repo", "unwatchable", "x.svelte"),
      ref("x.svelte"),
      revision(1)
    );
    expect(failing.warn).toHaveBeenCalledWith("source watch failed", expect.anything());
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
