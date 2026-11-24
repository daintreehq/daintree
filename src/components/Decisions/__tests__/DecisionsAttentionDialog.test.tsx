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
  ReassignDecisionsAnswerPayload,
} from "@shared/types/decisionsAttention";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";
import { DecisionsAttentionDialog } from "../DecisionsAttentionDialog";

vi.mock("@/hooks/useWorktrees", () => ({ useWorktrees: () => ({ worktrees: [] }) }));

const listAttention = vi.fn<() => Promise<DecisionsAttentionList>>();
const markAnswerHandled =
  vi.fn<(payload: { questionId: string }) => Promise<DecisionsAnswerOutcome>>();
const listAnswerDestinations =
  vi.fn<(questionId: string) => Promise<DecisionsAnswerDestinations>>();
const reassignAnswer =
  vi.fn<(payload: ReassignDecisionsAnswerPayload) => Promise<DecisionsAnswerOutcome>>();

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
    fullQuestion: `Question ${alias}?`,
    plan: null,
    reference: {
      hostId: "host-1",
      projectId: "project-1",
      terminalId: `pane-${alias}`,
      questionId: `qid-${alias}`,
    },
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
    token: `token-${alias}`,
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
      decisions: { listAttention, markAnswerHandled, listAnswerDestinations, reassignAnswer },
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
      // The token the item was read with goes too, so main refuses a question that changed since.
      expect(markAnswerHandled).toHaveBeenCalledWith({
        questionId: `qid-${alias}`,
        expected: `token-${alias}`,
      });
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
    await waitFor(() =>
      expect(markAnswerHandled).toHaveBeenCalledWith({ questionId: "qid-3", expected: "token-3" })
    );
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

