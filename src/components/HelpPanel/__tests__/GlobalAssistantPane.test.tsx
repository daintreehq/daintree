// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { GlobalAssistantView } from "@shared/types/ipc/help";

const host = vi.hoisted(() => ({ id: null as string | null }));
const canopy = vi.hoisted(() => ({ isOpen: false }));
/** Every live pane api the pane made: its subject and the input stamp it types under. */
const apis = vi.hoisted(
  () =>
    [] as Array<{
      subject: unknown;
      stamp: unknown;
      disposed: boolean;
      terminalSubmit: ReturnType<typeof vi.fn>;
    }>
);

vi.mock("@/clients/agentDefaultsClient", () => ({ agentDefaultsClient: { set: vi.fn() } }));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => host.id }));
vi.mock("@/store/canopyStore", () => ({
  useCanopyStore: (select: (state: { isOpen: boolean }) => unknown) => select(canopy),
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => false,
  subscribeProjectViewLifecycle: () => () => {},
}));
vi.mock("@/config/agents", () => ({ getAgentConfig: () => ({ name: "Claude Code" }) }));
vi.mock("@/services/assistantSubject", () => ({
  assistantTerminalApi: (subject: unknown, stamp: unknown) => {
    const api = {
      subject,
      stamp,
      disposed: false,
      terminalSubmit: vi.fn(async () => {}),
      terminalSendKey: vi.fn(async () => {}),
      dispose: () => {
        api.disposed = true;
      },
    };
    apis.push(api);
    return api;
  },
}));
vi.mock("@/components/Canopy/CanopyTerminal", async () => {
  const { useEffect } = await import("react");
  return {
    // The stream opens as the real pane's does, once it has mounted.
    CanopyTerminal: ({
      runId,
      onStreamChange,
    }: {
      runId: string;
      onStreamChange?: (state: { watchId: number; ended: boolean; secretPrompt: boolean }) => void;
    }) => {
      useEffect(() => {
        onStreamChange?.({ watchId: 1, ended: false, secretPrompt: false });
      }, [onStreamChange]);
      return <div data-testid="global-terminal" data-run={runId} />;
    },
  };
});
vi.mock("@/components/Terminal/HybridInputBar", () => ({
  HybridInputBar: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="global-composer" data-disabled={String(disabled === true)} />
  ),
}));

const { GlobalAssistantPane } = await import("../GlobalAssistantPane");
const { useHelpPanelStore } = await import("@/store/helpPanelStore");

const subject = {
  hostId: "local",
  scope: { kind: "global" as const },
  terminalId: "g1",
  incarnation: 2,
};

function viewOf(patch: Partial<GlobalAssistantView> = {}): GlobalAssistantView {
  return {
    phase: "absent",
    generation: 0,
    agentId: null,
    terminalId: null,
    attachments: [],
    inputOwner: null,
    inputEpoch: 0,
    subject: null,
    ...patch,
  };
}

const running = (patch: Partial<GlobalAssistantView> = {}) =>
  viewOf({
    phase: "running",
    generation: 1,
    agentId: "claude",
    terminalId: "g1",
    subject,
    ...patch,
  });

let listeners: Set<(state: GlobalAssistantView) => void>;

