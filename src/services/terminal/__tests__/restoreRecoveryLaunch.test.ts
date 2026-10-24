import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

const storeState = vi.hoisted(() => ({
  panelsById: {} as Record<string, PanelInstance>,
  panelIds: [] as string[],
  addPanel: vi.fn(async (_options: AddPanelOptions): Promise<string | null> => null),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => storeState },
}));

vi.mock("@/services/agentResume", () => ({
  reconcileResumeLaunchFlags: (session: { agentLaunchFlags?: string[] }) =>
    session.agentLaunchFlags ?? [],
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

const reconcileMovedPanel = vi.hoisted(() => vi.fn());
vi.mock("@/services/terminal/crossWorktreeMove", () => ({ reconcileMovedPanel }));

const resolvedCli = vi.hoisted((): { path: string | undefined } => ({ path: undefined }));

vi.mock("@/utils/agentLaunchCommand", () => ({
  getCurrentLaunchCliDetail: async () => undefined,
  resolveAgentLaunchBaseCommand: (registryCommand: string) => resolvedCli.path ?? registryCommand,
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => ({ command: id }),
}));

const {
  buildRestoreRecoveryLaunchOptions,
  getBulkResumeOutcome,
  heldForHostEndIds,
  launchFromRestoreRecovery,
  resumeAllHeldForHostEnd,
  siblingHeldSessionIds,
} = await import("../restoreRecoveryLaunch");

function heldPane(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "pane-a",
    kind: "terminal",
    title: "Task A",
    titleMode: "user",
    location: "grid",
    worktreeId: "/worktrees/task-a",
    cwd: "/worktrees/task-a",
    conversationCwd: "/repo",
    cols: 80,
    rows: 24,
    launchAgentId: "codex",
    command: "codex --model gpt-5",
    agentLaunchFlags: ["--model", "gpt-5"],
    agentModelId: "gpt-5",
    env: { CODEX_HOME: "/profiles/work" },
    restoreRecovery: { reason: "sibling-owns-resume-latest-slot" },
    hasPty: false,
    ...overrides,
  };
}

const NO_INPUTS = { flags: undefined, baseCommand: undefined };

function livePane(id: string, sessionId: string, agentId = "codex"): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    launchAgentId: agentId,
    agentSessionId: sessionId,
  };
}

beforeEach(() => {
  reconcileMovedPanel.mockReset();
  resolvedCli.path = undefined;
  storeState.panelsById = {};
  storeState.panelIds = [];
  storeState.addPanel.mockReset();
  storeState.addPanel.mockImplementation(async (options) => options.requestedId ?? null);
});

