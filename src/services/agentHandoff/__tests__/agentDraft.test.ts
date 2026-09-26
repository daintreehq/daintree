// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

// The real store graph pulls the whole app in; these are all the module reads,
// and driving them directly keeps the draft contract legible.
const { asStore, panelState, inputState, fleetState, projectState, drafts } = vi.hoisted(() => {
  const drafts = new Map<string, string>();
  return {
    drafts,
    asStore: <S>(state: S) => {
      const hook = (selector: (s: S) => unknown) => selector(state);
      hook.getState = () => state;
      return hook;
    },
    panelState: {
      panelsById: {} as Record<string, unknown>,
      panelIds: [] as string[],
      focusedId: null as string | null,
      backendStatus: "connected" as string,
      pingTerminal: vi.fn<(id: string) => void>(),
    },
    inputState: {
      hybridInputEnabled: true,
      voiceSubmittingPanels: new Set<string>(),
      getDraftInput: vi.fn(
        (id: string, projectId?: string) => drafts.get(`${projectId}:${id}`) ?? ""
      ),
      setDraftInput: vi.fn((id: string, value: string, projectId?: string) => {
        drafts.set(`${projectId}:${id}`, value);
      }),
      bumpExternalDraftRevision: vi.fn(),
    },
    fleetState: { armedIds: new Set<string>() },
    projectState: { currentProject: { id: "proj-1" } as { id: string } | undefined },
  };
});

vi.mock("@/store/panelStore", () => ({ usePanelStore: asStore(panelState) }));
vi.mock("@/store/terminalInputStore", () => ({ useTerminalInputStore: asStore(inputState) }));
vi.mock("@/store/fleetArmingStore", () => ({ useFleetArmingStore: asStore(fleetState) }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: asStore(projectState) }));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: asStore({ showAgentTaskTitles: true }),
}));
vi.mock("@/store/createWorktreeStore", () => ({ getCurrentViewStoreOrNull: () => null }));

const { canDraftAnywhere, draftAgentContext, listAgentPanes } = await import("../agentDraft");
const { useTypingLocatorStore } = await import("@/store/typingLocatorStore");

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
    ...overrides,
  };
}

function setPanels(...panels: PtyPanelData[]): void {
  panelState.panelsById = Object.fromEntries(panels.map((panel) => [panel.id, panel]));
  panelState.panelIds = panels.map((panel) => panel.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  drafts.clear();
  setPanels();
  panelState.backendStatus = "connected";
  inputState.hybridInputEnabled = true;
  fleetState.armedIds = new Set();
  useTypingLocatorStore.setState({ message: null, revision: 0 });
});

describe("draftAgentContext", () => {
  it("drafts the block into an empty draft without submitting anything", () => {
    setPanels(agentPanel("a"));
    const result = draftAgentContext("a", {
      text: "Card body",
      title: "Card",
      sourceLabel: "Kanban",
    });

    expect(result).toEqual({ status: "drafted", terminalId: "a" });
    expect(drafts.get("proj-1:a")).toBe("```\nKanban: Card\n\nCard body\n```\n");
    expect(inputState.bumpExternalDraftRevision).toHaveBeenCalledTimes(1);
    expect(panelState.pingTerminal).toHaveBeenCalledWith("a");
    expect(useTypingLocatorStore.getState().message?.kind).toBe("draft-added");
  });

  it("appends below what the user already typed rather than replacing it", () => {
    setPanels(agentPanel("a"));
    drafts.set("proj-1:a", "please review this");
    draftAgentContext("a", { text: "first" });
    draftAgentContext("a", { text: "second" });

    expect(drafts.get("proj-1:a")).toBe(
      "please review this\n\n```\nfirst\n```\n\n```\nsecond\n```\n"
    );
  });

  it("refuses with the reason, writes nothing, and says so", () => {
    setPanels(agentPanel("a", { isInputLocked: true }));
    const result = draftAgentContext("a", { text: "body" });

    expect(result).toEqual({ status: "refused", reason: "input-locked" });
    expect(inputState.setDraftInput).not.toHaveBeenCalled();
    expect(inputState.bumpExternalDraftRevision).not.toHaveBeenCalled();
    const message = useTypingLocatorStore.getState().message;
    expect(message?.kind).toBe("draft-refused");
    expect(message?.lead).toContain("locked");
  });

  it("refuses a plain shell rather than typing into it", () => {
    setPanels(agentPanel("shell", { launchAgentId: undefined }));
    expect(draftAgentContext("shell", { text: "rm -rf /" })).toEqual({
      status: "refused",
      reason: "not-agent",
    });
    expect(inputState.setDraftInput).not.toHaveBeenCalled();
  });

  it("drafts into a working agent — the draft waits for the user either way", () => {
    setPanels(agentPanel("a", { agentState: "working" }));
    expect(draftAgentContext("a", { text: "body" }).status).toBe("drafted");
  });

  it("keeps the user's trailing whitespace exactly", () => {
    setPanels(agentPanel("a"));
    drafts.set("proj-1:a", "note  \n\n\n");
    draftAgentContext("a", { text: "body" });
    expect(drafts.get("proj-1:a")).toBe("note  \n\n\n```\nbody\n```\n");
  });
});

describe("canDraftAnywhere", () => {
  it("is false while the input bar is off or the terminal service is down", () => {
    expect(canDraftAnywhere()).toBe(true);
    inputState.hybridInputEnabled = false;
    expect(canDraftAnywhere()).toBe(false);
    inputState.hybridInputEnabled = true;
    panelState.backendStatus = "recovering";
    expect(canDraftAnywhere()).toBe(false);
  });
});

describe("listAgentPanes", () => {
  it("reports only this view's agents", () => {
    setPanels(agentPanel("a"), agentPanel("shell", { launchAgentId: undefined }));
    expect(listAgentPanes().map((pane) => pane.terminalId)).toEqual(["a"]);
  });
});
