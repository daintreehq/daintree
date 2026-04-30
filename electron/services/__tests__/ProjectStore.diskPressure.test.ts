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
    last_accessed_at INTEGER NOT NULL DEFAULT 0
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
  app: { getPath: () => "/tmp/daintree-disk-pressure-test" },
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

    seededLastAccessedAt = Date.now() - 60_000;
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
});
