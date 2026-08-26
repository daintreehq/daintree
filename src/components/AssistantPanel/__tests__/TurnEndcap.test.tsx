// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantPanelView } from "../AssistantPanelView";
import { PROSE_SPECIMEN } from "../__preview__/proseSpecimen";
import type { AssistantSessionState, AssistantTurn } from "@/store/assistantStore";

/**
 * The rule that closes a settled assistant turn.
 *
 * Two things are worth pinning. WHETHER it draws — a bare divider on a 200ms wake
 * acknowledgement is noise, and one on a turn whose duration was never recorded is a
 * line with nothing to say. And WHERE it draws, which is the part that broke: a notice
 * attributed to a turn renders after the turn's own block, so an endcap rendered from
 * inside that block landed above the warning it was supposed to close over.
 */

vi.mock("@/components/Terminal/HybridInputBar", () => ({
  // The composer reaches for stores the panel view does not own. Nothing here is about
  // the composer.
  HybridInputBar: () => null,
}));

// A user turn measures itself to decide whether to fold. jsdom has no ResizeObserver
// and every element it reports has zero height, so the observer only needs to exist —
// nothing here depends on what it measures.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function stateWith(turns: AssistantTurn[], notices: AssistantSessionState["notices"] = []) {
  return { ...PROSE_SPECIMEN, turns, notices };
}

function assistantTurn(over: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    turnId: "t1",
    role: "assistant",
    startedAt: 1_000_000,
    endedAt: 1_018_400,
    segments: [{ kind: "text", text: "An answer." }],
    text: "An answer.",
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

describe("TurnEndcap", () => {
  it("states the turn's duration once it has settled", () => {
    const el = renderPanel(stateWith([assistantTurn()]));
    expect(el.textContent).toContain("18s");
  });

  it("keeps a tenth of a second on a short turn, and drops it on a long one", () => {
    // The panel's own duration format, unchanged: precision where it distinguishes two
    // turns and none where it is noise. Asserted here because the endcap is the first
    // place a duration is written down PERMANENTLY rather than ticking past.
    const quick = renderPanel(stateWith([assistantTurn({ endedAt: 1_004_200 })]));
    expect(quick.textContent).toContain("4.2s");
    const long = renderPanel(stateWith([assistantTurn({ endedAt: 1_018_400 })]));
    expect(long.textContent).toContain("18s");
  });

  it("never renders a minute as sixty seconds", () => {
    // 119,600ms floors to 1 minute with 59,600ms left, which rounds to 60. The endcap
    // stamps whatever it is handed into the transcript and keeps it there.
    const el = renderPanel(stateWith([assistantTurn({ endedAt: 1_119_600 })]));
    expect(el.textContent).not.toContain("60s");
    expect(el.textContent).toContain("2m 0s");
  });

  it("marks a turn the assistant started itself", () => {
    // A wake is not something the user asked for. Without the word, its rule is
    // indistinguishable from an answer's and the transcript implies they started it.
    const el = renderPanel(stateWith([assistantTurn({ wake: true })]));
    expect(el.textContent).toContain("Background · 18s");
  });

  it("draws nothing while the turn is still running", () => {
    const el = renderPanel(stateWith([assistantTurn({ complete: false, endedAt: undefined })]));
    expect(el.textContent).not.toContain("18s");
  });

  it("draws nothing for a turn whose end was never recorded", () => {
    const el = renderPanel(stateWith([assistantTurn({ endedAt: undefined })]));
    expect(el.querySelectorAll("[data-turn-endcap]")).toHaveLength(0);
  });

  it("draws nothing for a sub-second turn", () => {
    // A rule per turn would out-weigh the turns themselves on a run of quick wakes.
    const el = renderPanel(stateWith([assistantTurn({ endedAt: 1_000_400 })]));
    expect(el.textContent).not.toContain("0.4s");
  });

  it("never draws on a user's own turn", () => {
    const user: AssistantTurn = {
      turnId: "u1",
      role: "user",
      startedAt: 1_000_000,
      endedAt: 1_018_400,
      segments: [],
      text: "A question.",
      toolCallIds: [],
      interjections: [],
      complete: true,
    };
    const el = renderPanel(stateWith([user]));
    expect(el.textContent).not.toContain("18s");
  });

  it("closes AFTER a notice attributed to the same turn", () => {
    // The ordering bug. A notice belonging to a turn is part of what happened in it, so
    // a rule that renders above it claims the turn ended before its own warning
    // arrived. Asserted on DOM order rather than presence, because both elements were
    // present in the broken version too.
    const el = renderPanel(
      stateWith(
        [assistantTurn()],
        [
          {
            id: "n1",
            level: "warning",
            message: "Rate limited; retrying.",
            at: 1_010_000,
            turnId: "t1",
            afterTurnId: "t1",
          },
        ]
      )
    );
    const text = el.textContent ?? "";
    const noticeAt = text.indexOf("Rate limited");
    const endcapAt = text.indexOf("18s");
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(endcapAt).toBeGreaterThanOrEqual(0);
    expect(endcapAt).toBeGreaterThan(noticeAt);
  });

  it("keeps the duration readable to assistive technology", () => {
    // Only the rule is decorative. An `aria-hidden` on the whole row — which is what
    // shipped first — deleted the one place the elapsed time survives after the live
    // clock stops.
    const el = renderPanel(stateWith([assistantTurn()]));
    const hidden = [...el.querySelectorAll("[aria-hidden='true']")];
    expect(hidden.some((n) => n.textContent?.includes("18s"))).toBe(false);
  });
});