describe("buildRestoreRecoveryLaunchOptions (#12434)", () => {
  it("resumes the picked conversation in place, pinned to the destination", () => {
    const options = buildRestoreRecoveryLaunchOptions(
      heldPane(),
      { kind: "resume", sessionId: "sess-1" },
      { flags: ["--model", "gpt-5"], baseCommand: "/opt/bin/codex" }
    );

    expect(options).toMatchObject({
      kind: "terminal",
      requestedId: "pane-a",
      replacesRestoreRecovery: true,
      launchAgentId: "codex",
      cwd: "/worktrees/task-a",
      worktreeId: "/worktrees/task-a",
      agentSessionId: "sess-1",
      conversationCwd: "/repo",
      title: "Task A",
      titleMode: "user",
      location: "grid",
      env: { CODEX_HOME: "/profiles/work" },
      preserveMaximize: true,
    });
    // The probed executable, not the bare registry name the CLI may not be on PATH as.
    expect(options?.command).toBe(`/opt/bin/codex --model 'gpt-5' resume sess-1 -C '.'`);
    expect(options).not.toHaveProperty("restoreRecovery");
  });

  it("starts a new conversation where the pane runs, and forgets the old folder", () => {
    const options = buildRestoreRecoveryLaunchOptions(heldPane(), { kind: "fresh" }, NO_INPUTS);

    expect(options?.cwd).toBe("/worktrees/task-a");
    expect(options?.agentSessionId).toBeUndefined();
    expect(options?.conversationCwd).toBeUndefined();
  });

  it("starts new with the command restore built, preset overrides included", () => {
    // Restore built this with the pane's preset turning bypass off, which the
    // agent-level flag reconciliation handed in here knows nothing about.
    const options = buildRestoreRecoveryLaunchOptions(
      heldPane({ command: "/opt/bin/codex --model gpt-5", agentPresetId: "careful" }),
      { kind: "fresh" },
      {
        flags: ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5"],
        baseCommand: "/opt/bin/codex",
      }
    );

    expect(options?.command).toBe("/opt/bin/codex --model gpt-5");
  });

  // Claude reopens a conversation only in the folder it began in (#13509).
  it("resumes an agent bound to its conversation's folder there, and starts new where it lives", () => {
    const pane = heldPane({
      launchAgentId: "claude",
      command: "claude",
      agentLaunchFlags: undefined,
      env: undefined,
      restoreRecovery: { reason: "resume-deferred", sessionId: "sess-c" },
    });

    const resumed = buildRestoreRecoveryLaunchOptions(
      pane,
      { kind: "resume", sessionId: "sess-c" },
      NO_INPUTS
    );
    const fresh = buildRestoreRecoveryLaunchOptions(pane, { kind: "fresh" }, NO_INPUTS);

    expect(resumed?.cwd).toBe("/repo");
    expect(resumed?.conversationCwd).toBeUndefined();
    expect(resumed?.worktreeId).toBe("/worktrees/task-a");
    expect(fresh?.cwd).toBe("/worktrees/task-a");
  });

  it("launches nothing while the pane still has no destination", () => {
    const pane = heldPane({
      restoreRecovery: { reason: "destination-unavailable", awaitingDestination: true },
    });
    expect(buildRestoreRecoveryLaunchOptions(pane, { kind: "fresh" }, NO_INPUTS)).toBeNull();
  });

  it("launches nothing for a pane that isn't held, or has nowhere to render", () => {
    expect(
      buildRestoreRecoveryLaunchOptions(
        heldPane({ restoreRecovery: undefined }),
        { kind: "fresh" },
        NO_INPUTS
      )
    ).toBeNull();
    expect(
      buildRestoreRecoveryLaunchOptions(
        heldPane({ location: "trash" }),
        { kind: "fresh" },
        NO_INPUTS
      )
    ).toBeNull();
  });
});

describe("buildRestoreRecoveryLaunchOptions — restore provenance and the plugin hold (#14017)", () => {
  const provenance = {
    at: 5_000,
    disposition: "held" as const,
    lastSeen: { agentState: "idle" as const, at: 4_000 },
  };
  const pane = () =>
    heldPane({
      restoreProvenance: provenance,
      lastAgentObservation: { agentState: "idle", at: 4_000 },
      launchedByPluginId: "acme.orchestrator",
      holdOnRestart: true,
      restoreRecovery: { reason: "held-by-plugin" },
    });

  it("leaves the hold as a resume, keeping when restore ran and what it saw", () => {
    const options = buildRestoreRecoveryLaunchOptions(
      pane(),
      { kind: "resume", sessionId: "sess-1" },
      NO_INPUTS
    );

    expect(options?.restoreProvenance).toEqual({ ...provenance, disposition: "resume" });
  });

  it("leaves the hold as a fresh start", () => {
    const options = buildRestoreRecoveryLaunchOptions(pane(), { kind: "fresh" }, NO_INPUTS);

    expect(options?.restoreProvenance).toEqual({ ...provenance, disposition: "fresh" });
  });

  it.each([{ kind: "fresh" as const }, { kind: "resume" as const, sessionId: "sess-1" }])(
    "lets the user's $kind choice clear the plugin's hold, keeping its owner and what was seen",
    (choice) => {
      const options = buildRestoreRecoveryLaunchOptions(pane(), choice, NO_INPUTS);

      expect(options?.holdOnRestart).toBeUndefined();
      expect(options).toMatchObject({
        launchedByPluginId: "acme.orchestrator",
        lastAgentObservation: { agentState: "idle", at: 4_000 },
      });
    }
  );

  it("invents no provenance for a pane that carried none", () => {
    const options = buildRestoreRecoveryLaunchOptions(heldPane(), { kind: "fresh" }, NO_INPUTS);

    expect(options?.restoreProvenance).toBeUndefined();
  });
});

describe("siblingHeldSessionIds", () => {
  it("collects other panes' conversations for the same agent only", () => {
    const held = siblingHeldSessionIds(
      {
        "pane-a": livePane("pane-a", "own"),
        b: livePane("b", "sess-b"),
        c: livePane("c", "sess-c", "claude"),
      },
      "pane-a",
      "codex"
    );
    expect([...held]).toEqual(["sess-b"]);
  });
});