function destination(
  terminalId: string,
  title: string,
  over: Partial<DecisionsAnswerDestination> = {}
): DecisionsAnswerDestination {
  return {
    terminalId,
    run: `run-${terminalId}`,
    title,
    agentId: "claude",
    agentName: "Claude",
    projectId: "project-1",
    projectName: "Helios",
    worktreeId: "worktree-1",
    worktreeName: "main",
    askedHere: false,
    waitsFor: "composer",
    ...over,
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

    expect(row.textContent).toContain("Timeout notice not typed in.");
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
    // Main mints a new token for what the question asks now.
    listed = [noticeItem(3, { notice: { ...NOTICE, revision: 1 }, token: "token-3-round-1" })];
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

describe("DecisionsAttentionDialog: where and when a moved answer goes (#18056)", () => {
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

  async function choose(title: string): Promise<HTMLElement> {
    const row = within(destinationsMenu()!)
      .getAllByRole("menuitem")
      .find((candidate) => candidate.textContent?.includes(title));
    if (!row) throw new Error(`no destination ${title}`);
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "Enter" });
    return screen.findByRole("dialog", { name: /^Send q-3/ });
  }

  it.each([
    {
      title: "Queueing agent",
      says: /composer is empty, even while it's working/,
      never: /prompt/,
    },
    {
      title: "Prompt agent",
      says: /at its prompt with its composer empty, never while it's working/,
      never: /even while/,
    },
  ])(
    "confirms the wait the chosen agent's delivery makes ($title)",
    async ({ title, says, never }) => {
      listAnswerDestinations.mockResolvedValue({
        result: "listed",
        destinations: [
          destination("pane-8", "Queueing agent", { waitsFor: "composer" }),
          destination("pane-9", "Prompt agent", { waitsFor: "prompt" }),
        ],
      });
      render(tree(true));
      await listedRows(1);
      await openDestinations(3);
      await waitFor(() => expect(menuRows()).toHaveLength(2));

      const asking = await choose(title);
      expect(asking.getAttribute("aria-labelledby")).not.toBeNull();
      expect(
        document.getElementById(asking.getAttribute("aria-labelledby")!)?.textContent
      ).toContain(title);
      const body = asking.textContent ?? "";
      expect(body).toMatch(says);
      expect(body).not.toMatch(never);
    }
  );

  it("sends the run it listed with the move, keeps the answer when that terminal runs another agent now, and sends the fresh run when chosen again (#18093)", async () => {
    const before = "a1".repeat(32);
    const after = "b2".repeat(32);
    listAnswerDestinations
      .mockResolvedValueOnce({
        result: "listed",
        destinations: [destination("pane-8", "Queueing agent", { run: before })],
      })
      .mockResolvedValueOnce({
        result: "listed",
        destinations: [destination("pane-8", "Queueing agent", { run: after })],
      });
    reassignAnswer
      .mockReset()
      .mockResolvedValueOnce({ result: "refused", reason: "destination-changed" })
      .mockImplementationOnce(async ({ questionId }) => {
        listed = listed.filter((item) => item.questionId !== questionId);
        return { result: "delivered", terminalId: "pane-8", title: "Queueing agent" };
      });
    render(tree(true));
    await listedRows(1);
    await openDestinations(3);
    await waitFor(() => expect(menuRows()[0]).toContain("Queueing agent"));
    const reads = listAttention.mock.calls.length;

    fireEvent.click(
      within(await choose("Queueing agent")).getByRole("button", { name: "Send answer" })
    );
    await waitFor(() =>
      expect(screen.getByTestId("decisions-attention-outcome").textContent).toContain(
        "That terminal is running another agent now, so q-3's answer wasn't sent"
      )
    );
    expect(reassignAnswer).toHaveBeenCalledExactlyOnceWith({
      questionId: "qid-3",
      terminalId: "pane-8",
      run: before,
      expected: "token-3",
    });
    // The list was read again after the refusal, and still holds the answer.
    await waitFor(() => expect(listAttention.mock.calls.length).toBeGreaterThan(reads));
    await listedRows(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Send q-3/ })).toBeNull());

    // Chosen again, the menu reads the running agents afresh and sends the run it lists now.
    await openDestinations(3);
    await waitFor(() => expect(listAnswerDestinations).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(menuRows()[0]).toContain("Queueing agent"));
    fireEvent.click(
      within(await choose("Queueing agent")).getByRole("button", { name: "Send answer" })
    );
    await waitFor(() => expect(reassignAnswer).toHaveBeenCalledTimes(2));
    expect(reassignAnswer.mock.calls[1]![0]).toEqual({
      questionId: "qid-3",
      terminalId: "pane-8",
      run: after,
      expected: "token-3",
    });
    await waitFor(() =>
      expect(screen.getByTestId("decisions-attention-outcome").textContent).toContain(
        "Answer to q-3 typed into “Queueing agent”"
      )
    );
  });

  it("sets other projects' agents apart from the asking project's, each project under its own name", async () => {
    listAnswerDestinations.mockResolvedValue({
      result: "listed",
      destinations: [
        destination("pane-3", "Pane 3", { askedHere: true }),
        destination("pane-5", "Sibling", { worktreeId: "worktree-2", worktreeName: "feature" }),
        destination("pane-7", "Atlas agent", { projectId: "project-2", projectName: "Atlas" }),
        destination("pane-8", "Nameless agent", { projectId: "project-3", projectName: null }),
        destination("pane-9", "Atlas second", { projectId: "project-2", projectName: "Atlas" }),
      ],
    });
    render(tree(true));
    await listedRows(1);
    await openDestinations(3);
    await waitFor(() => expect(menuRows()[0]).toContain("Pane 3"));

    const groups = within(destinationsMenu()!).getAllByRole("group");
    const named = groups.map((group) => {
      const label = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
      return {
        label: label?.textContent ?? "",
        rows: within(group)
          .getAllByRole("menuitem")
          .map((row) => row.textContent ?? ""),
      };
    });
    expect(named.map((group) => group.label)).toEqual([
      "Asking project · Helios",
      "Other project · Atlas",
      "Other project",
    ]);
    expect(named[0]!.rows.map((row) => row.split("Claude")[0])).toEqual([
      expect.stringContaining("Pane 3"),
      expect.stringContaining("Sibling"),
    ]);
    expect(named[1]!.rows).toEqual([
      expect.stringContaining("Atlas agent"),
      expect.stringContaining("Atlas second"),
    ]);
    expect(named[2]!.rows).toEqual([expect.stringContaining("Nameless agent")]);
    // Every project after the asking one starts past a rule of its own.
    expect(groups.map((group) => within(group).queryAllByRole("separator").length)).toEqual([
      0, 1, 1,
    ]);
  });

  it("still calls another project's agents another project's when none of the asking project's are running", async () => {
    listAnswerDestinations.mockResolvedValue({
      result: "listed",
      destinations: [
        destination("pane-7", "Atlas agent", { projectId: "project-2", projectName: "Atlas" }),
      ],
    });
    render(tree(true));
    await listedRows(1);
    await openDestinations(3);
    await waitFor(() => expect(menuRows()[0]).toContain("Atlas agent"));

    const groups = within(destinationsMenu()!).getAllByRole("group");
    expect(groups).toHaveLength(1);
    const label = document.getElementById(groups[0]!.getAttribute("aria-labelledby") ?? "");
    expect(label?.textContent).toContain("Atlas");
    expect(label?.textContent).toMatch(/other project/i);
    expect(within(destinationsMenu()!).queryAllByRole("separator")).toEqual([]);
  });
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

