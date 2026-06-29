import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import * as schema from "../persistence/schema.js";

// Mirrors the real `projects` schema including the nullable `auto_parked_at`
// column added by migration 0005 (#10830).
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
    auto_parked_at INTEGER
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
  app: { getPath: () => "/tmp/daintree-autoparked-test" },
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

  it("clears autoParkedAt when the project is reopened (setCurrentProject)", async () => {
    store.updateProjectStatus(projectId, "closed", { autoParkedAt: Date.now() });
    expect(store.getProjectById(projectId)?.autoParkedAt).toEqual(expect.any(Number));

    await store.setCurrentProject(projectId);
    const project = store.getProjectById(projectId);
    expect(project?.status).toBe("active");
    expect(project?.autoParkedAt).toBeUndefined();
  });
});
