import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";

const shared = vi.hoisted(() => ({
  hosts: ["Studio 1", "Studio 2"] as string[],
  hostsError: null as Error | null,
  remoteHostsRegistered: true,
}));

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getProjectById: vi.fn((id: string) =>
      id === "proj-a" ? { id, name: "Daintree", path: "/repo/daintree" } : null
    ),
    getProjectSummaries: vi.fn(() => [
      { id: "proj-a", name: "Daintree", path: "/repo/daintree", emoji: "" },
      { id: "proj-b", name: "Plugin SDK", path: "/repo/sdk", emoji: "" },
    ]),
  },
}));

vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));

vi.mock("../../remote/runtime.js", () => ({
  getRemoteService: (key: string) => {
    if (key !== "remoteHostsClient" || !shared.remoteHostsRegistered) return undefined;
    return {
      list: () => {
        if (shared.hostsError) throw shared.hostsError;
        return shared.hosts.map((name) => ({ descriptor: { name } }));
      },
    };
  },
}));

import { gatherDictationNames, NO_DICTATION_NAMES } from "../voiceContextNames.js";
import { screenDictationNames } from "../voiceContextKeyterms.js";

const ASSISTANT = "assistant-1";
const GRID = "grid-1";
const ELSEWHERE = "grid-other";
const SHELL = "shell-1";
const EXITED_AGENT = "exited-agent-1";

function makePtyClient() {
  const owners: Record<string, string> = {
    [ASSISTANT]: "proj-a",
    [GRID]: "proj-a",
    [ELSEWHERE]: "proj-b",
    [SHELL]: "proj-a",
    [EXITED_AGENT]: "proj-a",
  };
  const records: Record<string, object> = {
    [GRID]: { detectedAgentId: "claude" },
    [ELSEWHERE]: { detectedAgentId: "claude" },
    [EXITED_AGENT]: { launchAgentId: "claude", agentState: "exited" },
  };
  return {
    hasTerminal: vi.fn((id: string) => id in owners),
    getTerminalProjectId: vi.fn((id: string) => owners[id] ?? null),
    getTerminalAsync: vi.fn(async (id: string) =>
      id in owners ? { id, isAssistantTerminal: id === ASSISTANT, ...records[id] } : null
    ),
  };
}

function makeWorktreeService(
  worktrees: Array<{ name: string; isMainWorktree?: boolean }> = [
    { name: "daintree", isMainWorktree: true },
    { name: "billing" },
    { name: "payments" },
  ]
) {
  return {
    getAllStatesForProjectAsync: vi.fn(async () => worktrees),
  };
}

function gather(
  terminalId: string | undefined,
  overrides: { ptyClient?: unknown; worktreeService?: unknown; projectId?: string | null } = {}
) {
  return gatherDictationNames({
    projectId: overrides.projectId === undefined ? "proj-a" : overrides.projectId,
    terminalId,
    ptyClient: (overrides.ptyClient ?? makePtyClient()) as PtyClient,
    worktreeService: (overrides.worktreeService ?? makeWorktreeService()) as WorkspaceClient,
  });
}