describe("DecisionsAttentionDialog: an opening for a pane leads with its items (#18055)", () => {
  /** The rows in the order they show, by alias. */
  function shownAliases(): number[] {
    return screen
      .getAllByTestId("decisions-attention-item")
      .map((row) => Number(row.dataset.questionId!.replace("qid-", "")));
  }

  /** The row that opens the rest of the list, by alias, or null when nothing sets them apart. */
  function elsewhereRow(): number | null {
    const heading = screen.queryByRole("heading", { name: "Elsewhere" });
    const row = heading?.closest<HTMLElement>("[data-question-id]");
    return row ? Number(row.dataset.questionId!.replace("qid-", "")) : null;
  }

  function openFor(terminalId: string | null) {
    act(() => useDecisionsAttentionStore.getState().open(terminalId));
  }

  /** One that leaves in one click, as nothing else is offered for it. */
  function plain(alias: number, over: Partial<DecisionsAttentionItem> = {}) {
    return makeItem(alias, { canResume: false, canReassign: false, ...over });
  }

  beforeEach(() => {
    listed = [];
    listAttention.mockReset();
    markAnswerHandled.mockReset();
    listAttention.mockImplementation(async () => ({ result: "listed", items: listed }));
    stubElectron();
    handlesQuestions();
    useDecisionsAttentionStore.setState({
      isOpen: false,
      request: { terminalId: null, returnFocusTo: null, seq: 0 },
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("puts the pane's own items first, in their order, then the rest under Elsewhere", async () => {
    const onHost = makeItem(5, {
      origin: { ...makeItem(5).origin, paneId: "pane-4", otherHost: { hostId: "h2", name: null } },
    });
    listed = [
      makeItem(3),
      makeItem(4),
      onHost,
      makeItem(6, { origin: { ...makeItem(6).origin, paneId: "pane-4" } }),
    ];
    const { rerender } = render(tree(false));
    openFor("pane-4");
    rerender(tree(true));
    await listedRows(4);

    // A Host's terminal can share the pane's id without being it.
    expect(shownAliases()).toEqual([4, 6, 3, 5]);
    expect(elsewhereRow()).toBe(3);
    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
    // The count is still every question's.
    expect(screen.getByTestId("decisions-attention-dialog").textContent).toContain(
      "4 questions need attention"
    );
    expect(screen.queryByTestId("decisions-attention-none-for-pane")).toBeNull();
  });

  it("lands on the new pane's item when reopened while open, though the old pane's focused row moves below it", async () => {
    listed = [makeItem(3), makeItem(4)];
    const { rerender } = render(tree(false));
    openFor("pane-3");
    rerender(tree(true));
    await listedRows(2);
    await waitFor(() => expect(document.activeElement).toBe(firstAction(3)));

    // Both rows already show, so the new opening's read moves pane 3's focused row below pane 4's.
    let land = () => {};
    listAttention.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = () => resolve({ result: "listed", items: listed });
        })
    );
    openFor("pane-4");
    await waitFor(() => expect(listAttention).toHaveBeenCalledTimes(2));
    await act(async () => land());

    await waitFor(() => expect(shownAliases()).toEqual([4, 3]));
    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
  });

  it("keeps a move the person made as the new opening's read came back, before it showed", async () => {
    listed = [makeItem(3), makeItem(4)];
    const { rerender } = render(tree(false));
    openFor("pane-3");
    rerender(tree(true));
    await listedRows(2);
    await waitFor(() => expect(document.activeElement).toBe(firstAction(3)));

    let land = () => {};
    listAttention.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = () => resolve({ result: "listed", items: listed });
        })
    );
    openFor("pane-4");
    await waitFor(() => expect(listAttention).toHaveBeenCalledTimes(2));
    const chosen = markButton(3);
    await act(async () => {
      land();
      // The read is back but not yet shown when the person tabs on.
      await new Promise((resolve) => setTimeout(resolve, 0));
      chosen.focus();
    });

    await waitFor(() => expect(shownAliases()).toEqual([4, 3]));
    expect(document.activeElement).toBe(chosen);
  });

  it("lands on the pane's item though focus is still in a modal under the list", async () => {
    listed = [makeItem(3), makeItem(4)];
    const { rerender } = render(tree(false));
    openFor("pane-3");
    rerender(tree(true));
    await listedRows(2);
    // The inbox the list was opened over, whose button can still hold focus as the read lands.
    const inbox = document.createElement("div");
    inbox.setAttribute("aria-modal", "true");
    const resolve = document.createElement("button");
    inbox.append(resolve);
    document.body.prepend(inbox);
    onTestFinished(() => inbox.remove());
    act(() => resolve.focus());

    openFor("pane-4");
    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
  });

  it("lands on the pane's item though a modal under the list took focus while its read was out", async () => {
    listed = [makeItem(3), makeItem(4)];
    const { rerender } = render(tree(false));
    openFor("pane-3");
    rerender(tree(true));
    await listedRows(2);
    const inbox = document.createElement("div");
    inbox.setAttribute("aria-modal", "true");
    const resolve = document.createElement("button");
    inbox.append(resolve);
    document.body.prepend(inbox);
    onTestFinished(() => inbox.remove());

    let land = () => {};
    listAttention.mockImplementationOnce(
      () =>
        new Promise((done) => {
          land = () => done({ result: "listed", items: listed });
        })
    );
    openFor("pane-4");
    await waitFor(() => expect(listAttention).toHaveBeenCalledTimes(2));
    act(() => resolve.focus());
    await act(async () => land());

    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));
  });

  it("leaves focus in a modal over the list when a new opening's read lands behind it", async () => {
    listed = [makeItem(3), makeItem(4)];
    const { rerender } = render(tree(false));
    openFor("pane-3");
    rerender(tree(true));
    await listedRows(2);
    await waitFor(() => expect(document.activeElement).toBe(firstAction(3)));
    // What the question view, opened from the list, holds while a notification opens the list for another pane.
    const reader = document.createElement("div");
    reader.setAttribute("aria-modal", "true");
    const close = document.createElement("button");
    reader.append(close);
    document.body.append(reader);
    onTestFinished(() => reader.remove());
    act(() => close.focus());

    openFor("pane-4");
    await waitFor(() => expect(shownAliases()).toEqual([4, 3]));
    await waitFor(() => expect(listAttention).toHaveBeenCalledTimes(2));

    expect(document.activeElement).toBe(close);
  });

  it("names nothing elsewhere while a new opening's read is out, or once it failed", async () => {
    listed = [makeItem(3), makeItem(4)];
    const { rerender } = render(tree(false));
    openFor("pane-3");
    rerender(tree(true));
    await listedRows(2);
    expect(elsewhereRow()).toBe(4);

    let fail = () => {};
    listAttention.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = () => reject(new Error("The relay went away"));
        })
    );
    openFor("pane-4");
    await waitFor(() => expect(listAttention).toHaveBeenCalledTimes(2));
    // Pane 4's own row still shows second, where the last opening put it, but isn't called elsewhere.
    expect(elsewhereRow()).toBeNull();
    await act(async () => fail());

    await waitFor(() => expect(screen.getByText("The relay went away")).toBeTruthy());
    expect(shownAliases()).toEqual([3, 4]);
    expect(elsewhereRow()).toBeNull();
    expect(screen.queryByTestId("decisions-attention-none-for-pane")).toBeNull();
  });

  it("keeps one list in main's order when opened for no pane, or for a pane that holds them all", async () => {
    listed = [makeItem(4), makeItem(3)];
    const { rerender } = render(tree(false));
    openFor(null);
    rerender(tree(true));
    await listedRows(2);
    expect(shownAliases()).toEqual([4, 3]);
    expect(elsewhereRow()).toBeNull();

    listed = [makeItem(3)];
    openFor("pane-3");
    await waitFor(() => expect(shownAliases()).toEqual([3]));
    expect(elsewhereRow()).toBeNull();
  });

  it("says nothing of the pane is left, and lands on no other pane's row, when opened for one with none", async () => {
    listed = [makeItem(3), makeItem(5)];
    const { rerender } = render(tree(false));
    openFor("pane-4");
    rerender(tree(true));
    await listedRows(2);

    await waitFor(() =>
      expect(screen.getByTestId("decisions-attention-none-for-pane").textContent).toBe(
        "Nothing from this terminal needs attention now."
      )
    );
    expect(elsewhereRow()).toBe(3);
    const id = screen.getByTestId("decisions-attention-dialog").getAttribute("aria-describedby");
    await waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById(id!)?.parentElement)
    );
  });

  it("hands focus to the first row below once the pane's last item leaves, and says so", async () => {
    // Main lists pane 4's item last; it shows first, so the row after it is 3, not 5.
    listed = [plain(3), plain(5), plain(4)];
    const { rerender } = render(tree(false));
    openFor("pane-4");
    rerender(tree(true));
    await listedRows(3);
    expect(shownAliases()).toEqual([4, 3, 5]);
    await waitFor(() => expect(document.activeElement).toBe(firstAction(4)));

    const mark = markButton(4);
    act(() => mark.focus());
    fireEvent.click(mark);
    await listedRows(2);

    await waitFor(() => expect(document.activeElement).toBe(firstAction(3)));
    expect(screen.getByTestId("decisions-attention-none-for-pane")).toBeTruthy();
    expect(elsewhereRow()).toBe(3);
  });
});

