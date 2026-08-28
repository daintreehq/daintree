// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantToolGroupHeader, type AssistantToolGroupState } from "../AssistantToolRow";
import { ToolSegment } from "../AssistantPanelView";
import type { AssistantToolCall } from "@/store/assistantStore";

/**
 * The collapsed Tool Call Disclosure — the ONLY record in the chat history that a
 * function was ever called, once a clean turn settles and folds itself away.
 *
 * It regressed into the documented "ghost row" failure of this pattern: a dim chevron
 * and secondary-tier text on no surface, which reads as a nav link or a disabled label
 * rather than as evidence that anything ran. These pin the rules that stop it going back
 * there — the rules, deliberately, not the values. Which Lucide glyph means "done" and
 * what the success colour resolves to are both design calls that may change again; that
 * every state is DISTINGUISHABLE and that the row still says a function ran are not.
 */

const ALL_STATES: AssistantToolGroupState[] = [
  "done",
  "failed",
  "waiting",
  "running",
  "handedOff",
  "interrupted",
];

function renderHeader(props: Partial<Parameters<typeof AssistantToolGroupHeader>[0]> = {}) {
  return render(
    <AssistantToolGroupHeader
      count={2}
      what="Listed worktrees, Read git state"
      open={false}
      panelId="tool-panel-1"
      onToggle={() => {}}
      {...props}
    />
  );
}

/**
 * Mirrors how `ToolGroup` wires the button to its list: same id on both sides, list
 * hidden rather than unmounted. Testing the pair is the only way to catch a dangling
 * `aria-controls`, which neither side can see on its own.
 */
function ToolDisclosureFixture({ open }: { open: boolean }) {
  const panelId = "tool-panel-fixture";
  return (
    <div>
      <AssistantToolGroupHeader
        count={2}
        what="Listed worktrees, Read git state"
        open={open}
        panelId={panelId}
        onToggle={() => {}}
      />
      <ul id={panelId} hidden={!open} />
    </div>
  );
}

function call(over: Partial<AssistantToolCall> = {}): AssistantToolCall {
  return {
    toolCallId: `c${Math.random()}`,
    toolId: "worktree.list",
    state: "done",
    ...over,
  } as AssistantToolCall;
}

afterEach(cleanup);

