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
    auto_parked_at INTEGER,
    stats_commit_count INTEGER,
    stats_issue_count INTEGER,
    stats_pr_count INTEGER,
    stats_provider_id TEXT,
    stats_last_updated INTEGER
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
  app: { getPath: () => "/tmp/daintree-mru-switch-test" },
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
import { getMruProjects } from "../../../shared/utils/projectMru.js";

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
});
