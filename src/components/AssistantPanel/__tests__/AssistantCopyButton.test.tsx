// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantPanelView } from "../AssistantPanelView";
import { turnProse } from "../AssistantCopyButton";
import { PROSE_SPECIMEN } from "../__preview__/proseSpecimen";
import type { AssistantSessionState, AssistantTurn } from "@/store/assistantStore";

/**
 * Copying a turn out of the transcript.
 *
 * What is worth pinning is WHAT lands on the clipboard, which is the half a rendered
 * check mark cannot show. A user's message copies whole even when the bubble is only
 * showing part of it, and an answer copies as the prose the assistant actually wrote —
 * not welded together the way the streaming buffer joins it, and not carrying the tool
 * rows and steers that share the same turn.
 */

vi.mock("@/components/Terminal/HybridInputBar", () => ({
  HybridInputBar: () => null,
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

function stateWith(turns: AssistantTurn[]): AssistantSessionState {
  return { ...PROSE_SPECIMEN, turns, notices: [] };
}

function turn(over: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    turnId: "t1",
    role: "assistant",
    startedAt: 1_000_000,
    endedAt: 1_018_400,
    segments: [],
    text: "",
    toolCallIds: [],
    interjections: [],
    complete: true,
    ...over,
  };
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

function copyButton(root: HTMLElement, label: string): HTMLButtonElement {
  const el = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(el, `no "${label}" button in the transcript`).not.toBeNull();
  return el!;
}

describe("turnProse", () => {
  it("separates segments the streaming join runs together", () => {
    // `turn.text` joins with nothing, which is right while tokens are arriving and
    // wrong the moment it is read back: the sentence before a tool call and the one
    // after it are separate paragraphs on screen and would paste as one word.
    const prose = turnProse(
      turn({
        segments: [
          { kind: "text", text: "Looking at the config." },
          { kind: "tools", toolCallIds: ["c1"] },
          { kind: "text", text: "It sets the port to 8080." },
        ],
      })
    );
    expect(prose).toBe("Looking at the config.\n\nIt sets the port to 8080.");
  });

  it("carries only what the assistant said", () => {
    // Tool calls, a mid-turn steer and the answer to a question are all part of what
    // happened in the turn — and none of them are the answer someone is pasting.
    const prose = turnProse(
      turn({
        segments: [
          { kind: "interjection", text: "also check the tests" },
          { kind: "answer", question: "Which branch?", label: "A", text: "develop" },
          { kind: "tools", toolCallIds: ["c1"] },
          { kind: "text", text: "Done." },
        ],
      })
    );
    expect(prose).toBe("Done.");
  });

  it("is empty for a turn that only ran tools", () => {
    expect(turnProse(turn({ segments: [{ kind: "tools", toolCallIds: ["c1"] }] }))).toBe("");
  });
});

describe("transcript copy buttons", () => {
  it("copies a user's whole message, not the part the bubble is showing", async () => {
    // The fold caps the bubble at roughly nine lines. A long paste is both the message
    // most worth copying and the only one that is folded, so a copy of what happens to
    // be on screen would be lossy in exactly the case that matters.
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const el = renderPanel(
      stateWith([turn({ turnId: "u1", role: "user", text: long, segments: [] })])
    );

    await act(async () => {
      copyButton(el, "Copy message").click();
    });

    expect(writeText).toHaveBeenCalledWith(long);
  });

  it("copies the answer from the row that closes it", async () => {
    const el = renderPanel(
      stateWith([
        turn({
          segments: [
            { kind: "text", text: "First." },
            { kind: "tools", toolCallIds: ["c1"] },
            { kind: "text", text: "Second." },
          ],
          text: "First.Second.",
        }),
      ])
    );

    await act(async () => {
      copyButton(el, "Copy response").click();
    });

    expect(writeText).toHaveBeenCalledWith("First.\n\nSecond.");
  });

  it("offers no copy on a turn with nothing to hand over", () => {
    // The endcap still draws — the duration is a fact about the turn either way — but
    // a copy button over an empty clipboard write is a control that does nothing.
    const el = renderPanel(
      stateWith([turn({ segments: [{ kind: "tools", toolCallIds: ["c1"] }] })])
    );
    expect(el.querySelector("[data-turn-endcap]")).not.toBeNull();
    expect(el.querySelector('button[aria-label="Copy response"]')).toBeNull();
  });
});
