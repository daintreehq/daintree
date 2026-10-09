// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender } from "@testing-library/react";
import { createRef, type KeyboardEvent, type ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { CanopyCard as CanopyCardData, CanopyCategory } from "@shared/types/ipc/canopy";
import { buildPilotGroups } from "@/components/Pilot/pilotRows";
import { buildCanopyInbox, type CanopyItem } from "../canopyModel";
import {
  TRASH_CONFIRM_MS,
  CanopyCard,
  type CanopyCardHandle,
  type CanopyCardHandlers,
} from "../CanopyCard";

interface ComposerProps {
  terminalId: string;
  isolated: boolean;
  disabled: boolean;
  onSend: (payload: { text: string; imagePaths?: string[] }) => void;
  onSendKey: (key: string) => void;
  submitText?: (text: string, imagePaths: string[]) => Promise<boolean>;
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

const { submit, sendKey, composerProps, terminalProps } = vi.hoisted(() => ({
  submit: vi.fn(async (..._args: unknown[]) => {}),
  sendKey: vi.fn(async (..._args: unknown[]) => {}),
  composerProps: { current: null as ComposerProps | null },
  terminalProps: { current: null as TerminalProps | null },
}));

// The live terminal needs a canvas and a PTY host; here only what it is handed matters.
vi.mock("../CanopyTerminal", () => ({
  CanopyTerminal: (props: TerminalProps) => {
    terminalProps.current = props;
    return <div data-canopy-terminal="" />;
  },
}));

vi.mock("@/components/Terminal/HybridInputBar", () => ({
  HybridInputBar: (props: ComposerProps) => {
    composerProps.current = props;
    return <div data-testid="composer" />;
  },
}));

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { canopy: { terminalSubmit: submit, terminalSendKey: sendKey } },
  });
  submit.mockClear();
  sendKey.mockClear();
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

  it("passes the composer's keys to the terminal, but Escape goes back to the list", async () => {
    renderCard(itemFor("approval", { options: ["Yes", "No"] }));
    const { h } = { h: currentHandlers! };
    await streamOpens({ watchId: 7 });
    // Escape leaves the reply rather than interrupting the agent's turn.
    await act(async () => (await composer()).onSendKey("escape"));
    expect(sendKey).not.toHaveBeenCalled();
    expect(h.onLeavePane).toHaveBeenCalledTimes(1);
    // Arrows steer the agent's menu; only Enter answers and moves the panel on.
    await act(async () => (await composer()).onSendKey("up"));
    expect(sendKey).toHaveBeenCalledWith(7, "up");
    expect(h.onSent).not.toHaveBeenCalled();
    await act(async () => (await composer()).onSendKey("enter"));
    expect(h.onSent).toHaveBeenCalledTimes(1);
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
});
