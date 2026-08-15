import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSessionOpenProject,
  getPreviousSessionOpenProjects,
  initSessionOpenProjectsTracker,
  removeSessionOpenProject,
  resetSessionOpenProjectsTrackerForTests,
} from "../sessionOpenProjectsTracker.js";

/**
 * The tracker owns two sets that must never contaminate each other: the
 * previous session's frozen membership (what the dot marks) and this session's
 * live membership (what gets persisted for next time) — #11794.
 */
describe("session-open projects tracker", () => {
  /**
   * A stand-in for the app_state row, seeded with a previous session's value.
   * Stateful on purpose: asserting on the writer's arguments alone cannot tell
   * "wrote an empty set" apart from "never wrote", which is exactly the
   * distinction the flush exists to make.
   */
  let stored: string[] | null;
  let write: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;

  const init = (opts?: { previous?: string[]; readOnly?: boolean; launchAtMs?: number }) => {
    stored = opts?.previous ? [...opts.previous].sort() : null;
    initSessionOpenProjectsTracker({
      previousSessionProjectIds: opts?.previous ?? [],
      launchAtMs: opts?.launchAtMs ?? 1_000,
      readOnly: opts?.readOnly ?? false,
      write,
    });
  };

  beforeEach(() => {
    stored = null;
    write = vi.fn((ids: ReadonlySet<string>) => {
      stored = [...ids].sort();
    });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetSessionOpenProjectsTrackerForTests();
  });

  afterEach(() => {
    warn.mockRestore();
    resetSessionOpenProjectsTrackerForTests();
  });

  describe("before the tracker is initialized", () => {
    it("reports no previous session rather than an empty one", () => {
      // Null and "the previous session had nothing open" are different claims:
      // a unit suite or a failed boot must not be able to hand out deadlines.
      expect(getPreviousSessionOpenProjects()).toBeNull();
    });

    it("absorbs every mutation without throwing or writing", () => {
      expect(() => {
        addSessionOpenProject("proj-a");
        removeSessionOpenProject("proj-a");
      }).not.toThrow();
      expect(write).not.toHaveBeenCalled();
    });
  });

  describe("the frozen previous session", () => {
    it("carries the launch instant the deadline is measured from", () => {
      init({ previous: ["proj-a"], launchAtMs: 12_345 });

      const snapshot = getPreviousSessionOpenProjects();
      expect(snapshot?.atMs).toBe(12_345);
      expect([...(snapshot?.projectIds ?? [])]).toEqual(["proj-a"]);
    });

    it("does not grow when this session opens something new", () => {
      init({ previous: ["proj-a"] });

      addSessionOpenProject("proj-b");

      // The whole point of the two sets: `proj-b` was opened now, so it was not
      // open last time and must not inherit the launch clock.
      expect([...(getPreviousSessionOpenProjects()?.projectIds ?? [])]).toEqual(["proj-a"]);
      expect(stored).toEqual(["proj-b"]);
    });

    it("does not shrink when a project it names is closed this session", () => {
      init({ previous: ["proj-a"] });

      removeSessionOpenProject("proj-a");

      expect([...(getPreviousSessionOpenProjects()?.projectIds ?? [])]).toEqual(["proj-a"]);
    });

    it("starts this session's set empty, so last session's ids never carry over", () => {
      init({ previous: ["proj-a", "proj-b"] });

      addSessionOpenProject("proj-c");

      // Persisting the union with the previous set is the lifetime latch that
      // made every project look recently active (#11794).
      expect(stored).toEqual(["proj-c"]);
    });
  });

  describe("this session's membership", () => {
    it("accumulates a deduplicated union across windows", () => {
      init();

      addSessionOpenProject("proj-a");
      addSessionOpenProject("proj-b");

      expect(stored).toEqual(["proj-a", "proj-b"]);
    });

    it("skips the write when a project already in the set is re-added", () => {
      init();
      addSessionOpenProject("proj-a");

      // A second window restoring the same project, or a switch back to it.
      addSessionOpenProject("proj-a");

      expect(write).toHaveBeenCalledTimes(1);
    });

    it("skips the write when removing a project that was never in the set", () => {
      init();
      addSessionOpenProject("proj-a");

      removeSessionOpenProject("proj-unrelated");

      expect(write).toHaveBeenCalledTimes(1);
    });

    it("persists what remains after a close", () => {
      init();
      addSessionOpenProject("proj-a");
      addSessionOpenProject("proj-b");

      removeSessionOpenProject("proj-a");

      expect(stored).toEqual(["proj-b"]);
    });

    it("ignores an empty project id on both sides", () => {
      init();

      addSessionOpenProject("");
      removeSessionOpenProject("");

      expect(write).not.toHaveBeenCalled();
    });
  });

  describe("write failures", () => {
    /** Fail the next write outright, leaving `stored` untouched. */
    const failNextWrite = () => {
      write.mockImplementationOnce(() => {
        throw new Error("database is locked");
      });
    };

    it("swallows the error rather than failing the operation that triggered it", () => {
      init();
      failNextWrite();

      expect(() => addSessionOpenProject("proj-a")).not.toThrow();
    });

    it("logs the underlying cause so a persistently stale checkpoint is diagnosable", () => {
      init();
      failNextWrite();

      addSessionOpenProject("proj-a");

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ message: "database is locked" })
      );
    });

    it("retries the whole set on the next mutation, even a duplicate add", () => {
      init({ previous: ["proj-a"] });
      failNextWrite();
      addSessionOpenProject("proj-a");
      // The failed attempt left last session's value on disk.
      expect(stored).toEqual(["proj-a"]);
      expect(write).toHaveBeenCalledTimes(1);

      // Normally a no-op — but the stored value is known stale, so this has to
      // reach the disk or the checkpoint stays diverged for the session.
      addSessionOpenProject("proj-a");

      expect(write).toHaveBeenCalledTimes(2);
      expect(stored).toEqual(["proj-a"]);
    });

    it("stops retrying once a write lands", () => {
      init();
      failNextWrite();
      addSessionOpenProject("proj-a");
      addSessionOpenProject("proj-a");
      expect(write).toHaveBeenCalledTimes(2);

      addSessionOpenProject("proj-a");

      expect(write).toHaveBeenCalledTimes(2);
    });
  });

  describe("a recovery launch", () => {
    it("still reports the previous session, so the dots survive safe mode", () => {
      init({ previous: ["proj-a"], readOnly: true });

      expect([...(getPreviousSessionOpenProjects()?.projectIds ?? [])]).toEqual(["proj-a"]);
    });

    it("never writes, so the reduced fleet cannot overwrite the real set", () => {
      init({ previous: ["proj-a"], readOnly: true });

      addSessionOpenProject("proj-b");
      removeSessionOpenProject("proj-a");

      expect(write).not.toHaveBeenCalled();
      expect(stored).toEqual(["proj-a"]);
    });
  });
});
