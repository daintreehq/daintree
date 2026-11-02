// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { GlobalAssistantView } from "@shared/types/ipc/help";

const host = vi.hoisted(() => ({ id: null as string | null }));
const canopy = vi.hoisted(() => ({ isOpen: false }));
/** The props the pane last gave the composer, so a test can press Enter or a key as the composer would. */
const composer = vi.hoisted(() => ({
  props: null as {
    submitText: (text: string, imagePaths: readonly string[]) => Promise<boolean>;
    onSendKey: (key: string) => void;
  } | null,
}));
/** Every live pane api the pane made: its subject and the input stamp it types under. */
const apis = vi.hoisted(
  () =>
    [] as Array<{
      subject: unknown;
      stamp: unknown;
      disposed: boolean;
      terminalSubmit: ReturnType<typeof vi.fn>;
      terminalSendKey: ReturnType<typeof vi.fn>;
    }>
);
/** What the stream mock reports once it has mounted. */
const stream = vi.hoisted(() => ({
  state: { watchId: 1 as number | null, ended: false, secretPrompt: false },
}));

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
      onStreamChange?: (state: {
        watchId: number | null;
        ended: boolean;
        secretPrompt: boolean;
      }) => void;
    }) => {
      useEffect(() => {
        onStreamChange?.(stream.state);
      }, [onStreamChange]);
      return <div data-testid="global-terminal" data-run={runId} />;
    },
  };
});
vi.mock("@/components/Terminal/HybridInputBar", () => ({
  HybridInputBar: (props: {
    disabled?: boolean;
    submitText: (text: string, imagePaths: readonly string[]) => Promise<boolean>;
    onSendKey: (key: string) => void;
  }) => {
    composer.props = props;
    return <div data-testid="global-composer" data-disabled={String(props.disabled === true)} />;
  },
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
    agentState: null,
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
    setGlobalAssistantInputEligible: vi.fn(async () => {}),
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
  // The panel header's slot, where the pane draws its agent and menu.
  const controls = document.createElement("div");
  document.body.appendChild(controls);
  const wrap = (visible: boolean) => (
    <TooltipProvider delayDuration={0}>
      <GlobalAssistantPane isVisible={visible} controlsHost={controls} onOpenDocs={vi.fn()} />
    </TooltipProvider>
  );
  const result = render(wrap(isVisible));
  return { ...result, rerenderVisible: (visible: boolean) => result.rerender(wrap(visible)) };
}

const flush = () => act(async () => {});

/** A refusal as it arrives from main: an AppError's user message packed into `Error.message`. */
function refusedBy(code: string, userMessage: string): Error {
  return new Error(`[AppError|${code}|${encodeURIComponent(userMessage)}] internal detail`);
}

const failureBanner = () => screen.queryByTestId("help-global-send-failed");

/** Press Enter in the composer the way it does: through the pane's `submitText`. */
async function sendFromComposer(text = "hello", imagePaths: readonly string[] = []) {
  let accepted: boolean | undefined;
  await act(async () => {
    accepted = await composer.props?.submitText(text, imagePaths);
  });
  return accepted;
}

/** The next call of `method` stays pending until the test settles it. */
function holdNext(method: ReturnType<typeof vi.fn>) {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  method.mockImplementationOnce(
    () =>
      new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      })
  );
  return {
    accept: () => act(async () => resolve()),
    refuse: (error: unknown) => act(async () => reject(error)),
  };
}

/** Press Enter without waiting for main, as a send still on its way. */
function startSending(text = "hello"): () => Promise<boolean> {
  let sent: Promise<boolean> | undefined;
  act(() => {
    sent = composer.props?.submitText(text, []);
  });
  return () => sent!;
}

async function pressKey(key: string) {
  await act(async () => {
    composer.props?.onSendKey(key);
  });
}

async function renderOwned() {
  installHelp(running({ inputOwner: "a1", inputEpoch: 3 }));
  renderPane();
  await flush();
  return apis.at(-1)!;
}

