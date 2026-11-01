// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender } from "@testing-library/react";
import { createRef, type KeyboardEvent, type ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCanopyStore } from "@/store/canopyStore";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { CanopyCard as CanopyCardData, CanopyCategory } from "@shared/types/ipc/canopy";
import { buildPilotGroups } from "@/components/Pilot/pilotRows";
import { bandForRun } from "@shared/utils/fleetBands";
import { usePanelStore } from "@/store/panelStore";
import type { PtyPanelData } from "@shared/types/panel";
import { buildCanopyInbox, type CanopyItem } from "../canopyModel";
import { useVoiceRecordingStore, type VoiceRecordingTarget } from "@/store/voiceRecordingStore";
import { DICTATION_OWNER_ATTR, canopyReplyVoiceId } from "@/services/canopyReplyDictation";
import {
  TRASH_CONFIRM_MS,
  CanopyCard,
  type CanopyCardHandle,
  type CanopyCardHandlers,
  type CanopyPaneFocus,
} from "../CanopyCard";

interface ComposerProps {
  terminalId: string;
  isolated: boolean;
  disabled: boolean;
  onSend: (payload: { text: string; imagePaths?: string[] }) => void;
  onSendKey: (key: string) => void;
  submitText?: (text: string, imagePaths: string[]) => Promise<boolean>;
  voiceTarget?: VoiceRecordingTarget;
  modEnterSend?: () => {
    submitText: (text: string, imagePaths: readonly string[]) => Promise<boolean>;
    sendEnter: () => void;
  };
}

interface TerminalProps {
  runId: string;
  spawnedAt: number;
  onStreamChange: (state: {
    watchId: number | null;
    ended: boolean;
    secretPrompt: boolean;
  }) => void;
}

const { submit, sendKey, composerProps, terminalProps, composerFocus, dictationFocus } = vi.hoisted(
  () => ({
    submit: vi.fn(async (..._args: unknown[]) => {}),
    sendKey: vi.fn(async (..._args: unknown[]) => {}),
    composerFocus: vi.fn(),
    dictationFocus: vi.fn(),
    composerProps: { current: null as ComposerProps | null },
    terminalProps: { current: null as TerminalProps | null },
  })
);

// The live terminal needs a canvas and a PTY host; here only what it is handed matters.
vi.mock("../CanopyTerminal", () => ({
  CanopyTerminal: (props: TerminalProps) => {
    terminalProps.current = props;
    return <div data-canopy-terminal="" />;
  },
}));

vi.mock("@/components/Terminal/HybridInputBar", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    HybridInputBar: (
      props: ComposerProps & {
        ref?: React.Ref<{ focus: () => void; focusForDictation: () => void }>;
      }
    ) => {
      composerProps.current = props;
      useImperativeHandle(props.ref, () => ({
        focus: composerFocus,
        focusForDictation: () => {
          composerFocus();
          dictationFocus();
        },
      }));
      return (
        <div data-testid="composer">
          <div className="cm-editor">
            <div tabIndex={-1} data-editor-content="" />
          </div>
        </div>
      );
    },
  };
});

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { canopy: { terminalSubmit: submit, terminalSendKey: sendKey } },
  });
  submit.mockClear();
  sendKey.mockClear();
  composerFocus.mockClear();
  dictationFocus.mockReset();
  composerProps.current = null;
  terminalProps.current = null;
});

/** The app root provides tooltips; the pane's buttons need one. */
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: TooltipProvider });
}

const PROPS = { domId: "card" };
const NOW = 1_700_000_000_000;

function itemFor(
  kind: CanopyCategory,
  card: Partial<CanopyCardData> = {},
  runId = "run-1"
): CanopyItem {
  const run: FleetRunRow = {
    runId,
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/Users/dev/app",
    agentId: "claude",
    agentState: "waiting",
    title: "Fix flaky panel tests",
    since: NOW - 60_000,
  };
  const groups = buildPilotGroups([run], {
    workspaces: new Map([["p1", { kind: "project", name: "app" }]]),
    currentWorkspaceId: null,
    nowMs: NOW,
  });
  const data: CanopyCardData = {
    runId,
    spawnedAt: NOW - 3_600_000,
    revision: 1,
    category: kind,
    confidence: 0.95,
    attentionProbability: 0.9,
    attentionScore: null,
    priority: 90,
    task: null,
    risk: "unknown",
    riskReason: null,
    action: null,
    progress: null,
    steps: null,
    tests: "unknown",
    changes: "unknown",
    handledAt: null,
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    wordsCategory: kind,
    stage: "described",
    describing: false,
    headline: "Run the panel store tests?",
    summary: "Claude wants to run npm test.",
    question: null,
    options: [],
    secretPrompt: false,
    activity: null,
    glance: { recap: null, said: null, doing: null, action: null },
    statusLine: null,
    contextLeft: null,
    stalledSince: null,
    observedAt: NOW,
    ...card,
  };
  return buildCanopyInbox(groups, new Map([[runId, data]]))[0]!;
}

function handlers() {
  return {
    onOpen: vi.fn<CanopyCardHandlers["onOpen"]>(),
    onTrash: vi.fn<CanopyCardHandlers["onTrash"]>(),
    onArchive: vi.fn<CanopyCardHandlers["onArchive"]>(),
    onSent: vi.fn<CanopyCardHandlers["onSent"]>(),
    onSendFailed: vi.fn<CanopyCardHandlers["onSendFailed"]>(),
    onAnswer: vi.fn<CanopyCardHandlers["onAnswer"]>(),
    onRename: vi.fn<CanopyCardHandlers["onRename"]>(async () => {}),
    onLeavePane: vi.fn<CanopyCardHandlers["onLeavePane"]>(),
  };
}