describe("collapsed tool group — evidence that a function ran", () => {
  it("names the calls as TOOL CALLS, never as generic 'actions'", () => {
    // "1 action" describes almost anything in an IDE. The one thing this row exists to
    // say is that a FUNCTION was called, so the fallback has to say so.
    renderHeader({ what: undefined, count: 1 });
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("tool call");
    expect(button.textContent).not.toMatch(/\baction\b/i);
  });

  it("puts what happened in the accessible name, with its completion state", () => {
    // WCAG 4.1.2: the glyph carries the outcome for a sighted reader, so the name has to
    // carry it for everyone else. A name that is only the verb text says a row exists,
    // not that it finished.
    renderHeader({ state: "done", durationMs: 480 });
    const name = screen.getByRole("button").getAttribute("aria-label") ?? "";
    expect(name).toMatch(/2 tool calls/);
    expect(name).toContain("Listed worktrees, Read git state");
    // The duration is named as TOOL time, not as elapsed wall-clock: a batch dispatches
    // concurrently, so the turn is shorter than the sum and claiming otherwise lies.
    expect(name).toMatch(/tool time/);
  });

  it("keeps the disclosed list in the document while collapsed", () => {
    // aria-controls must not dangle. Unmounting the list when closed left the button
    // naming an id that was not in the document, which announces that it expands
    // something without saying what. `hidden` keeps the relationship valid while taking
    // the content out of the accessibility tree and out of layout.
    const { container } = render(<ToolDisclosureFixture open={false} />);
    const button = container.querySelector("button");
    const listId = button?.getAttribute("aria-controls") ?? "";
    expect(listId).not.toBe("");
    // getElementById-equivalent rather than a selector: jsdom has no CSS.escape.
    const list = container.querySelector(`[id="${listId}"]`);
    expect(list, "aria-controls points at a node that is not in the document").not.toBeNull();
    expect(list?.hasAttribute("hidden")).toBe(true);
  });

  it("discloses the list it controls", () => {
    // The disclosure contract: without aria-controls the button announces that something
    // expands without saying what. https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
    renderHeader({ panelId: "calls-7" });
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-controls")).toBe("calls-7");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks every decorative glyph aria-hidden so the name is what gets announced", () => {
    const { container } = renderHeader({ state: "failed", failedCount: 1 });
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

describe("collapsed tool group — states stay told apart", () => {
  it("gives every state its own glyph-and-tone pairing", () => {
    // The rule, not the values: two states that render the same shape in the same colour
    // are indistinguishable while collapsed, which is how a failed run comes to look
    // exactly like a clean one. Whichever glyphs the design settles on, no two may
    // collide on BOTH axes.
    const seen = new Map<string, AssistantToolGroupState>();
    for (const state of ALL_STATES) {
      const { container, unmount } = renderHeader({ state });
      const glyph = container.querySelector("svg");
      expect(glyph, `${state} renders no status glyph`).not.toBeNull();
      // Shape is identified by the icon's own class marker, tone by the colour class.
      const signature = `${glyph?.getAttribute("class") ?? ""}`;
      const collision = seen.get(signature);
      expect(
        collision,
        `${state} is visually identical to ${collision} while collapsed`
      ).toBeUndefined();
      seen.set(signature, state);
      unmount();
    }
  });

  it("keeps a failure visible without expanding", () => {
    renderHeader({ state: "failed", failedCount: 2 });
    expect(screen.getByRole("button").textContent).toContain("2 failed");
  });

  it("never reports a call blocked on the reader as running", () => {
    // The three live states are not one state. A call waiting on the user's approval is
    // not busy — it is waiting for THEM — and collapsing it into "still running" puts
    // someone back to watching a spinner that is waiting on their own answer. Queued has
    // not started at all.
    renderHeader({ state: "waiting", awaitingApprovalCount: 2, runningCount: 0, queuedCount: 3 });
    const text = screen.getByRole("button").textContent ?? "";
    expect(text).toContain("2 needs approval");
    expect(text).toContain("3 queued");
    expect(text).not.toContain("still running");
    // And it reaches a screen reader, not just the eye.
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("needs approval");
  });

  it("reports work still running even when the group was collapsed by hand", () => {
    // The regression this closes: runningCount was gated on the turn having finished, so
    // a reader who collapsed a LIVE group got a header claiming nothing was running —
    // at the one moment the count matters most.
    renderHeader({ state: "running", runningCount: 3 });
    expect(screen.getByRole("button").textContent).toContain("3 still running");
  });
});

describe("collapsed tool group — restraint", () => {
  it("carries no accent colour", () => {
    // House rule: status colours only on this row. An accent here would make every
    // settled tool call compete with the assistant's actual answer.
    for (const state of ALL_STATES) {
      const { container, unmount } = renderHeader({ state });
      expect(container.innerHTML).not.toMatch(/accent/);
      unmount();
    }
  });

  it("sizes itself in the panel's em step, so it tracks the terminal font", () => {
    // A px size here would decouple the chrome from the terminal pane beside it the
    // moment someone changed their terminal font size.
    const { container } = renderHeader();
    const button = container.querySelector("button");
    expect(button?.className).toContain("assistant-text-sm");
    expect(button?.className).not.toMatch(/text-\[\d+px\]/);
  });
});

describe("ToolSegment — the derivation behind the header", () => {
  // These drive the REAL component with raw calls, because the tests above hand the
  // header its aggregate state ready-made. That gap is what let a queued-only group
  // render a spinning "Running" glyph while its own suffix said "queued": the header was
  // right about what it was given, and what it was given was wrong.
  it("does not call a queued-only batch 'running'", () => {
    render(
      <ToolSegment
        calls={[call({ state: "queued" }), call({ state: "queued" })]}
        turnComplete={false}
      />
    );
    const name = screen.getByRole("button").getAttribute("aria-label") ?? "";
    expect(name).not.toMatch(/^Running/);
    expect(screen.getByRole("button").textContent).toContain("2 queued");
    expect(screen.getByRole("button").textContent).not.toContain("still running");
  });

  it("lets a call blocked on approval outrank one that is merely running", () => {
    // Precedence matters: of the live states, only approval will not resolve without
    // the reader, so it is the one the glyph has to show.
    render(
      <ToolSegment
        calls={[call({ state: "active" }), call({ state: "waiting" })]}
        turnComplete={false}
      />
    );
    const name = screen.getByRole("button").getAttribute("aria-label") ?? "";
    expect(name).toMatch(/Waiting for approval/);
  });

  it("sums the tool time of the calls that reported one", () => {
    render(
      <ToolSegment
        calls={[call({ durationMs: 240 }), call({ durationMs: 240 }), call({})]}
        turnComplete
      />
    );
    expect(screen.getByRole("button").textContent).toContain("480ms");
  });

  it("keeps a failure ahead of every other outcome", () => {
    render(<ToolSegment calls={[call({}), call({ state: "failed" })]} turnComplete />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/^Failed/);
  });
});

describe("collapsed tool group — the header does not repeat what is already visible", () => {
  it("drops the verb list once the group is open", () => {
    // A one-call group's header text was a verbatim copy of the single row beneath it,
    // which reads as the heading having been rendered twice. Expanded, the rows say the
    // verbs; the header says what they cannot — how many, and the group's outcome.
    const { rerender } = render(
      <ToolSegment calls={[call({ verb: "Waiting on all", durationMs: 100 })]} turnComplete />
    );
    expect(screen.getByRole("button").textContent).toContain("Waiting on all");

    rerender(
      <ToolSegment calls={[call({ verb: "Waiting on all", durationMs: 100 })]} turnComplete />
    );
    fireEvent.click(screen.getByRole("button"));
    const header = screen.getByRole("button").textContent ?? "";
    expect(header).not.toContain("Waiting on all");
    expect(header).toContain("1 tool call");
  });

  it("still names the verbs in the accessible name while open", () => {
    // The visible text steps back; the accessible name must not, or a screen-reader user
    // loses the summary the sighted reader still gets from the rows.
    renderHeader({ open: true, what: "Listed worktrees" });
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Listed worktrees");
  });
});
