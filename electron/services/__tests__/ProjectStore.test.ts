import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { generateProjectId, isValidProjectId, getProjectStateDir } from "../projectStorePaths.js";

describe("ProjectStore", () => {
  describe("generateProjectId", () => {
    it("generates valid SHA256 hex string IDs", () => {
      const id = generateProjectId("/Users/foo/my-repo");
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });

    it("generates deterministic IDs for same path", () => {
      const id1 = generateProjectId("/Users/foo/my-repo");
      const id2 = generateProjectId("/Users/foo/my-repo");
      expect(id1).toBe(id2);
    });

    it("generates different IDs for different paths", () => {
      const id1 = generateProjectId("/Users/foo/repo-a");
      const id2 = generateProjectId("/Users/foo/repo-b");
      expect(id1).not.toBe(id2);
    });
  });

  describe("isValidProjectId", () => {
    it("accepts valid 64-character hex string", () => {
      const validId = "a".repeat(64);
      expect(isValidProjectId(validId)).toBe(true);
    });

    it("accepts mixed hex characters", () => {
      const validId = "0123456789abcdef".repeat(4);
      expect(isValidProjectId(validId)).toBe(true);
    });

    it("rejects short strings", () => {
      expect(isValidProjectId("abc")).toBe(false);
      expect(isValidProjectId("a".repeat(63))).toBe(false);
    });

    it("rejects long strings", () => {
      expect(isValidProjectId("a".repeat(65))).toBe(false);
    });

    it("rejects non-hex characters", () => {
      expect(isValidProjectId("g".repeat(64))).toBe(false);
      expect(isValidProjectId("z".repeat(64))).toBe(false);
    });

    it("rejects uppercase hex characters", () => {
      expect(isValidProjectId("A".repeat(64))).toBe(false);
      expect(isValidProjectId("ABCDEF".repeat(10) + "abcd")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isValidProjectId("")).toBe(false);
    });

    it("rejects path traversal attempts", () => {
      expect(isValidProjectId("../../../etc/passwd")).toBe(false);
      expect(isValidProjectId("..")).toBe(false);
      expect(isValidProjectId("./test")).toBe(false);
    });
  });

  describe("getProjectStateDir", () => {
    const projectsConfigDir = path.resolve("/home/user/.config/daintree/projects");

    it("returns valid path for valid hex ID", () => {
      const validId = "a".repeat(64);
      const dir = getProjectStateDir(projectsConfigDir, validId);
      expect(dir).toBe(path.join(projectsConfigDir, validId));
    });

    it("returns null for invalid project ID", () => {
      expect(getProjectStateDir(projectsConfigDir, "invalid")).toBeNull();
      expect(getProjectStateDir(projectsConfigDir, "")).toBeNull();
      expect(getProjectStateDir(projectsConfigDir, "short")).toBeNull();
    });

    it("rejects path with .. in middle", () => {
      const attemptedTraversal = "a".repeat(30) + ".." + "a".repeat(32);
      const dir = getProjectStateDir(projectsConfigDir, attemptedTraversal);
      expect(dir).toBeNull();
    });
  });

  describe("path safety integration", () => {
    const projectsConfigDir = path.resolve("/home/user/.config/daintree/projects");

    it("prevents accessing files outside projectsConfigDir", () => {
      const attacks = [
        "../../../etc/passwd",
        "..%2F..%2F..%2Fetc%2Fpasswd",
        "....//....//etc/passwd",
        "..\\..\\..\\etc\\passwd",
        "/etc/passwd",
        "a/../../../etc/passwd",
      ];

      for (const attack of attacks) {
        const result = getProjectStateDir(projectsConfigDir, attack);
        expect(result).toBeNull();
      }
    });
  });
});

describe("ProjectStore ID collision resistance", () => {
  it("generates unique IDs for similar paths", () => {
    const paths = [
      "/Users/foo/project",
      "/Users/foo/project1",
      "/Users/foo/project2",
      "/Users/foo/projects",
      "/Users/foo/project/",
      "/users/foo/project",
    ];

    const ids = paths.map(generateProjectId);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(paths.length);
  });
});

// --- getAllProjects status reconciliation tests (DB-backed) ---

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import fs from "fs";
import os from "os";
import * as schema from "../persistence/schema.js";
import { simpleGitMissingBinaryError } from "../../../shared/testing/simpleGitErrorFixtures.js";
import { GitOperationError } from "../../utils/errorTypes.js";

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    last_opened INTEGER NOT NULL,
    color TEXT,
    status TEXT,
    daintree_config_present INTEGER,
    in_repo_settings INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0,
    frecency_score REAL NOT NULL DEFAULT 3.0,
    last_accessed_at INTEGER NOT NULL DEFAULT 0,
    last_completion_seen_at INTEGER,
    auto_parked_at INTEGER,
    resumable_agent_count INTEGER,
    stats_commit_count INTEGER,
    stats_issue_count INTEGER,
    stats_pr_count INTEGER,
    stats_provider_id TEXT,
    stats_last_updated INTEGER,
    git_backed INTEGER,
    archived_at INTEGER,
    never_auto_sleep INTEGER NOT NULL DEFAULT 0,
    group_id TEXT
  );
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("../persistence/db.js", () => ({
  getSharedDb: () => db,
  openDb: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-reconciliation-test" },
}));

/** Set per test to control what the git layer does; counts construction. */
const gitBehavior = vi.hoisted(() => ({
  constructed: 0,
  getRepositoryRoot: vi.fn<(p: string) => Promise<string>>(async (p: string) => p),
}));

vi.mock("../GitService.js", () => ({
  GitService: class {
    constructor() {
      gitBehavior.constructed += 1;
    }
    async getRepositoryRoot(p: string): Promise<string> {
      return gitBehavior.getRepositoryRoot(p);
    }
  },
}));

vi.mock("../ProjectSettingsManager.js", () => ({
  ProjectSettingsManager: class {
    deleteAllEnvForProject() {}
    migrateEnvForProject() {}
    getEffectiveNotificationSettings(...args: unknown[]) {
      return { forwarded: args };
    }
  },
}));

vi.mock("../ProjectStateManager.js", () => ({
  ProjectStateManager: class {
    setStatePersistedObserver() {}
    invalidateProjectStateCache() {}
  },
}));

vi.mock("../ProjectFileStore.js", () => ({
  ProjectFileStore: class {},
}));

vi.mock("../GlobalFileStore.js", () => ({
  GlobalFileStore: class {},
}));

vi.mock("../ProjectIdentityFiles.js", () => ({
  ProjectIdentityFiles: class {
    async readInRepoProjectIdentity() {
      return { found: false };
    }
  },
}));

vi.mock("../projectQuarantineCleanup.js", () => ({
  cleanupQuarantinedProjectFiles: vi.fn(),
}));

import { ProjectStore } from "../ProjectStore.js";
import { setWritesSuppressed, resetWritesSuppressedForTesting } from "../diskPressureState.js";
import { getMruProjects } from "../../../shared/utils/projectMru.js";