/** ⌘⌫ as the list hands it to the selected run's pane. */
function keyPress(
  key: string,
  { metaKey = false, repeat = false }: { metaKey?: boolean; repeat?: boolean } = {}
): KeyboardEvent<HTMLElement> {
  return {
    key,
    metaKey,
    ctrlKey: false,
    altKey: false,
    repeat,
    preventDefault: () => {},
  } as unknown as KeyboardEvent<HTMLElement>;
}

function trashChord(repeat = false): KeyboardEvent<HTMLElement> {
  return keyPress("Backspace", { metaKey: true, repeat });
}

let currentHandlers: ReturnType<typeof handlers> | null = null;

function renderCard(item: CanopyItem, h = handlers()) {
  currentHandlers = h;
  const view = render(<CanopyCard item={item} {...PROPS} {...h} />);
  return { ...view, h, pane: view.container.querySelector<HTMLElement>("[data-canopy-detail]")! };
}

function buttonNamed(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.includes(text) || b.getAttribute("aria-label") === text
  );
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

/** The live view reports its stream; here, as main would once it opened. */
async function streamOpens(state: { watchId: number | null; secretPrompt?: boolean }) {
  const report = terminalProps.current!.onStreamChange;
  await act(async () => report({ ended: false, secretPrompt: false, ...state }));
}

/** The lazy composer resolves on a later tick. */
async function composer() {
  await vi.waitFor(() => expect(composerProps.current).not.toBeNull());
  return composerProps.current!;
}

