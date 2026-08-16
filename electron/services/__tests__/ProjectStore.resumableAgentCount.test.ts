import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";
import * as schema from "../persistence/schema.js";

// Mirrors the real `projects` schema including the nullable
// `resumable_agent_count` column added by migration 0012 (#11801).
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
    git_backed INTEGER
  );
  CREATE TABLE IF NOT EXISTS scratches (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_opened INTEGER NOT NULL,
    deleted_at INTEGER,
    last_completion_seen_at INTEGER,
    resumable_agent_count INTEGER
  );
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** A well-formed scratch id — the observer routes on the id's shape. */
const SCRATCH_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

/**
 * Captures the observer ProjectStore installs, so the test can drive it.
 * Hoisted alongside the `vi.mock` factories below, which are lifted above every
 * module-scope `let` and would otherwise read it before initialization.
 */
const observerSlot = vi.hoisted(() => ({
  current: null as ((projectId: string, state: unknown) => void) | null,
}));

vi.mock("../persistence/db.js", () => ({
  getSharedDb: () => db,
  openDb: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-resume-count-test" },
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
    setStatePersistedObserver(observer: (projectId: string, state: unknown) => void) {
      observerSlot.current = observer;
    }
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

function agentPanel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: "Agent",
    kind: "terminal",
    cwd: "/repo",
    location: "grid",
    launchAgentId: "claude",
    ...overrides,
  };
}

describe("ProjectStore resumable agent count", () => {
  let store: ProjectStore;
  let projectId: string;
  let projectDir: string;

  const storedCount = (id = projectId): number | null => {
    const row = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    return row?.resumableAgentCount ?? null;
  };

  const storedScratchCount = (id = SCRATCH_ID): number | null => {
    const row = db.select().from(schema.scratches).where(eq(schema.scratches.id, id)).get();
    return row?.resumableAgentCount ?? null;
  };

  const insertScratch = (overrides: { id?: string; deletedAt?: number } = {}) => {
    db.insert(schema.scratches)
      .values({
        id: overrides.id ?? SCRATCH_ID,
        path: `/tmp/scratches/${overrides.id ?? SCRATCH_ID}`,
        name: "Scratch",
        createdAt: Date.now(),
        lastOpened: Date.now(),
        ...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
      })
      .run();
  };

  beforeEach(async () => {
    observerSlot.current = null;
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-resume-"));
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
        name: "Resuming",
        emoji: "🌲",
        lastOpened: Date.now(),
        status: "closed",
        frecencyScore: 3.0,
        lastAccessedAt: Date.now(),
      })
      .run();

    store = new ProjectStore();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe("what a row reports", () => {
    it("says nothing at all for a row that has never been counted", () => {
      // The column is NULL for every row that predates the field. Reporting 0
      // there would claim the project restores nothing, which nobody checked.
      expect(store.getProjectById(projectId)?.resumableAgentCount).toBeUndefined();
    });

    it("carries a counted zero as an answer, distinct from never having counted", () => {
      db.update(schema.projects)
        .set({ resumableAgentCount: 0 })
        .where(eq(schema.projects.id, projectId))
        .run();
      expect(store.getProjectById(projectId)?.resumableAgentCount).toBe(0);
    });

    it("carries a positive count through", () => {
      db.update(schema.projects)
        .set({ resumableAgentCount: 4 })
        .where(eq(schema.projects.id, projectId))
        .run();
      expect(store.getProjectById(projectId)?.resumableAgentCount).toBe(4);
    });

    it("treats a corrupt count as never counted rather than as a claim", () => {
      // A negative or fractional value cannot have come from counting panels,
      // so the row falls back to making no claim.
      for (const corrupt of [-1, 1.5]) {
        db.update(schema.projects)
          .set({ resumableAgentCount: corrupt })
          .where(eq(schema.projects.id, projectId))
          .run();
        expect(store.getProjectById(projectId)?.resumableAgentCount).toBeUndefined();
      }
    });
  });

  describe("keeping the count current as state is written", () => {
    it("installs an observer on the state manager", () => {
      // The whole write-through design depends on this wiring existing; without
      // it every count below would silently come from nowhere.
      expect(observerSlot.current).toBeTypeOf("function");
    });

    it("recounts from the state that was just persisted", () => {
      observerSlot.current?.(projectId, {
        terminals: [
          agentPanel("a"),
          agentPanel("b"),
          agentPanel("c", { launchAgentId: undefined }),
        ],
      });
      expect(storedCount()).toBe(2);
    });

    it("writes a known zero when the state is cleared away", () => {
      observerSlot.current?.(projectId, { terminals: [agentPanel("a")] });
      expect(storedCount()).toBe(1);

      // Destructive close removes state.json outright — the project now
      // restores nothing, which is an answer and must replace the old count.
      observerSlot.current?.(projectId, null);
      expect(storedCount()).toBe(0);
    });

    it("lets a later save lower the count as panels go away", () => {
      observerSlot.current?.(projectId, { terminals: [agentPanel("a"), agentPanel("b")] });
      observerSlot.current?.(projectId, { terminals: [agentPanel("a")] });
      expect(storedCount()).toBe(1);
    });

    it("survives state for an id belonging to neither table", () => {
      // Not a 64-hex project id and not a scratch UUID, so it addresses no row
      // in either table and the observer has nothing to write.
      expect(() =>
        observerSlot.current?.("no-such-workspace", { terminals: [agentPanel("a")] })
      ).not.toThrow();
    });
  });

  // Scratches persist their panel grid through the SAME state manager (#11484),
  // so the one observer sees both kinds and the id's shape decides which table
  // it writes (#11821).
  describe("routing a scratch's state to the scratch row", () => {
    beforeEach(() => insertScratch());

    it("recounts a scratch's saved agents onto its own row", () => {
      observerSlot.current?.(SCRATCH_ID, {
        terminals: [
          agentPanel("a"),
          agentPanel("b"),
          agentPanel("c", { launchAgentId: undefined }),
        ],
      });
      expect(storedScratchCount()).toBe(2);
    });

    it("writes a known zero when a scratch's state is cleared away", () => {
      observerSlot.current?.(SCRATCH_ID, { terminals: [agentPanel("a")] });
      expect(storedScratchCount()).toBe(1);

      observerSlot.current?.(SCRATCH_ID, null);
      expect(storedScratchCount()).toBe(0);
    });

    it("leaves the project table untouched when a scratch saves", () => {
      // The bug this replaces: the write targeted `projects` unconditionally,
      // so a scratch save matched nothing. It must now match its own row and
      // still not reach across into anyone else's.
      observerSlot.current?.(SCRATCH_ID, { terminals: [agentPanel("a")] });
      expect(storedScratchCount()).toBe(1);
      expect(storedCount()).toBeNull();
    });

    it("leaves the scratch table untouched when a project saves", () => {
      observerSlot.current?.(projectId, { terminals: [agentPanel("a"), agentPanel("b")] });
      expect(storedCount()).toBe(2);
      expect(storedScratchCount()).toBeNull();
    });

    it("stops at the tombstone for a scratch being deleted", () => {
      const doomed = "8c6b1f22-1f3e-4a76-b1b0-2f9a7c4e51aa";
      insertScratch({ id: doomed, deletedAt: Date.now() });
      // Removal tombstones the row, then tears the state directory down — which
      // saves through this observer. A row already gone from every
      // renderer-facing query takes no maintenance writes.
      observerSlot.current?.(doomed, { terminals: [agentPanel("a")] });
      expect(storedScratchCount(doomed)).toBeNull();
    });

    it("survives a scratch id with no row of its own", () => {
      expect(() =>
        observerSlot.current?.("11111111-2222-4333-8444-555555555555", {
          terminals: [agentPanel("a")],
        })
      ).not.toThrow();
    });
  });

  describe("reconciling a row the write path never reached", () => {
    it("fills in a row that had no count", () => {
      const updated = store.reconcileResumableAgentCount(projectId, null, 3);
      expect(updated?.resumableAgentCount).toBe(3);
      expect(storedCount()).toBe(3);
    });

    it("reports no change when the row already agrees", () => {
      db.update(schema.projects)
        .set({ resumableAgentCount: 2 })
        .where(eq(schema.projects.id, projectId))
        .run();
      // Nothing moved, so there is nothing for a caller to broadcast.
      expect(store.reconcileResumableAgentCount(projectId, 2, 2)).toBeNull();
    });

    it("repairs a row whose stored count has gone stale", () => {
      db.update(schema.projects)
        .set({ resumableAgentCount: 5 })
        .where(eq(schema.projects.id, projectId))
        .run();
      expect(store.reconcileResumableAgentCount(projectId, 5, 1)?.resumableAgentCount).toBe(1);
      expect(storedCount()).toBe(1);
    });

    it("leaves a row alone when a newer write landed since it was read", () => {
      // The reconciler read NULL, then a real save wrote 7 while it was still
      // loading state off disk. Its own answer is older than the row's, so it
      // must not be allowed to overwrite it.
      observerSlot.current?.(projectId, {
        terminals: Array.from({ length: 7 }, (_, i) => agentPanel(`a${i}`)),
      });
      expect(storedCount()).toBe(7);

      expect(store.reconcileResumableAgentCount(projectId, null, 2)).toBeNull();
      expect(storedCount()).toBe(7);
    });

    it("retracts the claim when the project's state can no longer be read", () => {
      db.update(schema.projects)
        .set({ resumableAgentCount: 3 })
        .where(eq(schema.projects.id, projectId))
        .run();

      // A corrupt or future-schema state.json can't be enumerated, so the row
      // must stop promising three agents rather than keep a number nothing can
      // back up. Unknown, not zero — nobody established it restores nothing.
      const updated = store.reconcileResumableAgentCount(projectId, 3, null);
      expect(updated?.resumableAgentCount).toBeUndefined();
      expect(storedCount()).toBeNull();
    });

    it("leaves a row alone when its known count moved to a different one", () => {
      db.update(schema.projects)
        .set({ resumableAgentCount: 3 })
        .where(eq(schema.projects.id, projectId))
        .run();
      // Observed 1 before the read; the row now says 3, so someone else is
      // more current and this stale answer is dropped.
      expect(store.reconcileResumableAgentCount(projectId, 1, 9)).toBeNull();
      expect(storedCount()).toBe(3);
    });
  });

  describe("what the renderer is allowed to influence", () => {
    it("does not let a status change disturb the count", () => {
      observerSlot.current?.(projectId, { terminals: [agentPanel("a"), agentPanel("b")] });
      store.updateProjectStatus(projectId, "closed");
      // Closing a project is exactly when the dot matters most; the count
      // describes saved panels and must survive the transition untouched.
      expect(storedCount()).toBe(2);
    });
  });
});
