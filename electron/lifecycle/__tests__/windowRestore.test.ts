import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolvePrimaryRestoreProjectId,
  restoreWindowFleet,
  type CreateWindowResult,
  type RestoreWindowFleetDeps,
} from "../windowRestore.js";
import type { OpenWindowRecord } from "../../services/persistence/windowManifest.js";

const record = (projectId: string | null): OpenWindowRecord => ({ projectId });

interface Harness {
  deps: RestoreWindowFleetDeps;
  createWindow: ReturnType<typeof vi.fn>;
  resumeSaves: ReturnType<typeof vi.fn>;
  suppressSaves: ReturnType<typeof vi.fn>;
  onBackgroundWindowFailed: ReturnType<typeof vi.fn>;
  /** Project ids passed to createWindow, in call order. */
  openedProjects: () => (string | undefined)[];
  /** Reveal modes passed to createWindow, in call order. */
  revealModes: () => (string | undefined)[];
  /** Whether resumeSaves was told to persist. */
  persisted: () => boolean;
}

function harness(
  overrides: Partial<RestoreWindowFleetDeps> = {},
  createWindowImpl?: (
    projectId: string | undefined,
    opts?: { revealMode?: "show" | "showInactive" }
  ) => Promise<CreateWindowResult>
): Harness {
  const createWindow = vi.fn(createWindowImpl ?? (async () => "ok" as CreateWindowResult));
  const resumeSaves = vi.fn();
  const suppressSaves = vi.fn();
  const onBackgroundWindowFailed = vi.fn();

  const deps: RestoreWindowFleetDeps = {
    records: [],
    hadManifest: false,
    fallbackProjectId: undefined,
    createWindow,
    suppressSaves,
    resumeSaves,
    onBackgroundWindowFailed,
    ...overrides,
  };

  return {
    deps,
    createWindow,
    resumeSaves,
    suppressSaves,
    onBackgroundWindowFailed,
    openedProjects: () => createWindow.mock.calls.map((c) => c[0] as string | undefined),
    revealModes: () =>
      createWindow.mock.calls.map((c) => (c[1] as { revealMode?: string } | undefined)?.revealMode),
    persisted: () => resumeSaves.mock.calls.some((c) => c[0] === true),
  };
}

describe("resolvePrimaryRestoreProjectId", () => {
  it("takes the most-recently-focused record", () => {
    expect(resolvePrimaryRestoreProjectId([record("a"), record("b")], true, "other")).toBe("a");
  });

  it("uses the last-active project when there was no manifest at all", () => {
    expect(resolvePrimaryRestoreProjectId([], false, "last-active")).toBe("last-active");
  });

  it("never substitutes the last-active project when the manifest filtered to nothing", () => {
    // The whole point of the hadManifest flag: every project in a real manifest
    // was deleted, so the user gets a picker — not some unrelated project their
    // window set never named.
    expect(resolvePrimaryRestoreProjectId([], true, "unrelated")).toBeUndefined();
  });

  it("opens a picker when the most-recently-focused window was itself a picker", () => {
    expect(
      resolvePrimaryRestoreProjectId([record(null), record("b")], true, "other")
    ).toBeUndefined();
  });

  it("resolves to nothing on a first run with no manifest and no last-active project", () => {
    expect(resolvePrimaryRestoreProjectId([], false, undefined)).toBeUndefined();
  });
});

