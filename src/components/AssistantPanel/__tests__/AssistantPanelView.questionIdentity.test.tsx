// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { installPreviewShims } from "../__preview__/previewShims";
import { PROSE_SPECIMEN } from "../__preview__/proseSpecimen";
import { AssistantPanelView } from "../AssistantPanelView";
import type { AssistantQuestion, AssistantSessionState } from "@/store/assistantStore";

/**
 * A NEW question gets a new sheet, asserted through the real panel.
 *
 * The card's own suite proves a keyed sheet starts fresh — by supplying the key itself,
 * which is exactly what makes it insufficient: remove `key` from the production call
 * site and that test still passes. The guarantee lives at the call site, so this renders
 * the call site.
 *
 * What it protects is not cosmetic. The sheet's cursor, its filter and the latch that
 * stops it answering twice all belong to one question; a second question inheriting them
 * renders for a commit under the previous question's CLOSED latch and silently ignores
 * the first answer given to it.
 */

installPreviewShims();

// jsdom implements no layout, so it ships neither of these. The sheet calls
// scrollIntoView on every cursor move to keep the highlighted row visible, and the
// panel observes its own width to decide where a long prompt folds.
Element.prototype.scrollIntoView = vi.fn();
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

function question(id: string, defaultIndex: number): AssistantQuestion {
  return {
    questionId: id,
    turnId: null,
    toolCallId: null,
    question: `Which worktree? (${id})`,
    options: [
      { label: "A", text: "option one" },
      { label: "B", text: "option two" },
      { label: "C", text: "option three" },
    ],
    defaultIndex,
    requestedAt: 0,
  };
}

function stateWith(pendingQuestion: AssistantQuestion): AssistantSessionState {
  return { ...PROSE_SPECIMEN, pendingQuestion };
}

function selected(): string {
  return (
    screen.queryAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")
      ?.textContent ?? ""
  );
}

afterEach(cleanup);

describe("AssistantPanelView question identity", () => {
  it("mounts a FRESH sheet when the question changes", () => {
    const onAnswerQuestion = vi.fn().mockReturnValue(true);
    const view = (q: AssistantQuestion) => (
      <WorktreeStoreProvider>
        <AssistantPanelView
          state={stateWith(q)}
          onSubmit={() => true}
          onInterrupt={() => {}}
          onDecideApproval={() => {}}
          onAnswerQuestion={onAnswerQuestion}
        />
      </WorktreeStoreProvider>
    );

    const { rerender } = render(view(question("qst_1", 0)));
    expect(selected()).toContain("option one");

    // Move the cursor and answer, closing the sheet's latch.
    fireEvent.keyDown(screen.getByRole("group", { name: "Question" }), { key: "ArrowDown" });
    expect(selected()).toContain("option two");
    fireEvent.click(screen.getAllByRole("option")[2]!);
    expect(onAnswerQuestion).toHaveBeenCalledWith("qst_1", 2);

    // A DIFFERENT question, arriving in the same slot.
    rerender(view(question("qst_2", 2)));

    // Its own default, not the cursor the last sheet was left on.
    expect(selected()).toContain("option three");
    // …and it is answerable, which the carried-over latch would have prevented.
    fireEvent.click(screen.getAllByRole("option")[0]!);
    expect(onAnswerQuestion).toHaveBeenLastCalledWith("qst_2", 0);
    expect(onAnswerQuestion).toHaveBeenCalledTimes(2);
  });
});