describe("ProjectStore.getAllProjects reconciliation", () => {
  let store: ProjectStore;
  let alphaDir: string;
  let betaDir: string;
  let gammaDir: string;
  let currentProjectId: string;
  let staleActiveId: string;
  let invalidStatusId: string;

  beforeEach(async () => {
    alphaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-rec-a-"));
    betaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-rec-b-"));
    gammaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-rec-c-"));
    const { generateProjectId } = await import("../projectStorePaths.js");
    const alphaCanonical = await fs.promises.realpath(alphaDir);
    const betaCanonical = await fs.promises.realpath(betaDir);
    const gammaCanonical = await fs.promises.realpath(gammaDir);
    currentProjectId = generateProjectId(alphaCanonical);
    staleActiveId = generateProjectId(betaCanonical);
    invalidStatusId = generateProjectId(gammaCanonical);

    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    const now = Date.now();

    // Current project — incorrectly marked as "closed"
    db.insert(schema.projects)
      .values({
        id: currentProjectId,
        path: alphaCanonical,
        name: "Alpha",
        emoji: "🌲",
        lastOpened: now,
        status: "closed",
        frecencyScore: 10.0,
        lastAccessedAt: now,
      })
      .run();

    // Stale row — incorrectly marked as "active" (should be background)
    db.insert(schema.projects)
      .values({
        id: staleActiveId,
        path: betaCanonical,
        name: "Beta",
        emoji: "🌲",
        lastOpened: now - 86_400_000,
        status: "active",
        frecencyScore: 5.0,
        lastAccessedAt: now - 86_400_000,
      })
      .run();

    // Row with invalid status (not in validStatuses)
    db.insert(schema.projects)
      .values({
        id: invalidStatusId,
        path: gammaCanonical,
        name: "Gamma",
        emoji: "🌲",
        lastOpened: now - 172_800_000,
        status: "bogus-status",
        frecencyScore: 1.0,
        lastAccessedAt: now - 172_800_000,
      })
      .run();

    db.insert(schema.appState).values({ key: "currentProjectId", value: currentProjectId }).run();

    store = new ProjectStore();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(alphaDir, { recursive: true, force: true });
    fs.rmSync(betaDir, { recursive: true, force: true });
    fs.rmSync(gammaDir, { recursive: true, force: true });
  });

  it("reconciles all three status categories and persists to DB", () => {
    const projects = store.getAllProjects();

    // Returned values are reconciled
    const current = projects.find((p) => p.id === currentProjectId);
    const stale = projects.find((p) => p.id === staleActiveId);
    const invalid = projects.find((p) => p.id === invalidStatusId);

    expect(current?.status).toBe("active");
    expect(stale?.status).toBe("background");
    expect(invalid?.status).toBe("closed");

    // DB rows are persisted
    const currentRow = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, currentProjectId))
      .get();
    expect(currentRow?.status).toBe("active");

    const staleRow = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, staleActiveId))
      .get();
    expect(staleRow?.status).toBe("background");

    const invalidRow = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, invalidStatusId))
      .get();
    expect(invalidRow?.status).toBe("closed");
  });

  it("runs reconciliation inside an IMMEDIATE transaction", () => {
    const spy = vi.spyOn(db, "transaction");
    store.getAllProjects();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { behavior: "immediate" });
    spy.mockRestore();
  });

  it("gates demotion warning behind DAINTREE_VERBOSE", () => {
    const warnSpy = vi.spyOn(console, "warn");

    // Without DAINTREE_VERBOSE — no warning
    delete process.env.DAINTREE_VERBOSE;
    store.getAllProjects();
    expect(warnSpy).not.toHaveBeenCalled();

    // Re-insert the stale active row so the warning has something to fire for
    db.update(schema.projects)
      .set({ status: "active" })
      .where(eq(schema.projects.id, staleActiveId))
      .run();

    // With DAINTREE_VERBOSE — warning fires
    process.env.DAINTREE_VERBOSE = "1";
    store.getAllProjects();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Demoting incorrectly active project")
    );

    delete process.env.DAINTREE_VERBOSE;
    warnSpy.mockRestore();
  });

  it("no-ops when all statuses are already correct (no transaction opened)", () => {
    // First call reconciles everything
    store.getAllProjects();

    // Second call should be a no-op — no write-locking transaction is opened
    // when every row's status is already correct (the hot-path win).
    const updateSpy = vi.spyOn(db, "update");
    const txSpy = vi.spyOn(db, "transaction");
    store.getAllProjects();
    expect(txSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    txSpy.mockRestore();
    updateSpy.mockRestore();
  });
});

/**
 * The identity projection behind workspace discovery (#12307).
 *
 * Its whole reason to exist is what it does NOT do: `getAllProjects()` repairs
 * row statuses inside a write-locking IMMEDIATE transaction, which is wrong for
 * a read an external MCP client can call at will. Seeded with the same
 * inconsistent statuses the reconciliation suite above uses, so an
 * implementation that delegated to `getAllProjects()` and mapped its result
 * would be caught here rather than in production.
 */
