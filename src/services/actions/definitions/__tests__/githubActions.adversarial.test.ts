import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const githubClientMock = vi.hoisted(() => ({
  openIssues: vi.fn(),
  openPRs: vi.fn(),
  openCommits: vi.fn(),
  openIssue: vi.fn(),
  openPR: vi.fn(),
  assignIssue: vi.fn(),
  getRepoStats: vi.fn(),
  listIssues: vi.fn(),
  listPullRequests: vi.fn(),
  getIssueByNumber: vi.fn(),
  checkCli: vi.fn(),
  getConfig: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  validateToken: vi.fn(),
}));

const forgeClientMock = vi.hoisted(() => ({
  openIssues: vi.fn(),
  openPRs: vi.fn(),
  openCommits: vi.fn(),
  openIssue: vi.fn(),
  getIssueUrl: vi.fn(),
  assignIssue: vi.fn(),
  validateToken: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock("@/clients", () => ({ githubClient: githubClientMock, forgeClient: forgeClientMock }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));

import { registerGithubActions } from "../githubActions";

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerGithubActions(actions, callbacks);
  return (id: string) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return factory() as AnyActionDefinition;
  };
}

async function runAction(
  id: string,
  args?: unknown,
  ctx?: Record<string, unknown>
): Promise<unknown> {
  const def = setupActions()(id);
  return def.run(args, (ctx ?? {}) as never);
}

function setCurrentProject(project: { path?: string } | null) {
  projectStoreMock.getState.mockReturnValue({ currentProject: project });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(githubClientMock)) fn.mockResolvedValue(undefined);
  for (const fn of Object.values(forgeClientMock)) fn.mockResolvedValue(undefined);
});

describe("forge.* primaries adversarial", () => {
  it("openIssues falls back to current project path when no arg is given", async () => {
    setCurrentProject({ path: "/repo" });
    const def = setupActions()("forge.openIssues");
    await def.run({}, {} as never);
    expect(forgeClientMock.openIssues).toHaveBeenCalledWith("/repo", undefined, undefined);
  });

  it("openIssues throws loudly when neither arg nor current project has a path", async () => {
    setCurrentProject(null);
    const def = setupActions()("forge.openIssues");
    await expect(def.run({}, {} as never)).rejects.toThrow(/No project path/);
    expect(forgeClientMock.openIssues).not.toHaveBeenCalled();
  });

  it("openPRs also throws loudly without a path", async () => {
    setCurrentProject(null);
    const def = setupActions()("forge.openPRs");
    await expect(def.run({}, {} as never)).rejects.toThrow(/No project path/);
  });

  it("openCommits also throws loudly without a path", async () => {
    setCurrentProject(null);
    const def = setupActions()("forge.openCommits");
    await expect(def.run({}, {} as never)).rejects.toThrow(/No project path/);
  });

  it("openIssues: explicit projectPath takes precedence over current project", async () => {
    setCurrentProject({ path: "/stale" });
    const def = setupActions()("forge.openIssues");
    await def.run({ projectPath: "/explicit", query: "bug", state: "open" }, {} as never);
    expect(forgeClientMock.openIssues).toHaveBeenCalledWith("/explicit", "bug", "open");
  });

  it("openIssues schema accepts arbitrary state strings (runtime gap vs list schema)", async () => {
    // GitHubListOptionsSchema restricts state to an enum, but openIssues uses
    // z.string().optional() — mismatch. Documenting the gap.
    setCurrentProject({ path: "/repo" });
    const def = setupActions()("forge.openIssues");
    await def.run({ state: "wat" }, {} as never);
    expect(forgeClientMock.openIssues).toHaveBeenCalledWith("/repo", undefined, "wat");
  });

  it("openIssue forwards cwd + issueNumber positionally", async () => {
    const def = setupActions()("forge.openIssue");
    await def.run({ cwd: "/repo", issueNumber: 42 }, {} as never);
    expect(forgeClientMock.openIssue).toHaveBeenCalledWith("/repo", 42);
  });

  it("openIssue falls back to ctx.activeWorktreePath", async () => {
    await runAction("forge.openIssue", { issueNumber: 7 }, { activeWorktreePath: "/repo" });
    expect(forgeClientMock.openIssue).toHaveBeenCalledWith("/repo", 7);
  });

  it("validateToken forwards the token unchanged (including whitespace)", async () => {
    const def = setupActions()("forge.validateToken");
    await def.run({ token: "  ghp_123  " }, {} as never);
    expect(forgeClientMock.validateToken).toHaveBeenCalledWith("  ghp_123  ");
  });

  it("assignIssue forwards cwd, issueNumber, and username positionally", async () => {
    const def = setupActions()("forge.assignIssue");
    await def.run({ cwd: "/repo", issueNumber: 42, username: "bob" }, {} as never);
    expect(forgeClientMock.assignIssue).toHaveBeenCalledWith("/repo", 42, "bob");
  });

  it("assignIssue falls back to ctx.activeWorktreePath when cwd omitted", async () => {
    await runAction(
      "forge.assignIssue",
      { issueNumber: 7, username: "alice" },
      { activeWorktreePath: "/repo" }
    );
    expect(forgeClientMock.assignIssue).toHaveBeenCalledWith("/repo", 7, "alice");
  });

  it("assignIssue throws when no cwd and no ctx.activeWorktreePath", async () => {
    await expect(
      runAction("forge.assignIssue", { issueNumber: 7, username: "bob" })
    ).rejects.toThrow("No active worktree");
  });

  it("forge.* primaries never call githubClient", async () => {
    // All six forge.* primaries must route through forgeClient, not githubClient.
    // githubClient is reserved for the GitHub-specific github.* host actions below.
    setCurrentProject({ path: "/repo" });
    await runAction("forge.openIssues", {}, { activeWorktreePath: "/repo" });
    await runAction("forge.openPRs", {}, { activeWorktreePath: "/repo" });
    await runAction("forge.openCommits", {}, { activeWorktreePath: "/repo" });
    await runAction("forge.openIssue", { issueNumber: 1 }, { activeWorktreePath: "/repo" });
    await runAction(
      "forge.assignIssue",
      { issueNumber: 1, username: "bob" },
      { activeWorktreePath: "/repo" }
    );
    await runAction("forge.validateToken", { token: "ghp_test" });

    expect(githubClientMock.openIssues).not.toHaveBeenCalled();
    expect(githubClientMock.openPRs).not.toHaveBeenCalled();
    expect(githubClientMock.openCommits).not.toHaveBeenCalled();
    expect(githubClientMock.openIssue).not.toHaveBeenCalled();
    expect(githubClientMock.assignIssue).not.toHaveBeenCalled();
    expect(githubClientMock.validateToken).not.toHaveBeenCalled();
  });
});

