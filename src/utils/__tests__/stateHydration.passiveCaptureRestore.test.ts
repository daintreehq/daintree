// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentConfig } from "@shared/config/agentRegistry";

/**
 * #12433 end to end: a passive exit capture persisted by Main's real writeback,
 * through the real project-state queue and a real state file, is what the real
 * cold-restore path turns into an exact resume. Nothing in between is a stand-in
 * for the part under test.
 *
 * The Main side is loaded through non-literal specifiers so neither TypeScript
 * project has to type-check the other's tree; only its outer edges (the project
 * store facade, the journal, logging) are mocked.
 */

interface StateManager {
  enqueueProjectStateUpdate: (id: string, updater: unknown) => Promise<void>;
  saveProjectState: (id: string, state: unknown) => Promise<void>;
  getProjectState: (id: string) => Promise<{ terminals: Array<Record<string, unknown>> } | null>;
  dispose: () => void;
}

const { stateRef } = vi.hoisted(() => ({
  stateRef: { manager: null as StateManager | null },
}));

vi.mock("../../../electron/services/ProjectStore.js", () => ({
  projectStore: {
    enqueueProjectStateUpdate: (id: string, updater: unknown) =>
      stateRef.manager!.enqueueProjectStateUpdate(id, updater),
  },
}));
vi.mock("../../../electron/services/pty/agentSessionJournal.js", () => ({
  journalAgentSession: vi.fn(async () => true),
}));
vi.mock("../../../electron/services/assistantTerminal.js", () => ({
  isAssistantTerminalRecord: vi.fn(() => false),
}));
vi.mock("../../../electron/utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logWarn: vi.fn(),
}));
vi.mock("../../../electron/utils/performance.js", () => ({
  markPerformance: vi.fn(),
  withPerformanceSpan: vi.fn(async (_mark: string, task: () => Promise<unknown>) => task()),
}));

const appClientMock = { hydrate: vi.fn() };
const terminalClientMock = {
  getForProject: vi.fn(),
  reconnect: vi.fn(),
  reconnectBulk: vi.fn(),
  getSerializedStates: vi.fn(),
};
const worktreeClientMock = { getAll: vi.fn(), getAllWithStatus: vi.fn() };
const projectClientMock = {
  getTabGroups: vi.fn(),
  getTerminalSizes: vi.fn(),
  getDraftInputs: vi.fn(),
  setDraftInputs: vi.fn(),
  getInRepoPresets: vi.fn(),
};

vi.mock("@/clients", () => ({
  appClient: appClientMock,
  terminalClient: terminalClientMock,
  worktreeClient: worktreeClientMock,
  projectClient: projectClientMock,
  systemClient: { getTmpDir: vi.fn().mockResolvedValue("/tmp") },
}));
vi.mock("@/clients/terminalConfigClient", () => ({
  terminalConfigClient: { setScrollback: vi.fn() },
}));
vi.mock("@/store", () => ({
  useLayoutConfigStore: { getState: () => ({ setLayoutConfig: vi.fn() }) },
  useScrollbackStore: { getState: () => ({ setScrollbackLines: vi.fn() }) },
  usePerformanceModeStore: { getState: () => ({ setPerformanceMode: vi.fn() }) },
  useTerminalInputStore: {
    getState: () => ({ setHybridInputEnabled: vi.fn(), setHybridInputAutoFocus: vi.fn() }),
  },
  usePanelStore: { getState: () => ({ setSpawnError: vi.fn() }) },
}));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { setState: vi.fn() } }));
vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: {
    getState: () => ({ initialize: vi.fn().mockResolvedValue(undefined) }),
  },
}));
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { loadOverrides: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    fetchAndRestore: vi.fn().mockResolvedValue(undefined),
    restoreFetchedState: vi.fn().mockResolvedValue(undefined),
    initializeBackendTier: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    setGPUHardwareAvailable: vi.fn(),
    setTargetSize: vi.fn(),
    notifyScrollbackRestoreListeners: vi.fn(),
    notifyRestoreSettledWaiters: vi.fn(),
  },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn().mockReturnValue("notification-id") }));

const { hydrateAppState } = await import("../stateHydration");

interface ElectronSide {
  ProjectStateManager: new (dir: string) => StateManager;
  generateProjectId: (projectPath: string) => string;
  getLifecycleLedger: () => {
    recordLaunch: (id: string, facts: Record<string, unknown>) => number;
    recordClose: (id: string, generation: number, reason?: string, code?: number) => unknown;
  };
  disposeLifecycleLedger: () => void;
  writeBackCapturedSessionId: (capture: unknown) => Promise<string>;
  resetCapturedSessionPersistenceForTests: () => void;
}

