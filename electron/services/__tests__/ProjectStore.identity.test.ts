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

const repairWorktrees = vi.fn(async () => {});

// Phase-2 path-bearing-state migration surfaces (#11282). Mocked so the identity
// suite stays DB-focused and can assert the orchestration wiring directly. These
// are referenced in vi.mock factories at hoist time, so they must be vi.hoisted.
const {
  enqueueProjectStateUpdate,
  rekeyWindowStateForPath,
  rewriteAgentSessionPathsForProject,
  rewriteHibernationProjectPath,
  repairMovedSubmodulePaths,
} = vi.hoisted(() => ({
  enqueueProjectStateUpdate: vi.fn(async () => {}),
  rekeyWindowStateForPath: vi.fn(),
  rewriteAgentSessionPathsForProject: vi.fn(async () => {}),
  rewriteHibernationProjectPath: vi.fn(async () => {}),
  repairMovedSubmodulePaths: vi.fn(async () => {}),
}));

vi.mock("../../windowState.js", () => ({ rekeyWindowStateForPath }));
vi.mock("../pty/agentSessionHistory.js", () => ({ rewriteAgentSessionPathsForProject }));
vi.mock("../PendingHelpHibernationStore.js", () => ({
  getPendingHelpHibernationStore: () => ({ rewriteProjectPath: rewriteHibernationProjectPath }),
}));
vi.mock("../git/submodulePathRepair.js", () => ({ repairMovedSubmodulePaths }));

vi.mock("../persistence/db.js", () => ({
  getSharedDb: () => db,
  openDb: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-identity-test" },
}));

// Repository root normally IS the path handed in; set this to model the case
// where the requested folder sits inside an existing repository.
let repositoryRootOverride: string | null = null;

vi.mock("../GitService.js", () => ({
  GitService: class {
    async getRepositoryRoot(p: string): Promise<string> {
      return repositoryRootOverride ?? p;
    }
    repairWorktrees(...args: string[][]) {
      return repairWorktrees(...(args as []));
    }
  },
}));

const migrateEnvForProject = vi.fn();

vi.mock("../ProjectSettingsManager.js", () => ({
  ProjectSettingsManager: class {
    deleteAllEnvForProject() {}
    migrateEnvForProject(...args: string[]) {
      migrateEnvForProject(...args);
    }
    getEffectiveNotificationSettings() {
      return {};
    }
  },
}));

vi.mock("../ProjectStateManager.js", () => ({
  ProjectStateManager: class {
    invalidateProjectStateCache() {}
    enqueueProjectStateUpdate(...args: unknown[]) {
      return enqueueProjectStateUpdate(...(args as []));
    }
  },
}));

vi.mock("../ProjectFileStore.js", () => ({ ProjectFileStore: class {} }));
vi.mock("../GlobalFileStore.js", () => ({ GlobalFileStore: class {} }));
vi.mock("../projectQuarantineCleanup.js", () => ({
  cleanupQuarantinedProjectFiles: vi.fn(),
}));

import { ProjectStore } from "../ProjectStore.js";
import { mintProjectId, isValidProjectId, generateProjectId } from "../projectStorePaths.js";
import { ProjectIdentityFiles } from "../ProjectIdentityFiles.js";

/** Creates a real directory and returns its canonicalized path. */
async function makeDir(name: string): Promise<string> {
  const dir = path.join(tmpRoot, name);
  await fs.promises.mkdir(dir, { recursive: true });
  return fs.promises.realpath(dir);
}

async function writeAnchor(projectPath: string, id: string): Promise<void> {
  await new ProjectIdentityFiles().writeInRepoProjectIdentity(projectPath, {
    id,
    name: "Anchored",
  });
}