function makeHelp(initial: GlobalAssistantView, attachmentId: string) {
  return {
    attachGlobalAssistant: vi.fn(async () => ({ attachmentId, state: initial })),
    detachGlobalAssistant: vi.fn(async () => {}),
    ensureGlobalAssistant: vi.fn(async () => running({ inputOwner: attachmentId, inputEpoch: 1 })),
    claimGlobalAssistantInput: vi.fn(async () =>
      running({ inputOwner: attachmentId, inputEpoch: 5 })
    ),
    restartGlobalAssistant: vi.fn(),
    discardGlobalAssistant: vi.fn(),
    onGlobalAssistantChanged: vi.fn((callback: (state: GlobalAssistantView) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
  };
}

let help: ReturnType<typeof makeHelp>;

function installHelp(initial: GlobalAssistantView, attachmentId = "a1") {
  listeners = new Set();
  help = makeHelp(initial, attachmentId);
  Object.assign(window, { electron: { help } });
}

function push(state: GlobalAssistantView) {
  act(() => {
    for (const listener of [...listeners]) listener(state);
  });
}

function renderPane(isVisible = true) {
  const wrap = (visible: boolean) => (
    <TooltipProvider delayDuration={0}>
      <GlobalAssistantPane isVisible={visible} />
    </TooltipProvider>
  );
  const result = render(wrap(isVisible));
  return { ...result, rerenderVisible: (visible: boolean) => result.rerender(wrap(visible)) };
}

const flush = () => act(async () => {});

describe("GlobalAssistantPane (#14454)", () => {
  beforeAll(async () => {
    await primeRadix();
  });

  beforeEach(() => {
    host.id = null;
    canopy.isOpen = false;
    apis.length = 0;
    useHelpPanelStore.setState({ isOpen: true, globalSelected: true, globalTarget: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("attaches to read and starts nothing until Start is pressed", async () => {
    installHelp(viewOf());
    renderPane();
    await flush();
    expect(help.attachGlobalAssistant).toHaveBeenCalledTimes(1);
    expect(help.ensureGlobalAssistant).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("help-global-start"));
    await flush();
    expect(help.ensureGlobalAssistant).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("global-terminal").getAttribute("data-run")).toBe("g1");
  });

  it("lets its reader go when hidden or unmounted, and never ends the run", async () => {
    installHelp(running());
    const { rerenderVisible, unmount } = renderPane();
    await flush();
    rerenderVisible(false);
    await flush();
    expect(help.detachGlobalAssistant).toHaveBeenCalledWith("a1");
    rerenderVisible(true);
    await flush();
    expect(help.attachGlobalAssistant).toHaveBeenCalledTimes(2);
    unmount();
    expect(help.detachGlobalAssistant).toHaveBeenCalledTimes(2);
    expect(help.discardGlobalAssistant).not.toHaveBeenCalled();
    expect(help.restartGlobalAssistant).not.toHaveBeenCalled();
    expect(help.ensureGlobalAssistant).not.toHaveBeenCalled();
  });

  it("lets go of an attachment that answers after the pane is gone", async () => {
    installHelp(running());
    let answer!: (value: { attachmentId: string; state: GlobalAssistantView }) => void;
    help.attachGlobalAssistant.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    );
    const { unmount } = renderPane();
    unmount();
    await act(async () => answer({ attachmentId: "late", state: running() }));
    expect(help.detachGlobalAssistant).toHaveBeenCalledWith("late");
  });

  it("types only under the ownership it holds, and reopens the stream when that moves", async () => {
    installHelp(running({ inputOwner: "a1", inputEpoch: 3 }));
    renderPane();
    await flush();
    expect(apis.at(-1)?.stamp).toEqual({ attachmentId: "a1", inputEpoch: 3 });
    expect(screen.getByTestId("global-composer").getAttribute("data-disabled")).toBe("false");

    // Another window takes input: this pane reads only, on a fresh stream.
    push(running({ inputOwner: "b1", inputEpoch: 4 }));
    await flush();
    expect(apis.at(-2)?.disposed).toBe(true);
    expect(apis.at(-1)?.stamp).toBeUndefined();
    expect(screen.getByTestId("global-composer").getAttribute("data-disabled")).toBe("true");
    expect(screen.getByTestId("help-global-input-elsewhere").textContent).toContain(
      "Another window"
    );

    // Taking it back is explicit, and is a new ownership, not the old one.
    fireEvent.click(screen.getByTestId("help-global-take-input"));
    await flush();
    expect(help.claimGlobalAssistantInput).toHaveBeenCalledWith("a1");
    expect(apis.at(-1)?.stamp).toEqual({ attachmentId: "a1", inputEpoch: 5 });
  });

  it("keeps one stream while input moves between other windows", async () => {
    installHelp(running({ inputOwner: "b1", inputEpoch: 4 }));
    renderPane();
    await flush();
    const made = apis.length;
    push(running({ inputOwner: "c1", inputEpoch: 6 }));
    await flush();
    expect(apis.length).toBe(made);
  });

  it("says a chosen run ended rather than showing its successor, and starts nothing", async () => {
    useHelpPanelStore.setState({ globalTarget: { ...subject, incarnation: 1 } });
    installHelp(running());
    renderPane();
    await flush();
    expect(screen.queryByTestId("global-terminal")).toBeNull();
    expect(screen.getByTestId("help-global-show-current")).not.toBeNull();
    expect(help.ensureGlobalAssistant).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("help-global-show-current"));
    await flush();
    expect(useHelpPanelStore.getState().globalTarget).toBeNull();
    expect(screen.getByTestId("global-terminal")).not.toBeNull();
  });

  it("offers no restart, stop or input for a successor hidden behind an ended run", async () => {
    useHelpPanelStore.setState({ globalTarget: { ...subject, incarnation: 1 } });
    installHelp(running({ inputOwner: "b1", inputEpoch: 4 }));
    renderPane();
    await flush();
    expect(screen.queryByTestId("help-global-more")).toBeNull();
    expect(screen.queryByTestId("help-global-take-input")).toBeNull();
  });

  it("follows the replacement after an explicit restart of the chosen run", async () => {
    useHelpPanelStore.setState({ globalTarget: subject });
    installHelp(running({ generation: 7, inputOwner: "a1", inputEpoch: 3 }));
    help.restartGlobalAssistant.mockResolvedValue(
      running({ generation: 8, subject: { ...subject, terminalId: "g2" }, terminalId: "g2" })
    );
    renderPane();
    await flush();
    fireEvent.pointerDown(screen.getByTestId("help-global-more"), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByText("Restart conversation"));
    fireEvent.click(await screen.findByRole("button", { name: "Restart conversation" }));
    await flush();
    expect(useHelpPanelStore.getState().globalTarget).toBeNull();
    expect(screen.getByTestId("global-terminal").getAttribute("data-run")).toBe("g2");
  });

  it("keeps restart and stop for a run whose terminal couldn't be brought back", async () => {
    installHelp(running({ subject: null, inputOwner: "a1", inputEpoch: 3 }));
    renderPane();
    await flush();
    expect(screen.queryByTestId("global-terminal")).toBeNull();
    expect(screen.getByTestId("help-global-more")).not.toBeNull();
  });

  it("shows the chosen run when it is the one running", async () => {
    useHelpPanelStore.setState({ globalTarget: subject });
    installHelp(running());
    renderPane();
    await flush();
    expect(screen.getByTestId("global-terminal").getAttribute("data-run")).toBe("g1");
  });

  it("attaches nothing from a window bound to another host", async () => {
    host.id = "studio";
    installHelp(running());
    renderPane();
    await flush();
    expect(help.attachGlobalAssistant).not.toHaveBeenCalled();
  });

  it("confirms a restart against the run it was asked about", async () => {
    installHelp(running({ generation: 7, inputOwner: "a1", inputEpoch: 3 }));
    help.restartGlobalAssistant.mockResolvedValue(running({ generation: 8 }));
    renderPane();
    await flush();
    fireEvent.pointerDown(screen.getByTestId("help-global-more"), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByText("Restart conversation"));
    expect(help.restartGlobalAssistant).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Restart conversation" }));
    await flush();
    expect(help.restartGlobalAssistant).toHaveBeenCalledWith(7);
  });
});