describe("CanopyCard", () => {
  it("shows the run's own terminal, live, for its incarnation", () => {
    renderCard(itemFor("question"));
    expect(terminalProps.current).toMatchObject({ runId: "run-1", spawnedAt: NOW - 3_600_000 });
  });

  it("gives the real composer, isolated, and sends what is typed to that run", async () => {
    const { h } = renderCard(itemFor("question"));
    expect((await composer()).disabled).toBe(true);
    await streamOpens({ watchId: 7 });
    const bar = await composer();
    // Never a fleet broadcast, and never the pane's own input controller.
    expect(bar.isolated).toBe(true);
    expect(bar.terminalId).toBe("run-1");
    expect(bar.disabled).toBe(false);
    await act(async () => bar.onSend({ text: "Keep it read-only" }));
    // Through the open stream, so main sends to the incarnation on screen.
    expect(submit).toHaveBeenCalledWith(7, "Keep it read-only", undefined);
    expect(h.onSent).toHaveBeenCalledTimes(1);
  });

  it("sends nothing before the stream is open", async () => {
    renderCard(itemFor("question"));
    await act(async () => (await composer()).onSend({ text: "too early" }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports a send main refused", async () => {
    submit.mockRejectedValueOnce(new Error("gone"));
    const { h } = renderCard(itemFor("question"));
    await streamOpens({ watchId: 7 });
    await act(async () => (await composer()).onSend({ text: "hello" }));
    expect(h.onSendFailed).toHaveBeenCalledTimes(1);
    expect(h.onSent).not.toHaveBeenCalled();
  });

  it("tells the composer a refused send failed, so the draft stays where it was typed", async () => {
    const { h } = renderCard(itemFor("question"));
    await streamOpens({ watchId: 7 });
    const bar = await composer();
    submit.mockRejectedValueOnce(new Error("gone"));
    let took: boolean | undefined;
    await act(async () => {
      took = await bar.submitText!("hello", []);
    });
    expect(took).toBe(false);
    expect(h.onSendFailed).toHaveBeenCalledTimes(1);
    await act(async () => {
      took = await bar.submitText!("hello again", []);
    });
    expect(took).toBe(true);
    expect(h.onSent).toHaveBeenCalledTimes(1);
  });

  describe("a reply that outlives its card (#15510)", () => {
    function replyByRun() {
      const submitReply = vi.fn(async (..._args: unknown[]) => {});
      Object.assign(window.electron.canopy, { submitReply });
      return submitReply;
    }

    it("goes by the run and its incarnation, its stream having ended with the card", async () => {
      const submitReply = replyByRun();
      const h = handlers();
      const item = itemFor("question");
      const view = render(<CanopyCard item={item} {...PROPS} {...h} />);
      await streamOpens({ watchId: 7 });
      const bar = await composer();
      view.unmount();

      let took: boolean | undefined;
      await act(async () => {
        took = await bar.submitText!("Keep it read-only", ["/tmp/shot.png"]);
      });

      expect(took).toBe(true);
      expect(submit).not.toHaveBeenCalled();
      expect(submitReply).toHaveBeenCalledWith(
        "run-1",
        { spawnedAt: NOW - 3_600_000 },
        "Keep it read-only",
        ["/tmp/shot.png"]
      );
      expect(h.onSent).toHaveBeenCalledWith(item, undefined);
    });

    it("goes by the run even when the stream had dropped before the card went", async () => {
      const submitReply = replyByRun();
      const view = render(<CanopyCard item={itemFor("question")} {...PROPS} {...handlers()} />);
      await streamOpens({ watchId: 7 });
      await streamOpens({ watchId: null });
      const bar = await composer();
      view.unmount();

      let took: boolean | undefined;
      await act(async () => {
        took = await bar.submitText!("still mine", []);
      });

      expect(took).toBe(true);
      expect(submitReply).toHaveBeenCalledWith(
        "run-1",
        { spawnedAt: NOW - 3_600_000 },
        "still mine",
        undefined
      );
    });

    it("sends each of several to its own run, whatever order their cleanups land in", async () => {
      const submitReply = replyByRun();
      const sends = new Map<string, (text: string, imagePaths: string[]) => Promise<boolean>>();
      for (const runId of ["run-1", "run-2", "run-3"]) {
        composerProps.current = null;
        const view = render(
          <CanopyCard item={itemFor("question", {}, runId)} {...PROPS} {...handlers()} />
        );
        await streamOpens({ watchId: sends.size + 1 });
        sends.set(runId, (await composer()).submitText!);
        view.unmount();
      }

      for (const runId of ["run-3", "run-1", "run-2"]) {
        await act(async () => {
          await sends.get(runId)!(`reply to ${runId}`, []);
        });
      }

      expect(submit).not.toHaveBeenCalled();
      expect(submitReply.mock.calls.map(([runId, , text]) => [runId, text])).toEqual([
        ["run-3", "reply to run-3"],
        ["run-1", "reply to run-1"],
        ["run-2", "reply to run-2"],
      ]);
    });

    it("leaves ⌘↩'s route by the run too, and reports a refusal", async () => {
      const submitReply = replyByRun();
      submitReply.mockRejectedValueOnce(new Error("That agent isn't running any more."));
      const h = handlers();
      const item = itemFor("question");
      const view = render(<CanopyCard item={item} {...PROPS} {...h} />);
      await streamOpens({ watchId: 7 });
      const route = (await composer()).modEnterSend!();
      view.unmount();

      let took: boolean | undefined;
      await act(async () => {
        took = await route.submitText("too late", []);
      });

      expect(took).toBe(false);
      expect(submit).not.toHaveBeenCalled();
      expect(h.onSendFailed).toHaveBeenCalledTimes(1);
      expect(h.onSent).not.toHaveBeenCalled();
    });
  });

  it("passes the composer's keys to the terminal, but Escape goes back to the list", async () => {
    renderCard(itemFor("approval", { options: ["Yes", "No"] }));
    const { h } = { h: currentHandlers! };
    await streamOpens({ watchId: 7 });
    // Escape leaves the reply rather than interrupting the agent's turn.
    await act(async () => (await composer()).onSendKey("escape"));
    expect(sendKey).not.toHaveBeenCalled();
    expect(h.onLeavePane).toHaveBeenCalledTimes(1);
    // Arrows steer the agent's menu; only Enter answers it, and stays on the run.
    await act(async () => (await composer()).onSendKey("up"));
    expect(sendKey).toHaveBeenCalledWith(7, "up");
    expect(h.onSent).not.toHaveBeenCalled();
    await act(async () => (await composer()).onSendKey("enter"));
    expect(h.onSent).toHaveBeenCalledTimes(1);
    expect(h.onSent).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: "run-1" }),
      undefined
    );
  });

  describe("⌘↩", () => {
    const named = (runId: string, title: string): CanopyItem => {
      const item = itemFor("question", {}, runId);
      return { ...item, row: { ...item.row, title } };
    };

    it("moves on to the run the reply named at the press, through the stream open when the send lands", async () => {
      const h = handlers();
      const item = itemFor("question");
      const view = render(
        <CanopyCard item={item} {...PROPS} {...h} moveOnTo={named("run-2", "Pick a port")} />
      );
      await streamOpens({ watchId: 7 });
      const route = (await composer()).modEnterSend!();
      // A dictated send lands after its wait: the list has moved, the stream reopened.
      view.rerender(
        <CanopyCard item={item} {...PROPS} {...h} moveOnTo={named("run-3", "Bump the deps")} />
      );
      await streamOpens({ watchId: 8 });

      await act(async () => {
        await route.submitText("Keep it read-only", []);
      });
      expect(submit).toHaveBeenCalledWith(8, "Keep it read-only", undefined);
      expect(h.onSent).toHaveBeenLastCalledWith(item, "run-2");

      // An empty reply's Enter answers the agent's menu, and moves on the same way.
      await act(async () => route.sendEnter());
      expect(sendKey).toHaveBeenCalledWith(8, "enter");
      expect(h.onSent).toHaveBeenLastCalledWith(item, "run-2");
      expect(h.onSent).toHaveBeenCalledTimes(2);

      // Enter carries nowhere to go: it stays.
      await act(async () => {
        await (
          await composer()
        ).submitText!("and stay", []);
      });
      expect(h.onSent).toHaveBeenLastCalledWith(item, undefined);
    });

    it("sends and stays with nothing to name, and moves nowhere on a send main refused", async () => {
      const h = handlers();
      const item = itemFor("question");
      const view = render(<CanopyCard item={item} {...PROPS} {...h} />);
      await streamOpens({ watchId: 7 });

      await act(async () => {
        await (await composer()).modEnterSend!().submitText("no one below", []);
      });
      expect(h.onSent).toHaveBeenLastCalledWith(item, undefined);

      view.rerender(
        <CanopyCard item={item} {...PROPS} {...h} moveOnTo={named("run-2", "Pick a port")} />
      );
      submit.mockRejectedValueOnce(new Error("gone"));
      let took: boolean | undefined;
      await act(async () => {
        took = await (await composer()).modEnterSend!().submitText("refused", []);
      });
      expect(took).toBe(false);
      expect(h.onSendFailed).toHaveBeenCalledTimes(1);
      expect(h.onSent).toHaveBeenCalledTimes(1);
    });

    it("names where it goes in a line kept under the reply, blank with nowhere to go", async () => {
      const h = handlers();
      const item = itemFor("question");
      const view = render(
        <CanopyCard item={item} {...PROPS} {...h} moveOnTo={named("run-2", "Pick a port")} />
      );
      await composer();
      const line = () => view.container.querySelector<HTMLElement>("[data-canopy-move-on]");
      // Nothing to send through until the stream opens: the line is held, blank.
      expect(line()!.textContent).toBe("");
      await streamOpens({ watchId: 7 });
      expect(line()?.textContent).toContain("Send and go to");
      expect(line()?.textContent).toContain("Pick a port");

      view.rerender(<CanopyCard item={item} {...PROPS} {...h} moveOnTo={null} />);
      expect(line()).not.toBeNull();
      expect(line()!.textContent).toBe("");
    });
  });

  it("hands Reply to the live terminal while it asks for a secret", async () => {
    const h = handlers();
    const ref = createRef<CanopyCardHandle>();
    const { container } = render(
      <CanopyCard ref={ref} item={itemFor("question")} {...PROPS} {...h} />
    );
    await composer();
    // The live screen asks for a password before the card knows it.
    await streamOpens({ watchId: 7, secretPrompt: true });
    const textarea = document.createElement("textarea");
    container.querySelector("[data-canopy-terminal]")!.appendChild(textarea);
    expect(ref.current!.focusComposer()).toBe(true);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.activeElement).toBe(textarea);
  });

  it("moves the keyboard into the terminal when the reply it was in goes for a secret", async () => {
    const h = handlers();
    const { container, getByTestId } = render(
      <CanopyCard item={itemFor("question")} {...PROPS} {...h} />
    );
    await composer();
    await streamOpens({ watchId: 7 });
    const textarea = document.createElement("textarea");
    container.querySelector("[data-canopy-terminal]")!.appendChild(textarea);
    const reply = document.createElement("input");
    getByTestId("composer").appendChild(reply);
    reply.focus();
    await streamOpens({ watchId: 7, secretPrompt: true });
    expect(document.activeElement).toBe(textarea);
  });

  it("leaves the keyboard where it was when a secret takes a reply it wasn't in", async () => {
    const h = handlers();
    const { container } = render(<CanopyCard item={itemFor("question")} {...PROPS} {...h} />);
    await composer();
    await streamOpens({ watchId: 7 });
    container
      .querySelector("[data-canopy-terminal]")!
      .appendChild(document.createElement("textarea"));
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await streamOpens({ watchId: 7, secretPrompt: true });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("goes back to the list on Escape from a reply whose terminal has gone", async () => {
    const h = handlers();
    const { container } = render(<CanopyCard item={itemFor("question")} {...PROPS} {...h} />);
    await composer();
    // No stream: the composer is disabled and leaves Escape unhandled.
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    container.querySelector("[data-testid=composer]")!.appendChild(editor);
    // Mid-composition, Escape is the input method's.
    fireEvent.keyDown(editor, { key: "Escape", isComposing: true });
    expect(h.onLeavePane).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(h.onLeavePane).toHaveBeenCalledTimes(1);
  });

  describe("dictating a reply (#14777)", () => {
    beforeEach(() => {
      // This view is p1's, the project the fixtures' runs are in.
      window.__DAINTREE_INITIAL_PROJECT__ = { id: "p1" };
    });
    afterEach(() => {
      delete window.__DAINTREE_INITIAL_PROJECT__;
      useVoiceRecordingStore.setState({ micNotice: null });
    });

    function renderWithHandle(
      item: CanopyItem,
      props: {
        otherHostId?: string;
        hostScope?: string | null;
        reconnecting?: boolean;
        initialFocus?: CanopyPaneFocus;
        dictationRequest?: number;
        onDictationSettled?: (request: number) => void;
      } = {}
    ) {
      const ref = createRef<CanopyCardHandle>();
      const view = render(
        <CanopyCard ref={ref} item={item} {...PROPS} {...handlers()} {...props} />
      );
      return { ...view, ref };
    }

    it("gives the reply a dictation of its own, apart from the pane's, typed to this run", async () => {
      renderWithHandle(itemFor("question"));
      expect((await composer()).voiceTarget).toEqual({
        panelId: canopyReplyVoiceId("run-1"),
        panelTitle: "Reply to Fix flaky panel tests",
        surface: "canopy-reply",
        terminalId: "run-1",
        canopyRow: { runId: "run-1", hostScope: null },
      });
    });

    it("names its row as the list has it, under the host the panel lists it on (#14778)", async () => {
      renderWithHandle(itemFor("question", {}, "6.studio.run-1"), {
        otherHostId: "studio",
        hostScope: "*",
      });
      expect((await composer()).voiceTarget!.canopyRow).toEqual({
        runId: "6.studio.run-1",
        hostScope: "*",
      });
    });

    const frame = () =>
      act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

    it("hands the keyboard to the reply when sent back to it, whatever has focus as it opens (#14778)", async () => {
      // The indicator that asked keeps focus as the pane mounts.
      const indicator = document.createElement("button");
      document.body.append(indicator);
      indicator.focus();
      const settled = vi.fn();
      renderWithHandle(itemFor("question"), { dictationRequest: 1, onDictationSettled: settled });
      await composer();
      await frame();
      await frame();
      expect(dictationFocus).toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();

      // The user pressing anything is theirs: the handoff stands down and settles.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled).toHaveBeenCalledWith(1);
      const stopped = dictationFocus.mock.calls.length;
      await frame();
      await frame();
      expect(dictationFocus.mock.calls.length).toBe(stopped);
      indicator.remove();
    });

    it("takes a request on a pane already showing, and settles once the reply has the keyboard (#14778)", async () => {
      dictationFocus.mockImplementation(() => {
        document.querySelector<HTMLElement>("[data-editor-content]")?.focus();
      });
      const settled = vi.fn();
      const item = itemFor("question");
      const view = renderWithHandle(item, { onDictationSettled: settled });
      await composer();
      await frame();
      await frame();
      expect(dictationFocus).not.toHaveBeenCalled();

      view.rerender(
        <CanopyCard
          item={item}
          {...PROPS}
          {...handlers()}
          dictationRequest={2}
          onDictationSettled={settled}
        />
      );
      await frame();
      await frame();
      expect(document.activeElement?.closest(".cm-editor")).not.toBeNull();
      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled).toHaveBeenCalledWith(2);
      const landed = dictationFocus.mock.calls.length;
      await frame();
      expect(dictationFocus.mock.calls.length).toBe(landed);
    });

    it("names no terminal for main to read when another project's view has the run", async () => {
      window.__DAINTREE_INITIAL_PROJECT__ = { id: "p2" };
      renderWithHandle(itemFor("question"));
      const target = (await composer()).voiceTarget!;
      expect(target.panelId).toBe(canopyReplyVoiceId("run-1"));
      expect(target.terminalId).toBeUndefined();
      expect(target.otherHostId).toBeUndefined();
    });

    it("names no terminal of this machine's for another host's run", async () => {
      renderWithHandle(itemFor("question"), { otherHostId: "host-2" });
      const target = (await composer()).voiceTarget!;
      expect(target.panelId).toBe(canopyReplyVoiceId("run-1", "host-2"));
      expect(target.otherHostId).toBe("host-2");
      expect(target.terminalId).toBeUndefined();
    });

    it("takes the dictation key from its live terminal and its reply alike", async () => {
      const { container } = renderWithHandle(itemFor("question"));
      await composer();
      const owner = `[${DICTATION_OWNER_ATTR}]`;
      expect(container.querySelector("[data-canopy-terminal]")!.closest(owner)).not.toBeNull();
      expect(container.querySelector("[data-testid=composer]")!.closest(owner)).not.toBeNull();
    });

    it("dictates into the reply once its stream is open", async () => {
      const { ref } = renderWithHandle(itemFor("question"));
      await composer();
      expect(ref.current!.dictation()).toMatchObject({
        ok: false,
        message: expect.stringContaining("still connecting"),
      });

      await streamOpens({ watchId: 7 });
      const dictation = ref.current!.dictation();
      expect(dictation.ok).toBe(true);
      if (dictation.ok) expect(dictation.target.panelId).toBe(canopyReplyVoiceId("run-1"));
    });

    it("says it can't while the run asks for a secret, the readers' or the live screen's", async () => {
      const secretCard = renderWithHandle(itemFor("question", { secretPrompt: true }));
      expect(secretCard.ref.current!.dictation()).toMatchObject({
        ok: false,
        message: expect.stringContaining("secret"),
      });
      secretCard.unmount();

      const { ref } = renderWithHandle(itemFor("question"));
      await composer();
      await streamOpens({ watchId: 7, secretPrompt: true });
      expect(ref.current!.dictation()).toMatchObject({
        ok: false,
        message: expect.stringContaining("secret"),
      });
    });

    it("shows a microphone notice for the reply's own dictation, not the pane's", async () => {
      const { container } = renderWithHandle(itemFor("question"));
      await composer();
      const lost = (panelId: string) =>
        act(() => {
          useVoiceRecordingStore.setState({
            micNotice: { kind: "lost", target: { panelId }, deviceLabel: "AirPods" },
          });
        });

      lost("run-1");
      expect(container.textContent).not.toContain("Microphone lost");
      lost(canopyReplyVoiceId("run-1"));
      expect(container.textContent).toContain("Microphone lost");
    });

    it("keeps handing the keyboard to a loading reply while the dictation key is held", async () => {
      const { ref } = renderWithHandle(itemFor("question"));
      await composer();
      await streamOpens({ watchId: 7 });
      const dictation = ref.current!.dictation();
      if (!dictation.ok) throw new Error("expected a reply to dictate into");
      const frame = () =>
        act(async () => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        });

      dictation.focus();
      await frame();
      await frame();
      const before = composerFocus.mock.calls.length;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true, repeat: true }));
      await frame();
      expect(composerFocus.mock.calls.length).toBeGreaterThan(before);

      // A fresh press is the user going elsewhere: the handoff stands down.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
      const stopped = composerFocus.mock.calls.length;
      await frame();
      await frame();
      expect(composerFocus.mock.calls.length).toBe(stopped);
    });

    it("says it can't once the terminal has ended, or while its host reconnects", async () => {
      const ended = renderWithHandle(itemFor("question"));
      await composer();
      await act(async () =>
        terminalProps.current!.onStreamChange({ watchId: null, ended: true, secretPrompt: false })
      );
      expect(ended.ref.current!.dictation()).toMatchObject({
        ok: false,
        message: expect.stringContaining("ended"),
      });
      ended.unmount();

      const { ref } = renderWithHandle(itemFor("question"), { reconnecting: true });
      await composer();
      await streamOpens({ watchId: 7 });
      expect(ref.current!.dictation()).toMatchObject({
        ok: false,
        message: expect.stringContaining("reconnecting"),
      });
    });
  });

  it("keeps the row on an Escape the reply already used, to cancel its dictation", async () => {
    const h = handlers();
    const { container } = render(<CanopyCard item={itemFor("question")} {...PROPS} {...h} />);
    await composer();
    await streamOpens({ watchId: 7 });
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    container.querySelector("[data-testid=composer]")!.appendChild(editor);
    // As CodeMirror's keymap does when dictation takes the key.
    editor.addEventListener("keydown", (event) => event.preventDefault());

    fireEvent.keyDown(editor, { key: "Escape" });
    expect(h.onLeavePane).not.toHaveBeenCalled();
  });

  it("takes the first choice on Y only when the readers judged the action safe", () => {
    const h = handlers();
    const ref = createRef<CanopyCardHandle>();
    const options = ["Yes", "No"];
    const { rerender } = render(
      <CanopyCard
        ref={ref}
        item={itemFor("approval", { options, risk: "unknown" })}
        {...PROPS}
        {...h}
      />
    );
    act(() => {
      ref.current!.handleKey(keyPress("y"));
    });
    expect(h.onAnswer).not.toHaveBeenCalled();
    rerender(
      <CanopyCard
        ref={ref}
        item={itemFor("approval", { options, risk: "none" })}
        {...PROPS}
        {...h}
      />
    );
    act(() => {
      ref.current!.handleKey(keyPress("y"));
    });
    expect(h.onAnswer).toHaveBeenCalledWith(expect.anything(), "Yes");
  });

  it("answers a risky action's choice only on a second press of its number", () => {
    vi.useFakeTimers();
    try {
      const h = handlers();
      const ref = createRef<CanopyCardHandle>();
      const { container } = render(
        <CanopyCard
          ref={ref}
          item={itemFor("approval", {
            options: ["Yes", "Yes, allow all edits during this session"],
            risk: "caution",
            riskReason: "Rewrites every saved profile",
          })}
          {...PROPS}
          {...h}
        />
      );
      act(() => {
        ref.current!.handleKey(keyPress("2"));
      });
      expect(h.onAnswer).not.toHaveBeenCalled();
      expect(container.querySelector("[data-canopy-answer-armed]")?.textContent).toContain(
        "Press 2 again"
      );
      // Another number arms that one instead; it does not confirm the first.
      act(() => {
        ref.current!.handleKey(keyPress("1"));
      });
      expect(h.onAnswer).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(TRASH_CONFIRM_MS);
      });
      expect(container.querySelector("[data-canopy-answer-armed]")).toBeNull();
      act(() => {
        ref.current!.handleKey(keyPress("2"));
      });
      act(() => {
        ref.current!.handleKey(keyPress("2"));
      });
      expect(h.onAnswer).toHaveBeenCalledWith(
        expect.anything(),
        "Yes, allow all edits during this session"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers by clicking a choice, through the same guarded path as its number", () => {
    const h = handlers();
    const { container } = render(
      <CanopyCard
        item={itemFor("approval", { options: ["Yes", "No"], risk: "none" })}
        {...PROPS}
        {...h}
      />
    );
    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-canopy-choices] button");
    expect(buttons[1]!.textContent).toContain("No");
    fireEvent.click(buttons[1]!);
    expect(h.onAnswer).toHaveBeenCalledWith(expect.anything(), "No");
    const names = Array.from(buttons).map((b) => b.textContent);
    expect(names.some((n) => n?.includes("Reply"))).toBe(true);
    expect(names.some((n) => n?.includes("Go to terminal"))).toBe(true);
  });

  it("takes two clicks on a risky choice, and none while reconnecting", () => {
    const h = handlers();
    const item = itemFor("approval", { options: ["Yes", "No"], risk: "caution" });
    const { container, rerender } = render(<CanopyCard item={item} {...PROPS} {...h} />);
    const first = () => container.querySelector<HTMLButtonElement>("[data-canopy-choices] button")!;
    fireEvent.click(first());
    expect(h.onAnswer).not.toHaveBeenCalled();
    expect(first().textContent).toContain("Press again");
    fireEvent.click(first());
    expect(h.onAnswer).toHaveBeenCalledWith(expect.anything(), "Yes");
    rerender(<CanopyCard item={item} {...PROPS} {...h} reconnecting />);
    expect(first().disabled).toBe(true);
  });

  it("keeps a secret out of the composer, which records history", async () => {
    const { container } = renderCard(
      itemFor("question", { question: "Password:", secretPrompt: true })
    );
    await act(async () => {});
    expect(composerProps.current).toBeNull();
    expect(container.textContent).toContain("type it straight into the terminal");
  });

  it("hides the composer when the live screen asks for a secret the readers haven't seen", async () => {
    const { container } = renderCard({ ...itemFor("question"), card: null, pending: true });
    await composer();
    await streamOpens({ watchId: 7, secretPrompt: true });
    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    expect(container.textContent).toContain("type it straight into the terminal");
  });

  it("keeps Escape inside the terminal from closing the dialog around it", () => {
    const onDialogKey = vi.fn();
    const h = handlers();
    const { container } = render(
      <div onKeyDown={(event) => onDialogKey(event.key)}>
        <CanopyCard item={itemFor("question")} {...PROPS} {...h} />
      </div>
    );
    fireEvent.keyDown(container.querySelector("[data-canopy-terminal]")!, { key: "Escape" });
    expect(onDialogKey).not.toHaveBeenCalled();
  });

  it("titles the pane like the terminal's own, with its controls beside the title", () => {
    const { container, h } = renderCard(itemFor("finished"));
    expect(container.querySelector("h3")?.textContent).toBe("Fix flaky panel tests");
    fireEvent.click(buttonNamed(container, "Go to terminal"));
    expect(h.onOpen).toHaveBeenCalledTimes(1);
  });

  it("takes Cmd+W from inside the pane as trashing the agent's terminal, leaving Canopy open", () => {
    useCanopyStore.setState({ isOpen: true });
    const item = itemFor("working");
    const { pane, h } = renderCard(item);
    expect(pane.hasAttribute("data-close-owner")).toBe(true);
    const request = new Event("daintree:close-request", { cancelable: true });
    pane.querySelector("[data-canopy-terminal]")!.dispatchEvent(request);
    // Not bubbling: the hook hands it to the owner itself.
    expect(h.onTrash).not.toHaveBeenCalled();
    pane.dispatchEvent(request);
    expect(request.defaultPrevented).toBe(true);
    expect(h.onTrash).toHaveBeenCalledTimes(1);
    expect(h.onTrash).toHaveBeenCalledWith(item);
    expect(useCanopyStore.getState().isOpen).toBe(true);
  });

  it("trashes only on a second press, and stands down if none comes", () => {
    vi.useFakeTimers();
    try {
      const { container, h } = renderCard(itemFor("finished"));
      fireEvent.click(buttonNamed(container, "Trash terminal"));
      expect(h.onTrash).not.toHaveBeenCalled();
      // Armed: the control now says what the next press does.
      expect(container.querySelector("button[data-armed]")?.textContent).toContain(
        "Trash terminal"
      );

      act(() => {
        vi.advanceTimersByTime(TRASH_CONFIRM_MS);
      });
      expect(container.querySelector("button[data-armed]")).toBeNull();
      fireEvent.click(buttonNamed(container, "Trash terminal"));
      expect(h.onTrash).not.toHaveBeenCalled();

      fireEvent.click(buttonNamed(container, "Trash terminal"));
      expect(h.onTrash).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't re-arm Trash when the run returns to the screen it was pressed on", () => {
    const h = handlers();
    const finished = itemFor("finished");
    const { container, rerender } = render(<CanopyCard item={finished} {...PROPS} {...h} />);
    fireEvent.click(buttonNamed(container, "Trash terminal"));
    expect(container.querySelector("button[data-armed]")).not.toBeNull();
    rerender(<CanopyCard item={itemFor("working")} {...PROPS} {...h} />);
    expect(container.querySelector("button[data-armed]")).toBeNull();
    rerender(<CanopyCard item={finished} {...PROPS} {...h} />);
    expect(container.querySelector("button[data-armed]")).toBeNull();
    fireEvent.click(buttonNamed(container, "Trash terminal"));
    expect(h.onTrash).not.toHaveBeenCalled();
  });

  it("stands Trash down at once when another agent is selected, even a twin", () => {
    const h = handlers();
    const { container, rerender } = render(
      <CanopyCard item={itemFor("finished")} {...PROPS} {...h} />
    );
    fireEvent.click(buttonNamed(container, "Trash terminal"));
    expect(container.querySelector("button[data-armed]")).not.toBeNull();
    // Launched in the same millisecond, on the same revision: only the id differs.
    const twin = itemFor("finished", {}, "run-2");
    rerender(<CanopyCard item={twin} {...PROPS} {...h} />);
    expect(container.querySelector("button[data-armed]")).toBeNull();
    fireEvent.click(buttonNamed(container, "Trash terminal"));
    expect(h.onTrash).not.toHaveBeenCalled();
  });

  it("offers Trash on every run, a working one included, behind the same two presses", () => {
    const ref = createRef<CanopyCardHandle>();
    const h = handlers();
    const { container } = render(
      <CanopyCard ref={ref} item={itemFor("working")} {...PROPS} {...h} />
    );
    expect(buttonNamed(container, "Trash terminal")).toBeTruthy();
    act(() => {
      ref.current!.handleKey(trashChord());
    });
    expect(h.onTrash).not.toHaveBeenCalled();
    act(() => {
      ref.current!.handleKey(trashChord());
    });
    expect(h.onTrash).toHaveBeenCalledTimes(1);
  });

  it("says a run looks done in its title bar, with Trash an icon until its first press", () => {
    const { container, h } = renderCard(itemFor("finished"));
    const note = container.querySelector<HTMLElement>("[data-canopy-looks-done]");
    expect(note?.textContent).toContain("Looks done");
    // Said in the header, never laid over the terminal's rows.
    expect(note?.closest("[data-canopy-terminal]")).toBeNull();
    const trash = buttonNamed(container, "Trash terminal");
    expect(trash.textContent).not.toContain("Trash terminal");
    fireEvent.click(trash);
    expect(h.onTrash).not.toHaveBeenCalled();
    expect(container.querySelector("button[data-armed]")).toBe(trash);
    expect(trash.textContent).toContain("Trash terminal");
    // Armed, its name is the text it shows, not a hidden label beside it.
    expect(trash.getAttribute("aria-label")).toBeNull();
    fireEvent.click(trash);
    expect(h.onTrash).toHaveBeenCalledTimes(1);
  });

  it("says nothing about being done on a run that is asking something", () => {
    const { container } = renderCard(itemFor("question"));
    expect(container.querySelector("[data-canopy-looks-done]")).toBeNull();
  });

  it("archives the run from its header control and from E on its row", () => {
    const ref = createRef<CanopyCardHandle>();
    const h = handlers();
    const { container } = render(
      <CanopyCard ref={ref} item={itemFor("finished")} {...PROPS} {...h} />
    );
    act(() => {
      buttonNamed(container, "Archive").click();
    });
    act(() => {
      ref.current!.handleKey(keyPress("e"));
    });
    expect(h.onArchive).toHaveBeenCalledTimes(2);
  });

  it("counts a held chord as one press, not the confirming second", () => {
    const ref = createRef<CanopyCardHandle>();
    const h = handlers();
    render(<CanopyCard ref={ref} item={itemFor("finished")} {...PROPS} {...h} />);
    act(() => {
      ref.current!.handleKey(trashChord());
      ref.current!.handleKey(trashChord(true));
      ref.current!.handleKey(trashChord(true));
    });
    expect(h.onTrash).not.toHaveBeenCalled();
    act(() => {
      ref.current!.handleKey(trashChord());
    });
    expect(h.onTrash).toHaveBeenCalledTimes(1);
  });

  it("keeps keyboard focus on Trash while it arms", () => {
    const { container } = renderCard(itemFor("finished"));
    const button = buttonNamed(container, "Trash terminal");
    button.focus();
    fireEvent.click(button);
    expect(container.querySelector("button[data-armed]")).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("disarms when the run's screen or state moves on between the presses", () => {
    const h = handlers();
    const { container, rerender } = render(
      <CanopyCard item={itemFor("finished", { revision: 1 })} {...PROPS} {...h} />
    );
    fireEvent.click(buttonNamed(container, "Trash terminal"));
    // A new screen read in between: the next press arms again, it doesn't trash.
    rerender(<CanopyCard item={itemFor("finished", { revision: 2 })} {...PROPS} {...h} />);
    expect(container.querySelector("button[data-armed]")).toBeNull();
    fireEvent.click(buttonNamed(container, "Trash terminal"));
    expect(h.onTrash).not.toHaveBeenCalled();

    // Back to work and finished again on the same screen: still not armed.
    rerender(<CanopyCard item={itemFor("working", { revision: 2 })} {...PROPS} {...h} />);
    rerender(<CanopyCard item={itemFor("idle", { revision: 2 })} {...PROPS} {...h} />);
    expect(container.querySelector("button[data-armed]")).toBeNull();
  });
  describe("the pane's state chip", () => {
    // The row carries the run's band, as the fleet places it, beside the run.
    function withRun(overrides: Partial<FleetRunRow>): CanopyItem {
      const base = itemFor("finished");
      const run = { ...base.row.run, ...overrides };
      return { ...base, row: { ...base.row, run, band: bandForRun(run) } };
    }
    const chip = (container: HTMLElement) =>
      container.querySelector('[role="status"][aria-label^="Agent state"]');

    it("draws a hand-back as unread, then as finished once read, from a prompt or a completion", () => {
      for (const agentState of ["waiting", "completed"] as const) {
        const unread = renderCard(withRun({ agentState, handBack: { stoppedAt: NOW - 1 } }));
        expect(chip(unread.container)?.getAttribute("aria-label")).toBe("Agent state: unread");
        unread.unmount();

        const read = renderCard(
          withRun({ agentState, handBack: { stoppedAt: NOW - 2, seenAt: NOW - 1 } })
        );
        expect(chip(read.container)?.getAttribute("aria-label")).toBe("Agent state: finished");
        read.unmount();
      }
    });

    it("draws an approval wait amber only for an unread Canopy ask, whatever the hand-back says", () => {
      const approval = {
        agentState: "waiting",
        waitingReason: "approval",
        handBack: { stoppedAt: NOW - 2, seenAt: NOW - 1 },
      } as const;
      const asked = renderCard(
        withRun({
          ...approval,
          canopy: { kind: "asked", quote: "Run npm test?", readAt: NOW - 1, seen: false },
        })
      );
      expect(chip(asked.container)?.getAttribute("aria-label")).toBe("Agent state: waiting");
      asked.unmount();

      // With no reading it is the patterns' guess: unread until looked at.
      const guessed = renderCard(withRun(approval));
      expect(chip(guessed.container)?.getAttribute("aria-label")).toBe("Agent state: unread");
    });

    it("draws nothing for a prompt that asks nothing", () => {
      const { container } = renderCard(withRun({ agentState: "waiting" }));
      expect(chip(container)).toBeNull();
    });

    describe("the pane this view holds speaks for the run", () => {
      const ask = { kind: "asked", quote: "Run npm test?", readAt: NOW - 1, seen: false } as const;
      const viewWindow = window as { __DAINTREE_INITIAL_PROJECT__?: { id: string } };

      function holdPane(observation: Partial<PtyPanelData>) {
        const pane = {
          id: "run-1",
          kind: "terminal",
          title: "Claude",
          location: "grid",
          cwd: "/Users/dev/app",
          cols: 80,
          rows: 24,
          launchAgentId: "claude",
          ...observation,
        } as PtyPanelData;
        usePanelStore.setState({ panelsById: { "run-1": pane }, panelIds: ["run-1"] });
      }

      afterEach(() => {
        delete viewWindow.__DAINTREE_INITIAL_PROJECT__;
        usePanelStore.setState({ panelsById: {}, panelIds: [] });
      });

      it("drops the ask's amber once its own pane restarts or works, ahead of the row", () => {
        viewWindow.__DAINTREE_INITIAL_PROJECT__ = { id: "p1" };
        holdPane({ agentState: "waiting", isRestarting: true });
        const restarting = renderCard(withRun({ agentState: "waiting", canopy: ask }));
        expect(chip(restarting.container)).toBeNull();
        restarting.unmount();

        holdPane({ agentState: "working" });
        const working = renderCard(withRun({ agentState: "waiting", canopy: ask }));
        expect(chip(working.container)?.getAttribute("aria-label")).toBe("Agent state: working");
      });

      it("follows its own pane past an exit or a stop the row still reports", () => {
        viewWindow.__DAINTREE_INITIAL_PROJECT__ = { id: "p1" };
        // The row as the fleet built it for an exited run: its chrome has exited.
        const exitedRun = { ...itemFor("finished").row.run, agentState: "exited" as const };
        const exited = buildPilotGroups([exitedRun], {
          workspaces: new Map([["p1", { kind: "project", name: "app" }]]),
          currentWorkspaceId: null,
          nowMs: NOW,
        }).flatMap((group) => group.rows)[0]!;
        const base = itemFor("finished");
        holdPane({ agentState: "working", runtimeStatus: "running" });
        const restarted = renderCard({ ...base, row: { ...base.row, ...exited } } as CanopyItem);
        expect(chip(restarted.container)?.getAttribute("aria-label")).toBe("Agent state: working");
        restarted.unmount();

        holdPane({ agentState: "waiting", runtimeStatus: "exited" });
        const gone = renderCard(withRun({ agentState: "waiting", canopy: ask }));
        expect(chip(gone.container)).toBeNull();
        gone.unmount();

        // An exit on record outranks a stale working state, as on the pane.
        holdPane({ agentState: "working", runtimeStatus: "exited" });
        const exitedPane = renderCard(withRun({ agentState: "working" }));
        expect(chip(exitedPane.container)).toBeNull();
      });

      it("keeps the row's own observation for another project's run under the same id", () => {
        viewWindow.__DAINTREE_INITIAL_PROJECT__ = { id: "p2" };
        holdPane({ agentState: "waiting", isRestarting: true });
        const { container } = renderCard(withRun({ agentState: "waiting", canopy: ask }));
        expect(chip(container)?.getAttribute("aria-label")).toBe("Agent state: waiting");
      });
    });

    it("draws nothing for a completion with no hand-back", () => {
      const { container } = renderCard(withRun({ agentState: "completed" }));
      expect(chip(container)).toBeNull();
    });
  });

  describe("summary strip", () => {
    it("carries what the row leaves out: the summary, progress, reports and the assistant", () => {
      const view = render(
        <CanopyCard
          item={itemFor("finished", {
            summary: "Shipped the rounding fix.",
            progress: 75,
            steps: { done: 4, total: 6, current: "Run tests" },
            tests: "passing",
          })}
          {...PROPS}
          {...handlers()}
          workLabel="Started by Claude"
        />
      );
      const strip = view.container.querySelector("[data-canopy-summary]")!;
      expect(strip.textContent).toContain("Shipped the rounding fix.");
      expect(strip.textContent).toContain("Reported: tests pass");
      expect(strip.textContent).toContain("Started by Claude");
      expect(strip.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("75");
    });

    it("is absent when there is nothing to say", () => {
      const { container } = renderCard(itemFor("idle", { summary: null, headline: null }));
      expect(container.querySelector("[data-canopy-summary]")).toBeNull();
    });
  });
});
