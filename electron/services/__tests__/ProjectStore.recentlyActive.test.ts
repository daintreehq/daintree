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

import { ProjectStore } from "../ProjectStore.js";
import {
  initSessionOpenProjectsTracker,
  resetSessionOpenProjectsTrackerForTests,
} from "../sessionOpenProjectsTracker.js";
import { writeSessionOpenProjects } from "../persistence/sessionOpenProjectsStore.js";
import {
  SESSION_OPEN_PROJECTS_KEY,
  parseSessionOpenProjects,
  serializeSessionOpenProjects,
} from "../persistence/sessionOpenProjects.js";

/** Comfortably outside the recency window, without naming its length. */
const LONG_AGO = Date.now() - 24 * 60 * 60 * 1000;

describe("ProjectStore recently-active marker (#11791)", () => {
  let store: ProjectStore;
  let projectDir: string;
  let projectId: string;
  let otherDir: string;
  let otherId: string;

  /** Write a previous session's checkpoint the way a real shutdown left one. */
  const seedCheckpoint = (ids: string[]) => {
    const value = serializeSessionOpenProjects(ids);
    db.insert(schema.appState)
      .values({ key: SESSION_OPEN_PROJECTS_KEY, value })
      .onConflictDoUpdate({ target: schema.appState.key, set: { value } })
      .run();
  };

  /** The checkpoint as it now stands on disk, for the next launch to read. */
  const storedCheckpoint = (): string[] => {
    const row = db
      .select()
      .from(schema.appState)
      .where(eq(schema.appState.key, SESSION_OPEN_PROJECTS_KEY))
      .get();
    return parseSessionOpenProjects(row?.value ?? null);
  };

  /**
   * Boot the tracker the way main.ts does: read whatever is persisted, freeze
   * it, and start this session's set empty.
   */
  const launch = (opts?: { readOnly?: boolean }) => {
    resetSessionOpenProjectsTrackerForTests();
    initSessionOpenProjectsTracker({
      previousSessionProjectIds: storedCheckpoint(),
      launchAtMs: Date.now(),
      readOnly: opts?.readOnly ?? false,
      write: writeSessionOpenProjects,
    });
  };

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

    // The tracker is module state deliberately held for the life of a process;
    // each test seeds its own DB, so the launch has to be replayed.
    launch();
    store = new ProjectStore();
  });

  afterEach(() => {
    resetSessionOpenProjectsTrackerForTests();
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

    it("keeps the stamp through an unrelated update to the same row", () => {
      store.updateProjectStatus(projectId, "closed");
      const stamped = store.getProjectById(projectId)?.recentlyClosedAt;

      store.updateProject(projectId, { name: "Renamed" });

      // A rename is not a lifecycle transition; only those move the mark.
      expect(store.getProjectById(projectId)?.recentlyClosedAt).toBe(stamped);
    });

    it("re-stamps on a second close after the project was reopened", async () => {
      store.updateProjectStatus(projectId, "closed", { recentlyClosedAt: LONG_AGO });
      await store.setCurrentProject(projectId);
      store.updateProjectStatus(projectId, "closed");

      // The stale stamp must not survive the round trip and win the Math.max.
      expect(store.getProjectById(projectId)?.recentlyActiveUntil).toBeGreaterThan(Date.now());
    });

    it("does not mark a project whose folder merely reappeared on disk", async () => {
      db.update(schema.projects)
        .set({ status: "missing" })
        .where(eq(schema.projects.id, projectId))
        .run();

      await store.checkMissingProjects();

      const project = store.getProjectById(projectId);
      expect(project?.status).toBe("closed");
      // A folder coming back is not the user having just worked in it.
      expect(project?.recentlyClosedAt).toBeUndefined();
      expect(project?.recentlyActiveUntil).toBeUndefined();
    });
  });

  describe("the launch clock", () => {
    it("marks a project the previous session's checkpoint names", () => {
      seedCheckpoint([projectId]);
      launch();

      const project = store.getProjectById(projectId);
      // No close ever happened, so only the launch clock can be marking it.
      expect(project?.recentlyClosedAt).toBeUndefined();
      expect(project?.recentlyActiveUntil).toBeGreaterThan(Date.now());
    });

    it("leaves every project unmarked when no checkpoint has been written yet", () => {
      // The first launch after upgrading, and the #11794 regression: both rows
      // are `background`, which used to be read as "open at shutdown" and lit
      // up the entire list. Nothing may substitute for the missing checkpoint.
      db.update(schema.projects).set({ status: "background" }).run();
      launch();

      expect(store.getProjectById(projectId)?.recentlyActiveUntil).toBeUndefined();
      expect(store.getProjectById(otherId)?.recentlyActiveUntil).toBeUndefined();
    });

    it("ignores status entirely — a checkpointed project is marked whatever its row says", () => {
      db.update(schema.projects)
        .set({ status: "closed" })
        .where(eq(schema.projects.id, projectId))
        .run();
      db.update(schema.projects)
        .set({ status: "background" })
        .where(eq(schema.projects.id, otherId))
        .run();
      seedCheckpoint([projectId]);
      launch();

      // The checkpoint names `projectId` and not `otherId`; the statuses say
      // the opposite. Membership is the user's intent, not the row's state.
      expect(store.getProjectById(projectId)?.recentlyActiveUntil).toBeGreaterThan(Date.now());
      expect(store.getProjectById(otherId)?.recentlyActiveUntil).toBeUndefined();
    });

    it("keeps the two populations apart: a stale close stays expired, a checkpointed project does not", () => {
      db.update(schema.projects).set({ recentlyClosedAt: LONG_AGO }).run();
      seedCheckpoint([projectId]);
      launch();

      // Same stale stamp on both rows; only the one that was open at shutdown
      // gets the launch clock, which is the whole point of the two populations.
      expect(store.getProjectById(projectId)?.recentlyActiveUntil).toBeGreaterThan(Date.now());
      expect(store.getProjectById(otherId)?.recentlyActiveUntil).toBeLessThan(Date.now());
    });

    it("holds the previous set fixed, so opening a project now cannot join it", async () => {
      seedCheckpoint([projectId]);
      launch();
      expect(store.getProjectById(projectId)?.recentlyActiveUntil).toBeGreaterThan(Date.now());

      // `otherId` opens during THIS session. It must not join the launch
      // population — that set is the previous session's, and a set recomputed
      // on read would wrongly hand it the launch clock here.
      await store.setCurrentProject(otherId);
      expect(store.getProjectById(otherId)?.recentlyActiveUntil).toBeUndefined();

      // Closing it puts it on the close clock instead, where a stale stamp
      // reads as expired.
      store.updateProjectStatus(otherId, "closed", { recentlyClosedAt: LONG_AGO });
      expect(store.getProjectById(otherId)?.recentlyActiveUntil).toBeLessThan(Date.now());
    });

    it("does not pull a project into the set via the status repair", () => {
      db.insert(schema.appState)
        .values({ key: "currentProjectId", value: projectId })
        .onConflictDoUpdate({ target: schema.appState.key, set: { value: projectId } })
        .run();
      launch();

      // getAllProjects() promotes the current row to `active`. That repair is
      // bookkeeping about which row is current, never evidence of last session.
      const listed = store.getAllProjects().find((p) => p.id === projectId);
      expect(listed?.status).toBe("active");
      expect(listed?.recentlyActiveUntil).toBeUndefined();
    });
  });

  describe("the checkpoint this session leaves behind", () => {
    it("starts empty, so last session's projects never carry over", async () => {
      seedCheckpoint([projectId, otherId]);
      launch();

      await store.setCurrentProject(projectId);

      // Persisting the union with the previous set is the lifetime latch that
      // made every project look recently active (#11794).
      expect(storedCheckpoint()).toEqual([projectId]);
    });

    it("accumulates the union across switches — backgrounding is not closing", async () => {
      await store.setCurrentProject(projectId);
      await store.setCurrentProject(otherId);

      expect(store.getProjectById(projectId)?.status).toBe("background");
      expect(storedCheckpoint().sort()).toEqual([projectId, otherId].sort());
    });

    it("drops a project the user closed", async () => {
      await store.setCurrentProject(projectId);
      await store.setCurrentProject(otherId);

      store.updateProjectStatus(projectId, "closed");

      expect(storedCheckpoint()).toEqual([otherId]);
    });

    it("drops a project closed without killing its terminals", async () => {
      await store.setCurrentProject(otherId);
      await store.setCurrentProject(projectId);
      expect(storedCheckpoint().sort()).toEqual([projectId, otherId].sort());

      // The `killTerminals: false` branch of project:close writes `background`.
      // Same gesture as the killing branch — the status only says the processes
      // were kept, not that the user still considers the project open.
      store.updateProjectStatus(projectId, "background");

      // `otherId` is background too, from the switch — and stays, because
      // switching away is not closing.
      expect(store.getProjectById(otherId)?.status).toBe("background");
      expect(storedCheckpoint()).toEqual([otherId]);
    });

    it("drops a project whose folder went missing", async () => {
      await store.setCurrentProject(otherId);
      await store.setCurrentProject(projectId);
      // Only the current project is skipped by the sweep, so hand the pointer
      // to `otherId` and let the real sweep find `projectId`'s folder gone.
      await store.setCurrentProject(otherId);
      fs.rmSync(projectDir, { recursive: true, force: true });
      expect(storedCheckpoint().sort()).toEqual([projectId, otherId].sort());

      await store.checkMissingProjects();

      expect(store.getProjectById(projectId)?.status).toBe("missing");
      expect(storedCheckpoint()).toEqual([otherId]);
    });

    it("drops a project that was removed outright", async () => {
      await store.setCurrentProject(projectId);
      await store.setCurrentProject(otherId);

      await store.removeProject(projectId);

      // Ids are derived from the path, so leaving it would let a project later
      // re-added at the same folder inherit the deleted one's membership.
      expect(storedCheckpoint()).toEqual([otherId]);
    });

    it("is left untouched by a recovery launch, whose reduced set must not overwrite it", async () => {
      seedCheckpoint([projectId, otherId]);
      launch({ readOnly: true });

      await store.setCurrentProject(projectId);
      store.updateProjectStatus(otherId, "closed");

      // Safe mode opens one window on purpose; rolling that over would lose the
      // fleet the user actually had.
      expect(storedCheckpoint().sort()).toEqual([projectId, otherId].sort());
    });

    it("still marks the previous session's projects during a recovery launch", () => {
      seedCheckpoint([projectId]);
      launch({ readOnly: true });

      expect(store.getProjectById(projectId)?.recentlyActiveUntil).toBeGreaterThan(Date.now());
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