describe("DecisionsAttentionDialog: the whole question and its plan (#18055)", () => {
  beforeEach(() => {
    listed = [];
    listAttention.mockReset();
    listAttention.mockImplementation(async () => ({ result: "listed", items: listed }));
    stubElectron();
    useDecisionsAttentionStore.setState({
      isOpen: true,
      request: { terminalId: null, returnFocusTo: null, seq: 1 },
    });
    useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  });
  afterEach(() => {
    cleanup();
  });

  it("reads the rest of the question in place, past the heading's first line", async () => {
    const whole = "Drop the legacy index?\nThe reindex finished an hour ago.";
    listed = [
      makeItem(3, { question: "Drop the legacy index?", fullQuestion: whole }),
      makeItem(4),
    ];
    render(tree(true));
    await listedRows(2);

    const row = screen.getAllByTestId("decisions-attention-item")[0]!;
    const text = within(row).getByTestId("decisions-attention-question");
    expect(text.hidden).toBe(true);
    const show = within(row).getByRole("button", { name: "Show full question for q-3" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(show);
    expect(text.hidden).toBe(false);
    expect(text.textContent).toBe(whole);
    expect(show.getAttribute("aria-expanded")).toBe("true");
    expect(show.getAttribute("aria-controls")).toBe(text.id);
    fireEvent.click(within(row).getByRole("button", { name: "Show less of the question for q-3" }));
    expect(text.hidden).toBe(true);

    // A question that is all heading has nothing more to show.
    const other = screen.getAllByTestId("decisions-attention-item")[1]!;
    expect(within(other).queryByTestId("decisions-attention-question")).toBeNull();
    expect(within(other).queryByRole("button", { name: /Show full question/ })).toBeNull();
  });

  it("shows the plan the agent stated beside the notice that refers to it", async () => {
    listed = [
      makeItem(3, {
        answer: null,
        canReassign: false,
        plan: "Keep the recorded fixture.",
        notice: {
          kind: "expired",
          revision: 0,
          deadline: "2026-11-01T09:45:00.000Z",
          delivery: "needs-attention",
          disposition: "fallback-due",
        },
      }),
    ];
    render(tree(true));
    await listedRows(1);

    const plan = screen.getByTestId("decisions-attention-plan");
    expect(plan.textContent).toContain("The agent's plan if unanswered");
    expect(plan.textContent).toContain("Keep the recorded fixture.");
    // Right after the notice whose words refer to it.
    expect(plan.previousElementSibling?.textContent).toContain("its stated plan");
  });

  it("keeps the plan's toggle, and its focus, when it is folded back after coming to fit", async () => {
    let fits = false;
    const scroll = vi
      .spyOn(Element.prototype, "scrollHeight", "get")
      .mockImplementation(() => (fits ? 40 : 120));
    const client = vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(() => 40);
    onTestFinished(() => {
      scroll.mockRestore();
      client.mockRestore();
    });
    listed = [makeItem(3, { plan: "Keep the recorded fixture." })];
    render(tree(true));
    await listedRows(1);

    const toggle = await screen.findByRole("button", { name: "Show full plan for q-3" });
    fireEvent.click(toggle);
    // Wider now: the whole plan would fit folded.
    fits = true;
    act(() => toggle.focus());
    fireEvent.click(toggle);

    expect(toggle.isConnected).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe("Show full plan for q-3");
    expect(document.activeElement).toBe(toggle);
  });

  it("shows an advisory question's plan when its answer stalled, with no notice", async () => {
    listed = [makeItem(3, { plan: "Keep the recorded fixture." }), makeItem(4)];
    render(tree(true));
    await listedRows(2);

    const [planned, plain] = screen.getAllByTestId("decisions-attention-item");
    expect(within(planned!).getByTestId("decisions-attention-plan").textContent).toContain(
      "Keep the recorded fixture."
    );
    expect(within(plain!).queryByTestId("decisions-attention-plan")).toBeNull();
  });

  it("opens the question in the question view by its reference, and only one it can reach", async () => {
    const reference = {
      hostId: "host-1",
      projectId: "project-1",
      terminalId: "pane-3",
      questionId: "0190f0aa11112222333344445555aa03",
    };
    listed = [
      makeItem(3, { reference }),
      makeItem(4, {
        origin: { ...makeItem(4).origin, otherHost: { hostId: "h2", name: null } },
      }),
      makeItem(5, { reference: null }),
    ];
    render(tree(true));
    await listedRows(3);

    fireEvent.click(screen.getByRole("button", { name: "Open question q-3" }));
    const view = useDecisionsQuestionViewStore.getState();
    expect(view.isOpen).toBe(true);
    expect(view.request?.questions).toEqual([{ scope: "reference", reference }]);
    // Another machine's question this computer has no route to, and one with no reference, read only in place.
    expect(screen.queryByRole("button", { name: "Open question q-4" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open question q-5" })).toBeNull();
  });
});

describe("DecisionsAttentionDialog: closing once its last answer is resolved (#18027)", () => {
  let paneState: ((state: unknown) => void) | null = null;

  /** The list as the view's host mounts it: open and closed by the store, beside its opener. */
  function Hosted() {
    const isOpen = useDecisionsAttentionStore((state) => state.isOpen);
    const close = useDecisionsAttentionStore((state) => state.close);
    return (
      <TooltipProvider>
        <button type="button" data-testid="opener">
          Opener
        </button>
        <DecisionsAttentionDialog isOpen={isOpen} onClose={close} />
      </TooltipProvider>
    );
  }

  const dialog = () => screen.queryByTestId("decisions-attention-dialog");

  async function openFromOpener() {
    render(<Hosted />);
    const opener = screen.getByTestId("opener");
    act(() => opener.focus());
    act(() => useDecisionsAttentionStore.getState().open(null));
    return opener;
  }

  beforeEach(() => {
    listed = [];
    paneState = null;
    listAttention.mockReset();
    markAnswerHandled.mockReset();
    listAttention.mockImplementation(async () => ({ result: "listed", items: listed }));
    handlesQuestions();
    Object.defineProperty(window, "electron", {
      value: {
        decisions: { listAttention, markAnswerHandled, listAnswerDestinations },
        terminal: {
          onDecisionState: (callback: (state: unknown) => void) => {
            paneState = callback;
            return () => {
              paneState = null;
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

  it("closes once its last answer is marked handled, handing focus back to where it was opened", async () => {
    listed = [makeItem(3)];
    const opener = await openFromOpener();
    await listedRows(1);

    const asking = await ask(3);
    fireEvent.click(within(asking).getByRole("button", { name: "Mark handled" }));

    await waitFor(() => expect(useDecisionsAttentionStore.getState().isOpen).toBe(false));
    expect(markAnswerHandled).toHaveBeenCalledExactlyOnceWith({
      questionId: "qid-3",
      expected: "token-3",
    });
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(confirm()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("stays open while an answer is left, and closes with the last", async () => {
    listed = [makeItem(3, { canResume: false, canReassign: false }), makeItem(4)];
    await openFromOpener();
    await listedRows(2);

    fireEvent.click(markButton(3));
    await listedRows(1);
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(true);

    const asking = await ask(4);
    fireEvent.click(within(asking).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(useDecisionsAttentionStore.getState().isOpen).toBe(false));
  });

  it("leaves the keyboard in a confirmation already open when it's opened again for another pane", async () => {
    listed = [makeItem(3), makeItem(4)];
    await openFromOpener();
    await listedRows(2);
    const asking = await ask(3);
    const cancel = within(asking).getByRole("button", { name: "Cancel" });

    const reads = listAttention.mock.calls.length;
    act(() => useDecisionsAttentionStore.getState().open("pane-4"));
    await waitFor(() => expect(listAttention.mock.calls.length).toBeGreaterThan(reads));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(confirm()).not.toBeNull();
    expect(document.activeElement).toBe(cancel);
  });

  it("stays open, saying so, when its last answer is resolved in another window", async () => {
    listed = [makeItem(3)];
    await openFromOpener();
    await listedRows(1);

    listed = [];
    act(() => paneState?.({}));
    await waitFor(() =>
      expect(screen.queryAllByTestId("decisions-attention-item")).toHaveLength(0)
    );
    expect(dialog()?.textContent).toContain("Nothing needs attention right now");
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(true);
  });

  it("stays open when its last answer turns out to have been handled in another window first", async () => {
    listed = [makeItem(3, { canResume: false, canReassign: false })];
    markAnswerHandled.mockImplementation(async () => {
      listed = [];
      return { result: "resolved" };
    });
    await openFromOpener();
    await listedRows(1);

    fireEvent.click(markButton(3));
    await waitFor(() =>
      expect(screen.getByTestId("decisions-attention-outcome").textContent).toContain(
        "no longer needs attention"
      )
    );
    await waitFor(() =>
      expect(screen.queryAllByTestId("decisions-attention-item")).toHaveLength(0)
    );
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(true);
  });

  it("still closes once a read after a failed one finds its last answer gone", async () => {
    listed = [makeItem(3, { canResume: false, canReassign: false })];
    await openFromOpener();
    await listedRows(1);

    listAttention.mockRejectedValueOnce(new Error("The relay went away"));
    fireEvent.click(markButton(3));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(true);

    fireEvent.click(retry);
    await waitFor(() => expect(useDecisionsAttentionStore.getState().isOpen).toBe(false));
  });

  it("stays open when an action leaves its last answer listed", async () => {
    listed = [makeItem(3, { canResume: false, canReassign: false })];
    markAnswerHandled.mockResolvedValue({ result: "refused", reason: "changed" });
    await openFromOpener();
    await listedRows(1);

    fireEvent.click(markButton(3));
    await waitFor(() =>
      expect(screen.getByTestId("decisions-attention-outcome").textContent).toContain(
        "changed after this list was read"
      )
    );
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(true);
  });

  it("stays open, saying so, when opened with nothing listed", async () => {
    await openFromOpener();
    await waitFor(() =>
      expect(dialog()?.textContent).toContain("Nothing needs attention right now")
    );
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(true);
  });
});
