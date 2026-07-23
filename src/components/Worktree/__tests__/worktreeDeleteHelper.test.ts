import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildResumeCommandMock } = vi.hoisted(() => ({
  buildResumeCommandMock:
    vi.fn<
      (agentId: string, sessionId: string, flags?: string[], base?: string) => string | undefined
    >(),
}));

const removePanelMock = vi.fn<(id: string) => void>();
const addPanelMock = vi.fn<(options: unknown) => Promise<string | null>>();

interface MockPanelState {
  panelIds: string[];
  panelsById: Record<string, unknown>;
  removePanel: typeof removePanelMock;
  addPanel: typeof addPanelMock;
}
let mockState: MockPanelState;

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => mockState },
}));

vi.mock("@shared/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/types")>();
  return { ...actual, buildResumeCommand: buildResumeCommandMock };
});

vi.mock("@/utils/logger", () => ({
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  captureWorktreeTerminalSnapshot,
  closeTerminalsForWorktree,
  restoreClosedTerminals,
  getLiveTerminalIdsForWorktree,
} from "@/components/Worktree/worktreeDeleteHelper";

const getInfoMock = vi.fn<(id: string) => Promise<{ hasPty: boolean }>>();
(globalThis as Record<string, unknown>).window = globalThis.window ?? {};
(window as unknown as Record<string, unknown>).electron = {
  ...((window as unknown as Record<string, unknown>).electron ?? {}),
  terminal: { getInfo: getInfoMock },
};

function ptyPanel(overrides: Record<string, unknown>): Record<string, unknown> {
  return { kind: "terminal", worktreeId: "wt-1", location: "grid", ...overrides };
}

function seed(panels: Array<Record<string, unknown>>): void {
  mockState.panelIds = panels.map((p) => p.id as string);
  mockState.panelsById = Object.fromEntries(panels.map((p) => [p.id as string, p]));
}

beforeEach(() => {
  removePanelMock.mockReset();
  addPanelMock.mockReset().mockResolvedValue("ok");
  buildResumeCommandMock.mockReset();
  // `waitForTerminalsToClose` treats a terminal as closed only once `getInfo`
  // rejects (the backend has fully forgotten it) — `hasPty: false` alone is
  // deliberately insufficient (the Windows cwd-lock window). Reject to simulate
  // a fully torn-down terminal so the wait loop resolves immediately.
  getInfoMock.mockReset().mockRejectedValue(new Error("terminal gone"));
  mockState = {
    panelIds: [],
    panelsById: {},
    removePanel: removePanelMock,
    addPanel: addPanelMock,
  };
});

describe("getLiveTerminalIdsForWorktree", () => {
  it("returns the worktree's live panels — excludes trash, other worktrees, and ephemeral PTYs", () => {
    seed([
      ptyPanel({ id: "keep" }),
      ptyPanel({ id: "other-wt", worktreeId: "wt-2" }),
      ptyPanel({ id: "trashed", location: "trash" }),
      ptyPanel({ id: "ephemeral", excludeFromPersistence: true }),
      // Non-PTY panels are still closed with the worktree (unchanged behavior);
      // only the rollback snapshot is terminal-only.
      { id: "browser", kind: "browser", worktreeId: "wt-1", location: "grid" },
    ]);
    expect(getLiveTerminalIdsForWorktree("wt-1")).toEqual(["keep", "browser"]);
  });
});

describe("captureWorktreeTerminalSnapshot", () => {
  it("snapshots each live PTY terminal's relaunch metadata without mutating anything", () => {
    seed([
      ptyPanel({ id: "plain", cwd: "/repo/wt", title: "bash" }),
      ptyPanel({
        id: "agent",
        cwd: "/repo/wt",
        title: "claude",
        titleMode: "pinned",
        launchAgentId: "claude",
        agentSessionId: "sess-1",
        agentLaunchFlags: ["--model", "opus"],
        agentModelId: "opus",
        agentPresetId: "preset-a",
        command: "claude",
        location: "dock",
      }),
      { id: "browser", kind: "browser", worktreeId: "wt-1", location: "grid" },
    ]);

    const snapshot = captureWorktreeTerminalSnapshot("wt-1");

    expect(removePanelMock).not.toHaveBeenCalled();
    // The browser panel is not a terminal — it is not snapshotted.
    expect(snapshot.map((s) => s.id)).toEqual(["plain", "agent"]);
    expect(snapshot[0]).toMatchObject({ id: "plain", cwd: "/repo/wt", location: "grid" });
    expect(snapshot[1]).toMatchObject({
      id: "agent",
      title: "claude",
      titleMode: "pinned",
      launchAgentId: "claude",
      agentSessionId: "sess-1",
      agentLaunchFlags: ["--model", "opus"],
      agentModelId: "opus",
      agentPresetId: "preset-a",
      command: "claude",
      location: "dock",
    });
  });

  it("returns an empty snapshot when the worktree has no terminals", () => {
    seed([ptyPanel({ id: "other", worktreeId: "wt-2" })]);
    expect(captureWorktreeTerminalSnapshot("wt-1")).toEqual([]);
  });
});

describe("closeTerminalsForWorktree", () => {
  it("hard-removes each of the worktree's live panels and waits for close", async () => {
    seed([
      ptyPanel({ id: "plain" }),
      ptyPanel({ id: "agent", launchAgentId: "claude" }),
      { id: "browser", kind: "browser", worktreeId: "wt-1", location: "grid" },
    ]);

    await closeTerminalsForWorktree("wt-1");

    expect(removePanelMock.mock.calls.map((c) => c[0])).toEqual(["plain", "agent", "browser"]);
    expect(getInfoMock).toHaveBeenCalled();
  });

  it("does nothing when the worktree has no panels", async () => {
    seed([ptyPanel({ id: "other", worktreeId: "wt-2" })]);
    await closeTerminalsForWorktree("wt-1");
    expect(removePanelMock).not.toHaveBeenCalled();
  });
});

describe("restoreClosedTerminals", () => {
  it("relaunches with a resume command for a resume-capable agent session", async () => {
    buildResumeCommandMock.mockReturnValue("claude --resume sess-1");

    await restoreClosedTerminals([
      {
        id: "agent",
        worktreeId: "wt-1",
        cwd: "/repo/wt",
        location: "grid",
        command: "claude",
        launchAgentId: "claude",
        agentLaunchFlags: ["--flag"],
        agentSessionId: "sess-1",
      },
    ]);

    expect(buildResumeCommandMock).toHaveBeenCalledWith("claude", "sess-1", ["--flag"]);
    expect(addPanelMock).toHaveBeenCalledTimes(1);
    expect(addPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedId: "agent",
        kind: "terminal",
        worktreeId: "wt-1",
        cwd: "/repo/wt",
        command: "claude --resume sess-1",
        launchAgentId: "claude",
        bypassLimits: true,
        focusPolicy: "preserve",
      })
    );
  });

  it("falls back to the stored launch command when there is no session id", async () => {
    await restoreClosedTerminals([
      { id: "agent", location: "grid", command: "claude", launchAgentId: "claude" },
    ]);
    expect(buildResumeCommandMock).not.toHaveBeenCalled();
    expect(addPanelMock).toHaveBeenCalledWith(expect.objectContaining({ command: "claude" }));
  });

  it("falls back to the stored command when the agent has a session but no resume support", async () => {
    // buildResumeCommand returns undefined for agents without resume support.
    buildResumeCommandMock.mockReturnValue(undefined);
    await restoreClosedTerminals([
      {
        id: "agent",
        location: "grid",
        command: "codex",
        launchAgentId: "codex",
        agentSessionId: "sess-9",
      },
    ]);
    expect(buildResumeCommandMock).toHaveBeenCalledWith("codex", "sess-9", undefined);
    expect(addPanelMock).toHaveBeenCalledWith(expect.objectContaining({ command: "codex" }));
  });

  it("relaunches a plain terminal with its stored command and never builds a resume command", async () => {
    await restoreClosedTerminals([{ id: "plain", location: "grid", command: undefined }]);
    expect(buildResumeCommandMock).not.toHaveBeenCalled();
    expect(addPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestedId: "plain", command: undefined })
    );
  });

  it("is best-effort: a failed relaunch does not abort the rest", async () => {
    addPanelMock.mockRejectedValueOnce(new Error("spawn failed")).mockResolvedValue("ok");
    await expect(
      restoreClosedTerminals([
        { id: "a", location: "grid" },
        { id: "b", location: "grid" },
      ])
    ).resolves.toBeUndefined();
    expect(addPanelMock).toHaveBeenCalledTimes(2);
  });

  it("no-ops on an empty snapshot", async () => {
    await restoreClosedTerminals([]);
    expect(addPanelMock).not.toHaveBeenCalled();
  });
});
