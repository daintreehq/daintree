import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  readProfileManifest,
  restoreProfile,
  snapshotProfile,
  waitForProfileQuiescence,
} from "../demoProfile";

let scratch: string;
let projectPath: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "demo-profile-"));
  // A snapshot records the scene it is bound to and refuses to restore without
  // it, so every restore test needs a project directory that exists.
  projectPath = path.join(scratch, "project");
  mkdirSync(projectPath, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function details(overrides: Partial<Parameters<typeof snapshotProfile>[2]> = {}) {
  return { slug: "scene", projectPath, worktreePaths: [], ...overrides };
}

/** A userData directory shaped like one the app leaves behind. */
function makeLiveProfile(name = "work", extra: Record<string, string> = {}): string {
  const dir = path.join(scratch, name);
  mkdirSync(path.join(dir, "Cache"), { recursive: true });
  mkdirSync(path.join(dir, "Local Storage", "leveldb"), { recursive: true });
  mkdirSync(path.join(dir, "projects", "abc123"), { recursive: true });
  writeFileSync(path.join(dir, "daintree.db"), "sqlite-main");
  writeFileSync(path.join(dir, "config.json"), '{"terminals":[]}');
  writeFileSync(path.join(dir, "projects", "abc123", "state.json"), '{"panels":[]}');
  writeFileSync(path.join(dir, "Cache", "blob"), "cached");
  writeFileSync(path.join(dir, "Local Storage", "leveldb", "000001.log"), "state");
  for (const [relative, contents] of Object.entries(extra)) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

describe("snapshotProfile", () => {
  it("refuses to launder a dirty exit into a clean-looking profile", () => {
    // The failure this prevents: closeApp force-kills a slow shutdown, the
    // marker is quietly filtered out, and every take then boots on a profile
    // the app believes exited cleanly — skipping its own integrity check.
    const source = makeLiveProfile("work", { "running.lock": "12345" });

    expect(() => snapshotProfile(source, path.join(scratch, "snap"), details())).toThrow(
      /did not shut down cleanly/
    );
  });

  it("keeps real persisted state across all of the app's storage surfaces", () => {
    const source = makeLiveProfile();
    const snapshot = path.join(scratch, "snap");

    snapshotProfile(source, snapshot, details());

    expect(readFileSync(path.join(snapshot, "daintree.db"), "utf8")).toBe("sqlite-main");
    expect(readFileSync(path.join(snapshot, "config.json"), "utf8")).toBe('{"terminals":[]}');
    expect(readFileSync(path.join(snapshot, "projects", "abc123", "state.json"), "utf8")).toBe(
      '{"panels":[]}'
    );
    expect(existsSync(path.join(snapshot, "Local Storage", "leveldb", "000001.log"))).toBe(true);
  });

  it("drops caches nested inside browser partitions, not just top-level ones", () => {
    // Renderer and browser panels run on persistent partitions, so the caches
    // that dominate a profile's size are never at the top level.
    const source = makeLiveProfile("work", {
      "Partitions/daintree/Cache/data_0": "x",
      "Partitions/daintree/Code Cache/js/entry": "x",
      "Partitions/daintree/Local Storage/leveldb/000001.log": "keep me",
    });
    const snapshot = path.join(scratch, "snap");

    snapshotProfile(source, snapshot, details());

    expect(existsSync(path.join(snapshot, "Partitions", "daintree", "Cache"))).toBe(false);
    expect(existsSync(path.join(snapshot, "Partitions", "daintree", "Code Cache"))).toBe(false);
    expect(
      existsSync(
        path.join(snapshot, "Partitions", "daintree", "Local Storage", "leveldb", "000001.log")
      )
    ).toBe(true);
  });

  it.each([
    ["crash-loop-state.json", "would force safe mode from an old crash"],
    ["trashed-pids.json", "startup kills the PIDs it lists"],
    ["watchdog-kill.flag", "carries a stale PID"],
    ["DevToolsActivePort", "advertises a dead port"],
    ["gpu-disabled.flag", "encodes the bake machine's driver mitigation"],
    ["SingletonLock", "Electron single-instance state"],
  ])("drops %s (%s)", (entry) => {
    const source = makeLiveProfile("work", { [entry]: "stale" });
    const snapshot = path.join(scratch, "snap");

    snapshotProfile(source, snapshot, details());

    expect(existsSync(path.join(snapshot, entry))).toBe(false);
  });

  it("drops stale crash-recovery backups while keeping intentional durable ones", () => {
    const source = makeLiveProfile("work", {
      "backups/session-state.json": "stale session",
      "backups/dev-preview-manifest.json": "real state",
    });
    const snapshot = path.join(scratch, "snap");

    snapshotProfile(source, snapshot, details());

    expect(existsSync(path.join(snapshot, "backups", "session-state.json"))).toBe(false);
    expect(existsSync(path.join(snapshot, "backups", "dev-preview-manifest.json"))).toBe(true);
  });

  it("drops interrupted-backup sidecars but keeps the database itself", () => {
    const source = makeLiveProfile("work", {
      "daintree.db.backup.tmp-wal": "",
      "daintree.db.backup.tmp-shm": "",
      "daintree.db.backup": "verified backup",
    });
    const snapshot = path.join(scratch, "snap");

    snapshotProfile(source, snapshot, details());

    expect(existsSync(path.join(snapshot, "daintree.db.backup.tmp-wal"))).toBe(false);
    expect(existsSync(path.join(snapshot, "daintree.db.backup.tmp-shm"))).toBe(false);
    expect(existsSync(path.join(snapshot, "daintree.db.backup"))).toBe(true);
  });

  it("matches whole entries, not substrings", () => {
    const source = makeLiveProfile("work", {
      "running.lock.backup": "keep",
      "Local Storage/crash-loop-state.json": "nested, not the real one",
    });
    const snapshot = path.join(scratch, "snap");

    snapshotProfile(source, snapshot, details());

    expect(existsSync(path.join(snapshot, "running.lock.backup"))).toBe(true);
    expect(existsSync(path.join(snapshot, "Local Storage", "crash-loop-state.json"))).toBe(true);
  });

  it("records the scene the profile is bound to", () => {
    const worktree = path.join(scratch, "wt");
    mkdirSync(worktree, { recursive: true });
    const snapshot = path.join(scratch, "snap");

    snapshotProfile(makeLiveProfile(), snapshot, details({ worktreePaths: [worktree] }));

    const manifest = readProfileManifest(snapshot);
    expect(manifest?.projectPath).toBe(path.resolve(projectPath));
    expect(manifest?.worktreePaths).toEqual([path.resolve(worktree)]);
    expect(manifest?.role).toBe("snapshot");
  });

  it("leaves no staging directory behind on success", () => {
    const snapshot = path.join(scratch, "snap");
    snapshotProfile(makeLiveProfile(), snapshot, details());

    const leftovers = readdirSync(scratch).filter((entry) => entry.includes(".staging-"));
    expect(leftovers).toEqual([]);
  });

  it("keeps the last good snapshot when a new one fails", () => {
    // Re-baking must not be a destructive operation: a failure that wiped the
    // golden profile would cost a full re-bake for no reason.
    const snapshot = path.join(scratch, "snap");
    snapshotProfile(makeLiveProfile("good"), snapshot, details());
    const before = readProfileManifest(snapshot);

    const dirty = makeLiveProfile("dirty", { "running.lock": "999" });
    expect(() => snapshotProfile(dirty, snapshot, details())).toThrow();

    expect(readFileSync(path.join(snapshot, "daintree.db"), "utf8")).toBe("sqlite-main");
    expect(readProfileManifest(snapshot)?.bakedAt).toBe(before?.bakedAt);
  });

  it("refuses to overwrite a directory it did not create", () => {
    const victim = path.join(scratch, "precious");
    mkdirSync(victim, { recursive: true });
    writeFileSync(path.join(victim, "thesis.txt"), "years of work\n");

    expect(() => snapshotProfile(makeLiveProfile(), victim, details())).toThrow(
      /not a demo profile/
    );
    expect(readFileSync(path.join(victim, "thesis.txt"), "utf8")).toBe("years of work\n");
  });

  it("refuses to snapshot a directory onto itself", () => {
    const source = makeLiveProfile();
    expect(() => snapshotProfile(source, source, details())).toThrow(/onto itself/);
  });

  it("replaces its own earlier snapshot completely", () => {
    const snapshot = path.join(scratch, "snap");
    snapshotProfile(makeLiveProfile("first", { "stale.json": "old" }), snapshot, details());
    expect(existsSync(path.join(snapshot, "stale.json"))).toBe(true);

    snapshotProfile(makeLiveProfile("second"), snapshot, details());

    expect(existsSync(path.join(snapshot, "stale.json"))).toBe(false);
    expect(existsSync(path.join(snapshot, "daintree.db"))).toBe(true);
  });
});

describe("restoreProfile", () => {
  function makeSnapshot(name = "snap"): string {
    const snapshot = path.join(scratch, name);
    snapshotProfile(makeLiveProfile(), snapshot, details());
    return snapshot;
  }

  it("reproduces the persisted state in the work directory", () => {
    const snapshot = makeSnapshot();
    const work = path.join(scratch, "take");

    restoreProfile(snapshot, work);

    expect(readFileSync(path.join(work, "daintree.db"), "utf8")).toBe("sqlite-main");
    expect(readFileSync(path.join(work, "projects", "abc123", "state.json"), "utf8")).toBe(
      '{"panels":[]}'
    );
  });

  it("wipes state a previous take left behind", () => {
    const snapshot = makeSnapshot();
    const work = path.join(scratch, "take");

    restoreProfile(snapshot, work);
    writeFileSync(path.join(work, "from-last-take.json"), "dirty");
    writeFileSync(path.join(work, "daintree.db"), "mutated");

    restoreProfile(snapshot, work);

    expect(existsSync(path.join(work, "from-last-take.json"))).toBe(false);
    expect(readFileSync(path.join(work, "daintree.db"), "utf8")).toBe("sqlite-main");
  });

  it("marks the work directory as a take, not as a snapshot", () => {
    // Roles keep a mutated take directory from being mistaken for a golden one.
    const snapshot = makeSnapshot();
    const work = path.join(scratch, "take");

    restoreProfile(snapshot, work);

    expect(readProfileManifest(work)?.role).toBe("work");
    expect(readProfileManifest(snapshot)?.role).toBe("snapshot");
  });

  it("refuses a source with no completed snapshot manifest", () => {
    const partial = path.join(scratch, "partial");
    mkdirSync(partial, { recursive: true });
    writeFileSync(path.join(partial, "daintree.db"), "looks plausible");

    expect(() => restoreProfile(partial, path.join(scratch, "take"))).toThrow(
      /no complete snapshot manifest/
    );
  });

  it("refuses when the scene it was baked against is gone", () => {
    // Without the repository, a restored take opens a project that is not there.
    const snapshot = makeSnapshot();
    rmSync(projectPath, { recursive: true, force: true });

    expect(() => restoreProfile(snapshot, path.join(scratch, "take"))).toThrow(/project is gone/);
  });

  it("refuses a snapshot baked on another platform", () => {
    const snapshot = makeSnapshot();
    const manifestFile = path.join(snapshot, ".daintree-demo-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, platform: "solaris" }, null, 2) + "\n"
    );

    expect(() => restoreProfile(snapshot, path.join(scratch, "take"))).toThrow(/not portable/);
  });

  it("refuses to restore a snapshot onto itself", () => {
    const snapshot = makeSnapshot();
    expect(() => restoreProfile(snapshot, snapshot)).toThrow(/onto itself/);
    expect(existsSync(path.join(snapshot, "daintree.db"))).toBe(true);
  });

  it("refuses a work directory belonging to a different scene", () => {
    const snapshot = makeSnapshot();
    const otherWork = path.join(scratch, "other-take");
    snapshotProfile(makeLiveProfile("other-live"), path.join(scratch, "other-snap"), {
      slug: "other-scene",
      projectPath,
      worktreePaths: [],
    });
    restoreProfile(path.join(scratch, "other-snap"), otherWork);

    expect(() => restoreProfile(snapshot, otherWork)).toThrow(/belongs to demo profile/);
  });

  it("refuses a work directory where an app may still be running", () => {
    const snapshot = makeSnapshot();
    const work = path.join(scratch, "take");
    restoreProfile(snapshot, work);
    writeFileSync(path.join(work, "running.lock"), "4242");

    expect(() => restoreProfile(snapshot, work)).toThrow(/may still be running/);
  });
});

describe("waitForProfileQuiescence", () => {
  it("returns once the profile stops changing", async () => {
    const dir = makeLiveProfile();
    await expect(
      waitForProfileQuiescence(dir, { settleMs: 100, pollMs: 25, timeoutMs: 5_000 })
    ).resolves.toBeUndefined();
  });

  it("keeps waiting while a writer is still active, then settles", async () => {
    // This is the barrier that makes a debounced write survive the bake.
    const dir = makeLiveProfile();
    let writes = 0;
    const timer = setInterval(() => {
      writes += 1;
      writeFileSync(path.join(dir, "config.json"), `{"n":${writes}}`);
      if (writes >= 4) clearInterval(timer);
    }, 40);

    await waitForProfileQuiescence(dir, { settleMs: 150, pollMs: 25, timeoutMs: 5_000 });

    clearInterval(timer);
    expect(writes).toBe(4);
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).toBe('{"n":4}');
  });

  it("gives up rather than hanging when something never stops writing", async () => {
    const dir = makeLiveProfile();
    const timer = setInterval(() => {
      writeFileSync(path.join(dir, "config.json"), `{"t":${Date.now()}}`);
    }, 20);

    try {
      await expect(
        waitForProfileQuiescence(dir, { settleMs: 200, pollMs: 20, timeoutMs: 600 })
      ).rejects.toThrow(/never stopped changing/);
    } finally {
      clearInterval(timer);
    }
  });

  it("ignores cache churn, which never settles", async () => {
    const dir = makeLiveProfile();
    const timer = setInterval(() => {
      writeFileSync(path.join(dir, "Cache", "blob"), `${Date.now()}`);
    }, 20);

    try {
      await waitForProfileQuiescence(dir, { settleMs: 100, pollMs: 25, timeoutMs: 3_000 });
    } finally {
      clearInterval(timer);
    }
  });
});
