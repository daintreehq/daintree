// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types";
import {
  buildAgentPanes,
  pickPreselectedPane,
  resolveDraftRefusal,
  type AgentPaneListInputs,
  type DraftTargetInputs,
} from "../draftTarget";

function agentPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: "Claude",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    hasPty: true,
    runtimeStatus: "running",
    launchAgentId: "claude",
    worktreeId: "wt-main",
    ...overrides,
  };
}

function shellPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return agentPanel(id, { launchAgentId: undefined, title: "zsh", ...overrides });
}

function inputs(
  panels: PanelInstance[],
  overrides: Partial<DraftTargetInputs> = {}
): DraftTargetInputs {
  const panelsById: Record<string, PanelInstance> = {};
  for (const panel of panels) panelsById[panel.id] = panel;
  return {
    panelsById,
    backendStatus: "connected",
    hybridInputEnabled: true,
    voiceSubmittingIds: new Set(),
    armedIds: new Set(),
    ...overrides,
  };
}

function worktree(id: string, name: string, branch?: string): WorktreeSnapshot {
  return { id, worktreeId: id, name, branch, path: `/repo/${name}`, isCurrent: false };
}

function listInputs(
  panels: PanelInstance[],
  overrides: Partial<AgentPaneListInputs> = {}
): AgentPaneListInputs {
  return {
    ...inputs(panels),
    panelIds: panels.map((panel) => panel.id),
    focusedId: null,
    worktrees: new Map([
      ["wt-main", worktree("wt-main", "main", "develop")],
      ["wt-feat", worktree("wt-feat", "feature-login", "feature/login")],
    ]),
    showAgentTaskTitles: true,
    ...overrides,
  };
}

describe("resolveDraftRefusal", () => {
  it("accepts a live grid agent with its input bar available", () => {
    expect(resolveDraftRefusal(inputs([agentPanel("a")]), "a")).toBeNull();
  });

  it.each<[string, PanelInstance[], Partial<DraftTargetInputs>, string]>([
    ["a pane that does not exist", [], {}, "unknown-terminal"],
    ["a trashed pane", [agentPanel("a", { location: "trash" })], {}, "unknown-terminal"],
    ["a plain shell", [shellPanel("a")], {}, "not-agent"],
    [
      "an agent with no built-in input bar",
      [agentPanel("a", { launchAgentId: "acme.custom-agent" })],
      {},
      "not-agent",
    ],
    ["an exited agent", [agentPanel("a", { runtimeStatus: "exited" })], {}, "exited"],
    ["an agent with no PTY", [agentPanel("a", { hasPty: false })], {}, "exited"],
    ["a docked agent", [agentPanel("a", { location: "dock" })], {}, "not-in-grid"],
    [
      "the input bar switched off",
      [agentPanel("a")],
      { hybridInputEnabled: false },
      "input-bar-off",
    ],
    [
      "a disconnected backend",
      [agentPanel("a")],
      { backendStatus: "disconnected" },
      "backend-unavailable",
    ],
    ["a locked input", [agentPanel("a", { isInputLocked: true })], {}, "input-locked"],
    ["a restarting pane", [agentPanel("a", { isRestarting: true })], {}, "restarting"],
    [
      "a dictation about to submit",
      [agentPanel("a")],
      { voiceSubmittingIds: new Set(["a"]) },
      "input-busy",
    ],
    [
      "an agent armed in a live broadcast",
      [agentPanel("a"), agentPanel("b")],
      { armedIds: new Set(["a", "b"]) },
      "fleet-armed",
    ],
  ])("refuses %s", (_name, panels, overrides, reason) => {
    expect(resolveDraftRefusal(inputs(panels, overrides), "a")).toBe(reason);
  });

  it("does not refuse an unarmed agent while other agents broadcast", () => {
    const state = inputs([agentPanel("a"), agentPanel("b"), agentPanel("c")], {
      armedIds: new Set(["b", "c"]),
    });
    expect(resolveDraftRefusal(state, "a")).toBeNull();
  });

  it("names the most permanent reason when several apply", () => {
    const panel = shellPanel("a", { location: "dock", isInputLocked: true });
    expect(resolveDraftRefusal(inputs([panel], { hybridInputEnabled: false }), "a")).toBe(
      "not-agent"
    );
  });
});

describe("buildAgentPanes", () => {
  it("lists agents with their worktree, observed state and draftability", () => {
    const panes = buildAgentPanes(
      listInputs(
        [
          agentPanel("a", { agentState: "working" }),
          agentPanel("b", { worktreeId: "wt-feat", isInputLocked: true }),
        ],
        { focusedId: "a" }
      )
    );
    expect(panes).toEqual([
      expect.objectContaining({
        terminalId: "a",
        agentId: "claude",
        worktree: { id: "wt-main", name: "main", branch: "develop" },
        observedState: "working",
        isFocused: true,
        canDraft: true,
      }),
      expect.objectContaining({
        terminalId: "b",
        worktree: { id: "wt-feat", name: "feature-login", branch: "feature/login" },
        isFocused: false,
        canDraft: false,
        draftRefusal: "input-locked",
      }),
    ]);
    expect(panes[0]).not.toHaveProperty("draftRefusal");
  });

  it("leaves out shells, exited and demoted agents, and the trash", () => {
    const panes = buildAgentPanes(
      listInputs([
        shellPanel("shell"),
        agentPanel("exited", { runtimeStatus: "exited" }),
        agentPanel("gone", { hasPty: false }),
        agentPanel("demoted", { everDetectedAgent: true }),
        agentPanel("trashed", { location: "trash" }),
        agentPanel("live"),
      ])
    );
    expect(panes.map((pane) => pane.terminalId)).toEqual(["live"]);
  });

  it("lists a docked agent, but as one that cannot take a draft", () => {
    const [pane] = buildAgentPanes(listInputs([agentPanel("docked", { location: "dock" })]));
    expect(pane).toMatchObject({ canDraft: false, draftRefusal: "not-in-grid" });
  });

  it("reports a pane with no worktree as such", () => {
    const [pane] = buildAgentPanes(listInputs([agentPanel("a", { worktreeId: undefined })]));
    expect(pane!.worktree).toBeNull();
  });
});

describe("pickPreselectedPane", () => {
  const panes = buildAgentPanes(
    listInputs(
      [
        agentPanel("main-1"),
        agentPanel("feat-locked", { worktreeId: "wt-feat", isInputLocked: true }),
        agentPanel("feat-1", { worktreeId: "wt-feat" }),
        agentPanel("feat-2", { worktreeId: "wt-feat" }),
      ],
      { focusedId: "main-1" }
    )
  );

  it("prefers a draftable agent in the requested worktree over the focused one", () => {
    expect(pickPreselectedPane(panes, "wt-feat")?.terminalId).toBe("feat-1");
  });

  it("falls back to the focused agent when the worktree has none that can draft", () => {
    expect(pickPreselectedPane(panes, "wt-empty")?.terminalId).toBe("main-1");
    expect(pickPreselectedPane(panes, undefined)?.terminalId).toBe("main-1");
  });

  it("prefers the focused agent within the requested worktree", () => {
    const focusedInFeat = panes.map((pane) => ({
      ...pane,
      isFocused: pane.terminalId === "feat-2",
    }));
    expect(pickPreselectedPane(focusedInFeat, "wt-feat")?.terminalId).toBe("feat-2");
  });

  it("preselects nothing when nothing fits", () => {
    const unfocused = panes.map((pane) => ({ ...pane, isFocused: false }));
    expect(pickPreselectedPane(unfocused, undefined)).toBeNull();
  });
});
