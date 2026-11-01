import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RESTORE_HYDRATION_WAIT_MS,
  RESTORE_WINDOW_STALL_MS,
  normalizeWindowRecords,
  resolvePrimaryRestoreProjectId,
  restoreWindowFleet,
  windowRestoreArgs,
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
    opts?: {
      revealMode?: "show" | "showInactive";
      backgroundProjectIds?: readonly string[];
    }
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

  it("opens a picker, not a local lookup of the key, for a window that was on a host", () => {
    expect(
      resolvePrimaryRestoreProjectId([record(`studio-01:${"a".repeat(64)}`)], true, "other")
    ).toBeUndefined();
  });
});

describe("windowRestoreArgs (#15564)", () => {
  it("opens a local workspace by its id, carrying its background list", () => {
    expect(windowRestoreArgs({ projectId: "a", backgroundProjectIds: ["b"] })).toEqual({
      projectId: "a",
      options: { backgroundProjectIds: ["b"] },
    });
  });

  it("opens a host's workspace on the picker and hands the key to the host restore", () => {
    const key = `studio-01:${"a".repeat(64)}`;
    const args = windowRestoreArgs({ projectId: key });
    expect(args.projectId).toBeUndefined();
    expect(args.options.remoteWorkspaceKey).toBe(key);
  });

  it("opens a picker window as a picker", () => {
    const args = windowRestoreArgs({ projectId: null });
    expect(args.projectId).toBeUndefined();
    expect(args.options.remoteWorkspaceKey).toBeUndefined();
  });
});

