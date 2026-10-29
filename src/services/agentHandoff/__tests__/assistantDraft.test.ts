// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

// The real store graph pulls the whole app in; these are all the module reads,
// and driving them directly keeps the draft contract legible.
const { asStore, panelState, inputState, helpState, drafts } = vi.hoisted(() => {
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
    helpState: {
      activeSlot: 2,
      slot: { terminalId: "help" as string | null, agentId: "claude" as string | null },
      setActiveSlot: vi.fn<(slot: number) => void>(),
      setOpen: vi.fn<(open: boolean) => void>(),
      requestFocus: vi.fn<() => void>(),
    },
  };
});

vi.mock("@/store/panelStore", () => ({ usePanelStore: asStore(panelState) }));
vi.mock("@/store/terminalInputStore", () => ({ useTerminalInputStore: asStore(inputState) }));
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: asStore({ armedIds: new Set<string>() }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: asStore({ currentProject: { id: "proj-1" } }),
}));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: asStore({ showAgentTaskTitles: true }),
}));
vi.mock("@/store/createWorktreeStore", () => ({ getCurrentViewStoreOrNull: () => null }));
vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: asStore(helpState),
  selectActiveSlot: (state: typeof helpState) => state.slot,
}));

const { draftAssistantContext } = await import("../assistantDraft");
const { useTypingLocatorStore } = await import("@/store/typingLocatorStore");

function assistantPanel(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "help",
    kind: "terminal",
    title: "Claude",
    location: "overlay",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    hasPty: true,
    runtimeStatus: "running",
    launchAgentId: "claude",
    agentState: "working",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  drafts.clear();
  panelState.panelsById = { help: assistantPanel() };
  inputState.hybridInputEnabled = true;
  helpState.slot = { terminalId: "help", agentId: "claude" };
  useTypingLocatorStore.setState({ message: null, revision: 0 });
});

describe("draftAssistantContext", () => {
  it("drafts below what the user typed, submits nothing, and opens on the composer", () => {
    drafts.set("proj-1:help", "what went wrong here?");
    const result = draftAssistantContext({
      text: "Tests failed",
      title: "Terminal output",
      sourceLabel: "Claude: fix auth",
    });

    expect(result).toEqual({ status: "drafted", terminalId: "help" });
    expect(drafts.get("proj-1:help")).toBe(
      "what went wrong here?\n\n```daintree-context\nClaude: fix auth: Terminal output\n\nTests failed\n```\n"
    );
    expect(inputState.bumpExternalDraftRevision).toHaveBeenCalledTimes(1);
    expect(helpState.setOpen).toHaveBeenCalledWith(true);
    expect(helpState.requestFocus).toHaveBeenCalledTimes(1);
    expect(useTypingLocatorStore.getState().message?.kind).toBe("draft-added");
  });

  it("re-selects the session it drafted into, so a global view doesn't cover it", () => {
    draftAssistantContext({ text: "body" });
    expect(helpState.setActiveSlot).toHaveBeenCalledWith(helpState.activeSlot);
  });

  it("refuses with the reason, writes nothing, and leaves the panel alone", () => {
    panelState.panelsById = { help: assistantPanel({ isInputLocked: true }) };
    const result = draftAssistantContext({ text: "body" });

    expect(result).toEqual({ status: "refused", reason: "input-locked" });
    expect(inputState.setDraftInput).not.toHaveBeenCalled();
    expect(helpState.setOpen).not.toHaveBeenCalled();
    expect(helpState.requestFocus).not.toHaveBeenCalled();
    const message = useTypingLocatorStore.getState().message;
    expect(message?.kind).toBe("draft-refused");
    expect(message?.lead).toContain("locked");
  });

  it("refuses when the input bar is off rather than writing behind the terminal", () => {
    inputState.hybridInputEnabled = false;
    expect(draftAssistantContext({ text: "body" })).toEqual({
      status: "refused",
      reason: "input-bar-off",
    });
    expect(inputState.setDraftInput).not.toHaveBeenCalled();
  });

  it("refuses when no session is running", () => {
    helpState.slot = { terminalId: null, agentId: null };
    expect(draftAssistantContext({ text: "body" })).toEqual({
      status: "refused",
      reason: "unknown-terminal",
    });
    expect(inputState.setDraftInput).not.toHaveBeenCalled();
    expect(useTypingLocatorStore.getState().message?.kind).toBe("draft-refused");
  });
});
