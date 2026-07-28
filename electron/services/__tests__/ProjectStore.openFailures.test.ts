import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import * as schema from "../persistence/schema.js";

/**
 * Producer-side coverage for #11409: these drive `addProject` against a REAL
 * filesystem so the pre-flight classification actually runs. The dialog and
 * toast suites inject already-classified `AppError`s, which means they'd stay
 * green if the pre-flight were deleted — this file is what fails if it is.
 */

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

/** Set per test to control what the git layer does; counts construction. */
const gitBehavior = vi.hoisted(() => ({
  constructed: 0,
  getRepositoryRoot: vi.fn<(p: string) => Promise<string>>(async (p: string) => p),
}));

vi.mock("../persistence/db.js", () => ({
  getSharedDb: () => db,
  openDb: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-open-failures-test" },
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

/** The exact text #11409 reported seeing in the dialog. */
const REPORTED_RAW_TEXT =
  "Git operation failed: getRepositoryRoot\nCannot use simple-git on a directory that does not exist";

/**
 * simple-git 3.36.0 stringifies a failed spawn into the message and rethrows a
 * bare error — no `code`, no `syscall`, no `cause`. Reproduced faithfully here
 * because a synthetic errno-bearing cause chain would pass against detection
 * that can never fire in production.
 */
function simpleGitMissingBinaryError(): Error {
  const error = new Error("Error: spawn git ENOENT");
  Object.assign(error, { task: { commands: ["rev-parse", "--show-toplevel"] } });
  return error;
}

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
