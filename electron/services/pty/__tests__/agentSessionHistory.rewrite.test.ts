import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  rewriteAgentSessionPathsForProject,
  readSessionHistory,
  readSessionHistorySync,
  getSessionHistoryPath,
  type AgentSessionRecord,
} from "../agentSessionHistory.js";

const OLD = "/old/project";
const NEW = "/new/renamed";

describe("rewriteAgentSessionPathsForProject", () => {
  let userDataDir: string;
  const previousUserData = process.env.DAINTREE_USER_DATA;

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "daintree-history-rewrite-"));
    process.env.DAINTREE_USER_DATA = userDataDir;
  });

  afterEach(async () => {
    process.env.DAINTREE_USER_DATA = previousUserData;
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  async function seed(records: AgentSessionRecord[]): Promise<void> {
    await fsp.writeFile(getSessionHistoryPath(userDataDir)!, JSON.stringify(records));
  }

  const rec = (over: Partial<AgentSessionRecord>): AgentSessionRecord => ({
    sessionId: "s1",
    agentId: "claude",
    worktreeId: null,
    title: null,
    projectId: null,
    savedAt: 1000,
    ...over,
  });

  it("rebases worktreeId and cwd only for the matching project's records", async () => {
    await seed([
      rec({ sessionId: "a", projectId: "p1", worktreeId: "/old/project", cwd: "/old/project/wt" }),
      rec({ sessionId: "b", projectId: "p2", worktreeId: "/old/project", cwd: "/old/project" }),
      rec({ sessionId: "c", projectId: null, worktreeId: "/old/project", cwd: "/old/project" }),
    ]);

    await rewriteAgentSessionPathsForProject("p1", OLD, NEW);

    const out = await readSessionHistory(userDataDir);
    const byId = Object.fromEntries(out.map((r) => [r.sessionId, r]));
    expect(byId.a.worktreeId).toBe("/new/renamed");
    expect(byId.a.cwd).toBe("/new/renamed/wt");
    // Other project and legacy null-project records are untouched.
    expect(byId.b.worktreeId).toBe("/old/project");
    expect(byId.c.worktreeId).toBe("/old/project");
  });

  it("leaves records with worktreeId outside the old root unchanged", async () => {
    await seed([
      rec({ sessionId: "a", projectId: "p1", worktreeId: "/elsewhere/wt", cwd: "/elsewhere/wt" }),
    ]);

    await rewriteAgentSessionPathsForProject("p1", OLD, NEW);

    const out = await readSessionHistory(userDataDir);
    expect(out[0].worktreeId).toBe("/elsewhere/wt");
    expect(out[0].cwd).toBe("/elsewhere/wt");
  });

  it("preserves record order and timestamps", async () => {
    await seed([
      rec({ sessionId: "a", projectId: "p1", worktreeId: "/old/project", savedAt: 3000 }),
      rec({ sessionId: "b", projectId: "p1", worktreeId: "/old/project", savedAt: 2000 }),
    ]);

    await rewriteAgentSessionPathsForProject("p1", OLD, NEW);

    const out = await readSessionHistory(userDataDir);
    expect(out.map((r) => r.sessionId)).toEqual(["a", "b"]);
    expect(out.map((r) => r.savedAt)).toEqual([3000, 2000]);
  });

  it("refreshes the read cache so a subsequent sync read sees the rewrite", async () => {
    await seed([rec({ sessionId: "a", projectId: "p1", worktreeId: "/old/project" })]);
    // Prime the cache with the pre-rewrite value.
    expect(readSessionHistorySync(userDataDir)[0].worktreeId).toBe("/old/project");

    await rewriteAgentSessionPathsForProject("p1", OLD, NEW);

    expect(readSessionHistorySync(userDataDir)[0].worktreeId).toBe("/new/renamed");
  });

  it("does not write when nothing changed (no matching project record)", async () => {
    await seed([rec({ sessionId: "a", projectId: "other", worktreeId: "/old/project" })]);
    const before = await fsp.stat(getSessionHistoryPath(userDataDir)!);

    await rewriteAgentSessionPathsForProject("p1", OLD, NEW);

    const after = await fsp.stat(getSessionHistoryPath(userDataDir)!);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("is a no-op when old equals new", async () => {
    await seed([rec({ sessionId: "a", projectId: "p1", worktreeId: "/old/project" })]);
    await rewriteAgentSessionPathsForProject("p1", OLD, OLD);
    const out = await readSessionHistory(userDataDir);
    expect(out[0].worktreeId).toBe("/old/project");
  });
});
