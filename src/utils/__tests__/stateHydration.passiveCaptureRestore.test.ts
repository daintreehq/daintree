// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentConfig } from "@shared/config/agentRegistry";
import { quoteLaunchArgOptional } from "@shared/utils/shellEscape";

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
vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    fetchAndRestore: vi.fn().mockResolvedValue(undefined),
    restoreFetchedState: vi.fn().mockResolvedValue(undefined),
    initializeBackendTier: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    setGPUHardwareAvailable: vi.fn(),
    setTargetSize: vi.fn(),
    notifyScrollbackRestoreListeners: vi.fn(),
    addInstanceDestroyedListener: vi.fn(() => () => {}),
    notifyRestoreSettledWaiters: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});
vi.mock("@/lib/notify", () => ({ notify: vi.fn().mockReturnValue("notification-id") }));

const { hydrateAppState } = await import("../stateHydration");
// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock so restore reaches it through the accessor.
const { load: loadTerminalService } =
  await import("@/services/terminal/terminalInstanceServiceAccessor");
await loadTerminalService();

interface ElectronSide {
  ProjectStateManager: new (dir: string) => StateManager;
  generateProjectId: (projectPath: string) => string;
  getLifecycleLedger: () => {
    recordLaunch: (id: string, facts: Record<string, unknown>) => number;
    recordClose: (id: string, generation: number, reason?: string, code?: number) => unknown;
  };
  disposeLifecycleLedger: () => void;
  writeBackCapturedSessionId: (capture: unknown) => Promise<string>;
  acceptObservedAgentSession: (observation: unknown) => Promise<string>;
  resetCapturedSessionPersistenceForTests: () => void;
  offerAgentRunArgvSession: (
    terminalId: string,
    terminal: Record<string, unknown>,
    observation: { agentType: string; command: string }
  ) => void;
  events: { on: (event: string, listener: (payload: unknown) => void) => () => void };
}

async function loadElectronSide(): Promise<ElectronSide> {
  const harness = "../../../electron/services/pty/__tests__/passiveCaptureRestoreHarness.ts";
  return import(/* @vite-ignore */ harness);
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
      // Quoted the way the command builder quotes positional values: `-C '.'`,
      // a PowerShell literal on Windows as much as a POSIX one elsewhere.
      const resumeArgs = resume.args(sessionId).map((arg) => quoteLaunchArgOptional(arg));
      expect(args?.command).toContain(resumeArgs.join(" "));
    }
  });

  // #15994: Codex quit to the shell, the user typed `codex resume <id>` to
  // reopen an older conversation, and Daintree restarted mid-turn. No farewell
  // and no teardown capture, and live attribution never covers a hand-started
  // run, so the run's own argv is the only record of what it was running.
  it.each([
    ["holds no id", undefined],
    ["holds the conversation it launched", "019a0000-0000-7000-8000-00000000a1d0"],
  ])(
    "resumes a hand-resumed run exactly after a mid-turn restart, when the pane %s",
    async (_name, launchedId) => {
      const HAND_ID = "0199f8c1-2b4d-7e3a-9f10-5c6d7e8f9a0b";
      const codexPane = (id: string, agentSessionId?: string) => ({
        id,
        kind: "terminal",
        launchAgentId: "codex",
        title: "Codex",
        // Two panes in one folder compete for the single resume-latest slot.
        cwd: "/project",
        location: "grid",
        command: "codex",
        ...(agentSessionId && { agentSessionId }),
      });
      await stateRef.manager!.saveProjectState(projectId, {
        projectId,
        sidebarWidth: 350,
        terminals: [codexPane("pane-a", launchedId), codexPane("pane-b")],
      });

      const ledger = main.getLifecycleLedger();
      const generation = ledger.recordLaunch("pane-a", { projectId, launchAgentId: "codex" });
      ledger.recordLaunch("pane-b", { projectId, launchAgentId: "codex" });

      // Main's side of the pty-host bridge.
      const accepted: Array<Promise<string>> = [];
      const off = main.events.on("agent-session:observed", (payload) => {
        accepted.push(main.acceptObservedAgentSession(payload));
      });
      try {
        // The launched run quits to the shell: its farewell is journaled, never
        // written to the pane.
        await expect(
          main.writeBackCapturedSessionId({
            terminalId: "pane-a",
            launchGeneration: null,
            boundary: "demotion",
            run: { launchGeneration: generation, agentIncarnation: 0 },
            record: {
              sessionId: "019a0000-0000-7000-8000-00000000fa7e",
              agentId: "codex",
              worktreeId: null,
              title: "Codex",
              projectId,
              cwd: "/project",
            },
          })
        ).resolves.toBe("ineligible-boundary");

        // The hand-typed resume, as the census reports the npm shim.
        main.offerAgentRunArgvSession(
          "pane-a",
          { launchAgentId: "codex", launchGeneration: generation, projectId, agentIncarnation: 1 },
          { agentType: "codex", command: `node /opt/homebrew/bin/codex resume ${HAND_ID}` }
        );
        expect(accepted).toHaveLength(1);
        await expect(accepted[0]).resolves.toBe(launchedId ? "superseded" : "filled");
      } finally {
        off();
      }

      // The restart: nothing else is written, and the next launch reads disk.
      const reader = new main.ProjectStateManager(dir);
      const persisted = await reader.getProjectState(projectId);
      reader.dispose();
      expect(persisted?.terminals.map((t) => t.agentSessionId)).toEqual([HAND_ID, undefined]);

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
      const handResumed = byPane.get("pane-a");
      expect(handResumed?.agentSessionId).toBe(HAND_ID);
      expect(handResumed?.command).toContain(
        resume
          .args(HAND_ID)
          .map((arg) => quoteLaunchArgOptional(arg))
          .join(" ")
      );
      // An exact id no longer leaves the pane to the folder's resume-latest
      // election, which its sibling used to win.
      expect(handResumed?.command).not.toContain("--last");
      const sibling = byPane.get("pane-b");
      expect(sibling?.agentSessionId).toBeUndefined();
      expect(sibling?.command).not.toContain(HAND_ID);
    }
  );
});