describe("launchFromRestoreRecovery (#12434)", () => {
  it("replaces the held pane under its own id", async () => {
    storeState.panelsById = { "pane-a": heldPane() };

    await expect(launchFromRestoreRecovery("pane-a", { kind: "fresh" })).resolves.toBe("launched");
    expect(storeState.addPanel).toHaveBeenCalledTimes(1);
    expect(storeState.addPanel.mock.calls[0]?.[0]).toMatchObject({
      requestedId: "pane-a",
      replacesRestoreRecovery: true,
    });
  });

  it("raises the move notice when a conversation resumes away from where the pane is filed (#13509)", async () => {
    const claude = {
      launchAgentId: "claude",
      command: "claude",
      agentLaunchFlags: undefined,
      env: undefined,
      restoreRecovery: { reason: "resume-deferred" as const, sessionId: "sess-c" },
    };
    storeState.panelsById = { "pane-a": heldPane(claude) };

    await launchFromRestoreRecovery("pane-a", { kind: "resume", sessionId: "sess-c" });

    expect(storeState.addPanel.mock.calls[0]?.[0].cwd).toBe("/repo");
    expect(reconcileMovedPanel).toHaveBeenCalledWith("pane-a", "/worktrees/task-a");

    reconcileMovedPanel.mockReset();
    storeState.panelsById = { "pane-a": heldPane(claude) };
    await launchFromRestoreRecovery("pane-a", { kind: "fresh" });

    expect(reconcileMovedPanel).not.toHaveBeenCalled();
  });

  it("launches the probed executable", async () => {
    resolvedCli.path = "/opt/bin/codex";
    storeState.panelsById = { "pane-a": heldPane() };

    await launchFromRestoreRecovery("pane-a", { kind: "resume", sessionId: "sess-1" });

    expect(storeState.addPanel.mock.calls[0]?.[0].command).toMatch(/^\/opt\/bin\/codex /);
  });

  it("refuses a conversation a sibling picked up while the list sat open", async () => {
    storeState.panelsById = { "pane-a": heldPane(), b: livePane("b", "sess-1") };

    await expect(
      launchFromRestoreRecovery("pane-a", { kind: "resume", sessionId: "sess-1" })
    ).resolves.toBe("held-elsewhere");
    expect(storeState.addPanel).not.toHaveBeenCalled();
  });

  it("lets only one of two panes picking the same conversation at once open it", async () => {
    storeState.panelsById = {
      "pane-a": heldPane(),
      "pane-b": heldPane({ id: "pane-b" }),
    };
    let release: (id: string) => void = () => {};
    storeState.addPanel.mockImplementationOnce(
      (options) =>
        new Promise<string | null>((resolve) => {
          release = () => resolve(options.requestedId ?? null);
        })
    );

    const first = launchFromRestoreRecovery("pane-a", { kind: "resume", sessionId: "sess-1" });
    const second = launchFromRestoreRecovery("pane-b", { kind: "resume", sessionId: "sess-1" });

    await expect(second).resolves.toBe("held-elsewhere");
    release("pane-a");
    await expect(first).resolves.toBe("launched");
    expect(storeState.addPanel).toHaveBeenCalledTimes(1);
  });

  it("ignores a second click on the same pane while its launch is in flight", async () => {
    storeState.panelsById = { "pane-a": heldPane() };
    let release: () => void = () => {};
    storeState.addPanel.mockImplementationOnce(
      (options) =>
        new Promise<string | null>((resolve) => {
          release = () => resolve(options.requestedId ?? null);
        })
    );

    const first = launchFromRestoreRecovery("pane-a", { kind: "fresh" });
    await expect(launchFromRestoreRecovery("pane-a", { kind: "fresh" })).resolves.toBe(
      "unavailable"
    );
    release();
    await expect(first).resolves.toBe("launched");
    expect(storeState.addPanel).toHaveBeenCalledTimes(1);
  });

  it("reports the store refusing the replacement, e.g. a pane closed mid-flight", async () => {
    storeState.panelsById = { "pane-a": heldPane() };
    storeState.addPanel.mockResolvedValueOnce(null);

    await expect(launchFromRestoreRecovery("pane-a", { kind: "fresh" })).resolves.toBe(
      "unavailable"
    );
  });

  it("does nothing for a pane that isn't held", async () => {
    storeState.panelsById = { "pane-a": livePane("pane-a", "sess-a") };

    await expect(launchFromRestoreRecovery("pane-a", { kind: "fresh" })).resolves.toBe(
      "unavailable"
    );
    expect(storeState.addPanel).not.toHaveBeenCalled();
  });
});

