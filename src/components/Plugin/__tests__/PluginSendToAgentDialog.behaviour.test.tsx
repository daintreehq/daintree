// @vitest-environment jsdom
/**
 * The `host.sendToAgent` picker: what it opens on, what Enter does with it, and
 * the two ways to start an agent for the handoff. The draft and launch paths
 * are their own suites; here they are the seams the picker hands off to.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useEscapeStack: () => {}, useOverlayState: () => {} };
});
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/store/paletteStore", () => {
  const usePaletteStore = (selector?: (s: { activePaletteId: null }) => unknown) =>
    selector ? selector({ activePaletteId: null }) : { activePaletteId: null };
  usePaletteStore.getState = () => ({ activePaletteId: null });
  return { usePaletteStore };
});

const { panelState, asStore } = vi.hoisted(() => ({
  asStore: <S,>(state: S) => {
    const hook = (selector: (s: S) => unknown) => selector(state);
    hook.getState = () => state;
    return hook;
  },
  panelState: {
    panelsById: {} as Record<string, unknown>,
    panelIds: [] as string[],
    focusedId: null as string | null,
  },
}));
vi.mock("@/store/panelStore", () => ({ usePanelStore: asStore(panelState) }));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: asStore({ showAgentTaskTitles: true }),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: asStore({ activeWorktreeId: "wt-main" }),
}));
vi.mock("@/store/agentPreferencesStore", () => ({
  useAgentPreferencesStore: asStore({ defaultAgent: "claude" }),
}));
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: asStore({ availability: {}, isInitialized: true }),
}));
vi.mock("@/lib/resolveAgentId", () => ({ getDefaultAgentId: () => "claude" }));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: () =>
    new Map([
      ["wt-main", { id: "wt-main", name: "main" }],
      ["wt-feat", { id: "wt-feat", name: "feature-login" }],
    ]),
}));

const { draftAgentContext, launchAgentForHandoff } = vi.hoisted(() => ({
  draftAgentContext: vi.fn((terminalId: string) => ({ status: "drafted", terminalId })),
  launchAgentForHandoff: vi.fn(async () => ({ status: "drafted", terminalId: "new" })),
}));
vi.mock("@/services/agentHandoff/agentDraft", () => ({
  draftAgentContext,
  readDraftTargetInputs: () => ({
    panelsById: panelState.panelsById,
    backendStatus: "connected",
    hybridInputEnabled: true,
    voiceSubmittingIds: new Set(),
    armedIds: new Set(),
  }),
}));
vi.mock("@/services/agentHandoff/launchForHandoff", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  launchAgentForHandoff,
}));

import { PluginSendToAgentDialog } from "../PluginSendToAgentDialog";
import { usePluginPromptStore } from "@/store/pluginPromptStore";
import type { PluginSendToAgentRequest } from "@shared/types/pluginUiPrompt";

function agentPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
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

function setPanels(...panels: PtyPanelData[]): void {
  panelState.panelsById = Object.fromEntries(panels.map((panel) => [panel.id, panel]));
  panelState.panelIds = panels.map((panel) => panel.id);
}

const REQUEST: PluginSendToAgentRequest = {
  text: "Card body",
  title: "Fix login redirect",
  sourceLabel: "Acme Board",
  worktreeId: "wt-feat",
};

function open(request: PluginSendToAgentRequest = REQUEST) {
  const resolve = vi.fn();
  usePluginPromptStore.setState({
    queue: [],
    current: {
      promptId: "p1",
      pluginId: "acme",
      params: { kind: "sendToAgent", request },
      resolve,
    },
  });
  render(<PluginSendToAgentDialog />);
  return resolve;
}

function combobox(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
  if (!input) throw new Error("no combobox rendered");
  return input;
}

function selectedOption(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
}

function option(id: string): HTMLElement {
  const el = document.getElementById(`plugin-send-to-agent-${id}`);
  if (!el) throw new Error(`no option ${id}`);
  return el;
}

function press(key: string): void {
  act(() => {
    fireEvent.keyDown(combobox(), { key });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  panelState.focusedId = "main-1";
  setPanels(
    agentPanel("main-1"),
    agentPanel("feat-1", { worktreeId: "wt-feat" }),
    agentPanel("feat-locked", { worktreeId: "wt-feat", isInputLocked: true })
  );
});

afterEach(() => {
  cleanup();
  usePluginPromptStore.getState().reset();
});

describe("PluginSendToAgentDialog", () => {
  it("opens on an agent in the worktree the plugin named, over the focused one", () => {
    open();
    expect(selectedOption()?.id).toBe("plugin-send-to-agent-feat-1");
  });

  it("opens on the focused agent when the plugin named no worktree", () => {
    open({ ...REQUEST, worktreeId: undefined });
    expect(selectedOption()?.id).toBe("plugin-send-to-agent-main-1");
  });

  it("drafts into the chosen agent on Enter and answers the plugin with the result", () => {
    const resolve = open();
    press("Enter");
    expect(draftAgentContext).toHaveBeenCalledWith("feat-1", REQUEST);
    expect(resolve).toHaveBeenCalledWith({ status: "drafted", terminalId: "feat-1" });
  });

  it("shows an agent that cannot take a draft, disabled, with the reason", () => {
    open();
    const locked = option("feat-locked");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(locked.textContent).toContain("Input locked");
    act(() => {
      fireEvent.click(locked);
    });
    expect(draftAgentContext).not.toHaveBeenCalled();
  });

  it("starts a new agent in the named worktree from New agent here", () => {
    const resolve = open();
    act(() => {
      fireEvent.click(option("new-here"));
    });
    expect(launchAgentForHandoff).toHaveBeenCalledWith(
      "claude",
      { kind: "existing-worktree", worktreeId: "wt-feat" },
      REQUEST
    );
    // Closes now; the plugin's answer is the draft that lands once it is up.
    expect(resolve.mock.calls[0]![0]).toBeInstanceOf(Promise);
  });

  it("asks for a branch, prefilled from the title, before creating a worktree", () => {
    open();
    act(() => {
      fireEvent.click(option("new-worktree"));
    });
    expect(combobox().value).toBe("fix-login-redirect");
    expect(launchAgentForHandoff).not.toHaveBeenCalled();

    act(() => {
      fireEvent.change(combobox(), { target: { value: "feature/login-fix" } });
    });
    press("Enter");
    expect(launchAgentForHandoff).toHaveBeenCalledWith(
      "claude",
      { kind: "new-worktree", branchName: "feature/login-fix" },
      REQUEST
    );
  });

  it("steps back from the branch step on Escape instead of dismissing", () => {
    const resolve = open();
    act(() => {
      fireEvent.click(option("new-worktree"));
    });
    press("Escape");
    expect(resolve).not.toHaveBeenCalled();
    expect(option("feat-1")).toBeTruthy();
  });
});
