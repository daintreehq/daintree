// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
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
    },
    answer: {
      source: "human",
      choices: ["Approve"],
      text: null,
      correction: false,
      answeredAt: "2026-11-01T09:30:00.000Z",
    },
    answerUnavailable: null,
    followUps: [],
    canResume: true,
    canReassign: true,
    ...over,
  };
}

function tree(isOpen: boolean) {
  return (
    <TooltipProvider>
      <DecisionsAttentionDialog isOpen={isOpen} onClose={vi.fn()} />
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
    Object.defineProperty(window, "electron", {
      value: {
        decisions: { listAttention, markAnswerHandled },
        terminal: { onDecisionState: () => () => {} },
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
