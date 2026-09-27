import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const windowStatesStoreMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const appMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    getPath: vi.fn(() => "/fake/userData"),
    getVersion: vi.fn(() => "1.0.0"),
    isPackaged: false as boolean,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (handlers.get(event) === handler) handlers.delete(event);
    }),
    _handlers: handlers,
  };
});

const utilsMock = vi.hoisted(() => ({
  resilientAtomicWriteFileSync: vi.fn(),
  resilientRenameSync: vi.fn(),
  tightenFilePermissionsSync: vi.fn(),
  tightenDirPermissionsSync: vi.fn(),
  OWNER_RW_FILE_MODE: 0o600,
  OWNER_RWX_DIR_MODE: 0o700,
}));

vi.mock("../../utils/fs.js", () => utilsMock);

vi.mock("../../store.js", () => ({
  store: storeMock,
  windowStatesStore: windowStatesStoreMock,
}));

const browserWindowMock = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => [{}]),
  getFocusedWindow: vi.fn(() => null),
}));

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
}));

vi.mock("../GpuCrashMonitorService.js", () => ({
  isGpuDisabledByFlag: vi.fn(() => false),
}));

const getRecentActionsMock = vi.hoisted(() => vi.fn(() => [] as unknown[]));

vi.mock("../ActionBreadcrumbService.js", () => ({
  getActionBreadcrumbService: () => ({
    getRecentActions: getRecentActionsMock,
  }),
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => ({
    onSuspend: vi.fn(() => vi.fn()),
    onWake: vi.fn(() => vi.fn()),
  }),
}));

import { CrashRecoveryService } from "../CrashRecoveryService.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

function makeService(): CrashRecoveryService {
  return new CrashRecoveryService();
}

