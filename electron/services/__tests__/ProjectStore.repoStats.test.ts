import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";
import * as schema from "../persistence/schema.js";

// Mirrors the real `projects` schema including the nullable stats_* columns
// added by migration 0007 (#11078).
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
    auto_parked_at INTEGER,
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
  app: { getPath: () => "/tmp/daintree-repostats-test" },
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

import { ProjectStore } from "../ProjectStore.js";
import { setWritesSuppressed, resetWritesSuppressedForTesting } from "../diskPressureState.js";

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