describe("ProjectStore.getAllProjectIdentities", () => {
  let store: ProjectStore;
  let dirs: string[];
  let currentId: string;
  let staleActiveId: string;
  let relocatedId: string;

  beforeEach(async () => {
    const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "daintree-ident-"));
    const alphaDir = mk();
    const betaDir = mk();
    const gammaDir = mk();
    dirs = [alphaDir, betaDir, gammaDir];

    const { generateProjectId } = await import("../projectStorePaths.js");
    const alpha = await fs.promises.realpath(alphaDir);
    const beta = await fs.promises.realpath(betaDir);
    const gamma = await fs.promises.realpath(gammaDir);

    currentId = generateProjectId(alpha);
    staleActiveId = generateProjectId(beta);
    // A project that has MOVED: its id was minted from a path it no longer
    // lives at, which is precisely the case hashing cannot recover (#11282).
    relocatedId = generateProjectId("/somewhere/it/used/to/live");

    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    const now = Date.now();
    db.insert(schema.projects)
      .values({
        id: currentId,
        path: alpha,
        name: "Alpha",
        emoji: "🌲",
        lastOpened: now,
        status: "closed",
        frecencyScore: 10,
        lastAccessedAt: now,
      })
      .run();
    db.insert(schema.projects)
      .values({
        id: staleActiveId,
        path: beta,
        name: "Beta",
        emoji: "🌲",
        lastOpened: now - 1000,
        status: "active",
        frecencyScore: 5,
        lastAccessedAt: now - 1000,
      })
      .run();
    db.insert(schema.projects)
      .values({
        id: relocatedId,
        path: gamma,
        name: "Gamma",
        emoji: "🌲",
        lastOpened: now - 2000,
        status: null,
        frecencyScore: 1,
        lastAccessedAt: now - 2000,
      })
      .run();
    db.insert(schema.appState).values({ key: "currentProjectId", value: currentId }).run();

    store = new ProjectStore();
  });

  afterEach(() => {
    sqlite.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns id, path and name for every row and nothing else", () => {
    const identities = store.getAllProjectIdentities();

    expect(identities).toHaveLength(3);
    for (const identity of identities) {
      // Identity only — a widened projection would leak emoji, statuses,
      // frecency and completion timestamps onto the external MCP surface.
      expect(Object.keys(identity).sort()).toEqual(["id", "name", "path"]);
    }
    expect(identities.map((i) => i.name).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("includes closed and legacy-null-status projects", () => {
    const ids = store.getAllProjectIdentities().map((i) => i.id);

    // `status` is lifecycle, not deletion: a closed workspace is still one a
    // caller may want to bind to, and listing only open ones would put a client
    // back where it started.
    expect(ids).toContain(currentId);
    expect(ids).toContain(relocatedId);
  });

  it("returns the stored id for a relocated project rather than a path hash", async () => {
    const { generateProjectId } = await import("../projectStorePaths.js");
    const relocated = store.getAllProjectIdentities().find((i) => i.id === relocatedId);

    expect(relocated).toBeDefined();
    // The whole point of the tool: hashing the CURRENT path gives a different
    // id, so discovery has to report what is stored.
    expect(generateProjectId(relocated!.path)).not.toBe(relocated!.id);
  });

  it("opens no write transaction and repairs no status", () => {
    const txSpy = vi.spyOn(db, "transaction");
    const updateSpy = vi.spyOn(db, "update");

    store.getAllProjectIdentities();

    expect(txSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();

    // And the rows the reconciliation pass would have rewritten are untouched:
    // `currentId` is the current project still marked "closed", and
    // `staleActiveId` is a non-current row still marked "active".
    const currentRow = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, currentId))
      .get();
    const staleRow = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, staleActiveId))
      .get();
    expect(currentRow?.status).toBe("closed");
    expect(staleRow?.status).toBe("active");

    txSpy.mockRestore();
    updateSpy.mockRestore();
  });

  it("returns an empty list when no projects are registered", () => {
    db.delete(schema.projects).run();
    expect(store.getAllProjectIdentities()).toEqual([]);
  });
});

describe("ProjectStore disk pressure suppression", () => {
  let store: ProjectStore;
  let alphaDir: string;
  let betaDir: string;
  let projectId: string;
  let otherProjectId: string;
  const seededFrecencyScore = 7.5;
  // Use a recent timestamp so the half-life decay during the test doesn't
  // drag the new score below the seeded value when frecency is recomputed.
  let seededLastAccessedAt: number;
  let seededLastOpened: number;

  beforeEach(async () => {
    alphaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-ps-alpha-"));
    betaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-ps-beta-"));
    // generateProjectId uses path.normalize on the canonical realpath
    const { generateProjectId } = await import("../projectStorePaths.js");
    const alphaCanonical = await fs.promises.realpath(alphaDir);
    const betaCanonical = await fs.promises.realpath(betaDir);
    projectId = generateProjectId(alphaCanonical);
    otherProjectId = generateProjectId(betaCanonical);

    // Outside the 5-minute access debounce, so an unsuppressed bump is
    // expected to actually add its increment.
    seededLastAccessedAt = Date.now() - 10 * 60_000;
    seededLastOpened = seededLastAccessedAt;

    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    db.insert(schema.projects)
      .values({
        id: projectId,
        path: alphaCanonical,
        name: "Alpha",
        emoji: "🌲",
        lastOpened: seededLastOpened,
        status: "closed",
        frecencyScore: seededFrecencyScore,
        lastAccessedAt: seededLastAccessedAt,
      })
      .run();

    db.insert(schema.projects)
      .values({
        id: otherProjectId,
        path: betaCanonical,
        name: "Beta",
        emoji: "🌲",
        lastOpened: seededLastOpened,
        status: "active",
        frecencyScore: 1.0,
        lastAccessedAt: seededLastAccessedAt,
      })
      .run();

    db.insert(schema.appState).values({ key: "currentProjectId", value: otherProjectId }).run();

    store = new ProjectStore();
  });

  afterEach(() => {
    resetWritesSuppressedForTesting();
    sqlite.close();
    fs.rmSync(alphaDir, { recursive: true, force: true });
    fs.rmSync(betaDir, { recursive: true, force: true });
  });

  it("setCurrentProject still updates currentProjectId and active status under suppression", async () => {
    setWritesSuppressed(true);

    await store.setCurrentProject(projectId);

    const ptr = db
      .select()
      .from(schema.appState)
      .where(eq(schema.appState.key, "currentProjectId"))
      .get();
    expect(ptr?.value).toBe(projectId);

    const newActive = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .get();
    expect(newActive?.status).toBe("active");

    const previous = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, otherProjectId))
      .get();
    expect(previous?.status).toBe("background");
  });

  it("setCurrentProject does NOT update frecency columns under suppression", async () => {
    setWritesSuppressed(true);

    await store.setCurrentProject(projectId);

    const row = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    expect(row?.frecencyScore).toBe(seededFrecencyScore);
    expect(row?.lastAccessedAt).toBe(seededLastAccessedAt);
    expect(row?.lastOpened).toBe(seededLastOpened);
  });

  it("setCurrentProject DOES update frecency columns when not suppressed", async () => {
    setWritesSuppressed(false);

    await store.setCurrentProject(projectId);

    const row = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    // Frecency score increases on access (boost added before decay).
    expect(row?.frecencyScore).toBeGreaterThan(seededFrecencyScore);
    expect(row?.lastAccessedAt).toBeGreaterThan(seededLastAccessedAt);
    expect(row?.lastOpened).toBeGreaterThan(seededLastOpened);
  });

  it("addProject for existing project skips frecency refresh under suppression", async () => {
    setWritesSuppressed(true);

    const result = await store.addProject(alphaDir);

    expect(result.id).toBe(projectId);
    expect(result.frecencyScore).toBe(seededFrecencyScore);
    expect(result.lastAccessedAt).toBe(seededLastAccessedAt);

    // DB row unchanged
    const row = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    expect(row?.frecencyScore).toBe(seededFrecencyScore);
    expect(row?.lastAccessedAt).toBe(seededLastAccessedAt);
    expect(row?.lastOpened).toBe(seededLastOpened);
  });

  it("addProject for existing project DOES refresh frecency when not suppressed", async () => {
    setWritesSuppressed(false);

    const result = await store.addProject(alphaDir);

    expect(result.id).toBe(projectId);
    expect(result.frecencyScore ?? 0).toBeGreaterThan(seededFrecencyScore);
    expect(result.lastAccessedAt ?? 0).toBeGreaterThanOrEqual(seededLastAccessedAt);
  });

  it("switching back inside the debounce window re-bases the score without incrementing", async () => {
    setWritesSuppressed(false);

    // Simulate having left the project moments ago: lastOpened is fresh while
    // the score timestamp is old. Rapid A↔B toggling must not accrue rank.
    const justLeft = Date.now() - 30_000;
    db.update(schema.projects)
      .set({ lastOpened: justLeft })
      .where(eq(schema.projects.id, projectId))
      .run();

    await store.setCurrentProject(projectId);

    const row = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    // Re-based to now (timestamp advances, decay applied) but no +1 increment.
    expect(row?.lastAccessedAt).toBeGreaterThan(seededLastAccessedAt);
    expect(row?.frecencyScore).toBeLessThanOrEqual(seededFrecencyScore);
    expect(row?.frecencyScore).toBeGreaterThan(seededFrecencyScore - 0.01);
    // lastOpened still tracks the real open, debounced or not.
    expect(row?.lastOpened).toBeGreaterThan(justLeft);
  });
});