describe("restoreWindowFleet", () => {
  let h: Harness;

  describe("a plain cold launch with three saved windows", () => {
    beforeEach(async () => {
      h = harness({
        records: [record("a"), record("b"), record("c")],
        hadManifest: true,
      });
      await restoreWindowFleet(h.deps);
    });

    it("recreates one window per record", () => {
      expect(h.createWindow).toHaveBeenCalledTimes(3);
    });

    it("gives each window its own project, in manifest order", () => {
      expect(h.openedProjects()).toEqual(["a", "b", "c"]);
    });

    it("reveals only the background windows inactive, so focus lands on the first", () => {
      const [primary, ...background] = h.revealModes();
      expect(primary).toBeUndefined();
      expect(background).toEqual(["showInactive", "showInactive"]);
    });

    it("persists the fleet once every window is up", () => {
      expect(h.persisted()).toBe(true);
    });

    it("holds saves across the whole fan-out", () => {
      expect(h.suppressSaves).toHaveBeenCalledTimes(1);
      expect(h.resumeSaves).toHaveBeenCalledTimes(1);
    });
  });

  describe("fan-out sequencing", () => {
    /** Records start/end around a tick so overlap is observable. */
    function traced(records: OpenWindowRecord[]) {
      const events: string[] = [];
      let active = 0;
      let peak = 0;
      const h = harness({ records, hadManifest: true }, async (projectId) => {
        active++;
        peak = Math.max(peak, active);
        events.push(`start:${projectId}`);
        await Promise.resolve();
        await Promise.resolve();
        events.push(`end:${projectId}`);
        active--;
        return "ok";
      });
      return { h, events, peakOf: () => peak };
    }

    it("finishes the first window before either of the rest starts", async () => {
      // initGlobalServices() flips its "initialized" guard synchronously at
      // entry, so a second window overlapping the first sails past the guard and
      // races its migrations. Completion-before-start is the actual invariant —
      // merely observing the primary alone at its own first tick proves nothing,
      // since every call records itself before yielding.
      const { h, events } = traced([record("a"), record("b"), record("c")]);
      await restoreWindowFleet(h.deps);

      expect(events.indexOf("end:a")).toBeLessThan(events.indexOf("start:b"));
      expect(events.indexOf("end:a")).toBeLessThan(events.indexOf("start:c"));
    });

    it("runs the background windows together rather than one after another", async () => {
      const { h, events, peakOf } = traced([record("a"), record("b"), record("c")]);
      await restoreWindowFleet(h.deps);

      expect(events.indexOf("start:c")).toBeLessThan(events.indexOf("end:b"));
      expect(peakOf()).toBe(2);
    });

    it("never overlaps anything with the primary when it is the only window", async () => {
      const { h, peakOf } = traced([record("a")]);
      await restoreWindowFleet(h.deps);
      expect(peakOf()).toBe(1);
    });
  });

  it("restores two windows onto the same project rather than collapsing them", async () => {
    h = harness({ records: [record("same"), record("same")], hadManifest: true });
    await restoreWindowFleet(h.deps);
    expect(h.openedProjects()).toEqual(["same", "same"]);
  });

  it("opens one picker window when every saved project was deleted", async () => {
    h = harness({ records: [], hadManifest: true, fallbackProjectId: "unrelated" });
    await restoreWindowFleet(h.deps);
    expect(h.createWindow).toHaveBeenCalledTimes(1);
    expect(h.openedProjects()).toEqual([undefined]);
  });

  it("opens one window seeded the old way when there is no manifest", async () => {
    h = harness({ records: [], hadManifest: false, fallbackProjectId: "last-active" });
    await restoreWindowFleet(h.deps);
    expect(h.openedProjects()).toEqual(["last-active"]);
  });

  describe("a background window that fails", () => {
    beforeEach(async () => {
      h = harness(
        { records: [record("a"), record("b"), record("c")], hadManifest: true },
        async (projectId) => {
          if (projectId === "b") throw new Error("renderer died");
          return "ok";
        }
      );
      await restoreWindowFleet(h.deps);
    });

    it("does not stop the other windows from restoring", () => {
      expect(h.openedProjects()).toEqual(["a", "b", "c"]);
    });

    it("leaves the stored manifest alone, so the next launch still tries all three", () => {
      expect(h.persisted()).toBe(false);
    });

    it("reports the failure", () => {
      expect(h.onBackgroundWindowFailed).toHaveBeenCalledTimes(1);
    });

    it("still releases the save hold", () => {
      expect(h.resumeSaves).toHaveBeenCalledTimes(1);
    });
  });

  it("leaves the manifest alone when a background window reports it is not ok", async () => {
    // Resolving with a non-"ok" status is not a rejection, so it would sail past
    // an allSettled check that only looked for rejections.
    h = harness({ records: [record("a"), record("b")], hadManifest: true }, async (projectId) =>
      projectId === "b" ? "not-registered" : "ok"
    );
    await restoreWindowFleet(h.deps);
    expect(h.persisted()).toBe(false);
    expect(h.onBackgroundWindowFailed).not.toHaveBeenCalled();
  });

  describe("a primary window that cannot come up", () => {
    it("does not start the background windows when the primary reports exit", async () => {
      h = harness(
        { records: [record("a"), record("b")], hadManifest: true },
        async () => "exit-requested"
      );
      await restoreWindowFleet(h.deps);
      expect(h.createWindow).toHaveBeenCalledTimes(1);
    });

    it("leaves the stored manifest alone when the primary reports exit", async () => {
      h = harness(
        { records: [record("a"), record("b")], hadManifest: true },
        async () => "exit-requested"
      );
      await restoreWindowFleet(h.deps);
      expect(h.persisted()).toBe(false);
    });

    it("releases the save hold and rethrows when the primary throws", async () => {
      h = harness({ records: [record("a"), record("b")], hadManifest: true }, async () => {
        throw new Error("startup failed");
      });

      await expect(restoreWindowFleet(h.deps)).rejects.toThrow("startup failed");
      // The hold must be released even on the throw path, or every later save
      // in the process would be silently dropped.
      expect(h.resumeSaves).toHaveBeenCalledTimes(1);
      expect(h.persisted()).toBe(false);
    });
  });
});