async function loadElectronSide(): Promise<ElectronSide> {
  const root = "../../../electron/services/";
  const load = (file: string) => import(/* @vite-ignore */ `${root}${file}`);
  const [manager, paths, ledger, persistence] = await Promise.all([
    load("ProjectStateManager.js"),
    load("projectStorePaths.js"),
    load("pty/lifecycleLedger.js"),
    load("pty/agentSessionCapturePersistence.js"),
  ]);
  const side: ElectronSide = Object.assign({}, manager, paths, ledger, persistence);
  return side;
}

const SESSION_ID = "019a0000-0000-7000-8000-0000000012c3";
const SIBLING_SESSION_ID = "019a0000-0000-7000-8000-0000000012c4";

/** The slice of the respawn arguments this test reads. */
interface RespawnArgs {
  requestedId?: string;
  command?: string;
  agentSessionId?: string;
}

describe("passive exit capture → cold restore (#12433)", () => {
  let main: ElectronSide;
  let dir: string;
  let projectId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("scheduler", { postTask: vi.fn(() => new Promise(() => {})) });
    main = await loadElectronSide();
    main.disposeLifecycleLedger();
    main.resetCapturedSessionPersistenceForTests();
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "daintree-passive-restore-"));
    projectId = main.generateProjectId("/project");
    await fsp.mkdir(path.join(dir, projectId), { recursive: true });
    stateRef.manager = new main.ProjectStateManager(dir);

    terminalClientMock.getForProject.mockResolvedValue([]);
    terminalClientMock.reconnect.mockResolvedValue({ exists: false });
    terminalClientMock.reconnectBulk.mockResolvedValue({});
    terminalClientMock.getSerializedStates.mockRejectedValue(new Error("unavailable"));
    worktreeClientMock.getAllWithStatus.mockResolvedValue({ worktrees: [], gitBacked: null });
    projectClientMock.getTabGroups.mockResolvedValue([]);
    projectClientMock.getTerminalSizes.mockResolvedValue({});
    projectClientMock.getDraftInputs.mockResolvedValue({});
    projectClientMock.getInRepoPresets.mockResolvedValue({});
  });

  afterEach(async () => {
    stateRef.manager?.dispose();
    stateRef.manager = null;
    main.disposeLifecycleLedger();
    main.resetCapturedSessionPersistenceForTests();
    vi.unstubAllGlobals();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("resumes each pane in its own exact conversation after a natural exit", async () => {
    const codexPane = (id: string) => ({
      id,
      kind: "terminal",
      launchAgentId: "codex",
      title: "Codex",
      // Several conversations in one checkout: exactly the case where only
      // the pane's own captured id can tell them apart.
      cwd: "/project",
      location: "grid",
      command: "codex",
    });
    await stateRef.manager!.saveProjectState(projectId, {
      projectId,
      sidebarWidth: 350,
      terminals: [codexPane("pane-a"), codexPane("pane-b")],
    });

    const ledger = main.getLifecycleLedger();
    for (const [paneId, sessionId] of [
      ["pane-a", SESSION_ID],
      ["pane-b", SIBLING_SESSION_ID],
    ] as const) {
      const generation = ledger.recordLaunch(paneId, { projectId, launchAgentId: "codex" });
      ledger.recordClose(paneId, generation, "exit", 0);
      await expect(
        main.writeBackCapturedSessionId({
          terminalId: paneId,
          launchGeneration: generation,
          boundary: "exit",
          record: {
            sessionId,
            agentId: "codex",
            worktreeId: null,
            title: "Codex",
            projectId,
            cwd: "/project",
          },
        })
      ).resolves.toBe("filled");
    }

    // What the next launch reads: the file on disk, through a fresh manager.
    const reader = new main.ProjectStateManager(dir);
    const persisted = await reader.getProjectState(projectId);
    reader.dispose();
    expect(persisted?.terminals.map((t) => t.agentSessionId)).toEqual([
      SESSION_ID,
      SIBLING_SESSION_ID,
    ]);

    appClientMock.hydrate.mockResolvedValue({
      appState: { terminals: persisted!.terminals, sidebarWidth: 350 },
      terminalConfig: { scrollbackLines: 1000, performanceMode: false },
      project: { id: projectId, path: "/project" },
      agentSettings: { agents: {} },
    });
    const addPanel = vi.fn(async (_args: RespawnArgs) => "ok");

    await hydrateAppState({
      addPanel,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    const resume = getAgentConfig("codex")?.resume;
    if (resume?.kind !== "session-id") throw new Error("codex must resume by session id");
    const byPane = new Map(
      addPanel.mock.calls.map(([args]): [string | undefined, RespawnArgs] => [
        args.requestedId,
        args,
      ])
    );
    for (const [paneId, sessionId] of [
      ["pane-a", SESSION_ID],
      ["pane-b", SIBLING_SESSION_ID],
    ] as const) {
      // An exact id per pane, not "most recent in this folder".
      const args = byPane.get(paneId);
      expect(args?.agentSessionId).toBe(sessionId);
      expect(args?.command).toContain(resume.args(sessionId).join(" "));
    }
  });
});