describe("ProjectStore.getEffectiveNotificationSettings (#15635)", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });
    db.insert(schema.appState).values({ key: "currentProjectId", value: "current" }).run();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("asks for the named project's overrides, never the current one's", () => {
    const store = new ProjectStore();
    const shell = { waitingEnabled: false };

    expect(store.getCurrentProjectId()).toBe("current");
    expect(store.getEffectiveNotificationSettings("other", shell)).toEqual({
      forwarded: ["other", shell],
    });
    expect(store.getEffectiveNotificationSettings(null)).toEqual({
      forwarded: [null, undefined],
    });
  });
});

describe("ProjectStore transaction mode", () => {
  let store: ProjectStore;
  let projectId: string;
  let otherProjectId: string;
  let alphaDir: string;
  let betaDir: string;
  let seededLastAccessedAt: number;
  let seededLastOpened: number;
  const seededFrecencyScore = 7.5;

  beforeEach(async () => {
    alphaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-ps-tx-a-"));
    betaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-ps-tx-b-"));
    const { generateProjectId } = await import("../projectStorePaths.js");
    const alphaCanonical = await fs.promises.realpath(alphaDir);
    const betaCanonical = await fs.promises.realpath(betaDir);
    projectId = generateProjectId(alphaCanonical);
    otherProjectId = generateProjectId(betaCanonical);

    // Outside the 5-minute access debounce, so an unsuppressed bump is
    // expected to actually add its increment.
    seededLastAccessedAt = Date.now() - 10 * 60_000;
    seededLastOpened = seededLastAccessedAt;

    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    db.insert(schema.projects)
      .values({
        id: projectId,
        path: alphaCanonical,
        name: "Alpha",
        emoji: "🌲",
        lastOpened: seededLastOpened,
        status: "closed",
        frecencyScore: seededFrecencyScore,
        lastAccessedAt: seededLastAccessedAt,
      })
      .run();

    db.insert(schema.projects)
      .values({
        id: otherProjectId,
        path: betaCanonical,
        name: "Beta",
        emoji: "🌲",
        lastOpened: seededLastOpened,
        status: "active",
        frecencyScore: 1.0,
        lastAccessedAt: seededLastAccessedAt,
      })
      .run();

    // Seed a different current project so the "mark previous as background" branch fires
    db.insert(schema.appState).values({ key: "currentProjectId", value: otherProjectId }).run();

    store = new ProjectStore();
  });

  afterEach(() => {
    resetWritesSuppressedForTesting();
    sqlite.close();
    fs.rmSync(alphaDir, { recursive: true, force: true });
    fs.rmSync(betaDir, { recursive: true, force: true });
  });

  it("runs setCurrentProject transaction in IMMEDIATE mode", async () => {
    const spy = vi.spyOn(db, "transaction");
    await store.setCurrentProject(projectId);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { behavior: "immediate" });
    spy.mockRestore();
  });
});

describe("ProjectStore autoParkedAt", () => {
  let store: ProjectStore;
  let projectDir: string;
  let projectId: string;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-park-"));
    const canonical = await fs.promises.realpath(projectDir);
    const { generateProjectId } = await import("../projectStorePaths.js");
    projectId = generateProjectId(canonical);

    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    db.insert(schema.projects)
      .values({
        id: projectId,
        path: canonical,
        name: "Parked",
        emoji: "🌲",
        lastOpened: Date.now() - 10 * 60_000,
        status: "background",
        frecencyScore: 3.0,
        lastAccessedAt: Date.now() - 10 * 60_000,
      })
      .run();

    store = new ProjectStore();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("persists autoParkedAt when closing with the marker", () => {
    const t = Date.now();
    store.updateProjectStatus(projectId, "closed", { autoParkedAt: t });
    const project = store.getProjectById(projectId);
    expect(project?.status).toBe("closed");
    expect(project?.autoParkedAt).toBe(t);
  });

  it("clears autoParkedAt when passed null (robust null clear, not undefined)", () => {
    store.updateProjectStatus(projectId, "closed", { autoParkedAt: Date.now() });
    expect(store.getProjectById(projectId)?.autoParkedAt).toEqual(expect.any(Number));

    store.updateProjectStatus(projectId, "closed", { autoParkedAt: null });
    expect(store.getProjectById(projectId)?.autoParkedAt).toBeUndefined();
  });

  it("leaves autoParkedAt untouched when status is updated without the option", () => {
    const t = Date.now();
    store.updateProjectStatus(projectId, "closed", { autoParkedAt: t });
    // A status-only update must not stomp the existing marker.
    store.updateProjectStatus(projectId, "closed");
    expect(store.getProjectById(projectId)?.autoParkedAt).toBe(t);
  });

  it("round-trips neverAutoSleep without touching pinned", () => {
    expect(store.getProjectById(projectId)?.neverAutoSleep).toBeUndefined();

    store.updateProject(projectId, { neverAutoSleep: true });
    const on = store.getProjectById(projectId);
    expect(on?.neverAutoSleep).toBe(true);
    expect(on?.pinned).toBeUndefined();

    store.updateProject(projectId, { pinned: true });
    expect(store.getProjectById(projectId)?.neverAutoSleep).toBe(true);

    store.updateProject(projectId, { neverAutoSleep: false });
    expect(store.getProjectById(projectId)?.neverAutoSleep).toBeUndefined();
    expect(store.getProjectById(projectId)?.pinned).toBe(true);
  });

  it("clears autoParkedAt when the project is reopened (setCurrentProject)", async () => {
    store.updateProjectStatus(projectId, "closed", { autoParkedAt: Date.now() });
    expect(store.getProjectById(projectId)?.autoParkedAt).toEqual(expect.any(Number));

    await store.setCurrentProject(projectId);
    const project = store.getProjectById(projectId);
    expect(project?.status).toBe("active");
    expect(project?.autoParkedAt).toBeUndefined();
  });
});