describe("gatherDictationNames", () => {
  beforeEach(() => {
    shared.hosts = ["Studio 1", "Studio 2"];
    shared.hostsError = null;
    shared.remoteHostsRegistered = true;
  });

  it("gives the Assistant the paired hosts, every project and the project's worktrees", async () => {
    await expect(gather(ASSISTANT)).resolves.toEqual({
      hosts: ["Studio 1", "Studio 2"],
      projects: ["Daintree", "Plugin SDK"],
      worktrees: ["billing", "payments"],
    });
  });

  it("gives an agent pane the hosts, its other projects and its worktrees", async () => {
    const worktreeService = makeWorktreeService();
    await expect(gather(GRID, { worktreeService })).resolves.toEqual({
      hosts: ["Studio 1", "Studio 2"],
      projects: ["Plugin SDK"],
      worktrees: ["billing", "payments"],
    });
    expect(worktreeService.getAllStatesForProjectAsync).toHaveBeenCalledWith(
      "/repo/daintree",
      "proj-a"
    );
  });

  it("gives a plain shell or an exited agent only its worktrees", async () => {
    for (const id of [SHELL, EXITED_AGENT]) {
      await expect(gather(id)).resolves.toEqual({
        hosts: [],
        projects: [],
        worktrees: ["billing", "payments"],
      });
    }
  });

  it("keeps the projects in the order the store ranks them, not alphabetically", async () => {
    const store = (await import("../ProjectStore.js")).projectStore;
    vi.mocked(store.getProjectSummaries).mockReturnValueOnce([
      { id: "proj-c", name: "Zephyr", path: "/repo/z", emoji: "" },
      { id: "proj-a", name: "Daintree", path: "/repo/daintree", emoji: "" },
      { id: "proj-b", name: "Plugin SDK", path: "/repo/sdk", emoji: "" },
      { id: "proj-d", name: "CandidCue", path: "/repo/cue", emoji: "" },
    ]);
    const names = await gather(GRID);
    expect(names.projects).toEqual(["Zephyr", "Plugin SDK", "CandidCue"]);
  });

  it("leaves an agent pane its worktrees when the hosts can't be read", async () => {
    shared.hostsError = new Error("registry gone");
    await expect(gather(GRID)).resolves.toEqual({
      hosts: [],
      projects: [],
      worktrees: ["billing", "payments"],
    });
  });

  it("leaves an agent pane its worktrees when the projects can't be read", async () => {
    const store = (await import("../ProjectStore.js")).projectStore;
    vi.mocked(store.getProjectSummaries).mockImplementationOnce(() => {
      throw new Error("db gone");
    });
    await expect(gather(GRID)).resolves.toEqual({
      hosts: [],
      projects: [],
      worktrees: ["billing", "payments"],
    });
  });

  it("leaves out the main worktree, which is the project itself", async () => {
    const names = await gather(GRID);
    expect(names.worktrees).not.toContain("daintree");
  });

  it("gives nothing for a terminal another project owns than the view asking", async () => {
    await expect(gather(ELSEWHERE)).resolves.toBe(NO_DICTATION_NAMES);
  });

  it("gives nothing without a target, or for a terminal main doesn't track", async () => {
    await expect(gather(undefined)).resolves.toBe(NO_DICTATION_NAMES);
    await expect(gather("t-gone")).resolves.toBe(NO_DICTATION_NAMES);
    await expect(gatherDictationNames({ projectId: "proj-a", terminalId: GRID })).resolves.toBe(
      NO_DICTATION_NAMES
    );
  });

  it("reads no worktrees for a project it can't find, or without the workspace service", async () => {
    const ptyClient = makePtyClient();
    ptyClient.getTerminalProjectId.mockReturnValue("proj-gone");
    const worktreeService = makeWorktreeService();
    await expect(
      gather(GRID, { ptyClient, worktreeService, projectId: "proj-gone" })
    ).resolves.toEqual({
      hosts: ["Studio 1", "Studio 2"],
      projects: ["Daintree", "Plugin SDK"],
      worktrees: [],
    });
    expect(worktreeService.getAllStatesForProjectAsync).not.toHaveBeenCalled();

    await expect(
      gatherDictationNames({
        projectId: "proj-a",
        terminalId: GRID,
        ptyClient: makePtyClient() as unknown as PtyClient,
      })
    ).resolves.toEqual({
      hosts: ["Studio 1", "Studio 2"],
      projects: ["Plugin SDK"],
      worktrees: [],
    });
  });

  it("keeps the other names when the worktree read fails", async () => {
    const worktreeService = {
      getAllStatesForProjectAsync: vi.fn(async () => {
        throw new Error("workspace host gone");
      }),
    };
    await expect(gather(ASSISTANT, { worktreeService })).resolves.toEqual({
      hosts: ["Studio 1", "Studio 2"],
      projects: ["Daintree", "Plugin SDK"],
      worktrees: [],
    });
  });

  it("gives nothing when the host list throws", async () => {
    shared.hostsError = new Error("registry gone");
    await expect(gather(ASSISTANT)).resolves.toBe(NO_DICTATION_NAMES);
  });

  it("gives the Assistant no hosts when Remote Hosts isn't running", async () => {
    shared.remoteHostsRegistered = false;
    const names = await gather(ASSISTANT);
    expect(names.hosts).toEqual([]);
    expect(names.projects).toEqual(["Daintree", "Plugin SDK"]);
  });

  it("treats a terminal it can't read as an ordinary one", async () => {
    const ptyClient = makePtyClient();
    ptyClient.getTerminalAsync.mockRejectedValue(new Error("pty host gone"));
    await expect(gather(ASSISTANT, { ptyClient })).resolves.toEqual({
      hosts: [],
      projects: [],
      worktrees: ["billing", "payments"],
    });
  });

  it("collects names the screen then dedupes, caps and clears of secrets", async () => {
    shared.hosts = ["Studio 1", "studio 1", `ghp_${"a1B2".repeat(9)}`];
    const worktreeService = makeWorktreeService(
      Array.from({ length: 12 }, (_, i) => ({ name: `feature-${i + 1}` }))
    );
    const screened = screenDictationNames(await gather(ASSISTANT, { worktreeService }));
    expect(screened).toEqual({
      hosts: ["Studio 1"],
      projects: ["Daintree", "Plugin SDK"],
      worktrees: ["feature-1", "feature-2", "feature-3", "feature-4", "feature-5"],
    });
  });
});