describe("normalizeWindowRecords (#12596)", () => {
  const withBackground = (projectId: string | null, ids: string[]): OpenWindowRecord => ({
    projectId,
    backgroundProjectIds: ids,
  });

  it("returns a manifest with no collisions untouched", () => {
    const records = [withBackground("a", ["x"]), record("b"), record(null)];
    const normalized = normalizeWindowRecords(records);
    expect(normalized).toEqual(records);
    expect(normalized[0]).toBe(records[0]);
  });

  it("drops a later window showing a project an earlier window already shows", () => {
    expect(normalizeWindowRecords([record("a"), record("b"), record("a")])).toEqual([
      record("a"),
      record("b"),
    ]);
  });

  it("never collapses picker windows into each other", () => {
    expect(normalizeWindowRecords([record(null), record(null)])).toEqual([
      record(null),
      record(null),
    ]);
  });

  it("lets a project one window shows outrank another window's warm copy of it", () => {
    expect(normalizeWindowRecords([withBackground("a", ["b", "x"]), record("b")])).toEqual([
      withBackground("a", ["x"]),
      record("b"),
    ]);
  });

  it("keeps a background project in only the first window that had it", () => {
    expect(
      normalizeWindowRecords([withBackground("a", ["x"]), withBackground("b", ["x", "y"])])
    ).toEqual([withBackground("a", ["x"]), withBackground("b", ["y"])]);
  });

  it("folds a dropped window's background projects into the window that kept its project", () => {
    expect(
      normalizeWindowRecords([
        withBackground("a", ["x"]),
        record("b"),
        withBackground("a", ["x", "y", "b"]),
      ])
    ).toEqual([withBackground("a", ["x", "y"]), record("b")]);
  });

  it("drops the background list entirely when nothing survives the filter", () => {
    expect(normalizeWindowRecords([record("a"), withBackground("b", ["a"])])).toEqual([
      record("a"),
      record("b"),
    ]);
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

    it("brings the background windows up one after another, never together (#12800)", async () => {
      const { h, events, peakOf } = traced([record("a"), record("b"), record("c"), record("d")]);
      await restoreWindowFleet(h.deps);

      expect(events).toEqual([
        "start:a",
        "end:a",
        "start:b",
        "end:b",
        "start:c",
        "end:c",
        "start:d",
        "end:d",
      ]);
      expect(peakOf()).toBe(1);
    });

    it("holds each window until it hydrates, except the last, which nothing waits behind", async () => {
      const h = harness({ records: [record("a"), record("b"), record("c")], hadManifest: true });
      await restoreWindowFleet(h.deps);
      const waits = h.createWindow.mock.calls.map(
        (c) => (c[1] as { awaitHydrationMs?: number } | undefined)?.awaitHydrationMs
      );
      expect(waits).toEqual([RESTORE_HYDRATION_WAIT_MS, RESTORE_HYDRATION_WAIT_MS, undefined]);
    });

    it("never holds a lone primary window for hydration", async () => {
      const h = harness({ records: [record("a")], hadManifest: true });
      await restoreWindowFleet(h.deps);
      expect(h.createWindow.mock.calls[0][1]?.awaitHydrationMs).toBeUndefined();
    });
  });

  describe("a manifest naming one project in two windows (#12596)", () => {
    beforeEach(async () => {
      h = harness({
        records: [record("same"), record("other"), record("same")],
        hadManifest: true,
      });
      await restoreWindowFleet(h.deps);
    });

    it("restores the project once, in the window that was focused most recently", () => {
      expect(h.openedProjects()).toEqual(["same", "other"]);
    });

    it("still persists, because the duplicate was dropped on purpose rather than failing", () => {
      expect(h.persisted()).toBe(true);
    });
  });

  it("skips a saved window whose project was opened elsewhere before the fan-out began", async () => {
    // The primary window is usable before the rest are created; a saved
    // project the user opened there in the meantime must not get a second view.
    h = harness({
      records: [record("a"), record("b"), record(null), record("c")],
      hadManifest: true,
      isProjectOwned: (projectId) => projectId === "b",
    });
    await restoreWindowFleet(h.deps);
    expect(h.openedProjects()).toEqual(["a", undefined, "c"]);
    expect(h.persisted()).toBe(true);
  });

  it("re-checks ownership as each background window's turn comes, not once up front", async () => {
    // A sequential restore gives the user time to open a saved project by hand
    // before its window is reached; it must not get a second view.
    const owned = new Set<string>();
    h = harness(
      {
        records: [record("a"), record("b"), record("c")],
        hadManifest: true,
        isProjectOwned: (projectId) => owned.has(projectId),
      },
      async (projectId) => {
        if (projectId === "b") owned.add("c");
        return "ok";
      }
    );
    await restoreWindowFleet(h.deps);
    expect(h.openedProjects()).toEqual(["a", "b"]);
    expect(h.persisted()).toBe(true);
  });

  it("stops restoring background windows once one reports the process is exiting", async () => {
    h = harness(
      { records: [record("a"), record("b"), record("c")], hadManifest: true },
      async (projectId) => (projectId === "b" ? "exit-requested" : "ok")
    );
    await restoreWindowFleet(h.deps);
    expect(h.openedProjects()).toEqual(["a", "b"]);
    expect(h.persisted()).toBe(false);
    expect(h.resumeSaves).toHaveBeenCalledTimes(1);
  });

  it("stops before the next window once the app has started shutting down", async () => {
    let quitting = false;
    h = harness(
      {
        records: [record("a"), record("b"), record("c")],
        hadManifest: true,
        isShuttingDown: () => quitting,
      },
      async (projectId) => {
        if (projectId === "b") quitting = true;
        return "ok";
      }
    );
    await restoreWindowFleet(h.deps);
    expect(h.openedProjects()).toEqual(["a", "b"]);
    expect(h.persisted()).toBe(false);
    expect(h.resumeSaves).toHaveBeenCalledTimes(1);
  });

  describe("a background window whose setup never settles", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("lets the next window start once it has held the queue too long", async () => {
      vi.useFakeTimers();
      h = harness(
        { records: [record("a"), record("b"), record("c")], hadManifest: true },
        (projectId) =>
          projectId === "b"
            ? new Promise<CreateWindowResult>(() => {})
            : Promise.resolve<CreateWindowResult>("ok")
      );
      const done = restoreWindowFleet(h.deps);

      await vi.advanceTimersByTimeAsync(RESTORE_WINDOW_STALL_MS - 1);
      expect(h.openedProjects()).toEqual(["a", "b"]);

      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(h.openedProjects()).toEqual(["a", "b", "c"]);
      expect(h.persisted()).toBe(false);
    });

    it("still reports it if it fails after the queue moved on", async () => {
      vi.useFakeTimers();
      let failLate: (error: Error) => void = () => {};
      h = harness({ records: [record("a"), record("b")], hadManifest: true }, (projectId) =>
        projectId === "b"
          ? new Promise<CreateWindowResult>((_, reject) => {
              failLate = reject;
            })
          : Promise.resolve<CreateWindowResult>("ok")
      );
      const done = restoreWindowFleet(h.deps);
      await vi.advanceTimersByTimeAsync(RESTORE_WINDOW_STALL_MS);
      await done;

      failLate(new Error("host never came up"));
      await Promise.resolve();
      expect(h.onBackgroundWindowFailed).toHaveBeenCalledTimes(1);
    });
  });

  it("carries on past a window that is not ok", async () => {
    h = harness(
      { records: [record("a"), record("b"), record("c")], hadManifest: true },
      async (projectId) => (projectId === "b" ? "not-registered" : "ok")
    );
    await restoreWindowFleet(h.deps);
    expect(h.openedProjects()).toEqual(["a", "b", "c"]);
    expect(h.persisted()).toBe(false);
  });

  it("opens windows that were on a host as pickers here, each carrying its host's project", async () => {
    const remoteA = `studio-01:${"a".repeat(64)}`;
    const remoteB = `studio-02:${"b".repeat(64)}`;
    h = harness({
      records: [record(remoteA), record("local"), record(remoteB)],
      hadManifest: true,
    });
    await restoreWindowFleet(h.deps);
    expect(h.openedProjects()).toEqual([undefined, "local", undefined]);
    const remoteKeys = h.createWindow.mock.calls.map(
      (c) => (c[1] as { remoteWorkspaceKey?: string } | undefined)?.remoteWorkspaceKey
    );
    expect(remoteKeys).toEqual([remoteA, undefined, remoteB]);
    expect(h.persisted()).toBe(true);
  });

  it("names each host the restore needs once the focused window is up, before the rest (#15888)", async () => {
    const onHost = `studio-01:${"a".repeat(64)}`;
    const onOtherHost = `studio-02:${"b".repeat(64)}`;
    const windowsAtHook: number[] = [];
    const onRemoteHostsNeeded = vi.fn(() => {
      windowsAtHook.push(h.createWindow.mock.calls.length);
    });
    h = harness({
      records: [
        { projectId: "local", backgroundProjectIds: [onHost, "local-bg"] },
        record(onOtherHost),
        record(`studio-01:${"c".repeat(64)}`),
      ],
      hadManifest: true,
      onRemoteHostsNeeded,
    });
    await restoreWindowFleet(h.deps);
    expect(onRemoteHostsNeeded).toHaveBeenCalledTimes(1);
    expect(onRemoteHostsNeeded).toHaveBeenCalledWith(["studio-01", "studio-02"]);
    expect(windowsAtHook).toEqual([1]);
  });

  it("names no host for a restore that has none", async () => {
    const onRemoteHostsNeeded = vi.fn();
    h = harness({
      records: [{ projectId: "a", backgroundProjectIds: ["b"] }, record("c"), record(null)],
      hadManifest: true,
      onRemoteHostsNeeded,
    });
    await restoreWindowFleet(h.deps);
    expect(onRemoteHostsNeeded).not.toHaveBeenCalled();
  });

  it("names no host when the focused window didn't come up", async () => {
    const onRemoteHostsNeeded = vi.fn();
    h = harness(
      {
        records: [record(`studio-01:${"a".repeat(64)}`), record("b")],
        hadManifest: true,
        onRemoteHostsNeeded,
      },
      async () => "exit-requested"
    );
    await restoreWindowFleet(h.deps);
    expect(onRemoteHostsNeeded).not.toHaveBeenCalled();
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

describe("restoreWindowFleet — background project lists (#12320)", () => {
  const bgOf = (h: Harness): (readonly string[] | undefined)[] =>
    h.createWindow.mock.calls.map(([, opts]) => opts?.backgroundProjectIds);

  it("hands each window its own background list", async () => {
    const h = harness({
      records: [
        { projectId: "a", backgroundProjectIds: ["a1", "a2"] },
        { projectId: "b", backgroundProjectIds: ["b1"] },
      ],
      hadManifest: true,
    });
    await restoreWindowFleet(h.deps);
    expect(bgOf(h)).toEqual([["a1", "a2"], ["b1"]]);
  });
});

describe("restoreWindowFleet behind a window that is already open (#12801)", () => {
  it("opens every record as an inactive background window and no primary", async () => {
    const h = harness({
      records: [record("a"), record("b"), record("c")],
      hadManifest: true,
      primaryAlreadyOpen: true,
    });

    await restoreWindowFleet(h.deps);

    expect(h.openedProjects()).toEqual(["a", "b", "c"]);
    expect(h.revealModes()).toEqual(["showInactive", "showInactive", "showInactive"]);
    expect(h.persisted()).toBe(true);
  });

  it("starts each window only after the one before it settles", async () => {
    const pending: Array<(result: CreateWindowResult) => void> = [];
    const h = harness(
      { records: [record("a"), record("b")], hadManifest: true, primaryAlreadyOpen: true },
      () => new Promise<CreateWindowResult>((resolve) => pending.push(resolve))
    );

    const run = restoreWindowFleet(h.deps);
    await Promise.resolve();
    expect(h.openedProjects()).toEqual(["a"]);
    const waits = () =>
      h.createWindow.mock.calls.map(
        (c) => (c[1] as { awaitHydrationMs?: number } | undefined)?.awaitHydrationMs
      );
    expect(waits()).toEqual([RESTORE_HYDRATION_WAIT_MS]);

    pending[0]("ok");
    await vi.waitFor(() => expect(h.openedProjects()).toEqual(["a", "b"]));
    expect(waits()).toEqual([RESTORE_HYDRATION_WAIT_MS, undefined]);

    pending[1]("ok");
    await run;
    expect(h.persisted()).toBe(true);
  });

  it("opens nothing for an empty manifest instead of a fallback window", async () => {
    const h = harness({
      records: [],
      hadManifest: false,
      fallbackProjectId: "last-active",
      primaryAlreadyOpen: true,
    });

    await restoreWindowFleet(h.deps);

    expect(h.createWindow).not.toHaveBeenCalled();
  });
});