describe("githubActions adversarial (non-migrating)", () => {
  it("listIssues forwards the whole options object unchanged", async () => {
    githubClientMock.listIssues.mockResolvedValue({ issues: [], nextCursor: "c2" });
    const def = setupActions()("github.listIssues");
    await def.run({ cwd: "/repo", search: "q", state: "open", cursor: "c1" }, {} as never);
    expect(githubClientMock.listIssues).toHaveBeenCalledWith({
      cwd: "/repo",
      search: "q",
      state: "open",
      cursor: "c1",
    });
  });

  it("openPR forwards prUrl", async () => {
    const def = setupActions()("github.openPR");
    await def.run({ prUrl: "https://github.com/x/y/pull/1" }, {} as never);
    expect(githubClientMock.openPR).toHaveBeenCalledWith("https://github.com/x/y/pull/1");
  });

  it("getRepoStats forwards cwd + bypassCache", async () => {
    const def = setupActions()("github.getRepoStats");
    await def.run({ cwd: "/repo", bypassCache: true }, {} as never);
    expect(githubClientMock.getRepoStats).toHaveBeenCalledWith("/repo", true);
  });

  it("setToken and clearToken are marked danger:safe — agents are trusted to manage credentials", () => {
    const setDef = setupActions()("github.setToken");
    const clearDef = setupActions()("github.clearToken");
    expect(setDef.danger).toBe("safe");
    expect(clearDef.danger).toBe("safe");
  });

  it("checkCli has no schema and calls client directly", async () => {
    githubClientMock.checkCli.mockResolvedValue({ available: true });
    const def = setupActions()("github.checkCli");
    const result = await def.run(undefined, {} as never);
    expect(result).toEqual({ available: true });
  });

  it("getIssueByNumber forwards cwd + issueNumber and returns null when issue is missing", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue(null);
    const def = setupActions()("github.getIssueByNumber");
    const result = await def.run({ cwd: "/repo", issueNumber: 42 }, {} as never);
    expect(githubClientMock.getIssueByNumber).toHaveBeenCalledWith("/repo", 42);
    expect(result).toBeNull();
  });

  it("listIssues falls back to ctx.activeWorktreePath when cwd omitted", async () => {
    githubClientMock.listIssues.mockResolvedValue({ issues: [], nextCursor: null });
    await runAction("github.listIssues", {}, { activeWorktreePath: "/repo" });
    expect(githubClientMock.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo" })
    );
  });

  it("listIssues preserves all filter fields when falling back to ctx", async () => {
    githubClientMock.listIssues.mockResolvedValue({ issues: [], nextCursor: null });
    await runAction(
      "github.listIssues",
      { search: "q", state: "open", cursor: "c1" },
      { activeWorktreePath: "/repo" }
    );
    expect(githubClientMock.listIssues).toHaveBeenCalledWith({
      cwd: "/repo",
      search: "q",
      state: "open",
      cursor: "c1",
    });
  });

  it("listPullRequests preserves all filter fields when falling back to ctx", async () => {
    githubClientMock.listPullRequests.mockResolvedValue({ pullRequests: [], nextCursor: null });
    await runAction(
      "github.listPullRequests",
      { search: "q", state: "merged", cursor: "c1" },
      { activeWorktreePath: "/repo" }
    );
    expect(githubClientMock.listPullRequests).toHaveBeenCalledWith({
      cwd: "/repo",
      search: "q",
      state: "merged",
      cursor: "c1",
    });
  });

  it("listIssues throws when no cwd and no ctx.activeWorktreePath", async () => {
    await expect(runAction("github.listIssues", {})).rejects.toThrow("No active worktree");
  });

  it("listIssues prefers explicit cwd over ctx", async () => {
    githubClientMock.listIssues.mockResolvedValue({ issues: [], nextCursor: null });
    await runAction("github.listIssues", { cwd: "/explicit" }, { activeWorktreePath: "/ctx" });
    expect(githubClientMock.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/explicit" })
    );
  });

  it("listPullRequests falls back to ctx.activeWorktreePath when cwd omitted", async () => {
    githubClientMock.listPullRequests.mockResolvedValue({ pullRequests: [], nextCursor: null });
    await runAction("github.listPullRequests", {}, { activeWorktreePath: "/repo" });
    expect(githubClientMock.listPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo" })
    );
  });

  it("getRepoStats falls back to ctx.activeWorktreePath", async () => {
    await runAction("github.getRepoStats", {}, { activeWorktreePath: "/repo" });
    expect(githubClientMock.getRepoStats).toHaveBeenCalledWith("/repo", undefined);
  });

  it("getIssueByNumber falls back to ctx.activeWorktreePath", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue(null);
    await runAction("github.getIssueByNumber", { issueNumber: 5 }, { activeWorktreePath: "/repo" });
    expect(githubClientMock.getIssueByNumber).toHaveBeenCalledWith("/repo", 5);
  });
});

