import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

const storeState = vi.hoisted(() => ({
  panelsById: {} as Record<string, PanelInstance>,
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

const { buildRestoreRecoveryLaunchOptions, launchFromRestoreRecovery, siblingHeldSessionIds } =
  await import("../restoreRecoveryLaunch");

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
  storeState.panelsById = {};
  storeState.addPanel.mockReset();
  storeState.addPanel.mockImplementation(async (options) => options.requestedId ?? null);
});

describe("buildRestoreRecoveryLaunchOptions (#12434)", () => {
  it("resumes the picked conversation in place, pinned to the destination", () => {
    const options = buildRestoreRecoveryLaunchOptions(
      heldPane(),
      { kind: "resume", sessionId: "sess-1" },
      ["--model", "gpt-5"]
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
    expect(options?.command).toBe("codex --model 'gpt-5' resume sess-1 -C '.'");
    expect(options).not.toHaveProperty("restoreRecovery");
  });

  it("starts a new conversation where the pane runs, and forgets the old folder", () => {
    const options = buildRestoreRecoveryLaunchOptions(heldPane(), { kind: "fresh" }, undefined);

    expect(options?.command).toBe("codex --model gpt-5");
    expect(options?.cwd).toBe("/worktrees/task-a");
    expect(options?.agentSessionId).toBeUndefined();
    expect(options?.conversationCwd).toBeUndefined();
  });

  it("launches nothing while the pane still has no destination", () => {
    const pane = heldPane({
      restoreRecovery: { reason: "destination-unavailable", awaitingDestination: true },
    });
    expect(buildRestoreRecoveryLaunchOptions(pane, { kind: "fresh" }, undefined)).toBeNull();
  });

  it("launches nothing for a pane that isn't held, or has nowhere to render", () => {
    expect(
      buildRestoreRecoveryLaunchOptions(
        heldPane({ restoreRecovery: undefined }),
        { kind: "fresh" },
        undefined
      )
    ).toBeNull();
    expect(
      buildRestoreRecoveryLaunchOptions(
        heldPane({ location: "trash" }),
        { kind: "fresh" },
        undefined
      )
    ).toBeNull();
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
