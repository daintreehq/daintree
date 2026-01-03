import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalRegistry } from "../TerminalRegistry.js";
import type { TerminalProcess } from "../TerminalProcess.js";

function hashProjectId(projectRootPath: string): string {
  const canonical = path.normalize(fs.realpathSync(projectRootPath));
  return createHash("sha256").update(canonical).digest("hex");
}

function createMockTerminalProcess(options: {
  id: string;
  cwd: string;
  projectId?: string;
  worktreeId?: string;
}): TerminalProcess {
  const info = {
    id: options.id,
    projectId: options.projectId,
    cwd: options.cwd,
    shell: "/bin/sh",
    kind: "terminal",
    type: "terminal",
    spawnedAt: Date.now(),
    analysisEnabled: false,
    lastInputTime: Date.now(),
    lastOutputTime: Date.now(),
    lastCheckTime: Date.now(),
    restartCount: 0,
    worktreeId: options.worktreeId,
    outputBuffer: "",
    semanticBuffer: [],
    pendingSemanticData: "",
    semanticFlushTimer: null,
    inputWriteQueue: [],
    inputWriteTimeout: null,
    ptyProcess: { pid: 12345 },
  };

  return {
    getInfo: () => info,
    getPtyProcess: () => info.ptyProcess,
  } as unknown as TerminalProcess;
}

describe("TerminalRegistry projectId inference", () => {
  it("counts terminals without projectId using .git directory root hashing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canopy-terminal-registry-"));
    try {
      fs.mkdirSync(path.join(root, ".git"));
      const subdir = path.join(root, "subdir");
      fs.mkdirSync(subdir);

      const projectId = hashProjectId(root);
      const registry = new TerminalRegistry();
      registry.add(
        "t1",
        createMockTerminalProcess({
          id: "t1",
          cwd: subdir,
        })
      );

      const stats = registry.getProjectStats(projectId);
      expect(stats.terminalCount).toBe(1);
      expect(registry.getForProject(projectId)).toEqual(["t1"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("infers main projectId for linked worktrees via commondir", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "canopy-terminal-registry-wt-"));
    try {
      const mainRoot = path.join(sandbox, "main");
      const commonGitDir = path.join(mainRoot, ".git");
      fs.mkdirSync(path.join(commonGitDir, "worktrees", "wt1"), { recursive: true });

      const worktreeRoot = path.join(sandbox, "worktree-wt1");
      fs.mkdirSync(worktreeRoot, { recursive: true });

      const gitDir = path.join(commonGitDir, "worktrees", "wt1");
      fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${gitDir}\n`, "utf8");
      fs.writeFileSync(path.join(gitDir, "commondir"), "../..", "utf8");

      const projectId = hashProjectId(mainRoot);

      const registry = new TerminalRegistry();
      registry.add(
        "t2",
        createMockTerminalProcess({
          id: "t2",
          cwd: path.join(worktreeRoot, "nested"),
          worktreeId: worktreeRoot,
        })
      );

      const stats = registry.getProjectStats(projectId);
      expect(stats.terminalCount).toBe(1);
      expect(registry.getForProject(projectId)).toEqual(["t2"]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("excludes trashed terminals from getForProject and getProjectStats", () => {
    const registry = new TerminalRegistry(120000);
    const projectId = "project-123";

    const activeTerminal = createMockTerminalProcess({
      id: "t-active",
      cwd: "/tmp",
      projectId,
    });

    const trashedTerminal = createMockTerminalProcess({
      id: "t-trashed",
      cwd: "/tmp",
      projectId,
    });

    registry.add("t-active", activeTerminal);
    registry.add("t-trashed", trashedTerminal);

    registry.trash("t-trashed", () => {});

    const terminals = registry.getForProject(projectId);
    expect(terminals).toEqual(["t-active"]);
    expect(terminals).not.toContain("t-trashed");

    const stats = registry.getProjectStats(projectId);
    expect(stats.terminalCount).toBe(1);
    expect(stats.processIds).toEqual([12345]);
  });

  it("includes terminals in getForProject after restore from trash", () => {
    const registry = new TerminalRegistry(120000);
    const projectId = "project-123";

    const terminal = createMockTerminalProcess({
      id: "t-1",
      cwd: "/tmp",
      projectId,
    });

    registry.add("t-1", terminal);
    registry.trash("t-1", () => {});

    expect(registry.getForProject(projectId)).toEqual([]);

    registry.restore("t-1");

    expect(registry.getForProject(projectId)).toEqual(["t-1"]);

    const stats = registry.getProjectStats(projectId);
    expect(stats.terminalCount).toBe(1);
    expect(stats.processIds).toEqual([12345]);
    expect(stats.terminalTypes).toEqual({ terminal: 1 });
  });

  it("clears trash timeout when terminal is deleted", () => {
    const registry = new TerminalRegistry(120000);
    const projectId = "project-123";
    let killedId: string | null = null;

    const terminal = createMockTerminalProcess({
      id: "t-1",
      cwd: "/tmp",
      projectId,
    });

    registry.add("t-1", terminal);
    registry.trash("t-1", (id) => {
      killedId = id;
    });

    expect(registry.isInTrash("t-1")).toBe(true);

    registry.delete("t-1");

    expect(registry.isInTrash("t-1")).toBe(false);
    expect(killedId).toBe(null);
  });
});