describe("githubClient import boundary", () => {
  const rootDir = path.resolve(import.meta.dirname, "../../../../..");

  const allowlist = new Set([
    "src/services/actions/definitions/githubActions.ts",
    "src/services/actions/definitions/workflowCreationActions.ts",
    "src/hooks/useRepositoryStats.ts",
    "src/hooks/useGitHubRateLimit.ts",
    "src/hooks/useGitHubTokenHealth.ts",
    "src/hooks/useProjectHealth.ts",
    "src/components/Layout/GitHubStatsToolbarButton.tsx",
    "src/components/Worktree/IssuePickerDialog.tsx",
  ]);

  function collectSrcFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        files.push(...collectSrcFiles(full));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) {
        files.push(full);
      }
    }
    return files;
  }

  const importPattern =
    /import\s+(?:type\s+)?\{[^}]*\bgithubClient\b[^}]*\}\s+from\s+['"]([^'"]+)['"]/;

  function extractImportPath(importSource: string): string | null {
    if (importSource === "@/clients" || importSource === "@/clients/githubClient") {
      return importSource;
    }
    return null;
  }

  it("no non-allowlisted production file imports githubClient", () => {
    const srcDir = path.join(rootDir, "src");
    const allFiles = collectSrcFiles(srcDir);
    const violations: string[] = [];

    for (const filePath of allFiles) {
      const relPath = path.relative(rootDir, filePath).replace(/\\/g, "/");
      if (allowlist.has(relPath)) continue;

      const content = fs.readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        const m = line.match(importPattern);
        const importSource = m?.[1];
        if (importSource && extractImportPath(importSource)) {
          violations.push(`${relPath}: imports githubClient from "${importSource}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("every allowlisted file still imports githubClient (drift check)", () => {
    const stale: string[] = [];

    for (const relPath of allowlist) {
      const filePath = path.join(rootDir, relPath);
      if (!fs.existsSync(filePath)) {
        stale.push(`${relPath}: file not found`);
        continue;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      if (!importPattern.test(content)) {
        stale.push(`${relPath}: no longer imports githubClient — remove from allowlist`);
      }
    }

    expect(stale).toEqual([]);
  });
});
