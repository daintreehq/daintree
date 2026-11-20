// @vitest-environment jsdom
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DecisionsAnswerDestination,
  DecisionsAnswerDestinations,
  DecisionsAnswerOutcome,
  DecisionsAttentionItem,
  DecisionsAttentionList,
} from "@shared/types/decisionsAttention";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { DecisionsAttentionDialog } from "../DecisionsAttentionDialog";

vi.mock("@/hooks/useWorktrees", () => ({ useWorktrees: () => ({ worktrees: [] }) }));

const listAttention = vi.fn<() => Promise<DecisionsAttentionList>>();
const markAnswerHandled =
  vi.fn<(payload: { questionId: string }) => Promise<DecisionsAnswerOutcome>>();
const listAnswerDestinations =
  vi.fn<(questionId: string) => Promise<DecisionsAnswerDestinations>>();

/** The list as main would read it now; actions change it before the next read. */
let listed: DecisionsAttentionItem[] = [];

function makeItem(
  alias: number,
  over: Partial<DecisionsAttentionItem> = {}
): DecisionsAttentionItem {
  return {
    questionId: `qid-${alias}`,
    alias,
    status: "needs-attention",
    reason: "pane_gone",
    question: `Question ${alias}?`,
    askedAt: "2026-11-01T09:00:00.000Z",
    origin: {
      projectId: "project-1",
      projectName: "Helios",
      worktreeId: "worktree-1",
      worktreeName: "main",
      agentId: "claude",
      agentName: "Claude",
      paneId: `pane-${alias}`,
      paneTitle: `Pane ${alias}`,
      otherHost: null,
    },
    answer: {
      source: "human",
      choices: ["Approve"],
      text: null,
      correction: false,
      answeredAt: "2026-11-01T09:30:00.000Z",
    },
    answerUnavailable: null,
    notice: null,
    followUps: [],
    canResume: true,
    canReassign: true,
    ...over,
  };
}

function tree(isOpen: boolean, onClose: () => void = vi.fn()) {
  return (
    <TooltipProvider>
      <DecisionsAttentionDialog isOpen={isOpen} onClose={onClose} />
    </TooltipProvider>
  );
}

/** A dialog plays its exit and focus is handed on a timer, so these waits outlast a loaded runner. */
function waitFor(check: () => void) {
  return vi.waitFor(check, { timeout: 4000 });
}

async function listedRows(count: number) {
  await waitFor(() =>
    expect(screen.getAllByTestId("decisions-attention-item")).toHaveLength(count)
  );
}

function markButton(alias: number): HTMLButtonElement {
  return screen.getByRole("button", { name: `Mark q-${alias} handled` }) as HTMLButtonElement;
}

/** The first action of a question's row: where focus lands when its neighbour leaves. */
function firstAction(alias: number): HTMLElement {
  const row = screen
    .getAllByTestId("decisions-attention-item")
    .find((candidate) => candidate.getAttribute("data-question-id") === `qid-${alias}`);
  const action = row?.querySelector<HTMLElement>("[data-attention-action]");
  if (!action) throw new Error(`no row for q-${alias}`);
  return action;
}

function confirm(): HTMLElement | null {
  return screen.queryByRole("alertdialog");
}

async function confirmGone() {
  await waitFor(() => expect(confirm()).toBeNull());
}

/** Clicks Mark handled the way a pointer does, focus first, and waits for the confirm to take its focus. */
async function ask(alias: number): Promise<HTMLElement> {
  const button = markButton(alias);
  act(() => button.focus());
  fireEvent.click(button);
  const asking = await screen.findByRole("alertdialog");
  await waitFor(() =>
    expect(document.activeElement).toBe(within(asking).getByRole("button", { name: "Cancel" }))
  );
  return asking;
}

function stubElectron() {
  Object.defineProperty(window, "electron", {
    value: {
      decisions: { listAttention, markAnswerHandled, listAnswerDestinations },
      terminal: { onDecisionState: () => () => {} },
    },
    configurable: true,
    writable: true,
  });
}

