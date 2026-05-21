import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

const WORKSPACE_SERVICE_PATH = path.resolve(__dirname, "../WorkspaceService.ts");

describe("WorkspaceService PR callback branch guards — issue #8074", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(WORKSPACE_SERVICE_PATH, "utf-8");
  });

  it("guards onPRDetected against stale lookup branches before mutating the monitor", () => {
    // Without this host-side guard, monitor.setPRInfo + emitUpdate bake the
    // stale PR into the worktree-update snapshot, bypassing the renderer's
    // branch guard on the pr-detected event.
    const onPRDetectedStart = source.indexOf("onPRDetected: (worktreeId, data) =>");
    const onPRDetectedEnd = source.indexOf("onPRCleared:", onPRDetectedStart);
    expect(onPRDetectedStart).toBeGreaterThan(0);
    const block = source.slice(onPRDetectedStart, onPRDetectedEnd);
    expect(block).toMatch(/data\.branchName !== undefined/);
    expect(block).toMatch(/monitor\.branch !== undefined/);
    expect(block).toMatch(/monitor\.branch !== data\.branchName/);
    // The guard must precede the monitor.setPRInfo write.
    expect(block.indexOf("monitor.branch !== data.branchName")).toBeLessThan(
      block.indexOf("monitor.setPRInfo(")
    );
  });

  it("guards onPRCleared against stale lookup branches before clearing the monitor", () => {
    const onPRClearedStart = source.indexOf("onPRCleared: (worktreeId, data) =>");
    const onPRClearedEnd = source.indexOf("onIssueDetected:", onPRClearedStart);
    expect(onPRClearedStart).toBeGreaterThan(0);
    const block = source.slice(onPRClearedStart, onPRClearedEnd);
    expect(block).toMatch(/data\.branchName !== undefined/);
    expect(block).toMatch(/monitor\.branch !== undefined/);
    expect(block).toMatch(/monitor\.branch !== data\.branchName/);
    expect(block.indexOf("monitor.branch !== data.branchName")).toBeLessThan(
      block.indexOf("monitor.clearPRInfo()")
    );
  });

  it("guards onIssueDetected against stale lookup branches before mutating the monitor", () => {
    const onIssueDetectedStart = source.indexOf("onIssueDetected: (worktreeId, data) =>");
    const onIssueDetectedEnd = source.indexOf("onIssueNotFound:", onIssueDetectedStart);
    expect(onIssueDetectedStart).toBeGreaterThan(0);
    const block = source.slice(onIssueDetectedStart, onIssueDetectedEnd);
    expect(block).toMatch(/data\.branchName !== undefined/);
    expect(block).toMatch(/monitor\.branch !== undefined/);
    expect(block).toMatch(/monitor\.branch !== data\.branchName/);
    expect(block.indexOf("monitor.branch !== data.branchName")).toBeLessThan(
      block.indexOf("monitor.setIssueTitle(")
    );
  });
});
