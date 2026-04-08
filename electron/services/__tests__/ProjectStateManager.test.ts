import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProjectStateManager } from "../ProjectStateManager.js";
import { generateProjectId } from "../projectStorePaths.js";
import type { ProjectState } from "../../types/index.js";

function makeState(overrides?: Partial<ProjectState>): ProjectState {
  return {
    projectId: "test-project",
    sidebarWidth: 350,
    terminals: [
      {
        id: "t1",
        title: "Terminal 1",
        location: "grid" as const,
        kind: "terminal" as const,
        type: "terminal" as const,
        cwd: "/tmp",
      },
      {
        id: "t2",
        title: "Terminal 2",
        location: "dock" as const,
        kind: "terminal" as const,
        type: "terminal" as const,
        cwd: "/tmp",
      },
    ],
    terminalSizes: { t1: { cols: 80, rows: 24 } },
    focusPanelState: { sidebarWidth: 300, diagnosticsOpen: false },
    ...overrides,
  };
}

describe("ProjectStateManager clone isolation", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-state-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/project");

    const projectDir = path.join(tempDir, projectId);
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns null when no state file exists", async () => {
    const id = generateProjectId("/nonexistent/project");
    const result = await manager.getProjectState(id);
    expect(result).toBeNull();
  });

  it("returns deep clones on read — mutating one result does not affect the next", async () => {
    const state = makeState();
    await manager.saveProjectState(projectId, state);

    const first = await manager.getProjectState(projectId);
    expect(first).not.toBeNull();

    // Mutate nested fields on the first result
    first!.terminals[0].title = "MUTATED";
    first!.terminalSizes!.t1.cols = 999;
    first!.focusPanelState!.sidebarWidth = 999;

    // Second read should be unaffected
    const second = await manager.getProjectState(projectId);
    expect(second!.terminals[0].title).toBe("Terminal 1");
    expect(second!.terminalSizes!.t1.cols).toBe(80);
    expect(second!.focusPanelState!.sidebarWidth).toBe(300);
  });

  it("save-path isolation — mutating state after save does not corrupt the cache", async () => {
    const state = makeState();
    await manager.saveProjectState(projectId, state);

    // Mutate the original state object after saving
    state.terminals[0].title = "MUTATED";
    state.sidebarWidth = 9999;

    const result = await manager.getProjectState(projectId);
    expect(result!.terminals[0].title).toBe("Terminal 1");
    expect(result!.sidebarWidth).toBe(350);
  });
});
