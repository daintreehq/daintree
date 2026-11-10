import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
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
    resumable_agent_count INTEGER,
    stats_commit_count INTEGER,
    stats_issue_count INTEGER,
    stats_pr_count INTEGER,
    stats_provider_id TEXT,
    stats_last_updated INTEGER,
    git_backed INTEGER,
    archived_at INTEGER,
    never_auto_sleep INTEGER NOT NULL DEFAULT 0,
    clone_state TEXT,
    clone_job TEXT,
    group_id TEXT
  );
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let tmpRoot: string;

/** Paths this fake treats as repositories; anything else throws like real git. */
const repoPaths = new Set<string>();
const getRepositoryRoot = vi.fn(async (p: string) => {
  if (!repoPaths.has(p)) {
    throw new Error(`fatal: not a git repository (or any of the parent directories): .git`);
  }
  return p;
});

vi.mock("../persistence/db.js", () => ({
  getSharedDb: () => db,
  openDb: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-clone-test" },
}));

vi.mock("../GitService.js", () => ({
  GitService: class {
    async getRepositoryRoot(p: string): Promise<string> {
      return getRepositoryRoot(p);
    }
    repairWorktrees() {}
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
    setStatePersistedObserver() {}
    invalidateProjectStateCache() {}
    enqueueProjectStateUpdate() {}
  },
}));

vi.mock("../ProjectFileStore.js", () => ({ ProjectFileStore: class {} }));
vi.mock("../GlobalFileStore.js", () => ({ GlobalFileStore: class {} }));
vi.mock("../projectQuarantineCleanup.js", () => ({
  cleanupQuarantinedProjectFiles: vi.fn(),
}));

import { ProjectStore } from "../ProjectStore.js";

async function makeDir(name: string): Promise<string> {
  const dir = path.join(tmpRoot, name);
  await fs.promises.mkdir(dir, { recursive: true });
  return fs.promises.realpath(dir);
}

const job = { url: "https://github.com/acme/widgets.git", shallow: false };

describe("a project registered before its clone finished (#16352)", () => {
  let store: ProjectStore;

  beforeEach(async () => {
    tmpRoot = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-clone-")));
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });
    repoPaths.clear();
    getRepositoryRoot.mockClear();
    store = new ProjectStore();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("registers the project with the dialog's identity before the folder exists", () => {
    const target = path.join(tmpRoot, "widgets");
    const project = store.insertCloningProject(target, {
      identity: { name: "Widgets", emoji: "🧩" },
      job,
    });

    expect(project).toMatchObject({
      path: target,
      name: "Widgets",
      emoji: "🧩",
      cloneState: "cloning",
    });
    expect(store.getProjectById(project.id)?.cloneState).toBe("cloning");
    expect(store.getCloneJob(project.id)).toEqual(job);
    expect(getRepositoryRoot).not.toHaveBeenCalled();
  });

  it("is never marked missing while it waits for its folder", async () => {
    const project = store.insertCloningProject(path.join(tmpRoot, "widgets"), { job });

    expect(await store.checkMissingProjects()).toEqual([]);
    expect(store.getProjectById(project.id)?.status).not.toBe("missing");
  });

  it("opens by path to the registered row instead of classifying an empty folder", async () => {
    const target = path.join(tmpRoot, "widgets");
    const project = store.insertCloningProject(target, { job });

    const opened = await store.addProject(target);

    expect(opened.id).toBe(project.id);
    expect(getRepositoryRoot).not.toHaveBeenCalled();
  });

  it("records a failure and lists the project as still awaiting its clone", () => {
    const project = store.insertCloningProject(path.join(tmpRoot, "widgets"), { job });
    const failedJob = { ...job, error: "Repository not found" };

    expect(store.setCloneState(project.id, "failed", failedJob).cloneState).toBe("failed");
    expect(store.getProjectsAwaitingClone()).toEqual([
      {
        project: expect.objectContaining({ id: project.id, cloneState: "failed" }),
        job: failedJob,
      },
    ]);
  });

  it("becomes an ordinary project under the same id once the checkout lands", async () => {
    const target = path.join(tmpRoot, "widgets");
    const project = store.insertCloningProject(target, {
      identity: { name: "Widgets", emoji: "🧩" },
      job,
    });
    await makeDir("widgets");

    const ready = await store.completeClone(project.id);

    expect(ready.id).toBe(project.id);
    expect(ready.cloneState).toBeUndefined();
    expect(ready.name).toBe("Widgets");
    expect(store.getCloneJob(project.id)).toBeNull();
    expect(store.getProjectsAwaitingClone()).toEqual([]);
  });

  it("takes the repository's committed name once the checkout lands", async () => {
    const target = path.join(tmpRoot, "widgets");
    const project = store.insertCloningProject(target, { job });
    const dir = await makeDir("widgets");
    await fs.promises.mkdir(path.join(dir, ".daintree"), { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, ".daintree", "project.json"),
      JSON.stringify({ version: 1, name: "Acme Widgets", emoji: "🛠️" })
    );

    const ready = await store.completeClone(project.id);

    expect(ready).toMatchObject({ name: "Acme Widgets", emoji: "🛠️", daintreeConfigPresent: true });
  });
});
