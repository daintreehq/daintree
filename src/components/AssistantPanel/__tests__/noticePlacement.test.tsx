// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantPanelView } from "../AssistantPanelView";
import { PROSE_SPECIMEN } from "../__preview__/proseSpecimen";
import type { AssistantNotice, AssistantSessionState, AssistantTurn } from "@/store/assistantStore";

/**
 * Where a notice lands in the transcript.
 *
 * Command results are what make this matter. A slash line is not part of a turn — the
 * engine answers it on the command path and the result carries no `turnId` — so every
 * one of them used to collect at the END of the transcript, below everything. With a
 * single command that is invisible. With three it puts the commands up the transcript
 * and their answers in a block at the bottom, and the only way to pair them is to read
 * the command echoed inside each answer.
 *
 * `/login` then `/account` is an ordinary two-command sequence, so this is the normal
 * case for the account surface rather than an edge one.
 */

vi.mock("@/components/Terminal/HybridInputBar", () => ({ HybridInputBar: () => null }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function userTurn(turnId: string, text: string): AssistantTurn {
  return {
    turnId,
    role: "user",
    startedAt: 1_000_000,
    endedAt: 1_000_000,
    segments: [{ kind: "text", text }],
    text,
    toolCallIds: [],
    interjections: [],
    complete: true,
  };
}

function commandResult(id: string, afterTurnId: string, text: string): AssistantNotice {
  return { id, level: "info", message: text, at: 1_000_001, turnId: null, afterTurnId };
}

function renderPanel(state: AssistantSessionState): HTMLElement {
  const { container } = render(
    <AssistantPanelView
      state={state}
      onSubmit={() => true}
      onInterrupt={() => {}}
      onDecideApproval={() => {}}
    />
  );
  return container;
}

/** Position of `needle` in the rendered text, or -1. Used to assert ORDER, not presence. */
function at(el: HTMLElement, needle: string) {
  return (el.textContent ?? "").indexOf(needle);
}

describe("notice placement", () => {
  it("draws each command result under the command that produced it", () => {
    const el = renderPanel({
      ...PROSE_SPECIMEN,
      turns: [userTurn("t1", "/login"), userTurn("t2", "/account")],
      notices: [
        commandResult("n1", "t1", "SIGNED-IN-ANSWER"),
        commandResult("n2", "t2", "PLAN-ANSWER"),
      ],
    });

    // Asserted on ORDER rather than presence: both answers were present in the broken
    // version too — they were simply both at the bottom, in the wrong order relative to
    // the second command.
    expect(at(el, "SIGNED-IN-ANSWER")).toBeGreaterThan(-1);
    expect(at(el, "PLAN-ANSWER")).toBeGreaterThan(at(el, "/account"));
    expect(at(el, "SIGNED-IN-ANSWER")).toBeLessThan(at(el, "/account"));
  });

  it("keeps a notice that arrived before any turn at the end", () => {
    // Nothing to sit behind, and the end is where the panel's session-level strip lives.
    // A boot error on an empty transcript has to stay visible rather than being dropped
    // for want of an anchor.
    const el = renderPanel({
      ...PROSE_SPECIMEN,
      turns: [userTurn("t1", "a question")],
      notices: [
        { ...commandResult("n1", "t1", "ANCHORED"), afterTurnId: null, level: "error" as const },
      ],
    });

    expect(at(el, "ANCHORED")).toBeGreaterThan(-1);
  });

  it("does not lose a notice whose turn has been cleared", () => {
    // `/clear` empties the transcript. A notice still anchored to a turn that is gone
    // must fall through to the session strip rather than matching nothing and vanishing.
    const el = renderPanel({
      ...PROSE_SPECIMEN,
      turns: [],
      notices: [commandResult("n1", "t-gone", "ORPHANED")],
    });

    expect(at(el, "ORPHANED")).toBeGreaterThan(-1);
  });

  it("still draws a turn-attributed notice inside its own turn", () => {
    // The pre-existing behaviour, unchanged: a notice the ENGINE attributed to a turn is
    // part of what happened in it, and belongs above the rule that closes the turn.
    const el = renderPanel({
      ...PROSE_SPECIMEN,
      turns: [userTurn("t1", "a question")],
      notices: [
        {
          id: "n1",
          level: "warning",
          message: "RETRY-WARNING",
          at: 1_000_001,
          turnId: "t1",
          afterTurnId: "t1",
        },
      ],
    });

    expect(at(el, "RETRY-WARNING")).toBeGreaterThan(-1);
  });
});