describe("ProjectStore.setCurrentProject MRU lastOpened bump", () => {
  let store: ProjectStore;
  let alphaDir: string;
  let betaDir: string;
  let gammaDir: string;
  let alphaId: string;
  let betaId: string;
  let gammaId: string;
  // T_ALPHA < T_BETA < T_GAMMA — Gamma is the most recently opened of the others.
  let tAlpha: number;
  let tBeta: number;
  let tGamma: number;

  beforeEach(async () => {
    alphaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-mru-a-"));
    betaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-mru-b-"));
    gammaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-mru-c-"));
    const { generateProjectId } = await import("../projectStorePaths.js");
    const alphaCanonical = await fs.promises.realpath(alphaDir);
    const betaCanonical = await fs.promises.realpath(betaDir);
    const gammaCanonical = await fs.promises.realpath(gammaDir);
    alphaId = generateProjectId(alphaCanonical);
    betaId = generateProjectId(betaCanonical);
    gammaId = generateProjectId(gammaCanonical);

    const baseline = Date.now() - 10 * 60_000;
    tAlpha = baseline;
    tBeta = baseline + 60_000;
    tGamma = baseline + 120_000;

    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    // Alpha is current but has the OLDEST lastOpened (stale because it was
    // opened a while ago and never bumped while the user worked in it).
    db.insert(schema.projects)
      .values({
        id: alphaId,
        path: alphaCanonical,
        name: "Alpha",
        emoji: "🌲",
        lastOpened: tAlpha,
        status: "active",
        frecencyScore: 5.0,
        lastAccessedAt: tAlpha,
      })
      .run();

    db.insert(schema.projects)
      .values({
        id: betaId,
        path: betaCanonical,
        name: "Beta",
        emoji: "🌲",
        lastOpened: tBeta,
        status: "background",
        frecencyScore: 5.0,
        lastAccessedAt: tBeta,
      })
      .run();

    db.insert(schema.projects)
      .values({
        id: gammaId,
        path: gammaCanonical,
        name: "Gamma",
        emoji: "🌲",
        lastOpened: tGamma,
        status: "background",
        frecencyScore: 5.0,
        lastAccessedAt: tGamma,
      })
      .run();

    db.insert(schema.appState).values({ key: "currentProjectId", value: alphaId }).run();

    store = new ProjectStore();
  });

  afterEach(() => {
    resetWritesSuppressedForTesting();
    sqlite.close();
    fs.rmSync(alphaDir, { recursive: true, force: true });
    fs.rmSync(betaDir, { recursive: true, force: true });
    fs.rmSync(gammaDir, { recursive: true, force: true });
  });

  it("bumps the departing project's lastOpened so it becomes the top MRU candidate", async () => {
    // Switch Alpha → Gamma.
    await store.setCurrentProject(gammaId);

    const alphaRow = db.select().from(schema.projects).where(eq(schema.projects.id, alphaId)).get();
    const gammaRow = db.select().from(schema.projects).where(eq(schema.projects.id, gammaId)).get();

    // Gamma is now active and has the freshest lastOpened.
    expect(gammaRow?.status).toBe("active");
    expect(gammaRow?.lastOpened).toBeGreaterThan(tGamma);

    // Alpha is background and its lastOpened was bumped — within 1ms of Gamma
    // but still strictly less so the active project remains the MRU head.
    expect(alphaRow?.status).toBe("background");
    expect(alphaRow!.lastOpened).toBeGreaterThan(tBeta);
    expect(alphaRow!.lastOpened).toBeLessThan(gammaRow!.lastOpened!);

    // Sanity: MRU sort now ranks Alpha above Beta among non-current projects.
    const projects = store.getAllProjects();
    const mruExcludingCurrent = getMruProjects(projects).filter((p) => p.id !== gammaId);
    expect(mruExcludingCurrent[0]?.id).toBe(alphaId);
    expect(mruExcludingCurrent[1]?.id).toBe(betaId);
  });

  it("supports Alt+Tab toggle: A→B→A returns to the original project", async () => {
    // Simulate the quick-tap path: pick the top MRU non-current and switch.
    const switchToTopMru = async (): Promise<string> => {
      const currentId = store.getCurrentProjectId();
      const others = getMruProjects(store.getAllProjects()).filter((p) => p.id !== currentId);
      const target = others[0];
      if (!target) throw new Error("no target");
      await store.setCurrentProject(target.id);
      return target.id;
    };

    // Press Cmd+Alt+= from Alpha → goes to Gamma (most-recent non-current).
    const firstTarget = await switchToTopMru();
    expect(firstTarget).toBe(gammaId);
    expect(store.getCurrentProjectId()).toBe(gammaId);

    // Press Cmd+Alt+= again → must return to Alpha, not slide to Beta.
    const secondTarget = await switchToTopMru();
    expect(secondTarget).toBe(alphaId);
    expect(store.getCurrentProjectId()).toBe(alphaId);
  });

  it("does NOT touch the departing project's lastOpened under write suppression", async () => {
    setWritesSuppressed(true);

    await store.setCurrentProject(gammaId);

    const alphaRow = db.select().from(schema.projects).where(eq(schema.projects.id, alphaId)).get();

    // Status still flips (session state is unconditional), but lastOpened is
    // left alone so we don't write to disk under pressure.
    expect(alphaRow?.status).toBe("background");
    expect(alphaRow?.lastOpened).toBe(tAlpha);
  });

  it("gives the departing MRU bump to the named project, not the global pointer (#11101)", async () => {
    // Multi-window: Alpha is globally current (window A still displays it) while
    // window B, displaying Beta, is the one switching to Gamma.
    //
    // Only `lastOpened` is asserted here. `status` is NOT a per-window concept —
    // getAllProjects() reconciles it to a singleton keyed on the global pointer —
    // so asserting "Alpha stays active" would encode an invariant the store
    // deliberately does not hold.
    await store.setCurrentProject(gammaId, betaId);

    const alphaRow = db.select().from(schema.projects).where(eq(schema.projects.id, alphaId)).get();
    const betaRow = db.select().from(schema.projects).where(eq(schema.projects.id, betaId)).get();
    const gammaRow = db.select().from(schema.projects).where(eq(schema.projects.id, gammaId)).get();

    // Beta actually departed a window, so it takes the departing bump and
    // becomes the top Alt+Tab candidate behind the newly-active Gamma.
    expect(betaRow!.lastOpened).toBeGreaterThan(tGamma);
    expect(betaRow!.lastOpened).toBeLessThan(gammaRow!.lastOpened!);

    // Alpha departed nothing — bumping it would hand the Alt+Tab head to a
    // project the user never left, which is what the global read used to do.
    expect(alphaRow?.lastOpened).toBe(tAlpha);

    expect(gammaRow?.status).toBe("active");
    expect(store.getCurrentProjectId()).toBe(gammaId);

    const mruExcludingCurrent = getMruProjects(store.getAllProjects()).filter(
      (p) => p.id !== gammaId
    );
    expect(mruExcludingCurrent[0]?.id).toBe(betaId);
  });

  it("bumps nothing when the departing project is explicitly null", async () => {
    // A welcome view has no project to depart. `undefined` would infer Alpha from
    // the global pointer and hand it an MRU boost the user never earned.
    await store.setCurrentProject(gammaId, null);

    const alphaRow = db.select().from(schema.projects).where(eq(schema.projects.id, alphaId)).get();
    const gammaRow = db.select().from(schema.projects).where(eq(schema.projects.id, gammaId)).get();

    expect(alphaRow?.lastOpened).toBe(tAlpha);
    expect(gammaRow?.status).toBe("active");
    expect(store.getCurrentProjectId()).toBe(gammaId);
  });

  it("records a remote activation as engagement without moving this machine's pointer (#13290)", () => {
    const before = db.select().from(schema.projects).where(eq(schema.projects.id, betaId)).get()!;
    store.recordRemoteActivation(betaId);
    const after = db.select().from(schema.projects).where(eq(schema.projects.id, betaId)).get()!;

    expect(after.status).toBe("active");
    expect(after.frecencyScore).toBeGreaterThan(before.frecencyScore);
    expect(after.lastAccessedAt).toBeGreaterThan(before.lastAccessedAt);
    expect(store.getCurrentProjectId()).toBe(alphaId);
  });

  it("records only the status of a remote activation under write suppression", () => {
    setWritesSuppressed(true);
    store.recordRemoteActivation(betaId);
    const row = db.select().from(schema.projects).where(eq(schema.projects.id, betaId)).get()!;
    expect(row.status).toBe("active");
    expect(row.lastOpened).toBe(tBeta);
    expect(row.frecencyScore).toBe(5.0);
  });

  it("lists summaries without repairing the status a remote switch wrote (#13290)", () => {
    store.recordRemoteActivation(betaId);
    const summaries = store.getProjectSummaries();
    const row = db.select().from(schema.projects).where(eq(schema.projects.id, betaId)).get()!;

    expect(row.status).toBe("active");
    expect(summaries.map((project) => project.id)[0]).toBe(betaId);
    expect(summaries.map((project) => project.id).sort()).toEqual(
      [alphaId, betaId, gammaId].sort()
    );
  });
});

