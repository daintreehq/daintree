import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSessionOpenProject,
  flushSessionOpenProjects,
  getPreviousSessionOpenProjects,
  initSessionOpenProjectsTracker,
  removeSessionOpenProject,
  resetSessionOpenProjectsTrackerForTests,
} from "../sessionOpenProjectsTracker.js";

vi.mock("../../utils/logger.js", () => ({ logError: vi.fn() }));

/**
 * The tracker owns two sets that must never contaminate each other: the
 * previous session's frozen membership (what the dot marks) and this session's
 * live membership (what gets persisted for next time) — #11794.
 */
describe("session-open projects tracker", () => {
  let write: ReturnType<typeof vi.fn>;

  /** The set the writer was handed on its most recent call. */
  const lastWritten = (): string[] => {
    const call = write.mock.calls.at(-1);
    return call ? [...(call[0] as ReadonlySet<string>)].sort() : [];
  };

  const init = (opts?: { previous?: string[]; readOnly?: boolean; launchAtMs?: number }) => {
    initSessionOpenProjectsTracker({
      previousSessionProjectIds: opts?.previous ?? [],
      launchAtMs: opts?.launchAtMs ?? 1_000,
      readOnly: opts?.readOnly ?? false,
      write,
    });
  };

  beforeEach(() => {
    write = vi.fn();
    resetSessionOpenProjectsTrackerForTests();
  });

  afterEach(() => {
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
        flushSessionOpenProjects();
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
      expect(lastWritten()).toEqual(["proj-b"]);
    });

    it("does not shrink when a project it names is closed this session", () => {
      init({ previous: ["proj-a"] });

      removeSessionOpenProject("proj-a");

      expect([...(getPreviousSessionOpenProjects()?.projectIds ?? [])]).toEqual(["proj-a"]);
    });

    it("starts this session's set empty, so last session's ids never carry over", () => {
      init({ previous: ["proj-a", "proj-b"] });

      addSessionOpenProject("proj-c");

      // Persisting the union with the previous set is exactly the lifetime
      // latch #11794 was about.
      expect(lastWritten()).toEqual(["proj-c"]);
    });
  });

  describe("this session's membership", () => {
    it("accumulates a deduplicated union across windows", () => {
      init();

      addSessionOpenProject("proj-a");
      addSessionOpenProject("proj-b");

      expect(lastWritten()).toEqual(["proj-a", "proj-b"]);
    });

    it("skips the write when a project already in the set is re-added", () => {
      init();
      addSessionOpenProject("proj-a");
      const writes = write.mock.calls.length;

      // A second window restoring the same project, or a switch back to it.
      addSessionOpenProject("proj-a");

      expect(write.mock.calls.length).toBe(writes);
    });

    it("skips the write when removing a project that was never in the set", () => {
      init();
      addSessionOpenProject("proj-a");
      const writes = write.mock.calls.length;

      removeSessionOpenProject("proj-unrelated");

      expect(write.mock.calls.length).toBe(writes);
    });

    it("persists what remains after a close", () => {
      init();
      addSessionOpenProject("proj-a");
      addSessionOpenProject("proj-b");

      removeSessionOpenProject("proj-a");

      expect(lastWritten()).toEqual(["proj-b"]);
    });

    it("ignores an empty project id on both sides", () => {
      init();

      addSessionOpenProject("");
      removeSessionOpenProject("");

      expect(write).not.toHaveBeenCalled();
    });
  });

  describe("write failures", () => {
    it("swallows the error rather than failing the operation that triggered it", () => {
      init();
      write.mockImplementation(() => {
        throw new Error("database is locked");
      });

      expect(() => addSessionOpenProject("proj-a")).not.toThrow();
    });

    it("retries the whole set on the next mutation, even a duplicate add", () => {
      init();
      write.mockImplementationOnce(() => {
        throw new Error("database is locked");
      });
      addSessionOpenProject("proj-a");

      // Normally a no-op — but the stored value is known stale, so this has to
      // reach the disk or the checkpoint stays diverged for the session.
      addSessionOpenProject("proj-a");

      expect(lastWritten()).toEqual(["proj-a"]);
    });

    it("stops retrying once a write lands", () => {
      init();
      write.mockImplementationOnce(() => {
        throw new Error("database is locked");
      });
      addSessionOpenProject("proj-a");
      addSessionOpenProject("proj-a");
      const writes = write.mock.calls.length;

      addSessionOpenProject("proj-a");

      expect(write.mock.calls.length).toBe(writes);
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
      flushSessionOpenProjects();

      expect(write).not.toHaveBeenCalled();
    });
  });

  describe("the flush", () => {
    it("clears a stale checkpoint for a session that opened nothing", () => {
      init({ previous: ["proj-a"] });

      flushSessionOpenProjects();

      // Picker window, then quit. Without this the launch after would light up
      // `proj-a` a second time.
      expect(lastWritten()).toEqual([]);
    });

    it("writes whatever has accumulated, so its ordering does not matter", () => {
      init({ previous: ["proj-a"] });
      addSessionOpenProject("proj-b");

      flushSessionOpenProjects();

      expect(lastWritten()).toEqual(["proj-b"]);
    });
  });
});