describe("project identity across folder moves", () => {
  let store: ProjectStore;

  beforeEach(async () => {
    tmpRoot = await fs.promises.realpath(
      fs.mkdtempSync(path.join(os.tmpdir(), "daintree-identity-"))
    );
    sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });
    repairWorktrees.mockClear();
    migrateEnvForProject.mockClear();
    enqueueProjectStateUpdate.mockClear();
    rekeyWindowStateForPath.mockClear();
    rewriteAgentSessionPathsForProject.mockClear();
    rewriteHibernationProjectPath.mockClear();
    repairMovedSubmodulePaths.mockClear();
    repositoryRootOverride = null;
    store = new ProjectStore();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("finalizeRelocatedPath (phase 3)", () => {
    it("preserves the given status instead of forcing 'closed'", async () => {
      const original = await makeDir("orig-active");
      const registered = await store.addProject(original);
      store.updateProject(registered.id, { status: "active" });
      const moved = await makeDir("moved-active");

      const result = await store.finalizeRelocatedPath({
        projectId: registered.id,
        expectedOldPath: registered.path,
        newPath: moved,
        status: "active",
      });

      expect(result.status).toBe("active");
      expect(result.path).toBe(moved);
      // The path changed, so the phase-2 migration + worktree repair ran.
      expect(enqueueProjectStateUpdate).toHaveBeenCalled();
      expect(repairWorktrees).toHaveBeenCalled();
    });

    it("closes the project when a plain relocateProject delegates", async () => {
      const original = await makeDir("orig-closed");
      const registered = await store.addProject(original);
      store.updateProject(registered.id, { status: "active" });
      const moved = await makeDir("moved-closed");

      const result = await store.relocateProject(registered.id, moved);
      expect(result.status).toBe("closed");
    });

    it("refuses to finalize when the row no longer points at the expected old path", async () => {
      const original = await makeDir("orig-stale");
      const registered = await store.addProject(original);
      const moved = await makeDir("moved-stale");

      await expect(
        store.finalizeRelocatedPath({
          projectId: registered.id,
          expectedOldPath: path.join(tmpRoot, "somewhere-else"),
          newPath: moved,
          status: "active",
        })
      ).rejects.toThrow(/moved concurrently/);
    });
  });

  describe("creation identity", () => {
    it("applies the chosen name and emoji when a new row is minted", async () => {
      const dir = await makeDir("fresh");

      const created = await store.addProject(dir, { identity: { name: "Chosen", emoji: "🚀" } });

      expect(created.name).toBe("Chosen");
      expect(created.emoji).toBe("🚀");
    });

    it("falls back to basename and the default emoji without an identity", async () => {
      const dir = await makeDir("fresh");

      const created = await store.addProject(dir);

      expect(created.name).toBe(path.basename(dir));
      expect(created.emoji).toBe("🌲");
    });

    it("cannot rename an already-registered project by re-adding it", async () => {
      const dir = await makeDir("existing");
      const first = await store.addProject(dir, { identity: { name: "First", emoji: "🚀" } });

      const second = await store.addProject(dir, { identity: { name: "Hijacked", emoji: "💀" } });

      expect(second.id).toBe(first.id);
      expect(second.name).toBe("First");
      expect(second.emoji).toBe("🚀");
      expect(store.getAllProjects()).toHaveLength(1);
    });

    it("cannot rename an adopted moved project by supplying an identity", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original, {
        identity: { name: "Original", emoji: "🚀" },
      });
      await writeAnchor(original, registered.id);

      const moved = path.join(tmpRoot, "renamed");
      await fs.promises.rename(original, moved);
      const canonicalMoved = await fs.promises.realpath(moved);

      const reopened = await store.addProject(canonicalMoved, {
        identity: { name: "Hijacked", emoji: "💀" },
      });

      expect(reopened.id).toBe(registered.id);
      expect(reopened.emoji).not.toBe("💀");
    });

    it("keeps the identity when the requested path is a symlink to the repo root", async () => {
      // The ancestor guard compares canonical paths. Comparing the raw request
      // instead would treat a symlink as "not the root" and silently drop an
      // identity the user actually chose.
      const real = await makeDir("real-repo");
      const link = path.join(tmpRoot, "linked-repo");
      await fs.promises.symlink(real, link);

      const created = await store.addProject(link, { identity: { name: "Chosen", emoji: "🚀" } });

      expect(created.path).toBe(real);
      expect(created.name).toBe("Chosen");
      expect(created.emoji).toBe("🚀");
    });

    it("keeps the identity when the requested path has a trailing separator", async () => {
      const dir = await makeDir("trailing");

      const created = await store.addProject(`${dir}${path.sep}`, {
        identity: { name: "Chosen", emoji: "🚀" },
      });

      expect(created.name).toBe("Chosen");
      expect(created.emoji).toBe("🚀");
    });

    it("does not stamp a child folder's identity onto its ancestor repository", async () => {
      // Creating `<root>/child` inside an existing repo resolves the git root
      // back to `<root>`, so the row minted is the ANCESTOR — the child's
      // chosen identity must not ride along onto it.
      const root = await makeDir("repo-root");
      const child = await makeDir("repo-root/child");
      repositoryRootOverride = root;

      const created = await store.addProject(child, { identity: { name: "Child", emoji: "🚀" } });

      expect(created.path).toBe(root);
      expect(created.name).toBe(path.basename(root));
      expect(created.emoji).toBe("🌲");
    });
  });

  describe("addProject move detection", () => {
    it("keeps the original id when an anchored folder has moved", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      await writeAnchor(original, registered.id);

      // Simulate the user renaming the folder outside Daintree.
      const moved = path.join(tmpRoot, "renamed");
      await fs.promises.rename(original, moved);
      const canonicalMoved = await fs.promises.realpath(moved);

      const reopened = await store.addProject(canonicalMoved);

      expect(reopened.id).toBe(registered.id);
      expect(reopened.path).toBe(canonicalMoved);
      // One project, not two — the old row was repointed, not orphaned.
      expect(store.getAllProjects()).toHaveLength(1);
    });

    it("does not copy or re-key state when adopting a moved folder", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      await writeAnchor(original, registered.id);

      const moved = path.join(tmpRoot, "renamed");
      await fs.promises.rename(original, moved);
      await store.addProject(await fs.promises.realpath(moved));

      // Identity never changes, so there is nothing to migrate. A call here
      // would mean the id had been re-keyed behind our back.
      expect(migrateEnvForProject).not.toHaveBeenCalled();
    });

    it("repairs linked worktrees after adopting a moved folder", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      await writeAnchor(original, registered.id);

      const moved = path.join(tmpRoot, "renamed");
      await fs.promises.rename(original, moved);
      await store.addProject(await fs.promises.realpath(moved));

      expect(repairWorktrees).toHaveBeenCalledTimes(1);
    });

    it("rewrites all path-bearing state surfaces after adopting a moved folder", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      await writeAnchor(original, registered.id);

      const moved = path.join(tmpRoot, "renamed");
      await fs.promises.rename(original, moved);
      const canonicalMoved = await fs.promises.realpath(moved);
      await store.addProject(canonicalMoved);

      // Every ancillary surface is rebased with the immutable id and old→new roots.
      expect(rekeyWindowStateForPath).toHaveBeenCalledWith(original, canonicalMoved);
      expect(rewriteAgentSessionPathsForProject).toHaveBeenCalledWith(
        registered.id,
        original,
        canonicalMoved
      );
      expect(rewriteHibernationProjectPath).toHaveBeenCalledWith(
        registered.id,
        original,
        canonicalMoved
      );
      expect(repairMovedSubmodulePaths).toHaveBeenCalledWith(original, canonicalMoved);
      // The per-project state write is queued (never a raw read-merge-write) with
      // the immutable id and a path-rewriting updater.
      expect(enqueueProjectStateUpdate).toHaveBeenCalledWith(registered.id, expect.any(Function));
    });

    it("does not rewrite path-bearing state when the current project is declined for adoption", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      await writeAnchor(original, registered.id);
      db.insert(schema.appState).values({ key: "currentProjectId", value: registered.id }).run();

      const moved = path.join(tmpRoot, "renamed");
      await fs.promises.rename(original, moved);
      await store.addProject(await fs.promises.realpath(moved));

      expect(rekeyWindowStateForPath).not.toHaveBeenCalled();
      expect(repairMovedSubmodulePaths).not.toHaveBeenCalled();
    });

    it("isolates a synchronously-throwing migration surface — the move still succeeds and repairs run", async () => {
      rewriteHibernationProjectPath.mockImplementationOnce(() => {
        throw new Error("app.getPath exploded");
      });
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      await writeAnchor(original, registered.id);
      const moved = path.join(tmpRoot, "renamed");
      await fs.promises.rename(original, moved);
      const canonicalMoved = await fs.promises.realpath(moved);

      // A sync throw while building a surface must NOT reject the adoption.
      await expect(store.addProject(canonicalMoved)).resolves.toMatchObject({ id: registered.id });
      expect(repairMovedSubmodulePaths).toHaveBeenCalledWith(original, canonicalMoved);
    });

    it("mints a distinct id for a copy whose original still exists", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      await writeAnchor(original, registered.id);

      // A clone inherits the tracked anchor, but the original is still there.
      const clone = await makeDir("clone");
      await writeAnchor(clone, registered.id);

      const added = await store.addProject(clone);

      expect(added.id).not.toBe(registered.id);
      expect(store.getProjectById(registered.id)?.path).toBe(original);
      expect(store.getAllProjects()).toHaveLength(2);
    });

    it("registers a new project when the anchor names nothing known", async () => {
      const dir = await makeDir("unknown-anchor");
      const unknownAnchor = "a".repeat(64);
      await writeAnchor(dir, unknownAnchor);

      const added = await store.addProject(dir);

      // An anchor with no local row must not be trusted as this project's id.
      expect(added.id).not.toBe(unknownAnchor);
      expect(added.path).toBe(dir);
      expect(store.getAllProjects()).toHaveLength(1);
    });

    it.each([
      ["EACCES", "EACCES"],
      ["EIO", "EIO"],
    ])("does not treat an unreadable original (%s) as a move", async (_label, code) => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      await writeAnchor(original, registered.id);

      const candidate = await makeDir("candidate");
      await writeAnchor(candidate, registered.id);

      // The original may still be sitting there behind a permissions or I/O
      // failure. Only a provably absent original means "moved".
      const accessSpy = vi.spyOn(fs.promises, "access").mockImplementation(async (target) => {
        if (target === original) {
          throw Object.assign(new Error(`${code}: cannot read`), { code });
        }
      });

      try {
        const added = await store.addProject(candidate);

        expect(added.id).not.toBe(registered.id);
        expect(store.getProjectById(registered.id)?.path).toBe(original);
        expect(store.getAllProjects()).toHaveLength(2);
        expect(repairWorktrees).not.toHaveBeenCalled();
      } finally {
        accessSpy.mockRestore();
      }
    });

    it("declines to adopt the currently active project", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      await writeAnchor(original, registered.id);
      db.insert(schema.appState).values({ key: "currentProjectId", value: registered.id }).run();

      const moved = path.join(tmpRoot, "renamed");
      await fs.promises.rename(original, moved);
      const canonicalMoved = await fs.promises.realpath(moved);

      const added = await store.addProject(canonicalMoved);

      // Repointing a live project would strand its view and PTYs on the old
      // path, so it registers separately instead.
      expect(added.id).not.toBe(registered.id);
      expect(store.getProjectById(registered.id)?.path).toBe(original);
    });

    it("ignores a malformed anchor without losing the rest of the identity", async () => {
      const dir = await makeDir("bad-anchor");
      await fs.promises.mkdir(path.join(dir, ".daintree"), { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, ".daintree", "project.json"),
        JSON.stringify({ version: 1, id: "not-a-valid-id", name: "Kept" }),
        "utf-8"
      );

      const identity = await new ProjectIdentityFiles().readInRepoProjectIdentity(dir);

      expect(identity.id).toBeUndefined();
      expect(identity.name).toBe("Kept");
    });
  });

  describe("relocateProject", () => {
    it("preserves the project id when reattaching a folder", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);

      const moved = path.join(tmpRoot, "elsewhere");
      await fs.promises.rename(original, moved);
      const canonicalMoved = await fs.promises.realpath(moved);

      const relocated = await store.relocateProject(registered.id, canonicalMoved);

      expect(relocated.id).toBe(registered.id);
      expect(relocated.path).toBe(canonicalMoved);
      expect(migrateEnvForProject).not.toHaveBeenCalled();
    });

    it("carries project metadata across a reattachment", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      store.updateProject(registered.id, { name: "Renamed", emoji: "🚀", pinned: true });

      const moved = path.join(tmpRoot, "elsewhere");
      await fs.promises.rename(original, moved);
      const relocated = await store.relocateProject(
        registered.id,
        await fs.promises.realpath(moved)
      );

      expect(relocated.name).toBe("Renamed");
      expect(relocated.emoji).toBe("🚀");
      expect(relocated.pinned).toBe(true);
    });

    it("rejects reattaching onto a folder another project already owns", async () => {
      const a = await makeDir("project-a");
      const b = await makeDir("project-b");
      const projectA = await store.addProject(a);
      await store.addProject(b);

      await expect(store.relocateProject(projectA.id, b)).rejects.toThrow(/already exists/i);
      expect(store.getProjectById(projectA.id)?.path).toBe(a);
    });

    it("gives a new repository at a vacated path its own identity", async () => {
      // The end-to-end shape of the collision mintProjectId guards against: a
      // project keeps sha256(oldPath) after moving away, so a different repo
      // created at that same path must not inherit its row.
      const original = await makeDir("original");
      const registered = await store.addProject(original);
      const preferredForOriginal = generateProjectId(original);
      expect(registered.id).toBe(preferredForOriginal);

      const moved = path.join(tmpRoot, "elsewhere");
      await fs.promises.rename(original, moved);
      await store.relocateProject(registered.id, await fs.promises.realpath(moved));

      // A brand-new repository now occupies the vacated path.
      const reborn = await makeDir("original");
      const added = await store.addProject(reborn);

      expect(added.id).not.toBe(registered.id);
      expect(isValidProjectId(added.id)).toBe(true);
      expect(store.getProjectById(registered.id)?.id).toBe(preferredForOriginal);
    });

    it("skips worktree repair when the path did not actually change", async () => {
      const dir = await makeDir("unchanged");
      const registered = await store.addProject(dir);

      const relocated = await store.relocateProject(registered.id, dir);

      expect(relocated.path).toBe(dir);
      expect(repairWorktrees).not.toHaveBeenCalled();
    });

    it("stores a decomposed-Unicode destination in NFC so the immutable id still resolves", async () => {
      const original = await makeDir("original");
      const registered = await store.addProject(original);

      // A real destination whose name is NFD ("cafe" + combining acute U+0301).
      // getGitRoot realpaths it (bytes preserved on APFS/ext4), and the store must
      // persist and resolve the NFC ("é") form rather than the raw NFD spelling.
      const nfdDir = await makeDir("relocated-cafe\u0301");
      const nfc = nfdDir.normalize("NFC");
      const relocated = await store.relocateProject(registered.id, nfdDir);

      expect(relocated.id).toBe(registered.id);
      expect(relocated.path).toBe(nfc);
      expect(store.resolveProjectIdForPath(nfc)).toBe(registered.id);
      // The raw NFD spelling resolves too, since lookups normalize.
      expect(store.resolveProjectIdForPath(nfdDir)).toBe(registered.id);
    });
  });

  describe("mintProjectId", () => {
    it("prefers the path-derived id when it is free", () => {
      const isTaken = vi.fn(() => false);
      const id = mintProjectId("/some/path", isTaken);

      // Compared against the independent derivation, not another call to the
      // function under test.
      expect(id).toBe(generateProjectId("/some/path"));
      expect(isTaken).toHaveBeenCalledWith(generateProjectId("/some/path"));
    });

    it("falls back to a fresh id when the path-derived id is taken", () => {
      // A project that moved away from this path keeps its original id, so the
      // hash of the path can already be claimed when a new repo appears there.
      const preferred = generateProjectId("/some/path");
      const id = mintProjectId("/some/path", (candidate) => candidate === preferred);

      expect(id).not.toBe(preferred);
      expect(isValidProjectId(id)).toBe(true);
    });

    it("treats Unicode-equivalent paths as the same project", () => {
      const composed = "/Users/foo/café";
      const decomposed = composed.normalize("NFD");

      expect(mintProjectId(composed, () => false)).toBe(mintProjectId(decomposed, () => false));
    });
  });

  describe("in-repo anchor durability", () => {
    it("keeps the anchor when an unrelated metadata edit rewrites the file", async () => {
      const dir = await makeDir("durable");
      const identityFiles = new ProjectIdentityFiles();
      const anchorId = "b".repeat(64);
      await identityFiles.writeInRepoProjectIdentity(dir, { id: anchorId, name: "Before" });

      // A plain rename goes through the same writer without naming an id.
      await identityFiles.writeInRepoProjectIdentity(dir, { name: "After", emoji: "🌲" });

      const identity = await identityFiles.readInRepoProjectIdentity(dir);
      expect(identity.id).toBe(anchorId);
      expect(identity.name).toBe("After");
    });
  });
});