describe("resuming panes an unclean end held (#14382)", () => {
  const hostEnd = { cause: "external-kill" as const, at: 1_000 };
  const hostHeld = (id: string, overrides: Partial<PtyPanelData> = {}) =>
    heldPane({
      id,
      restoreRecovery: { reason: "host-ended-uncleanly", sessionId: `sess-${id}`, hostEnd },
      ...overrides,
    });

  it("names only panes it can resume without a choice, in the view's order", () => {
    const panels: Record<string, PanelInstance> = {
      b: hostHeld("b"),
      a: hostHeld("a"),
      noSession: hostHeld("noSession", {
        restoreRecovery: { reason: "host-ended-uncleanly", hostEnd },
      }),
      noDestination: hostHeld("noDestination", {
        restoreRecovery: {
          reason: "host-ended-uncleanly",
          sessionId: "sess-x",
          awaitingDestination: true,
        },
      }),
      trashed: hostHeld("trashed", { location: "trash" }),
      otherHold: heldPane({ id: "otherHold" }),
      live: livePane("live", "sess-live"),
    };

    expect(
      heldForHostEndIds(panels, [
        "a",
        "noSession",
        "noDestination",
        "trashed",
        "otherHold",
        "live",
        "b",
      ])
    ).toEqual(["a", "b"]);
  });

  it("resumes each one into its own conversation, one after another", async () => {
    storeState.panelsById = {
      a: hostHeld("a"),
      b: hostHeld("b"),
      other: heldPane({ id: "other" }),
    };
    storeState.panelIds = ["a", "other", "b"];

    await expect(resumeAllHeldForHostEnd()).resolves.toEqual(["launched", "launched"]);
    expect(storeState.addPanel.mock.calls.map((call) => call[0])).toMatchObject([
      { requestedId: "a", agentSessionId: "sess-a" },
      { requestedId: "b", agentSessionId: "sess-b" },
    ]);
  });

  it("waits for each launch before starting the next", async () => {
    storeState.panelsById = { a: hostHeld("a"), b: hostHeld("b") };
    storeState.panelIds = ["a", "b"];
    let releaseA: () => void = () => {};
    storeState.addPanel.mockImplementationOnce(
      (options) =>
        new Promise((resolve) => {
          releaseA = () => resolve(options.requestedId ?? null);
        })
    );

    const run = resumeAllHeldForHostEnd();
    await vi.waitFor(() => expect(storeState.addPanel).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storeState.addPanel).toHaveBeenCalledTimes(1);

    releaseA();
    await expect(run).resolves.toEqual(["launched", "launched"]);
  });

  it("leaves what it couldn't start on that pane, and clears it once it starts", async () => {
    storeState.panelsById = {
      a: hostHeld("a"),
      live: livePane("live", "sess-a", "codex"),
    };
    storeState.panelIds = ["a"];

    await expect(resumeAllHeldForHostEnd()).resolves.toEqual(["held-elsewhere"]);
    expect(getBulkResumeOutcome("a")).toBe("held-elsewhere");

    delete storeState.panelsById.live;
    await resumeAllHeldForHostEnd();
    expect(getBulkResumeOutcome("a")).toBeUndefined();
  });

  it("runs once at a time, however many panes offer it", async () => {
    storeState.panelsById = { a: hostHeld("a") };
    storeState.panelIds = ["a"];

    const [first, second] = await Promise.all([
      resumeAllHeldForHostEnd(),
      resumeAllHeldForHostEnd(),
    ]);
    expect(first).toEqual(["launched"]);
    expect(second).toEqual([]);
    expect(storeState.addPanel).toHaveBeenCalledTimes(1);
  });

  it("skips a pane resumed or closed while the others launched", async () => {
    storeState.panelsById = { a: hostHeld("a"), b: hostHeld("b") };
    storeState.panelIds = ["a", "b"];
    storeState.addPanel.mockImplementation(async (options) => {
      delete storeState.panelsById.b;
      return options.requestedId ?? null;
    });

    await expect(resumeAllHeldForHostEnd()).resolves.toEqual(["launched"]);
    expect(storeState.addPanel).toHaveBeenCalledTimes(1);
  });
});