describe("GlobalAssistantPane (#14454)", () => {
  beforeAll(async () => {
    await primeRadix();
  });

  beforeEach(() => {
    host.id = null;
    canopy.isOpen = false;
    composer.props = null;
    stream.state = { watchId: 1, ended: false, secretPrompt: false };
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

  it("types under input main hands it when the holder goes, without asking (#16098)", async () => {
    installHelp(running({ inputOwner: "b1", inputEpoch: 4 }));
    renderPane();
    await flush();
    push(running({ inputOwner: "a1", inputEpoch: 5 }));
    await flush();
    expect(apis.at(-1)?.stamp).toEqual({ attachmentId: "a1", inputEpoch: 5 });
    expect(screen.getByTestId("global-composer").getAttribute("data-disabled")).toBe("false");
    expect(screen.queryByTestId("help-global-input-elsewhere")).toBeNull();
    expect(help.claimGlobalAssistantInput).not.toHaveBeenCalled();
  });

  it("attaches behind Canopy as a view that can't type, and says when it can, still attached", async () => {
    canopy.isOpen = true;
    installHelp(running({ inputOwner: "b1", inputEpoch: 4 }));
    const { rerenderVisible } = renderPane();
    await flush();
    expect(help.attachGlobalAssistant).toHaveBeenCalledWith(false);
    expect(help.setGlobalAssistantInputEligible).not.toHaveBeenCalled();

    canopy.isOpen = false;
    rerenderVisible(true);
    await flush();
    expect(help.setGlobalAssistantInputEligible).toHaveBeenCalledTimes(1);
    expect(help.setGlobalAssistantInputEligible).toHaveBeenCalledWith("a1", true);
    expect(help.attachGlobalAssistant).toHaveBeenCalledTimes(1);
    expect(help.detachGlobalAssistant).not.toHaveBeenCalled();

    canopy.isOpen = true;
    rerenderVisible(true);
    await flush();
    expect(help.setGlobalAssistantInputEligible).toHaveBeenLastCalledWith("a1", false);
  });

  it("tells main of a change made while its attach was on its way", async () => {
    canopy.isOpen = true;
    installHelp(running());
    let answer!: (value: { attachmentId: string; state: GlobalAssistantView }) => void;
    help.attachGlobalAssistant.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    );
    const { rerenderVisible } = renderPane();
    await flush();
    canopy.isOpen = false;
    rerenderVisible(true);
    await flush();
    expect(help.setGlobalAssistantInputEligible).not.toHaveBeenCalled();
    await act(async () => answer({ attachmentId: "a1", state: running() }));
    await flush();
    expect(help.attachGlobalAssistant).toHaveBeenCalledWith(false);
    expect(help.setGlobalAssistantInputEligible).toHaveBeenCalledTimes(1);
    expect(help.setGlobalAssistantInputEligible).toHaveBeenCalledWith("a1", true);
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
    // It can't type to the successor it hides, so input nobody holds passes it over.
    expect(help.setGlobalAssistantInputEligible).toHaveBeenLastCalledWith("a1", false);

    fireEvent.click(screen.getByTestId("help-global-show-current"));
    await flush();
    expect(useHelpPanelStore.getState().globalTarget).toBeNull();
    expect(screen.getByTestId("global-terminal")).not.toBeNull();
    expect(help.setGlobalAssistantInputEligible).toHaveBeenLastCalledWith("a1", true);
  });

  it("offers no restart, stop or input for a successor hidden behind an ended run", async () => {
    useHelpPanelStore.setState({ globalTarget: { ...subject, incarnation: 1 } });
    installHelp(running({ inputOwner: "b1", inputEpoch: 4 }));
    renderPane();
    await flush();
    // The menu stays for docs; it offers nothing that would act on the hidden successor.
    fireEvent.pointerDown(screen.getByTestId("help-global-more"), { button: 0, ctrlKey: false });
    await screen.findByText("Open docs");
    expect(screen.queryByText("Restart conversation")).toBeNull();
    expect(screen.queryByText("Stop global assistant")).toBeNull();
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

  it("confirms a stop without claiming the conversation is gone or in past sessions (#14979)", async () => {
    installHelp(running({ generation: 7, inputOwner: "a1", inputEpoch: 3 }));
    help.discardGlobalAssistant.mockResolvedValue(true);
    renderPane();
    await flush();
    fireEvent.pointerDown(screen.getByTestId("help-global-more"), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByText("Stop global assistant"));
    const body = (await screen.findByRole("alertdialog")).textContent ?? "";
    // The transcript stays in the agent's own store, and the global assistant has
    // no picker to resume it from: neither "discarded" nor "past sessions" holds.
    expect(body).not.toMatch(/discard|delet|past session/i);
    expect(body).toContain("new conversation");
    expect(help.discardGlobalAssistant).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Stop global assistant" }));
    await flush();
    expect(help.discardGlobalAssistant).toHaveBeenCalledWith(7);
  });

  describe("a refused send or key (#14977)", () => {
    it("says why a refused message didn't go, and that the draft is still there", async () => {
      const api = await renderOwned();
      expect(failureBanner()).toBeNull();
      api.terminalSubmit.mockRejectedValueOnce(
        refusedBy("PERMISSION", "Another window has this assistant's input.")
      );

      expect(await sendFromComposer()).toBe(false);
      expect(api.terminalSubmit).toHaveBeenCalledTimes(1);
      const banner = failureBanner()!;
      expect(banner.getAttribute("role")).toBe("status");
      expect(banner.textContent).toContain("Couldn't send to assistant");
      expect(banner.textContent).toContain("Another window has this assistant's input.");
      expect(banner.textContent).toContain("Your message is still in the box; press Enter");
      expect(banner.textContent).not.toContain("internal detail");
    });

    it("shows the words of a plain rejection and a fallback for one with none", async () => {
      const api = await renderOwned();
      api.terminalSubmit.mockRejectedValueOnce(new Error("That agent isn't running any more."));
      await sendFromComposer();
      expect(failureBanner()!.textContent).toContain("That agent isn't running any more.");

      api.terminalSubmit.mockRejectedValueOnce(undefined);
      await sendFromComposer();
      expect(failureBanner()!.textContent).toContain("The assistant didn't take it.");

      api.terminalSubmit.mockRejectedValueOnce(new Error("   "));
      await sendFromComposer();
      expect(failureBanner()!.textContent).toContain("The assistant didn't take it.");
    });

    it("clears on an accepted send, which still carries its images", async () => {
      const api = await renderOwned();
      api.terminalSubmit.mockRejectedValueOnce(new Error("Couldn't reach it."));
      await sendFromComposer();
      expect(failureBanner()).not.toBeNull();

      expect(await sendFromComposer("again", ["/tmp/a.png"])).toBe(true);
      expect(failureBanner()).toBeNull();
      expect(api.terminalSubmit).toHaveBeenLastCalledWith(1, "again", ["/tmp/a.png"]);
    });

    it("clears a key's banner once a message is accepted", async () => {
      const api = await renderOwned();
      api.terminalSendKey.mockRejectedValueOnce(new Error("Couldn't reach it."));
      await pressKey("escape");
      expect(failureBanner()).not.toBeNull();

      const held = holdNext(api.terminalSubmit);
      const sent = startSending();
      expect(failureBanner()).not.toBeNull();
      await held.accept();
      expect(await sent()).toBe(true);
      expect(failureBanner()).toBeNull();
    });

    it("says a refused key didn't go, without claiming a draft", async () => {
      const api = await renderOwned();
      api.terminalSendKey.mockRejectedValueOnce(
        refusedBy("NOT_FOUND", "That assistant isn't running any more.")
      );

      await pressKey("escape");
      const banner = failureBanner()!;
      expect(banner.textContent).toContain("Couldn't send key to assistant");
      expect(banner.textContent).toContain("That assistant isn't running any more.");
      expect(banner.textContent).not.toContain("still in the box");

      await pressKey("up");
      expect(failureBanner()).toBeNull();
      expect(api.terminalSendKey).toHaveBeenLastCalledWith(1, "up");
    });

    it("keeps an unsent message's banner through a key that goes", async () => {
      const api = await renderOwned();
      api.terminalSubmit.mockRejectedValueOnce(new Error("Couldn't reach it."));
      await sendFromComposer();
      await pressKey("down");
      expect(api.terminalSendKey).toHaveBeenCalledTimes(1);
      expect(failureBanner()!.textContent).toContain("Couldn't send to assistant");
    });

    it("lets a newer refusal stand when an older send settles after it", async () => {
      const api = await renderOwned();
      const older = holdNext(api.terminalSubmit);
      const first = startSending("one");
      api.terminalSubmit.mockRejectedValueOnce(new Error("Newer."));
      await sendFromComposer("two");
      expect(failureBanner()!.textContent).toContain("Newer.");

      await older.refuse(new Error("Older."));
      expect(await first()).toBe(false);
      expect(failureBanner()!.textContent).toContain("Newer.");
      expect(failureBanner()!.textContent).not.toContain("Older.");
    });

    it("keeps a newer refusal when an older send turns out to have gone", async () => {
      const api = await renderOwned();
      const older = holdNext(api.terminalSubmit);
      const first = startSending("one");
      api.terminalSubmit.mockRejectedValueOnce(new Error("Newer."));
      await sendFromComposer("two");

      await older.accept();
      expect(await first()).toBe(true);
      expect(failureBanner()!.textContent).toContain("Newer.");
    });

    it("lets a newer send that went hold off an older refusal", async () => {
      const api = await renderOwned();
      const older = holdNext(api.terminalSubmit);
      const first = startSending("one");
      expect(await sendFromComposer("two")).toBe(true);

      await older.refuse(new Error("Too late."));
      expect(await first()).toBe(false);
      expect(failureBanner()).toBeNull();
    });

    it("keeps a newer key refusal when an older key turns out to have gone", async () => {
      const api = await renderOwned();
      const older = holdNext(api.terminalSendKey);
      await pressKey("up");
      api.terminalSendKey.mockRejectedValueOnce(new Error("Newer."));
      await pressKey("down");
      expect(failureBanner()!.textContent).toContain("Newer.");

      await older.accept();
      expect(failureBanner()!.textContent).toContain("Newer.");
    });

    it("keeps a newer key refusal when an older key is refused after it", async () => {
      const api = await renderOwned();
      const older = holdNext(api.terminalSendKey);
      await pressKey("up");
      api.terminalSendKey.mockRejectedValueOnce(new Error("Newer."));
      await pressKey("down");

      await older.refuse(new Error("Older."));
      expect(failureBanner()!.textContent).toContain("Newer.");
      expect(failureBanner()!.textContent).not.toContain("Older.");
    });

    it("lets a newer key that went hold off an older key's refusal", async () => {
      const api = await renderOwned();
      const older = holdNext(api.terminalSendKey);
      await pressKey("up");
      await pressKey("down");
      expect(api.terminalSendKey).toHaveBeenCalledTimes(2);

      await older.refuse(new Error("Too late."));
      expect(failureBanner()).toBeNull();
    });

    it("keeps a message's attempts apart from a key's", async () => {
      const api = await renderOwned();
      const held = holdNext(api.terminalSubmit);
      const sent = startSending();
      api.terminalSendKey.mockRejectedValueOnce(new Error("Key trouble."));
      await pressKey("escape");
      expect(failureBanner()!.textContent).toContain("Key trouble.");

      // The message is still its own newest: it went, so the draft and every banner are done.
      await held.accept();
      expect(await sent()).toBe(true);
      expect(failureBanner()).toBeNull();
    });

    it("keeps an unsent message's banner when a key is refused after it", async () => {
      const api = await renderOwned();
      api.terminalSubmit.mockRejectedValueOnce(new Error("Message trouble."));
      await sendFromComposer();
      api.terminalSendKey.mockRejectedValueOnce(new Error("Key trouble."));
      await pressKey("escape");

      const banner = failureBanner()!;
      expect(banner.textContent).toContain("Couldn't send to assistant");
      expect(banner.textContent).toContain("Message trouble.");
      await pressKey("up");
      expect(failureBanner()!.textContent).toContain("Message trouble.");
    });

    it("drops the old banner while the next send is on its way", async () => {
      const api = await renderOwned();
      api.terminalSubmit.mockRejectedValueOnce(new Error("Couldn't reach it."));
      await sendFromComposer();
      expect(failureBanner()).not.toBeNull();

      api.terminalSubmit.mockImplementationOnce(() => new Promise(() => {}));
      act(() => {
        void composer.props?.submitText("again", []);
      });
      expect(failureBanner()).toBeNull();
    });

    it("keeps the refusal when input moves, and points at taking it back", async () => {
      const api = await renderOwned();
      api.terminalSubmit.mockRejectedValueOnce(
        refusedBy("PERMISSION", "Another window has this assistant's input.")
      );
      await sendFromComposer();

      push(running({ inputOwner: "b1", inputEpoch: 4 }));
      await flush();
      expect(apis.at(-1)).not.toBe(api);
      const banner = failureBanner()!;
      expect(banner.textContent).toContain("Another window has this assistant's input.");
      expect(banner.textContent).toContain("take input to send it again");
      expect(screen.getByTestId("help-global-take-input")).not.toBeNull();

      fireEvent.click(screen.getByTestId("help-global-take-input"));
      await flush();
      expect(failureBanner()!.textContent).toContain("press Enter to try again");
    });

    it("lands a refusal that arrives after input moved", async () => {
      const api = await renderOwned();
      const held = holdNext(api.terminalSubmit);
      const sent = startSending();
      push(running({ inputOwner: "b1", inputEpoch: 4 }));
      await flush();
      expect(api.disposed).toBe(true);
      expect(apis.at(-1)).not.toBe(api);

      await held.refuse(refusedBy("PERMISSION", "Another window has this assistant's input."));
      expect(await sent()).toBe(false);
      expect(failureBanner()!.textContent).toContain("Another window has this assistant's input.");
    });

    it.each([
      ["a different terminal", { terminalId: "g2", incarnation: 2 }],
      ["a new incarnation of the same terminal", { terminalId: "g1", incarnation: 3 }],
    ])("forgets the refusal once the run becomes %s", async (_name, next) => {
      const api = await renderOwned();
      api.terminalSubmit.mockRejectedValueOnce(new Error("Couldn't reach it."));
      await sendFromComposer();
      expect(failureBanner()).not.toBeNull();

      // Nothing else about the session moves, so only the run's identity can drop it.
      push(
        running({
          terminalId: next.terminalId,
          subject: { ...subject, ...next },
          inputOwner: "a1",
          inputEpoch: 3,
        })
      );
      await flush();
      expect(screen.getByTestId("global-terminal").getAttribute("data-run")).toBe(next.terminalId);
      expect(failureBanner()).toBeNull();
    });

    it("ignores what a replaced run's send settles with", async () => {
      const api = await renderOwned();
      const held = holdNext(api.terminalSubmit);
      const sent = startSending();

      push(
        running({
          terminalId: "g2",
          subject: { ...subject, terminalId: "g2" },
          inputOwner: "a1",
          inputEpoch: 3,
        })
      );
      await flush();
      apis.at(-1)!.terminalSendKey.mockRejectedValueOnce(new Error("New run trouble."));
      await pressKey("escape");
      expect(failureBanner()!.textContent).toContain("New run trouble.");

      await held.refuse(new Error("Old run trouble."));
      expect(await sent()).toBe(false);
      expect(failureBanner()!.textContent).toContain("New run trouble.");
    });

    const TAKE_INPUT = "Your message is still in the box; take input to send it again.";
    const KEPT = "Your message is still in the box.";
    const nowhereToType = [
      [
        "another window holds input",
        { inputOwner: "b1" },
        {},
        "Another window has this assistant's input.",
        TAKE_INPUT,
      ],
      [
        "no window holds input",
        { inputOwner: null },
        {},
        "No window has this assistant's input.",
        TAKE_INPUT,
      ],
      [
        "the stream ended",
        { inputOwner: "a1" },
        { watchId: null, ended: true },
        "That assistant isn't running any more.",
        KEPT,
      ],
      [
        "the stream is still opening",
        { inputOwner: "a1" },
        { watchId: null, ended: false },
        "The assistant's terminal isn't ready yet.",
        KEPT,
      ],
    ] as const;

    async function renderWhereNothingTypes(
      owner: { inputOwner: string | null },
      streamState: Partial<typeof stream.state>
    ) {
      stream.state = { ...stream.state, ...streamState };
      installHelp(running({ ...owner, inputEpoch: 3 }));
      renderPane();
      await flush();
      return apis.at(-1)!;
    }

    it.each(nowhereToType)(
      "says why a message can't go when %s, without calling main",
      async (_name, owner, streamState, reason, recovery) => {
        const api = await renderWhereNothingTypes(owner, streamState);
        expect(await sendFromComposer()).toBe(false);
        expect(failureBanner()!.textContent).toContain("Couldn't send to assistant");
        expect(failureBanner()!.textContent).toContain(reason);
        expect(failureBanner()!.textContent).toContain(recovery);
        expect(failureBanner()!.textContent).not.toContain("press Enter");
        expect(api.terminalSubmit).not.toHaveBeenCalled();
        expect(api.terminalSendKey).not.toHaveBeenCalled();
      }
    );

    it.each(nowhereToType)(
      "says why a key can't go when %s, without calling main",
      async (_name, owner, streamState, reason) => {
        const api = await renderWhereNothingTypes(owner, streamState);
        await pressKey("escape");
        expect(failureBanner()!.textContent).toContain("Couldn't send key to assistant");
        expect(failureBanner()!.textContent).toContain(reason);
        expect(api.terminalSubmit).not.toHaveBeenCalled();
        expect(api.terminalSendKey).not.toHaveBeenCalled();
      }
    );

    it("forwards the stream the pane is reading", async () => {
      stream.state = { watchId: 7, ended: false, secretPrompt: false };
      const api = await renderOwned();
      await sendFromComposer("hello");
      await pressKey("up");
      expect(api.terminalSubmit).toHaveBeenCalledWith(7, "hello", undefined);
      expect(api.terminalSendKey).toHaveBeenCalledWith(7, "up");
    });

    it("points at Enter only while the composer would take it", async () => {
      const api = await renderOwned();
      api.terminalSubmit.mockRejectedValueOnce(new Error("Couldn't reach it."));
      await sendFromComposer();
      expect(failureBanner()!.textContent).toContain("press Enter to try again");
      cleanup();

      // A terminal asking for a secret takes no composer input, but the draft is still kept.
      stream.state = { watchId: 1, ended: false, secretPrompt: true };
      const locked = await renderOwned();
      expect(screen.getByTestId("global-composer").getAttribute("data-disabled")).toBe("true");
      locked.terminalSubmit.mockRejectedValueOnce(new Error("Couldn't reach it."));
      await sendFromComposer();
      expect(failureBanner()!.textContent).toContain("Your message is still in the box.");
      expect(failureBanner()!.textContent).not.toContain("press Enter");
      expect(failureBanner()!.textContent).not.toContain("take input");
    });
  });
});
