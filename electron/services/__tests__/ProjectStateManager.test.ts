import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProjectStateManager, PROJECT_STATE_SCHEMA_VERSION } from "../ProjectStateManager.js";
import { generateProjectId, stateFilePath } from "../projectStorePaths.js";
import type { ProjectState } from "../../types/index.js";
import { markPerformance, withPerformanceSpan } from "../../utils/performance.js";
import { PERF_MARKS } from "../../../shared/perf/marks.js";

vi.mock("../../utils/performance.js", () => ({
  markPerformance: vi.fn(),
  withPerformanceSpan: vi.fn(async (_mark: string, task: () => Promise<unknown>) => task()),
}));

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
        cwd: "/tmp",
      },
      {
        id: "t2",
        title: "Terminal 2",
        location: "dock" as const,
        kind: "terminal" as const,
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-"));
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

describe("ProjectStateManager telemetry", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(async () => {
    vi.mocked(withPerformanceSpan).mockClear();
    vi.mocked(markPerformance).mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-telemetry-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/telemetry-project");

    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("records a PROJECT_STATE_WRITE span with projectId and non-zero bytes on save", async () => {
    await manager.saveProjectState(projectId, makeState());

    const writeCall = vi
      .mocked(withPerformanceSpan)
      .mock.calls.find((call) => call[0] === PERF_MARKS.PROJECT_STATE_WRITE);

    expect(writeCall).toBeDefined();
    const meta = writeCall![2] as { projectId: string; bytes: number };
    expect(meta.projectId).toBe(projectId);
    expect(meta.bytes).toBeGreaterThan(0);
  });

  it("records a PROJECT_STATE_READ span with projectId on disk-read load", async () => {
    await manager.saveProjectState(projectId, makeState());
    manager.invalidateProjectStateCache(projectId);
    vi.mocked(withPerformanceSpan).mockClear();

    await manager.getProjectState(projectId);

    const readCall = vi
      .mocked(withPerformanceSpan)
      .mock.calls.find((call) => call[0] === PERF_MARKS.PROJECT_STATE_READ);

    expect(readCall).toBeDefined();
    const meta = readCall![2] as { projectId: string };
    expect(meta.projectId).toBe(projectId);
  });

  it("does not emit PROJECT_STATE_READ on a cache hit", async () => {
    await manager.saveProjectState(projectId, makeState());
    await manager.getProjectState(projectId);
    vi.mocked(withPerformanceSpan).mockClear();

    await manager.getProjectState(projectId);

    const readCall = vi
      .mocked(withPerformanceSpan)
      .mock.calls.find((call) => call[0] === PERF_MARKS.PROJECT_STATE_READ);
    expect(readCall).toBeUndefined();
  });

  it("does not emit PROJECT_STATE_READ when no state file exists", async () => {
    const missingId = generateProjectId("/missing/telemetry-project");

    const result = await manager.getProjectState(missingId);

    expect(result).toBeNull();
    const readCall = vi
      .mocked(withPerformanceSpan)
      .mock.calls.find((call) => call[0] === PERF_MARKS.PROJECT_STATE_READ);
    expect(readCall).toBeUndefined();
  });

  it("emits PROJECT_STATE_QUARANTINE when a corrupted state file is quarantined", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");

    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    expect(vi.mocked(markPerformance)).toHaveBeenCalledWith(PERF_MARKS.PROJECT_STATE_QUARANTINE, {
      projectId,
    });
  });
});

describe("ProjectStateManager quarantine recovery", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-recovery-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/recovery-project");
    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("surfaces the quarantined path when state JSON is invalid", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");

    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).toBeNull();
    expect(result.quarantinedPath).toMatch(/\.corrupted\.\d+$/);
    await expect(fs.access(result.quarantinedPath!)).resolves.toBeUndefined();
  });

  it("drains the quarantine signal after one read — subsequent reads return no path", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");

    const first = await manager.getProjectStateWithRecovery(projectId);
    expect(first.quarantinedPath).toMatch(/\.corrupted\.\d+$/);

    const second = await manager.getProjectStateWithRecovery(projectId);
    expect(second.state).toBeNull();
    expect(second.quarantinedPath).toBeUndefined();
  });

  it("returns no quarantinedPath when state is valid", async () => {
    await manager.saveProjectState(projectId, makeState());

    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).not.toBeNull();
    expect(result.quarantinedPath).toBeUndefined();
  });

  it("surfaces the quarantine when a preceding getProjectState() triggered it", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");

    // windowServices.ts-style caller reads state via the plain method — this
    // triggers quarantine but discards the recovery signal.
    const firstState = await manager.getProjectState(projectId);
    expect(firstState).toBeNull();

    // Hydration path later reads via the recovery-aware method and should
    // still receive the quarantined path.
    const result = await manager.getProjectStateWithRecovery(projectId);
    expect(result.state).toBeNull();
    expect(result.quarantinedPath).toMatch(/\.corrupted\.\d+$/);
  });
});