describe("CrashRecoveryService renderer deaths and per-project layouts (#12884)", () => {
  let userData: string;

  function crashFiles(prefix: string): string[] {
    const dir = path.join(userData, "crashes");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
  }

  function readCrashFile(name: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(userData, "crashes", name), "utf-8"));
  }

  function writeProjectState(projectId: string, terminals: unknown): void {
    const dir = path.join(userData, "projects", projectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ projectId, sidebarWidth: 350, terminals })
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "crash-recovery-renderer-"));
    appMock.getPath.mockReturnValue(userData);
    appMock.isPackaged = false;
    storeMock.get.mockImplementation((key: string) =>
      key === "appState" ? { terminals: [] } : undefined
    );
    windowStatesStoreMock.get.mockReturnValue({});
    utilsMock.resilientAtomicWriteFileSync.mockImplementation(
      (fp: string, data: string, enc?: BufferEncoding) => {
        fs.writeFileSync(fp, data, enc ?? "utf-8");
      }
    );
    utilsMock.resilientRenameSync.mockImplementation((src: string, dest: string) => {
      fs.renameSync(src, dest);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("recordRendererGone", () => {
    it("writes a non-fatal record with identity, reason and exit code", () => {
      writeProjectState(PROJECT_A, [
        { id: "t1", kind: "terminal" },
        { id: "t2", kind: "browser" },
      ]);
      const svc = makeService();
      svc.initialize();

      svc.recordRendererGone({
        process: "project-view",
        projectId: PROJECT_A,
        webContentsId: 7,
        reason: "killed",
        exitCode: 15,
      });

      const files = crashFiles("renderer-gone-");
      expect(files).toHaveLength(1);
      const record = readCrashFile(files[0]!);
      expect(record).toMatchObject({
        event: "renderer-gone",
        fatal: false,
        process: "project-view",
        projectId: PROJECT_A,
        webContentsId: 7,
        reason: "killed",
        exitCode: 15,
        panelCount: 2,
        panelKinds: { terminal: 1, browser: 1 },
      });
      expect(record).not.toHaveProperty("crashCause");
      expect(crashFiles("crash-")).toHaveLength(0);
    });

    it("omits panel metadata when the project's layout cannot be read", () => {
      const svc = makeService();
      svc.recordRendererGone({
        process: "project-view",
        projectId: PROJECT_A,
        reason: "crashed",
        exitCode: 1,
      });

      const record = readCrashFile(crashFiles("renderer-gone-")[0]!);
      expect(record).not.toHaveProperty("panelCount");
    });

    it("leaves the running marker untouched", () => {
      const svc = makeService();
      svc.initialize();
      const markerPath = path.join(userData, "running.lock");
      const before = fs.readFileSync(markerPath, "utf-8");

      svc.recordRendererGone({ process: "app-view", reason: "oom", exitCode: 0 });

      expect(fs.readFileSync(markerPath, "utf-8")).toBe(before);
    });

    it("does not spend the fatal latch", () => {
      const svc = makeService();
      svc.initialize();
      svc.recordRendererGone({ process: "project-view", reason: "crashed", exitCode: 1 });
      svc.recordCrash(new Error("real main-process failure"));

      const fatal = crashFiles("crash-");
      expect(fatal).toHaveLength(1);
      expect(readCrashFile(fatal[0]!).errorMessage).toBe("real main-process failure");
      const marker = JSON.parse(fs.readFileSync(path.join(userData, "running.lock"), "utf-8"));
      expect(marker.crashLogPath).toBe(path.join(userData, "crashes", fatal[0]!));
    });

    it("treats a quit after a renderer death as a clean exit", () => {
      const svc = makeService();
      svc.initialize();
      svc.recordRendererGone({ process: "project-view", reason: "killed", exitCode: 15 });
      svc.cleanupOnExit();

      const next = makeService();
      next.initialize();

      expect(next.getPendingCrash()).toBeNull();
    });

    it("records every renderer reason the same way", () => {
      const svc = makeService();
      const reasons = ["abnormal-exit", "killed", "crashed", "oom", "launch-failed"];
      reasons.forEach((reason, i) =>
        svc.recordRendererGone({ process: "app-view", webContentsId: i, reason, exitCode: 0 })
      );

      const recorded = crashFiles("renderer-gone-").map((f) => readCrashFile(f).reason);
      expect(recorded.sort()).toEqual([...reasons].sort());
    });

    it("rate-limits repeats from the same view", () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const svc = makeService();
      const details = {
        process: "project-view" as const,
        projectId: PROJECT_A,
        reason: "crashed",
        exitCode: 1,
      };

      svc.recordRendererGone(details);
      svc.recordRendererGone(details);
      expect(crashFiles("renderer-gone-")).toHaveLength(1);

      svc.recordRendererGone({ ...details, projectId: PROJECT_B });
      expect(crashFiles("renderer-gone-")).toHaveLength(2);

      now.mockReturnValue(1_000_000 + 60_000);
      svc.recordRendererGone(details);
      expect(crashFiles("renderer-gone-")).toHaveLength(3);
    });

    it("caps records per session", () => {
      const svc = makeService();
      for (let i = 0; i < 30; i++) {
        svc.recordRendererGone({
          process: "app-view",
          webContentsId: i,
          reason: "crashed",
          exitCode: 1,
        });
      }
      expect(crashFiles("renderer-gone-")).toHaveLength(20);
    });

    it("prunes old records without touching fatal crash logs", () => {
      const dir = path.join(userData, "crashes");
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 25; i++) {
        const file = path.join(dir, `renderer-gone-old-${i}.json`);
        fs.writeFileSync(file, "{}");
        fs.utimesSync(file, new Date(1_000 + i), new Date(1_000 + i));
      }
      fs.writeFileSync(path.join(dir, "crash-keep.json"), "{}");

      makeService().recordRendererGone({ process: "app-view", reason: "crashed", exitCode: 1 });

      expect(crashFiles("renderer-gone-")).toHaveLength(20);
      expect(fs.existsSync(path.join(dir, "crash-keep.json"))).toBe(true);
    });

    it("swallows write failures and does not retry them", () => {
      utilsMock.resilientAtomicWriteFileSync.mockImplementation(() => {
        throw new Error("disk full");
      });
      const svc = makeService();
      const details = { process: "app-view" as const, reason: "crashed", exitCode: 1 };

      expect(() => svc.recordRendererGone(details)).not.toThrow();
      svc.recordRendererGone(details);

      expect(utilsMock.resilientAtomicWriteFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("per-project panel layouts", () => {
    it("records fatal crash metadata from the live projects' layouts", () => {
      writeProjectState(PROJECT_A, [
        { id: "t1", kind: "terminal" },
        { id: "t2", kind: "terminal" },
      ]);
      writeProjectState(PROJECT_B, [{ id: "b1", kind: "browser" }]);
      const svc = makeService();
      svc.setLiveWorkspaceIdsProvider(() => [PROJECT_A, PROJECT_B, PROJECT_A]);

      svc.recordCrash(new Error("boom"));

      const entry = readCrashFile(crashFiles("crash-")[0]!);
      expect(entry.panelCount).toBe(3);
      expect(entry.panelKinds).toEqual({ terminal: 2, browser: 1 });
    });

    it("keeps an empty persisted layout authoritative over the legacy global list", () => {
      writeProjectState(PROJECT_A, []);
      storeMock.get.mockImplementation((key: string) =>
        key === "appState" ? { terminals: [{ id: "legacy", kind: "terminal" }] } : undefined
      );
      const svc = makeService();
      svc.setLiveWorkspaceIdsProvider(() => [PROJECT_A]);

      svc.recordCrash(new Error("boom"));

      expect(readCrashFile(crashFiles("crash-")[0]!).panelCount).toBe(0);
    });

    it("falls back to the legacy global list when no workspace is live", () => {
      storeMock.get.mockImplementation((key: string) =>
        key === "appState" ? { terminals: [{ id: "legacy", kind: "terminal" }] } : undefined
      );
      const svc = makeService();
      svc.setLiveWorkspaceIdsProvider(() => []);

      svc.recordCrash(new Error("boom"));

      expect(readCrashFile(crashFiles("crash-")[0]!).panelCount).toBe(1);
    });

    it("skips an unreadable project without losing the others", () => {
      writeProjectState(PROJECT_A, [{ id: "t1", kind: "terminal" }]);
      fs.mkdirSync(path.join(userData, "projects", PROJECT_B), { recursive: true });
      fs.writeFileSync(path.join(userData, "projects", PROJECT_B, "state.json"), "{not json");
      const svc = makeService();
      svc.setLiveWorkspaceIdsProvider(() => [PROJECT_A, PROJECT_B]);

      svc.recordCrash(new Error("boom"));

      expect(readCrashFile(crashFiles("crash-")[0]!).panelCount).toBe(1);
    });

    it.each([
      ["null terminals as an empty layout", { terminals: null }, [PROJECT_A, PROJECT_B]],
      ["a non-array terminals field as unreadable", { terminals: "nope" }, [PROJECT_A]],
      [
        "a newer schema version as unreadable",
        { _schemaVersion: 99, terminals: [{ id: "x" }] },
        [PROJECT_A],
      ],
    ])("treats %s", (_label, state, captured) => {
      writeProjectState(PROJECT_A, [{ id: "t1", kind: "terminal" }]);
      fs.mkdirSync(path.join(userData, "projects", PROJECT_B), { recursive: true });
      fs.writeFileSync(
        path.join(userData, "projects", PROJECT_B, "state.json"),
        JSON.stringify(state)
      );
      const svc = makeService();
      svc.setLiveWorkspaceIdsProvider(() => [PROJECT_A, PROJECT_B, "../escape"]);

      svc.takeBackup();

      const backup = JSON.parse(
        fs.readFileSync(path.join(userData, "backups", "session-state.json"), "utf-8")
      );
      expect(Object.keys(backup.projectLayouts)).toEqual(captured);
    });

    it("counts project layouts in a fresh on-disk backup without a crash", () => {
      writeProjectState(PROJECT_A, [
        { id: "t1", kind: "terminal" },
        { id: "t2", kind: "terminal" },
      ]);
      const svc = makeService();
      svc.setLiveWorkspaceIdsProvider(() => [PROJECT_A]);
      svc.initialize();
      svc.takeBackup();

      expect(svc.getBackupPanelCount(true)).toBe(2);
      expect(svc.hasProjectPanelLayouts()).toBe(true);
    });

    it("survives a provider that throws", () => {
      const svc = makeService();
      svc.setLiveWorkspaceIdsProvider(() => {
        throw new Error("disposing");
      });

      expect(() => svc.recordCrash(new Error("boom"))).not.toThrow();
      expect(crashFiles("crash-")).toHaveLength(1);
    });

    it("surfaces per-project panels in the next launch's recovery summary", () => {
      writeProjectState(PROJECT_A, [
        { id: "t1", kind: "terminal", title: "Claude", createdAt: 1 },
        { id: "t2", kind: "terminal", title: "Shell", location: "dock", createdAt: 1 },
      ]);
      writeProjectState(PROJECT_B, [{ id: "b1", kind: "browser", title: "Docs", createdAt: 1 }]);
      // A dev build discards a marker with no crash log as an orphaned restart.
      appMock.isPackaged = true;
      const crashed = makeService();
      crashed.setLiveWorkspaceIdsProvider(() => [PROJECT_A, PROJECT_B]);
      crashed.initialize();
      crashed.takeBackup();
      // No cleanupOnExit: the session died.

      const next = makeService();
      next.initialize();

      const pending = next.getPendingCrash()!;
      expect(pending.entry.panelCount).toBe(3);
      expect(pending.panels?.map((p) => [p.projectId, p.id])).toEqual([
        [PROJECT_A, "t1"],
        [PROJECT_A, "t2"],
        [PROJECT_B, "b1"],
      ]);
      expect(pending.panels?.[1]?.location).toBe("dock");
      expect(next.getBackupPanelCount()).toBe(3);
    });

    it("takes a new backup when only a project layout changed", () => {
      writeProjectState(PROJECT_A, [{ id: "t1", kind: "terminal" }]);
      const svc = makeService();
      svc.setLiveWorkspaceIdsProvider(() => [PROJECT_A]);
      svc.takeBackup();
      const backupPath = path.join(userData, "backups", "session-state.json");
      const first = fs.readFileSync(backupPath, "utf-8");

      svc.takeBackup();
      expect(fs.existsSync(path.join(userData, "backups", "session-state.previous.json"))).toBe(
        false
      );

      writeProjectState(PROJECT_A, [
        { id: "t1", kind: "terminal" },
        { id: "t2", kind: "terminal" },
      ]);
      svc.takeBackup();

      expect(fs.readFileSync(backupPath, "utf-8")).not.toBe(first);
      expect(
        JSON.parse(fs.readFileSync(backupPath, "utf-8")).projectLayouts[PROJECT_A]
      ).toHaveLength(2);
    });
  });

  describe("selective restore across projects", () => {
    function crashWithProjects(): CrashRecoveryService {
      writeProjectState(PROJECT_A, [
        { id: "t1", kind: "terminal" },
        { id: "t2", kind: "terminal" },
      ]);
      writeProjectState(PROJECT_B, [{ id: "b1", kind: "browser" }]);
      appMock.isPackaged = true;
      const crashed = makeService();
      crashed.setLiveWorkspaceIdsProvider(() => [PROJECT_A, PROJECT_B]);
      crashed.initialize();
      crashed.takeBackup();
      const next = makeService();
      next.initialize();
      return next;
    }

    it("reports the panels left out of a selection, by project", () => {
      const svc = crashWithProjects();

      expect(svc.getDeselectedProjectPanels(["t1"])).toEqual({
        [PROJECT_A]: ["t2"],
        [PROJECT_B]: ["b1"],
      });
    });

    it("reports nothing for no selection or a selection that matches nothing", () => {
      const svc = crashWithProjects();

      expect(svc.getDeselectedProjectPanels(undefined)).toEqual({});
      expect(svc.getDeselectedProjectPanels([])).toEqual({});
      expect(svc.getDeselectedProjectPanels(["stale"])).toEqual({});
    });

    it("accepts a selection of per-project panels even though the global list is empty", () => {
      const svc = crashWithProjects();

      expect(svc.restoreBackup(["t1", "b1"])).toBe(true);
    });

    it("rejects a selection that matches no captured panel", () => {
      const svc = crashWithProjects();

      expect(svc.restoreBackup(["stale"])).toBe(false);
      expect(svc.getBackupPanelCount()).toBe(3);
    });
  });
});
