import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";
import * as schema from "../persistence/schema.js";

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
    recently_closed_at INTEGER,
    stats_commit_count INTEGER,
    stats_issue_count INTEGER,
    stats_pr_count INTEGER,
    stats_provider_id TEXT,
    stats_last_updated INTEGER,
    git_backed INTEGER
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
  app: { getPath: () => "/tmp/daintree-recent-active-test" },
}));

vi.mock("../GitService.js", () => ({
  GitService: class {
    async getRepositoryRoot(p: string): Promise<string> {
      return p;
    }
  },
}));

vi.mock("../ProjectSettingsManager.js", () => ({
  ProjectSettingsManager: class {
    deleteAllEnvForProject() {}
    migrateEnvForProject() {}
    getEffectiveNotificationSettings() {
      return {};
    }
  },
}));

vi.mock("../ProjectStateManager.js", () => ({
  ProjectStateManager: class {
    invalidateProjectStateCache() {}
  },
}));

vi.mock("../ProjectFileStore.js", () => ({ ProjectFileStore: class {} }));
vi.mock("../GlobalFileStore.js", () => ({ GlobalFileStore: class {} }));
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

import { ProjectStore, resetLaunchSnapshotForTests } from "../ProjectStore.js";

/** Comfortably outside the recency window, without naming its length. */
const LONG_AGO = Date.now() - 24 * 60 * 60 * 1000;

describe("ProjectStore recently-active marker (#11791)", () => {
  let store: ProjectStore;
  let projectDir: string;
  let projectId: string;
  let otherDir: string;
  let otherId: string;

  const seed = (
    id: string,
    p: string,
    name: string,
    row: { status: string; recentlyClosedAt?: number }
  ) => {
    db.insert(schema.projects)
      .values({
        id,
        path: p,
        name,
        emoji: "🌲",
        lastOpened: LONG_AGO,
        status: row.status,
        frecencyScore: 3.0,
        lastAccessedAt: LONG_AGO,
        ...(row.recentlyClosedAt !== undefined ? { recentlyClosedAt: row.recentlyClosedAt } : {}),
      })
      .run();
  };

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-recent-"));
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-recent-other-"));
    const canonical = await fs.promises.realpath(projectDir);
    const otherCanonical = await fs.promises.realpath(otherDir);
    const { generateProjectId } = await import("../projectStorePaths.js");
    projectId = generateProjectId(canonical);
    otherId = generateProjectId(otherCanonical);

    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });

    seed(projectId, canonical, "Recent", { status: "closed" });
    seed(otherId, otherCanonical, "Other", { status: "closed" });

    // The launch snapshot is module state deliberately captured once per
    // process; each test seeds its own DB, so it has to be re-taken.
    resetLaunchSnapshotForTests();
    store = new ProjectStore();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  describe("the close clock", () => {
    it("marks a project the user just closed, and stamps when it happened", () => {
      const before = Date.now();
      store.updateProjectStatus(projectId, "closed");

      const project = store.getProjectById(projectId);
      expect(project?.recentlyClosedAt).toBeGreaterThanOrEqual(before);
      // Still ahead of the clock, so the row would draw the dot.
      expect(project?.recentlyActiveUntil).toBeGreaterThan(Date.now());
    });

    it("lets the mark expire on its own once the close is old enough", () => {
      store.updateProjectStatus(projectId, "closed");
      // Rewrite the stamp rather than advancing time: the deadline is derived
      // from it, so this is the same arithmetic the decay performs.
      db.update(schema.projects)
        .set({ recentlyClosedAt: LONG_AGO })
        .where(eq(schema.projects.id, projectId))
        .run();

      const project = store.getProjectById(projectId);
      expect(project?.recentlyActiveUntil).toBeLessThan(Date.now());
    });

    it("leaves a project that was never closed unmarked", () => {
      const project = store.getProjectById(projectId);
      expect(project?.recentlyClosedAt).toBeUndefined();
      expect(project?.recentlyActiveUntil).toBeUndefined();
    });

    it("clears the stamp when the project is reopened", async () => {
      store.updateProjectStatus(projectId, "closed");
      expect(store.getProjectById(projectId)?.recentlyClosedAt).toEqual(expect.any(Number));

      await store.setCurrentProject(projectId);

      const project = store.getProjectById(projectId);
      expect(project?.status).toBe("active");
      expect(project?.recentlyClosedAt).toBeUndefined();
    });

    it("does not stamp a project that was merely switched away from", async () => {
      await store.setCurrentProject(projectId);
      await store.setCurrentProject(otherId);

      const previous = store.getProjectById(projectId);
      // Backgrounded is still open — the decay must not start here.
      expect(previous?.status).toBe("background");
      expect(previous?.recentlyClosedAt).toBeUndefined();
    });

    it("honours an explicit stamp from a caller that already holds the clock", () => {
      store.updateProjectStatus(projectId, "closed", { recentlyClosedAt: LONG_AGO });
      expect(store.getProjectById(projectId)?.recentlyClosedAt).toBe(LONG_AGO);
    });

    it("does not mark a project whose folder merely reappeared on disk", async () => {
      db.update(schema.projects)
        .set({ status: "missing" })
        .where(eq(schema.projects.id, projectId))
        .run();
      resetLaunchSnapshotForTests();

      await store.checkMissingProjects();

      const project = store.getProjectById(projectId);
      expect(project?.status).toBe("closed");
      // A folder coming back is not the user having just worked in it.
      expect(project?.recentlyClosedAt).toBeUndefined();
      expect(project?.recentlyActiveUntil).toBeUndefined();
    });
  });

  describe("the launch clock", () => {
    it("marks a project that was still open when the app went away", () => {
      db.update(schema.projects)
        .set({ status: "background" })
        .where(eq(schema.projects.id, projectId))
        .run();
      resetLaunchSnapshotForTests();

      const project = store.getProjectById(projectId);
      // No close ever happened, so only the launch clock can be marking it.
      expect(project?.recentlyClosedAt).toBeUndefined();
      expect(project?.recentlyActiveUntil).toBeGreaterThan(Date.now());
    });

    it("keeps the two populations apart: a stale close stays expired, an open project does not", () => {
      db.update(schema.projects)
        .set({ status: "background", recentlyClosedAt: LONG_AGO })
        .where(eq(schema.projects.id, projectId))
        .run();
      db.update(schema.projects)
        .set({ status: "closed", recentlyClosedAt: LONG_AGO })
        .where(eq(schema.projects.id, otherId))
        .run();
      resetLaunchSnapshotForTests();

      // Same stale stamp on both rows; only the one that was open at shutdown
      // gets the launch clock, which is the whole point of the two populations.
      expect(store.getProjectById(projectId)?.recentlyActiveUntil).toBeGreaterThan(Date.now());
      expect(store.getProjectById(otherId)?.recentlyActiveUntil).toBeLessThan(Date.now());
    });

    it("does not extend the mark to projects that were already closed at shutdown", () => {
      resetLaunchSnapshotForTests();
      expect(store.getProjectById(otherId)?.recentlyActiveUntil).toBeUndefined();
    });
  });

  it("carries the deadline on every project the list hands out", () => {
    store.updateProjectStatus(projectId, "closed");

    const listed = store.getAllProjects().find((p) => p.id === projectId);
    const single = store.getProjectById(projectId);
    // The list read and the single lookup must not disagree about recency.
    expect(listed?.recentlyActiveUntil).toBe(single?.recentlyActiveUntil);
    expect(listed?.recentlyActiveUntil).toBeGreaterThan(Date.now());
  });
});