describe("ProjectStateManager schema version", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;
  let filePath: string;

  beforeEach(async () => {
    vi.mocked(markPerformance).mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-schema-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/schema-project");
    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
    filePath = stateFilePath(tempDir, projectId)!;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeRaw(content: unknown): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(content), "utf-8");
    manager.invalidateProjectStateCache(projectId);
  }

  it("reads a legacy unversioned file successfully", async () => {
    await writeRaw({
      projectId,
      sidebarWidth: 350,
      terminals: [],
    });

    const result = await manager.getProjectState(projectId);
    expect(result).not.toBeNull();
    expect(result!.sidebarWidth).toBe(350);
  });

  it("reads a v1 file successfully", async () => {
    await writeRaw({
      _schemaVersion: 1,
      projectId,
      sidebarWidth: 350,
      terminals: [],
    });

    const result = await manager.getProjectState(projectId);
    expect(result).not.toBeNull();
  });

  it("quarantines a future-version file to .future-vN and returns null", async () => {
    await writeRaw({
      _schemaVersion: 2,
      projectId,
      sidebarWidth: 350,
      terminals: [],
      mysteryNewField: "data we must not destroy",
    });

    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    await expect(fs.access(`${filePath}.future-v2`)).resolves.toBeUndefined();
    await expect(fs.access(filePath)).rejects.toThrow();
    await expect(fs.access(`${filePath}.corrupted`)).rejects.toThrow();
  });

  it("preserves the future-version file contents intact under the quarantine path", async () => {
    const original = {
      _schemaVersion: 99,
      projectId,
      sidebarWidth: 350,
      terminals: [],
      futureFeature: { nested: ["a", "b"] },
    };
    await writeRaw(original);

    await manager.getProjectState(projectId);

    const preserved = JSON.parse(await fs.readFile(`${filePath}.future-v99`, "utf-8"));
    expect(preserved).toEqual(original);
  });

  it("emits PROJECT_STATE_QUARANTINE for future-version reads", async () => {
    await writeRaw({
      _schemaVersion: 2,
      projectId,
      terminals: [],
    });

    await manager.getProjectState(projectId);

    expect(vi.mocked(markPerformance)).toHaveBeenCalledWith(PERF_MARKS.PROJECT_STATE_QUARANTINE, {
      projectId,
    });
  });

  it("surfaces the future-version quarantine path through getProjectStateWithRecovery", async () => {
    await writeRaw({
      _schemaVersion: 7,
      projectId,
      terminals: [],
    });

    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).toBeNull();
    expect(result.quarantinedPath).toBe(`${filePath}.future-v7`);
  });

  it("stamps _schemaVersion on every save", async () => {
    await manager.saveProjectState(projectId, makeState());

    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(raw._schemaVersion).toBe(PROJECT_STATE_SCHEMA_VERSION);
  });

  it("does not leak _schemaVersion into the in-memory ProjectState returned to callers", async () => {
    await manager.saveProjectState(projectId, makeState());
    manager.invalidateProjectStateCache(projectId);

    const result = await manager.getProjectState(projectId);

    expect(result).not.toBeNull();
    expect((result as unknown as Record<string, unknown>)._schemaVersion).toBeUndefined();
  });

  it("round-trips: save then invalidate cache then read returns equivalent state", async () => {
    const original = makeState();
    await manager.saveProjectState(projectId, original);
    manager.invalidateProjectStateCache(projectId);

    const result = await manager.getProjectState(projectId);

    expect(result).not.toBeNull();
    expect(result!.sidebarWidth).toBe(original.sidebarWidth);
    expect(result!.terminals).toHaveLength(original.terminals.length);
    expect(result!.terminalSizes).toEqual(original.terminalSizes);
  });

  it("treats a non-numeric _schemaVersion as legacy v0 and reads successfully", async () => {
    await writeRaw({
      _schemaVersion: "2",
      projectId,
      sidebarWidth: 350,
      terminals: [],
    });

    const result = await manager.getProjectState(projectId);

    expect(result).not.toBeNull();
    expect(result!.sidebarWidth).toBe(350);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("treats a negative _schemaVersion as legacy v0 and reads successfully", async () => {
    await writeRaw({
      _schemaVersion: -1,
      projectId,
      sidebarWidth: 350,
      terminals: [],
    });

    const result = await manager.getProjectState(projectId);

    expect(result).not.toBeNull();
  });

  it("preserves a prior quarantine when a second future-version file lands at the same version", async () => {
    const firstPayload = {
      _schemaVersion: 2,
      projectId,
      sidebarWidth: 350,
      terminals: [],
      featureA: "first quarantine — must survive",
    };
    await writeRaw(firstPayload);
    await manager.getProjectState(projectId);

    const originalQuarantine = JSON.parse(await fs.readFile(`${filePath}.future-v2`, "utf-8"));
    expect(originalQuarantine).toEqual(firstPayload);

    const secondPayload = {
      _schemaVersion: 2,
      projectId,
      sidebarWidth: 350,
      terminals: [],
      featureA: "second quarantine — must NOT clobber the first",
    };
    await writeRaw(secondPayload);
    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    // Original quarantine still intact at the canonical path.
    const stillThere = JSON.parse(await fs.readFile(`${filePath}.future-v2`, "utf-8"));
    expect(stillThere).toEqual(firstPayload);

    // Second future-version file moved to a timestamp-suffixed sibling.
    const dir = path.dirname(filePath);
    const entries = await fs.readdir(dir);
    const suffixed = entries.find((name) => /^state\.json\.future-v2\.\d+$/.test(name));
    expect(suffixed).toBeDefined();
    const suffixedContent = JSON.parse(await fs.readFile(path.join(dir, suffixed!), "utf-8"));
    expect(suffixedContent).toEqual(secondPayload);
  });

  it("quarantines a very large future-version number to .future-v{N}", async () => {
    await writeRaw({
      _schemaVersion: 999999,
      projectId,
      terminals: [],
    });

    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    await expect(fs.access(`${filePath}.future-v999999`)).resolves.toBeUndefined();
  });
});
