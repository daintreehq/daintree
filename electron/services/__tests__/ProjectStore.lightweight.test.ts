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
  app: { getPath: () => "/tmp/daintree-lightweight-test" },
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
import { ProjectIdentityFiles } from "../ProjectIdentityFiles.js";
import { setWritesSuppressed, resetWritesSuppressedForTesting } from "../diskPressureState.js";

async function makeDir(name: string): Promise<string> {
  const dir = path.join(tmpRoot, name);
  await fs.promises.mkdir(dir, { recursive: true });
  return fs.promises.realpath(dir);
}

describe("opening a folder without git (#11405)", () => {
  let store: ProjectStore;

  beforeEach(async () => {
    tmpRoot = await fs.promises.realpath(
      fs.mkdtempSync(path.join(os.tmpdir(), "daintree-lightweight-"))
    );
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });
    repoPaths.clear();
    getRepositoryRoot.mockClear();
    resetWritesSuppressedForTesting();
    store = new ProjectStore();
  });

  afterEach(() => {
    sqlite.close();
    resetWritesSuppressedForTesting();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rejects a folder with no repository unless the caller opted in", async () => {
    const folder = await makeDir("downloads");

    await expect(store.addProject(folder)).rejects.toMatchObject({ code: "NOT_A_GIT_REPO" });
    expect(store.getAllProjects()).toHaveLength(0);
  });

  it("adopts the folder when the caller opted in, flagged as not git-backed", async () => {
    const folder = await makeDir("downloads");

    const project = await store.addProject(folder, { gitBacked: false });

    expect(project.path).toBe(folder);
    expect(project.name).toBe(path.basename(folder));
    expect(project.gitBacked).toBe(false);
    expect(store.getProjectById(project.id)?.gitBacked).toBe(false);
  });

  it("reopens a known lightweight folder without opting in again", async () => {
    const folder = await makeDir("downloads");
    const first = await store.addProject(folder, { gitBacked: false });

    // No options: what Recents, a Dock drop, Open With and the CLI all send.
    const reopened = await store.addProject(folder);

    expect(reopened.id).toBe(first.id);
    expect(reopened.gitBacked).toBe(false);
    expect(store.getAllProjects()).toHaveLength(1);
  });

  it("leaves a repository-backed project undiscriminated", async () => {
    const folder = await makeDir("repo");
    repoPaths.add(folder);

    const project = await store.addProject(folder);

    expect(project.gitBacked).toBeUndefined();
    expect(sqlite.prepare("SELECT git_backed FROM projects WHERE id = ?").get(project.id)).toEqual({
      git_backed: null,
    });
  });

  it("promotes the same row once the folder becomes a repository", async () => {
    const folder = await makeDir("adopted");
    const lightweight = await store.addProject(folder, { gitBacked: false });

    repoPaths.add(folder);
    const promoted = await store.addProject(folder);

    expect(promoted.id).toBe(lightweight.id);
    expect(promoted.gitBacked).toBeUndefined();
    expect(store.getAllProjects()).toHaveLength(1);
  });

  it("persists a mode change even while writes are suppressed", async () => {
    const folder = await makeDir("adopted");
    const lightweight = await store.addProject(folder, { gitBacked: false });

    repoPaths.add(folder);
    setWritesSuppressed(true);
    const promoted = await store.addProject(folder);

    expect(promoted.gitBacked).toBeUndefined();
    // Ranking churn is still correctly dropped under pressure.
    expect(promoted.lastOpened).toBe(lightweight.lastOpened);
  });

  it("ignores an in-repo identity anchor a downloaded folder happens to carry", async () => {
    const original = await makeDir("original");
    repoPaths.add(original);
    const owner = await store.addProject(original);

    // A copy of that project's `.daintree/project.json`, as an archive would carry.
    const copy = await makeDir("copy");
    await new ProjectIdentityFiles().writeInRepoProjectIdentity(copy, {
      id: owner.id,
      name: "Anchored",
    });

    const adopted = await store.addProject(copy, { gitBacked: false });

    expect(adopted.id).not.toBe(owner.id);
    expect(adopted.name).toBe(path.basename(copy));
    expect(store.getProjectById(owner.id)?.path).toBe(original);
  });

  it("does not demote a registered repository whose git metadata went missing", async () => {
    const folder = await makeDir("repo");
    repoPaths.add(folder);
    const project = await store.addProject(folder);

    // An unmounted volume, a permissions blip, or a `.git` deleted externally.
    // Rewriting the row here would lose the project's git identity for good, so
    // the anomaly surfaces and demotion stays the user's explicit decision.
    repoPaths.delete(folder);
    await expect(store.addProject(folder)).rejects.toMatchObject({ code: "NOT_A_GIT_REPO" });

    expect(store.getProjectById(project.id)?.gitBacked).toBeUndefined();
  });

  it("classifies a repository and a repository-less folder without touching the registry", async () => {
    const repo = await makeDir("repo");
    repoPaths.add(repo);
    const plain = await makeDir("downloads");

    await expect(store.classifyGitBacking(repo)).resolves.toEqual({
      gitBacked: true,
      gitRoot: repo,
    });
    await expect(store.classifyGitBacking(plain)).resolves.toEqual({ gitBacked: false });

    // Classification answers a question; only addProject may act on the answer.
    expect(store.getAllProjects()).toHaveLength(0);
  });

  it("reports a registered repository whose git metadata went missing as not git-backed", async () => {
    const folder = await makeDir("repo");
    repoPaths.add(folder);
    const project = await store.addProject(folder);

    repoPaths.delete(folder);

    // What the switch/reopen guard consults (#11649). It reports the folder's
    // real state without demoting the row — the demotion stays the user's call.
    await expect(store.classifyGitBacking(folder)).resolves.toEqual({ gitBacked: false });
    expect(store.getProjectById(project.id)?.gitBacked).toBeUndefined();
  });

  it("refuses to call a vanished folder repository-less", async () => {
    const folder = await makeDir("repo");
    repoPaths.add(folder);
    await store.addProject(folder);

    // The row's repository is unreachable rather than proven absent. Answering
    // `gitBacked: false` here is what would let a yanked volume demote a project.
    repoPaths.delete(folder);
    await fs.promises.rm(folder, { recursive: true, force: true });

    await expect(store.classifyGitBacking(folder)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("demotes a registered repository only when the user explicitly asks", async () => {
    const folder = await makeDir("repo");
    repoPaths.add(folder);
    const project = await store.addProject(folder);

    repoPaths.delete(folder);
    const demoted = await store.addProject(folder, { gitBacked: false });

    expect(demoted.id).toBe(project.id);
    expect(demoted.gitBacked).toBe(false);
  });

  it("refuses a file even when lightweight adoption is explicitly requested", async () => {
    const file = path.join(tmpRoot, "note.txt");
    await fs.promises.writeFile(file, "hi");

    // gitBacked:false means "adopt this if it's a non-repository folder", not
    // "accept any path" — so a file is still refused as a file. Reporting
    // NOT_A_GIT_REPO here would offer "Open without git" for something that can
    // never be a workspace, and on this explicit path would reopen the very
    // dialog the caller just answered.
    await expect(store.addProject(file, { gitBacked: false })).rejects.toMatchObject({
      code: "NOT_A_DIRECTORY",
    });

    const { count } = sqlite
      .prepare("SELECT COUNT(*) AS count FROM projects WHERE path = ?")
      .get(file) as { count: number };
    expect(count).toBe(0);
  });

  it("does not consult git when reopening a known lightweight folder", async () => {
    const folder = await makeDir("downloads");
    await store.addProject(folder, { gitBacked: false });
    const callsAfterAdd = getRepositoryRoot.mock.calls.length;

    await store.addProject(folder);

    // One probe to learn there is still no repository, and nothing beyond it.
    expect(getRepositoryRoot.mock.calls.length).toBe(callsAfterAdd + 1);
  });
});