function handlesQuestions() {
  markAnswerHandled.mockImplementation(async ({ questionId }) => {
    listed = listed.filter((item) => item.questionId !== questionId);
    return { result: "handled" };
  });
}

describe("DecisionsAttentionDialog: Mark handled (#16638)", () => {
  beforeEach(() => {
    listed = [];
    listAttention.mockReset();
    markAnswerHandled.mockReset();
    listAttention.mockImplementation(async () => ({ result: "listed", items: listed }));
    stubElectron();
    useDecisionsAttentionStore.setState({
      isOpen: true,
      request: { terminalId: null, returnFocusTo: null, seq: 1 },
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("asks first, naming the question and where it was asked, while it can still be resumed or sent on", async () => {
    listed = [makeItem(3), makeItem(4, { canResume: false }), makeItem(5, { canReassign: false })];
    render(tree(true));
    await listedRows(3);

    for (const alias of [3, 4, 5]) {
      const asking = await ask(alias);
      expect(within(asking).getByText(`Mark q-${alias} handled?`)).toBeTruthy();
      expect(asking.textContent).toContain(`Question ${alias}?`);
      expect(asking.textContent).toContain(`Pane ${alias}`);
      expect(asking.textContent).toContain("Claude · Helios · main");
      expect(asking.textContent).toContain("won't type it in");
      expect(markAnswerHandled).not.toHaveBeenCalled();

      fireEvent.click(within(asking).getByRole("button", { name: "Cancel" }));
      await confirmGone();
    }
  });

  it("leaves the item and its actions as they were when cancelled, and hands focus back", async () => {
    listed = [makeItem(3), makeItem(4)];
    render(tree(true));
    await listedRows(2);

    // Cancel has the first focus, so a stray Enter doesn't take the answer away.
    const asking = await ask(3);
    fireEvent.click(within(asking).getByRole("button", { name: "Cancel" }));
    await confirmGone();

    expect(markAnswerHandled).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("decisions-attention-item")).toHaveLength(2);
    for (const name of ["Try resume for q-3", "Choose destination for q-3", "Mark q-3 handled"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByTestId("decisions-attention-outcome")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(markButton(3)));
  });

  it.each([
    { alias: 4, next: 5, where: "from the middle of the list, the row after it" },
    { alias: 5, next: 4, where: "from the end of the list, the row before it" },
  ])(
    "marks it handled once on the confirm, then lands focus on a neighbour $where",
    async ({ alias, next }) => {
      listed = [makeItem(3), makeItem(4), makeItem(5)];
      handlesQuestions();
      render(tree(true));
      await listedRows(3);

      const asking = await ask(alias);
      fireEvent.click(within(asking).getByRole("button", { name: "Mark handled" }));

      await waitFor(() => expect(markAnswerHandled).toHaveBeenCalledTimes(1));
      expect(markAnswerHandled).toHaveBeenCalledWith({ questionId: `qid-${alias}` });
      await listedRows(2);
      await confirmGone();

      expect(screen.getByTestId("decisions-attention-outcome").textContent).toContain(
        `Answer to q-${alias} marked handled`
      );
      await waitFor(() => expect(document.activeElement).toBe(firstAction(next)));
    }
  );

  it.each([
    {
      how: "fails",
      settle: () => Promise.reject(new Error("The relay went away")),
      said: "The relay went away",
    },
    {
      how: "is refused",
      settle: () => Promise.resolve({ result: "refused", reason: "not-running" } as const),
      said: "Decisions isn't running, so nothing changed",
    },
  ])(
    "keeps the item, says why and hands focus back when marking it $how",
    async ({ settle, said }) => {
      listed = [makeItem(3), makeItem(4)];
      markAnswerHandled.mockImplementation(settle);
      render(tree(true));
      await listedRows(2);

      const asking = await ask(3);
      fireEvent.click(within(asking).getByRole("button", { name: "Mark handled" }));

      await waitFor(() =>
        expect(screen.getByTestId("decisions-attention-outcome").textContent).toContain(said)
      );
      await confirmGone();
      expect(markAnswerHandled).toHaveBeenCalledTimes(1);
      expect(screen.getAllByTestId("decisions-attention-item")).toHaveLength(2);
      await waitFor(() => expect(document.activeElement).toBe(markButton(3)));
    }
  );

  it("marks an item handled in one click when it offers neither Try resume nor Choose destination", async () => {
    listed = [
      makeItem(3, { status: "delivery-uncertain", canResume: false, canReassign: false }),
      makeItem(4),
    ];
    handlesQuestions();
    render(tree(true));
    await listedRows(2);

    fireEvent.click(markButton(3));

    expect(confirm()).toBeNull();
    await waitFor(() => expect(markAnswerHandled).toHaveBeenCalledWith({ questionId: "qid-3" }));
    await listedRows(1);
    expect(screen.getByTestId("decisions-attention-outcome").textContent).toContain(
      "Answer to q-3 marked handled"
    );
  });

  it("names where each held follow-up was sent from (#17238)", async () => {
    const held = {
      status: "needs-attention" as const,
      reason: "pane_gone",
      unreadable: false,
      sentAt: "2026-11-01T10:00:00.000Z",
    };
    listed = [
      makeItem(5, {
        answer: null,
        followUps: [
          { ...held, messageId: "m-phone", onComputer: false, text: "From the phone." },
          { ...held, messageId: "m-desk", onComputer: true, text: "From the desk." },
        ],
      }),
    ];
    render(tree(true));
    await listedRows(1);

    const captions = [...document.querySelectorAll("figcaption")].map((el) => el.textContent ?? "");
    expect(captions.filter((text) => text.startsWith("Your follow-up from"))).toEqual([
      expect.stringContaining("from your phone"),
      expect.stringContaining("from your computer"),
    ]);
  });

  it("drops a confirmation with the list that asked it, so a reopening shows none", async () => {
    listed = [makeItem(3), makeItem(4)];
    const { rerender } = render(tree(true));
    await listedRows(2);
    await ask(3);

    rerender(tree(false));
    await confirmGone();
    rerender(tree(true));
    await listedRows(2);

    expect(confirm()).toBeNull();
    expect(markAnswerHandled).not.toHaveBeenCalled();
  });
});

function destination(terminalId: string, title: string): DecisionsAnswerDestination {
  return {
    terminalId,
    title,
    agentId: "claude",
    agentName: "Claude",
    projectId: "project-1",
    projectName: "Helios",
    worktreeId: "worktree-1",
    worktreeName: "main",
    askedHere: false,
  };
}

function settleable<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function destinationsMenu(): HTMLElement | null {
  return screen.queryByRole("menu");
}

async function openDestinations(alias: number) {
  const trigger = screen.getByRole("button", { name: `Choose destination for q-${alias}` });
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: "Enter" });
  await waitFor(() => expect(destinationsMenu()).not.toBeNull());
}

async function closeDestinations() {
  fireEvent.keyDown(destinationsMenu()!, { key: "Escape" });
  await waitFor(() => expect(destinationsMenu()).toBeNull());
}

function menuRows(): string[] {
  return within(destinationsMenu()!)
    .getAllByRole("menuitem")
    .map((row) => row.textContent ?? "");
}

describe("DecisionsAttentionDialog: a timeout notice (#17944)", () => {
  /** Past the list's 300 ms debounce, so a read it would make has started. */
  const PAST_REFRESH_DEBOUNCE_MS = 400;

  /** Listeners on the question list every window gets, by the event's name. */
  let events: Map<string, Set<(payload: unknown) => void>>;
  let revision = 0;

  /** The question list every window gets, holding these questions as needing a person. */
  function questionsChanged(...held: string[]) {
    revision += 1;
    const list = {
      revision,
      questions: held.map((questionId) => ({
        reference: { hostId: "host-1", projectId: "project-1", terminalId: "pane", questionId },
        standing: { kind: "needs-attention", deliveryStatus: "needs-attention" },
        stall: { answerRevision: 0, followUpIds: [], reason: "pane_gone" },
      })),
    };
    act(() => {
      for (const callback of events.get("decisions:questions-changed") ?? []) callback(list);
    });
  }

  const NOTICE: DecisionsAttentionItem["notice"] = {
    kind: "expired",
    revision: 0,
    deadline: "2026-11-01T09:45:00.000Z",
    delivery: "needs-attention",
    disposition: "fallback-due",
  };

  function noticeItem(alias: number, over: Partial<DecisionsAttentionItem> = {}) {
    return makeItem(alias, { answer: null, notice: NOTICE, canReassign: false, ...over });
  }

  beforeEach(() => {
    listed = [];
    events = new Map();
    listAttention.mockReset();
    markAnswerHandled.mockReset();
    listAttention.mockImplementation(async () => ({ result: "listed", items: listed }));
    Object.defineProperty(window, "electron", {
      value: {
        decisions: { listAttention, markAnswerHandled, listAnswerDestinations },
        terminal: { onDecisionState: () => () => {} },
        events: {
          on: (name: string, callback: (payload: unknown) => void) => {
            const named = events.get(name) ?? new Set();
            named.add(callback);
            events.set(name, named);
            return () => named.delete(callback);
          },
        },
      },
      configurable: true,
      writable: true,
    });
    useDecisionsAttentionStore.setState({
      isOpen: true,
      request: { terminalId: null, returnFocusTo: null, seq: 1 },
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("names the notice, says how the question ended apart from how far typing it got, and offers only its own session", async () => {
    listed = [noticeItem(3)];
    render(tree(true));
    await listedRows(1);
    const row = screen.getByTestId("decisions-attention-item");

    expect(row.textContent).toContain("Timeout notice needs attention.");
    expect(row.textContent).toContain("The terminal that asked was closed.");
    expect(row.textContent).toContain("Timeout notice, not typed in");
    expect(row.textContent).toContain("Its deadline passed without an answer.");
    expect(row.textContent).toContain(
      "The notice says the agent may go ahead with its stated plan."
    );
    expect(row.textContent).not.toContain("No answer is waiting");
    expect(within(row).getByRole("button", { name: "Try resume for q-3" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Choose destination/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /^Copy/ })).toBeNull();
  });

  it("says a possibly typed notice may or may not have been delivered, and what it may have said", async () => {
    listed = [
      noticeItem(3, {
        status: "delivery-uncertain",
        reason: "crash_unreconciled",
        notice: { ...NOTICE, delivery: "delivery-uncertain" },
        canResume: false,
      }),
    ];
    render(tree(true));
    await listedRows(1);
    const row = screen.getByTestId("decisions-attention-item");

    expect(row.textContent).toContain("This timeout notice may or may not have been delivered.");
    expect(row.textContent).toContain("Daintree stopped while typing it in");
    expect(row.textContent).toContain("Timeout notice, may or may not have been typed in");
    expect(row.textContent).not.toMatch(/told the agent|went ahead/);
    expect(within(row).queryByRole("button", { name: /Try resume/ })).toBeNull();
  });

  it("drops a notice another window handled once the question list changes, though no pane here moved", async () => {
    listed = [noticeItem(3), makeItem(4)];
    render(tree(true));
    await listedRows(2);
    expect(events.get("decisions:questions-changed")?.size).toBe(1);

    questionsChanged("qid-3", "qid-4");
    await waitFor(() => expect(listAttention).toHaveBeenCalledTimes(2));
    // A list change that leaves what needs a person the same reads nothing more.
    questionsChanged("qid-3", "qid-4");
    await new Promise((resolve) => setTimeout(resolve, PAST_REFRESH_DEBOUNCE_MS));
    expect(listAttention).toHaveBeenCalledTimes(2);

    // Handled in another window: main's list no longer holds it, and only the question list says so here.
    listed = [makeItem(4)];
    questionsChanged("qid-4");
    await listedRows(1);
    expect(screen.getByTestId("decisions-attention-item").getAttribute("data-question-id")).toBe(
      "qid-4"
    );
  });

  it("drops a Mark handled confirmation once another window handled the notice, and marks nothing", async () => {
    listed = [noticeItem(3), makeItem(4)];
    render(tree(true));
    await listedRows(2);
    const asking = await ask(3);
    expect(within(asking).getByText(/Its timeout notice leaves this list/)).toBeTruthy();

    listed = [makeItem(4)];
    questionsChanged("qid-4");
    await listedRows(1);
    await confirmGone();
    expect(markAnswerHandled).not.toHaveBeenCalled();
  });

  it("drops a confirmation once the question shows something new, though it is still listed", async () => {
    listed = [noticeItem(3)];
    render(tree(true));
    await listedRows(1);
    await ask(3);

    // Reopened and timed out again: the same question, a later round's notice.
    listed = [noticeItem(3, { notice: { ...NOTICE, revision: 1 } })];
    questionsChanged("qid-3", "round-1");
    await confirmGone();
    expect(markAnswerHandled).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("decisions-attention-item")).toHaveLength(1);
  });

  it("stops following the question list once closed", async () => {
    listed = [noticeItem(3)];
    const { rerender } = render(tree(true));
    await listedRows(1);
    useDecisionsAttentionStore.setState({ isOpen: false });
    rerender(tree(false));
    await waitFor(() => expect(events.get("decisions:questions-changed")?.size ?? 0).toBe(0));
  });
});

describe("DecisionsAttentionDialog: Choose destination (#17560)", () => {
  beforeEach(() => {
    listed = [makeItem(3)];
    listAttention.mockReset();
    listAnswerDestinations.mockReset();
    listAttention.mockImplementation(async () => ({ result: "listed", items: listed }));
    stubElectron();
    useDecisionsAttentionStore.setState({
      isOpen: true,
      request: { terminalId: null, returnFocusTo: null, seq: 1 },
    });
  });
  afterEach(() => {
    cleanup();
  });

  it.each([
    {
      how: "lists agents that have since gone",
      settle: (older: ReturnType<typeof settleable<DecisionsAnswerDestinations>>) =>
        older.resolve({ result: "listed", destinations: [destination("pane-old", "Gone agent")] }),
    },
    {
      how: "fails",
      settle: (older: ReturnType<typeof settleable<DecisionsAnswerDestinations>>) =>
        older.reject(new Error("The relay went away")),
    },
  ])(
    "keeps the reopened menu's agents when the lookup of a closed opening $how afterwards",
    async ({ settle }) => {
      const older = settleable<DecisionsAnswerDestinations>();
      const newer = settleable<DecisionsAnswerDestinations>();
      listAnswerDestinations.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      const onClose = vi.fn();
      render(tree(true, onClose));
      await listedRows(1);

      await openDestinations(3);
      expect(menuRows()).toEqual(["Looking…"]);
      await closeDestinations();
      // Escape closed the menu alone: the same row reopens it, not a remounted list.
      expect(onClose).not.toHaveBeenCalled();
      await openDestinations(3);
      expect(listAnswerDestinations).toHaveBeenCalledTimes(2);

      await act(async () => {
        newer.resolve({ result: "listed", destinations: [destination("pane-new", "Fresh agent")] });
      });
      await waitFor(() => expect(menuRows()[0]).toContain("Fresh agent"));

      await act(async () => {
        settle(older);
        await older.promise.catch(() => {});
      });

      const rows = menuRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("Fresh agent");
      expect(destinationsMenu()!.textContent).not.toContain("Gone agent");
      expect(destinationsMenu()!.textContent).not.toContain("The relay went away");
    }
  );
});

describe("DecisionsAttentionDialog: an opening for a pane (#17562)", () => {
  /** Reads held until the test lets them land, oldest first. */
  let held: Array<() => void> = [];
  /** A pane's Decisions state changing, as main pushes it to the open list. */
  let pushPaneState: ((state: unknown) => void) | null = null;

  /** Each read lists `listed` as it stood when the read began, or fails with `failure`. */
  function holdReads(failure?: Error) {
    listAttention.mockImplementation(() => {
      const snapshot = listed;
      return new Promise((resolve, reject) => {
        held.push(() =>
          failure === undefined ? resolve({ result: "listed", items: snapshot }) : reject(failure)
        );
      });
    });
  }

  async function landReads() {
    await act(async () => {
      const pending = held;
      held = [];
      for (const land of pending) land();
    });
  }

  async function landOldestRead() {
    await act(async () => {
      held.shift()?.();
    });
  }

  function openFor(terminalId: string) {
    act(() => useDecisionsAttentionStore.getState().open(terminalId));
  }

  /** The dialog's own surface, where its initial focus goes while a read is out. */
  function surface(): Element | null {
    return screen.getByTestId("decisions-attention-dialog").firstElementChild;
  }

  /** The list's own place in the dialog, holding its description. */
  function listPlace(): Element | null {
    const id = screen.getByTestId("decisions-attention-dialog").getAttribute("aria-describedby");
    return id === null ? null : (document.getElementById(id)?.parentElement ?? null);
  }

  /** Opened for pane 3 alone, settled on its answer, then closed with the list kept. */
  async function closeAfterFirstOpening(rerender: (ui: ReactElement) => void) {
    listed = [makeItem(3)];
    openFor("pane-3");
    rerender(tree(true));
    await listedRows(1);
    await waitFor(() => expect(document.activeElement).toBe(firstAction(3)));

    act(() => useDecisionsAttentionStore.getState().close());
    rerender(tree(false));
    await waitFor(() => expect(screen.queryByTestId("decisions-attention-dialog")).toBeNull());
  }

  /**
   * Reopened for pane 4 with its read held, listing `next` once it lands: the
   * last opening's list, pane 3 alone, shows meanwhile, and the dialog's own
   * surface holds focus.
   */
  async function reopenForPane4(
    rerender: (ui: ReactElement) => void,
    next = [makeItem(3), makeItem(4)]
  ) {
    listed = next;
    holdReads();
    openFor("pane-4");
    rerender(tree(true));
    await waitFor(() => expect(held).toHaveLength(1));
    expect(
      screen.getAllByTestId("decisions-attention-item").map((row) => row.dataset.questionId)
    ).toEqual(["qid-3"]);
    await waitFor(() => expect(document.activeElement).toBe(surface()));
  }

  beforeEach(() => {
    listed = [];
    held = [];
    pushPaneState = null;
    listAttention.mockReset();
    markAnswerHandled.mockReset();
    listAttention.mockImplementation(async () => ({ result: "listed", items: listed }));
    Object.defineProperty(window, "electron", {
      value: {
        decisions: { listAttention, markAnswerHandled },
        terminal: {
          onDecisionState: (callback: (state: unknown) => void) => {
            pushPaneState = callback;
            return () => {
              pushPaneState = null;
            };
          },
        },
      },
      configurable: true,
      writable: true,
    });
    useDecisionsAttentionStore.setState({
      isOpen: false,
      request: { terminalId: null, returnFocusTo: null, seq: 0 },
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("lands on the opening pane's answer from the first read", async () => {
    listed = [makeItem(3), makeItem(4)];
    const { rerender } = render(tree(false));
    openFor("pane-4");
    rerender(tree(true));

    await listedRows(2);
    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
  });

  it("reopened for a pane whose answer arrived while it was closed, lands on that answer once it is read", async () => {
    const { rerender } = render(tree(false));
    await closeAfterFirstOpening(rerender);
    await reopenForPane4(rerender);

    await landReads();
    await listedRows(2);
    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
  });

  it("leaves focus where the person moved it while the opening's read was out", async () => {
    const { rerender } = render(tree(false));
    await closeAfterFirstOpening(rerender);
    await reopenForPane4(rerender);

    const chosen = markButton(3);
    act(() => chosen.focus());
    await landReads();
    await listedRows(2);

    expect(document.activeElement).toBe(chosen);
  });

  it("lands on the answer when the control the person moved to went with the refresh", async () => {
    const { rerender } = render(tree(false));
    await closeAfterFirstOpening(rerender);
    await reopenForPane4(rerender, [makeItem(4)]);

    act(() => markButton(3).focus());
    await landReads();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Mark q-3 handled" })).toBeNull()
    );

    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
  });

  it("lands on the answer when focus went back behind the dialog during the read", async () => {
    const { rerender } = render(tree(false));
    await closeAfterFirstOpening(rerender);
    await reopenForPane4(rerender);

    // What a closing popover does when it hands focus back to the chip that opened the list.
    const chip = document.createElement("button");
    document.body.append(chip);
    onTestFinished(() => chip.remove());
    act(() => chip.focus());
    await landReads();
    await listedRows(2);

    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
  });

  it("leaves focus in a confirmation opened while the opening's read was out", async () => {
    const { rerender } = render(tree(false));
    await closeAfterFirstOpening(rerender);
    await reopenForPane4(rerender);

    // An assistive technology's press activates a control without focusing it.
    fireEvent.click(markButton(3));
    const asking = await screen.findByRole("alertdialog");
    const cancel = within(asking).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await landReads();
    await listedRows(2);

    expect(document.activeElement).toBe(cancel);
  });

  /**
   * Opened for pane 3 and settled on its answer, then opened for pane 4 with
   * its read held, with the window away from the start when `windowAway`.
   */
  async function reopenWhileOpenForPane4({ windowAway = false } = {}): Promise<HTMLElement> {
    listed = [makeItem(3)];
    const { rerender } = render(tree(false));
    openFor("pane-3");
    rerender(tree(true));
    await listedRows(1);
    const old = firstAction(3);
    await waitFor(() => expect(document.activeElement).toBe(old));

    listed = [makeItem(3), makeItem(4)];
    holdReads();
    const away = windowAway ? vi.spyOn(document, "hasFocus").mockReturnValue(false) : null;
    onTestFinished(() => away?.mockRestore());
    openFor("pane-4");
    await waitFor(() => expect(held).toHaveLength(1));
    away?.mockRestore();
    return old;
  }

  it("reopened while open, lands on the new pane's answer though the window hands focus back to the old one", async () => {
    const old = await reopenWhileOpenForPane4();

    // Coming back to the window, the browser fires focus at what held it when the window lost it.
    act(() => {
      window.dispatchEvent(new FocusEvent("blur"));
      old.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    await landReads();
    await listedRows(2);

    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
  });

  it("reopened while the window was away, lands on the new pane's answer once it comes back", async () => {
    const old = await reopenWhileOpenForPane4({ windowAway: true });

    act(() => {
      old.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    await landReads();
    await listedRows(2);

    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
  });

  it("reopened while open, leaves focus on the old answer when the person goes back to it", async () => {
    const old = await reopenWhileOpenForPane4();

    act(() => old.blur());
    act(() => old.focus());
    await landReads();
    await listedRows(2);

    expect(document.activeElement).toBe(old);
  });

  it("waits for the opening's latest read, not one a later read superseded", async () => {
    const { rerender } = render(tree(false));
    await closeAfterFirstOpening(rerender);
    await reopenForPane4(rerender);

    // A pane's push reads again for the same opening once its burst settles.
    act(() => pushPaneState?.({}));
    await waitFor(() => expect(held).toHaveLength(2));
    await landOldestRead();
    expect(screen.getAllByTestId("decisions-attention-item")).toHaveLength(1);
    expect(document.activeElement).toBe(surface());

    await landReads();
    await listedRows(2);
    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
  });

  it("holds focus in the list's place, not a stale row, when the opening's read fails", async () => {
    const { rerender } = render(tree(false));
    await closeAfterFirstOpening(rerender);

    holdReads(new Error("The relay went away"));
    openFor("pane-3");
    rerender(tree(true));
    await waitFor(() => expect(document.activeElement).toBe(surface()));
    await landReads();

    await waitFor(() => expect(screen.getByText("The relay went away")).toBeTruthy());
    // The last opening's row for the pane is still on show beside the error.
    await listedRows(1);
    await waitFor(() => expect(document.activeElement).toBe(listPlace()));
  });
});
