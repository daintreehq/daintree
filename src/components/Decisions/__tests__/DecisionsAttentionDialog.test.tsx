// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DecisionsAnswerOutcome,
  DecisionsAttentionItem,
  DecisionsAttentionList,
} from "@shared/types/decisionsAttention";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
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

function renderDialog() {
  return render(
    <TooltipProvider>
      <DecisionsAttentionDialog isOpen onClose={vi.fn()} />
    </TooltipProvider>
  );
}

async function listedRows(count: number) {
  await vi.waitFor(() =>
    expect(screen.getAllByTestId("decisions-attention-item")).toHaveLength(count)
  );
}

function markButton(alias: number): HTMLButtonElement {
  return screen.getByRole("button", { name: `Mark q-${alias} handled` }) as HTMLButtonElement;
}

function confirm(): HTMLElement | null {
  return screen.queryByRole("alertdialog");
}

/** A dialog plays its exit before it leaves the DOM. */
async function confirmGone() {
  await vi.waitFor(() => expect(confirm()).toBeNull());
}

function clickMark(alias: number) {
  const button = markButton(alias);
  act(() => button.focus());
  fireEvent.click(button);
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
      request: { terminalId: null, seq: 1 },
    });
    useAnnouncerStore.setState({ polite: "", assertive: "" });
  });
  afterEach(() => {
    cleanup();
  });

  it("asks first, naming the question, while the item can still be resumed or sent on", async () => {
    listed = [makeItem(3), makeItem(4, { canResume: false })];
    renderDialog();
    await listedRows(2);

    for (const alias of [3, 4]) {
      clickMark(alias);
      const asking = await screen.findByRole("alertdialog");
      expect(within(asking).getByText(`Mark q-${alias} handled?`)).toBeTruthy();
      expect(asking.textContent).toContain(`Question ${alias}?`);
      expect(asking.textContent).toContain("won't type it in");
      expect(markAnswerHandled).not.toHaveBeenCalled();

      fireEvent.click(within(asking).getByRole("button", { name: "Cancel" }));
      await confirmGone();
    }
  });

  it("leaves the item and its actions as they were when cancelled, and hands focus back", async () => {
    listed = [makeItem(3), makeItem(4)];
    renderDialog();
    await listedRows(2);

    clickMark(3);
    const asking = await screen.findByRole("alertdialog");
    // Cancel has the first focus, so a stray Enter doesn't take the answer away.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(within(asking).getByRole("button", { name: "Cancel" }))
    );
    fireEvent.click(within(asking).getByRole("button", { name: "Cancel" }));
    await confirmGone();

    expect(markAnswerHandled).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("decisions-attention-item")).toHaveLength(2);
    for (const name of ["Try resume for q-3", "Choose destination for q-3", "Mark q-3 handled"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByTestId("decisions-attention-outcome")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(markButton(3)));
  });

  it("marks it handled once on the confirm, then lands focus on the next row", async () => {
    listed = [makeItem(3), makeItem(4)];
    markAnswerHandled.mockImplementation(async ({ questionId }) => {
      listed = listed.filter((item) => item.questionId !== questionId);
      return { result: "handled" };
    });
    renderDialog();
    await listedRows(2);

    clickMark(3);
    const asking = await screen.findByRole("alertdialog");
    fireEvent.click(within(asking).getByRole("button", { name: "Mark handled" }));

    await vi.waitFor(() => expect(markAnswerHandled).toHaveBeenCalledTimes(1));
    expect(markAnswerHandled).toHaveBeenCalledWith({ questionId: "qid-3" });
    await listedRows(1);
    await confirmGone();

    expect(screen.getByTestId("decisions-attention-outcome").textContent).toContain(
      "Answer to q-3 marked handled"
    );
    const rows = screen.getAllByTestId("decisions-attention-item");
    expect(rows[0].getAttribute("data-question-id")).toBe("qid-4");
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        rows[0].querySelector("[data-attention-action]") as HTMLElement
      )
    );
  });

  it("marks an item handled in one click when it offers neither Try resume nor Choose destination", async () => {
    listed = [
      makeItem(3, { status: "delivery-uncertain", canResume: false, canReassign: false }),
      makeItem(4),
    ];
    markAnswerHandled.mockImplementation(async ({ questionId }) => {
      listed = listed.filter((item) => item.questionId !== questionId);
      return { result: "handled" };
    });
    renderDialog();
    await listedRows(2);

    clickMark(3);

    expect(confirm()).toBeNull();
    await vi.waitFor(() => expect(markAnswerHandled).toHaveBeenCalledWith({ questionId: "qid-3" }));
    await listedRows(1);
    expect(screen.getByTestId("decisions-attention-outcome").textContent).toContain(
      "Answer to q-3 marked handled"
    );
  });
});