const PROVIDER = "github.forge.provider";

describe("ProjectStore repository stats (issue #11078)", () => {
  let store: ProjectStore;
  let projectDir: string;
  let projectId: string;
  let projectPath: string;

  function readRow() {
    return db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  }

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-stats-"));
    projectPath = await fs.promises.realpath(projectDir);
    const { generateProjectId } = await import("../projectStorePaths.js");
    projectId = generateProjectId(projectPath);

    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    db.insert(schema.projects)
      .values({
        id: projectId,
        path: projectPath,
        name: "Stats",
        emoji: "🌲",
        lastOpened: Date.now(),
        status: "active",
        frecencyScore: 3.0,
        lastAccessedAt: Date.now(),
      })
      .run();

    store = new ProjectStore();
    resetWritesSuppressedForTesting();
  });

  afterEach(() => {
    resetWritesSuppressedForTesting();
    sqlite.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe("round trip", () => {
    it("exposes a saved snapshot on the project record", () => {
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 5000,
      });

      expect(store.getProjectById(projectId)?.lastKnownStats).toEqual({
        commitCount: 412,
        issueCount: 7,
        prCount: 3,
        providerId: PROVIDER,
        lastUpdated: 5000,
      });
    });

    it("persists a genuine zero rather than treating it as absent", () => {
      store.saveRepoStats(projectPath, {
        commitCount: 0,
        forge: { issueCount: 0, prCount: 0, providerId: PROVIDER },
        lastUpdated: 5000,
      });

      const stats = store.getProjectById(projectId)?.lastKnownStats;
      expect(stats?.commitCount).toBe(0);
      expect(stats?.issueCount).toBe(0);
      expect(stats?.prCount).toBe(0);
    });

    it("omits the snapshot entirely when no commit count was ever stored", () => {
      expect(store.getProjectById(projectId)?.lastKnownStats).toBeUndefined();
    });

    it("keeps a corrupt persisted count out of the project record", () => {
      // A hand-edited or partially-written row must not reach the renderer as a
      // negative/fractional count that the toolbar would render verbatim.
      db.update(schema.projects)
        .set({ statsCommitCount: -1, statsIssueCount: 1.5, statsPrCount: 2 })
        .where(eq(schema.projects.id, projectId))
        .run();

      // A bad commit count invalidates the whole snapshot (it is the anchor).
      expect(store.getProjectById(projectId)?.lastKnownStats).toBeUndefined();

      db.update(schema.projects)
        .set({ statsCommitCount: 10 })
        .where(eq(schema.projects.id, projectId))
        .run();

      const stats = store.getProjectById(projectId)?.lastKnownStats;
      expect(stats?.commitCount).toBe(10);
      // The fractional issue count is dropped; the valid PR count survives.
      expect(stats?.issueCount).toBeNull();
      expect(stats?.prCount).toBe(2);
    });
  });

  describe("ownership", () => {
    it("preserves the forge counts when only a commit count is reported", () => {
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 5000,
      });

      // The provider failed to resolve — mid-activation, disabled, offline. The
      // commit count still moves; the forge counts must not be nulled out.
      store.saveRepoStats(projectPath, { commitCount: 413 });

      expect(store.getProjectById(projectId)?.lastKnownStats).toEqual({
        commitCount: 413,
        issueCount: 7,
        prCount: 3,
        providerId: PROVIDER,
        lastUpdated: 5000,
      });
    });

    it("replaces the forge counts when the provider changes", () => {
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 5000,
      });

      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 1, prCount: 0, providerId: "gitlab.forge.provider" },
        lastUpdated: 6000,
      });

      const stats = store.getProjectById(projectId)?.lastKnownStats;
      expect(stats?.providerId).toBe("gitlab.forge.provider");
      expect(stats?.issueCount).toBe(1);
    });

    it("ignores a result that resolved out of order behind a newer one", () => {
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 6000,
      });

      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 99, prCount: 99, providerId: PROVIDER },
        lastUpdated: 5000,
      });

      const stats = store.getProjectById(projectId)?.lastKnownStats;
      expect(stats?.issueCount).toBe(7);
      expect(stats?.lastUpdated).toBe(6000);
    });

    it("orders against the newest observation seen, not just the newest one written", () => {
      // The no-restamp policy means a poll that merely *confirms* the current
      // counts writes nothing — so the stored timestamp lags the newest thing
      // we've actually seen. Without a separate high-water mark, a delayed older
      // result sails past the stored value and overwrites good counts.
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 100,
      });

      // A later poll confirms the same counts at t=200 — nothing is written, so
      // the row's timestamp stays at 100...
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 200,
      });
      expect(store.getProjectById(projectId)?.lastKnownStats?.lastUpdated).toBe(100);

      // ...but a straggler that observed different counts back at t=150 must
      // still lose to the t=200 observation.
      store.saveRepoStats(projectPath, {
        forge: { issueCount: 99, prCount: 99, providerId: PROVIDER },
        lastUpdated: 150,
      });

      expect(store.getProjectById(projectId)?.lastKnownStats?.issueCount).toBe(7);
    });

    it("rejects a forge snapshot carrying counts a provider should never emit", () => {
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 5000,
      });

      // Written raw, these would round-trip back as null on read and silently
      // destroy the good counts above.
      store.saveRepoStats(projectPath, {
        forge: { issueCount: -1, prCount: 3, providerId: PROVIDER },
        lastUpdated: 6000,
      });
      store.saveRepoStats(projectPath, {
        forge: { issueCount: 4, prCount: Number.NaN, providerId: PROVIDER },
        lastUpdated: 7000,
      });

      const stats = store.getProjectById(projectId)?.lastKnownStats;
      expect(stats?.issueCount).toBe(7);
      expect(stats?.prCount).toBe(3);
    });

    it("still accepts a forge snapshot whose counts are legitimately unknown", () => {
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: null, prCount: null, providerId: null },
        lastUpdated: 5000,
      });

      const stats = store.getProjectById(projectId)?.lastKnownStats;
      expect(stats?.issueCount).toBeNull();
      expect(stats?.providerId).toBeNull();
    });
  });

  describe("write cadence", () => {
    it("does not write when nothing material changed", () => {
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 5000,
      });

      // The provider re-stamps `lastUpdated` whenever its probe confirms nothing
      // changed. Treating that as a write would mean a SQLite UPDATE on every
      // poll of every open project, forever.
      const spy = vi.spyOn(sqlite, "prepare");
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 9999,
      });
      const wrote = spy.mock.calls.some(([sql]) => String(sql).startsWith("update"));
      spy.mockRestore();

      expect(wrote).toBe(false);
      // The re-stamp is also not recorded — the stored time is when the counts
      // last actually changed.
      expect(store.getProjectById(projectId)?.lastKnownStats?.lastUpdated).toBe(5000);
    });

    it("writes as soon as a count actually changes", () => {
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 5000,
      });
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 8, prCount: 3, providerId: PROVIDER },
        lastUpdated: 9999,
      });

      const stats = store.getProjectById(projectId)?.lastKnownStats;
      expect(stats?.issueCount).toBe(8);
      expect(stats?.lastUpdated).toBe(9999);
    });
  });

  describe("guards", () => {
    it("skips the write entirely under disk pressure", () => {
      setWritesSuppressed(true);
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 5000,
      });

      expect(readRow()?.statsCommitCount).toBeNull();
    });

    it("is a no-op for a path with no registered project", () => {
      expect(() =>
        store.saveRepoStats(path.join(projectPath, "worktrees", "feature"), { commitCount: 9 })
      ).not.toThrow();

      expect(readRow()?.statsCommitCount).toBeNull();
    });

    it("ignores a commit count that is not a usable count", () => {
      store.saveRepoStats(projectPath, { commitCount: 412 });
      store.saveRepoStats(projectPath, { commitCount: Number.NaN });
      store.saveRepoStats(projectPath, { commitCount: -5 });

      expect(store.getProjectById(projectId)?.lastKnownStats?.commitCount).toBe(412);
    });
  });

  describe("relocation", () => {
    it("carries the snapshot across a project relocation", async () => {
      store.saveRepoStats(projectPath, {
        commitCount: 412,
        forge: { issueCount: 7, prCount: 3, providerId: PROVIDER },
        lastUpdated: 5000,
      });

      const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-stats-moved-"));
      const newPath = await fs.promises.realpath(newDir);
      try {
        const relocated = await store.relocateProject(projectId, newPath);
        expect(relocated.lastKnownStats).toEqual({
          commitCount: 412,
          issueCount: 7,
          prCount: 3,
          providerId: PROVIDER,
          lastUpdated: 5000,
        });
      } finally {
        fs.rmSync(newDir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Producer-side coverage for #11409: these drive `addProject` against a REAL
 * filesystem so the pre-flight classification actually runs. The dialog and
 * toast suites inject already-classified `AppError`s, which means they'd stay
 * green if the pre-flight were deleted — this file is what fails if it is.
 */

/** The exact text #11409 reported seeing in the dialog. */
const REPORTED_RAW_TEXT =
  "Git operation failed: getRepositoryRoot\nCannot use simple-git on a directory that does not exist";

// The captured shape lives in shared/testing: the single-line version this
// file used to build passed against detection that could never fire in
// production, which is how #11764 shipped green.

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  throw new Error("expected addProject to reject");
}

describe("ProjectStore.addProject open failures", () => {
  let store: ProjectStore;
  let tmpRoot: string;

  beforeEach(() => {
    gitBehavior.constructed = 0;
    gitBehavior.getRepositoryRoot.mockImplementation(async (p: string) => p);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-open-fail-"));
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });
    store = new ProjectStore();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("classifies a missing folder without ever constructing git", async () => {
    const missing = path.join(tmpRoot, "gone");

    expect(await codeOf(() => store.addProject(missing))).toBe("NOT_FOUND");
    // The point of the fix: simple-git never runs, so its ambiguous
    // construction error can't be what the user ends up seeing.
    expect(gitBehavior.constructed).toBe(0);
  });

  it("tells a file apart from a missing folder", async () => {
    const asFile = path.join(tmpRoot, "a-file");
    fs.writeFileSync(asFile, "not a folder");

    expect(await codeOf(() => store.addProject(asFile))).toBe("NOT_A_DIRECTORY");
    expect(gitBehavior.constructed).toBe(0);
  });

  it("classifies a path whose parent segment is a file", async () => {
    const parentFile = path.join(tmpRoot, "parent-file");
    fs.writeFileSync(parentFile, "x");

    expect(await codeOf(() => store.addProject(path.join(parentFile, "child")))).toBe("NOT_FOUND");
  });

  it("reports a missing git binary from the shape simple-git actually throws", async () => {
    gitBehavior.getRepositoryRoot.mockRejectedValue(simpleGitMissingBinaryError());

    expect(await codeOf(() => store.addProject(tmpRoot))).toBe("GIT_NOT_INSTALLED");
  });

  it("still reports it once GitService has wrapped the failure", async () => {
    // GitService no longer rethrows the raw spawn error — it classifies it and
    // throws a GitOperationError carrying the original as `cause`. Detection
    // has to survive that hand-off, and this is the seam where #11764's two
    // independently-green layers hid the break from each other.
    gitBehavior.getRepositoryRoot.mockRejectedValue(
      new GitOperationError("git-not-installed", "Git operation failed: getRepositoryRoot", {
        cwd: tmpRoot,
        op: "getRepositoryRoot",
        cause: simpleGitMissingBinaryError(),
      })
    );

    expect(await codeOf(() => store.addProject(tmpRoot))).toBe("GIT_NOT_INSTALLED");
  });

  it("keeps the guided git-init path for a real folder that isn't a repository", async () => {
    gitBehavior.getRepositoryRoot.mockRejectedValue(
      new Error("fatal: not a git repository (or any of the parent directories): .git")
    );

    expect(await codeOf(() => store.addProject(tmpRoot))).toBe("NOT_A_GIT_REPO");
  });

  it("does not offer git init for a folder that vanished mid-operation", async () => {
    // Without the re-check this reports NOT_A_GIT_REPO and the user is invited
    // to run `git init` in a folder that no longer exists.
    const doomed = fs.mkdtempSync(path.join(tmpRoot, "doomed-"));
    gitBehavior.getRepositoryRoot.mockImplementation(async () => {
      fs.rmSync(doomed, { recursive: true, force: true });
      throw new Error("fatal: not a git repository");
    });

    expect(await codeOf(() => store.addProject(doomed))).toBe("NOT_FOUND");
  });

  it("re-checks the path before adopting it as a lightweight workspace", async () => {
    // The re-check has to run before lightweight adoption, not after: git reports
    // "not a git repository" either way, so without it a path that became a file
    // mid-operation would be adopted as a workspace instead of refused.
    const swapped = fs.mkdtempSync(path.join(tmpRoot, "swapped-"));
    gitBehavior.getRepositoryRoot.mockImplementation(async () => {
      fs.rmSync(swapped, { recursive: true, force: true });
      fs.writeFileSync(swapped, "now a file");
      throw new Error("fatal: not a git repository");
    });

    expect(await codeOf(() => store.addProject(swapped, { gitBacked: false }))).toBe(
      "NOT_A_DIRECTORY"
    );
  });

  it("never lets the reported internal text into the thrown message", async () => {
    gitBehavior.getRepositoryRoot.mockRejectedValue(new Error(REPORTED_RAW_TEXT));

    let thrown: { code?: string; message?: string; context?: Record<string, unknown> } = {};
    try {
      await store.addProject(tmpRoot);
    } catch (error) {
      thrown = error as typeof thrown;
    }

    expect(thrown.code).toBe("PROJECT_OPEN_FAILED");
    expect(thrown.message).not.toContain("simple-git");
    expect(thrown.message).not.toContain("getRepositoryRoot");
    // Still recoverable for diagnostics — demoted, not discarded.
    expect(String(thrown.context?.detail)).toContain("getRepositoryRoot");
  });

  it("succeeds normally for a healthy repository folder", async () => {
    const project = await store.addProject(tmpRoot);

    expect(project.path).toBe(await fs.promises.realpath(tmpRoot));
    expect(gitBehavior.constructed).toBeGreaterThan(0);
  });
});

describe("ProjectStore.addProject permission failures", () => {
  let store: ProjectStore;
  let tmpRoot: string;
  let locked: string;

  beforeEach(() => {
    gitBehavior.constructed = 0;
    gitBehavior.getRepositoryRoot.mockImplementation(async (p: string) => p);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-open-perm-"));
    locked = path.join(tmpRoot, "locked");
    fs.mkdirSync(locked);
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });
    store = new ProjectStore();
  });

  afterEach(() => {
    fs.chmodSync(locked, 0o700);
    sqlite.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // POSIX only, and never meaningful as root (which bypasses the mode bits).
  const canTestPermissions = process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!canTestPermissions)(
    "classifies an unreadable folder that still stats successfully",
    async () => {
      // stat() only needs execute permission on the PARENT, so a folder with
      // its own bits cleared stats fine and fails later inside git. Without an
      // explicit access check this lands in the generic bucket, not PERMISSION.
      fs.chmodSync(locked, 0o000);

      expect(fs.statSync(locked).isDirectory()).toBe(true);
      expect(await codeOf(() => store.addProject(locked))).toBe("PERMISSION");
      expect(gitBehavior.constructed).toBe(0);
    }
  );
});

describe("ProjectStore.onProjectRegistryChanged", () => {
  let store: ProjectStore;
  let alphaDir: string;
  let betaDir: string;
  let alphaId: string;

  beforeEach(async () => {
    alphaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-reg-a-"));
    betaDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-reg-b-"));
    const { generateProjectId } = await import("../projectStorePaths.js");
    const alphaCanonical = await fs.promises.realpath(alphaDir);
    alphaId = generateProjectId(alphaCanonical);

    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });
    db.insert(schema.projects)
      .values({
        id: alphaId,
        path: alphaCanonical,
        name: "Alpha",
        emoji: "🌲",
        lastOpened: Date.now(),
        status: "closed",
        frecencyScore: 1,
        lastAccessedAt: Date.now(),
      })
      .run();
    store = new ProjectStore();
  });

  afterEach(() => {
    resetWritesSuppressedForTesting();
    sqlite.close();
    fs.rmSync(alphaDir, { recursive: true, force: true });
    fs.rmSync(betaDir, { recursive: true, force: true });
  });

  it("fires for a project added or removed, and not for one reopened or already gone", async () => {
    const heard = vi.fn();
    store.onProjectRegistryChanged(heard);

    await store.addProject(alphaDir);
    expect(heard).not.toHaveBeenCalled();

    const beta = await store.addProject(betaDir);
    expect(heard).toHaveBeenCalledTimes(1);

    await store.removeProject(beta.id);
    expect(heard).toHaveBeenCalledTimes(2);

    await store.removeProject(beta.id);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("fires for a change to where a project is or what it is called, never for its status or ranking", () => {
    const heard = vi.fn();
    store.onProjectRegistryChanged(heard);

    store.updateProject(alphaId, { status: "active", pinned: true, frecencyScore: 4 });
    store.updateProjectStatus(alphaId, "background");
    expect(heard).not.toHaveBeenCalled();

    store.updateProject(alphaId, { name: "Alpha 2" });
    store.updateProject(alphaId, { path: betaDir });
    store.updateProject(alphaId, { gitBacked: false });
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("stops after unsubscribing, and a listener that throws neither fails the write nor silences the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const gone = vi.fn();
    const heard = vi.fn();
    store.onProjectRegistryChanged(() => {
      throw new Error("listener broke");
    });
    store.onProjectRegistryChanged(gone)();
    store.onProjectRegistryChanged(heard);

    expect(store.updateProject(alphaId, { name: "Renamed" }).name).toBe("Renamed");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});

describe("ProjectStore schedules (#15975)", () => {
  let store: ProjectStore;
  let repoDir: string;
  let projectId: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-sched-repo-"));
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });
    store = new ProjectStore();
    projectId = (await store.addProject(repoDir)).id;
  });

  afterEach(async () => {
    resetWritesSuppressedForTesting();
    if (store.getProjectById(projectId)) await store.removeProject(projectId);
    sqlite.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function schedulesFile(): string {
    const stateDir = getProjectStateDir(path.join("/tmp/daintree-reconciliation-test", "projects"), projectId);
    if (!stateDir) throw new Error("expected a state directory");
    return path.join(stateDir, "schedules.json");
  }

  it("removing a project deletes its schedules, tells listeners, and refuses later writes", async () => {
    const input = { name: "Nightly", launch: { agentId: "claude", prompt: "Go." } };
    expect((await store.schedules.create(projectId, input)).status).toBe("saved");
    expect(fs.existsSync(schedulesFile())).toBe(true);
    const heard = vi.fn();
    store.schedules.subscribe(heard);

    await store.removeProject(projectId);

    expect(fs.existsSync(schedulesFile())).toBe(false);
    expect(fs.existsSync(path.dirname(schedulesFile()))).toBe(false);
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ projectId, schedules: [] }));
    await expect(store.schedules.create(projectId, input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(fs.existsSync(path.dirname(schedulesFile()))).toBe(false);
  });
});
