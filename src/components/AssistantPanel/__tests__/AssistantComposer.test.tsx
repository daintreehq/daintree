// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantPanelView } from "../AssistantPanelView";
import { CAPTURED_STATES } from "../__preview__/capturedStates";
import type { AssistantSessionState } from "@/store/assistantStore";

/**
 * The composer's key map, against the cockpit it was ported from
 * (internal/ui/composer/keymap.go + hints.go + palette.go).
 *
 * Driven through real captured engine states rather than hand-built objects, so a
 * reducer change that alters the shape these read from surfaces here too.
 */

const BASE = CAPTURED_STATES.empty as AssistantSessionState;

function renderPanel(overrides: Partial<AssistantSessionState> = {}) {
  const onSubmit = vi.fn().mockReturnValue(true);
  const onInterrupt = vi.fn();
  const utils = render(
    <AssistantPanelView
      state={{ ...BASE, ...overrides }}
      onSubmit={onSubmit}
      onInterrupt={onInterrupt}
      onDecideApproval={vi.fn()}
    />
  );
  const input = utils.container.querySelector("textarea") as HTMLTextAreaElement;
  return { ...utils, input, onSubmit, onInterrupt };
}

/** Typing through the controlled textarea, caret left at the end as a real one would be. */
function type(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(value.length, value.length);
}

describe("assistant composer", () => {
  describe("palette", () => {
    it("opens on a slash and ranks by the cockpit's tiers", () => {
      const { input } = renderPanel();
      type(input, "/s");
      const options = screen.getAllByRole("option");
      expect(options.length).toBeGreaterThan(0);
      // "/scenario" and "/status" both prefix-match "s"; registry order breaks the tie.
      expect(options[0]?.textContent).toContain("/scenario");
    });

    it("stays open once an argument is typed", () => {
      // The cockpit kept it up, with its usage hint, while "/audit 5" was typed. Closing
      // on the first space is what made the hint unreadable exactly when it was needed.
      const { input } = renderPanel();
      type(input, "/scenario ");
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    });

    it("collapses to one row once a closed token names a command exactly", () => {
      const { input } = renderPanel();
      type(input, "/status ");
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });

    it("moves the selection with the arrow keys and wraps", () => {
      const { input } = renderPanel();
      type(input, "/s");
      const before = screen.getAllByRole("option");
      expect(before[0]?.getAttribute("aria-selected")).toBe("true");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");

      // Wrapping back past the top rather than sticking: paletteWrap's whole purpose.
      fireEvent.keyDown(input, { key: "ArrowUp" });
      fireEvent.keyDown(input, { key: "ArrowUp" });
      const opts = screen.getAllByRole("option");
      expect(opts[opts.length - 1]?.getAttribute("aria-selected")).toBe("true");
    });

    it("completes on Enter instead of submitting the raw draft", () => {
      // The regression this pins: Enter used to call submit() straight past the
      // highlighted row, so the selection was decorative.
      const { input, onSubmit } = renderPanel();
      type(input, "/s");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(input.value).toBe("/scenario ");
    });

    it("completes on Tab and PRESERVES the arguments already typed", () => {
      const { input } = renderPanel();
      type(input, "/stat urgent");
      fireEvent.keyDown(input, { key: "Tab" });
      expect(input.value).toBe("/status urgent");
    });

    it("dismisses on Escape without clearing the draft", () => {
      const { input } = renderPanel();
      type(input, "/s");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(input.value).toBe("/s");
    });
  });

  describe("escape", () => {
    it("clears a non-empty draft before it touches the turn", () => {
      const { input, onInterrupt } = renderPanel();
      type(input, "some prose");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input.value).toBe("");
      expect(onInterrupt).not.toHaveBeenCalled();
    });

    it("cancels the turn only on an empty draft while one is running", () => {
      const { input, onInterrupt } = renderPanel(CAPTURED_STATES.streaming);
      fireEvent.keyDown(input, { key: "Escape" });
      expect(onInterrupt).toHaveBeenCalledTimes(1);
    });

    it("does nothing on an empty draft with no turn running", () => {
      const { input, onInterrupt } = renderPanel();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(onInterrupt).not.toHaveBeenCalled();
    });
  });

  describe("history", () => {
    it("recalls the previous prompt on ArrowUp at the start of the draft", () => {
      const { input } = renderPanel();
      type(input, "first prompt");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(input.value).toBe("");

      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input.value).toBe("first prompt");
    });

    it("leaves ArrowUp alone when the caret is inside the draft", () => {
      // Inside a multi-line draft ↑ has to walk the draft's own rows first, or a
      // two-line prompt becomes uneditable.
      const { input } = renderPanel();
      type(input, "first prompt");
      fireEvent.keyDown(input, { key: "Enter" });
      type(input, "half written");
      input.setSelectionRange(4, 4);
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input.value).toBe("half written");
    });

    it("restores the stashed draft when walking back off the end", () => {
      const { input } = renderPanel();
      type(input, "first prompt");
      fireEvent.keyDown(input, { key: "Enter" });
      type(input, "");
      input.setSelectionRange(0, 0);

      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input.value).toBe("first prompt");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input.value).toBe("");
    });

    it("does not record a prompt the session refused", () => {
      const onSubmit = vi.fn().mockReturnValue(false);
      const { container } = render(
        <AssistantPanelView
          state={BASE}
          onSubmit={onSubmit}
          onInterrupt={vi.fn()}
          onDecideApproval={vi.fn()}
        />
      );
      const input = container.querySelector("textarea") as HTMLTextAreaElement;
      type(input, "refused");
      fireEvent.keyDown(input, { key: "Enter" });
      // The draft is kept, so there is nothing to recall — and recalling it would
      // duplicate what is already in the box.
      expect(input.value).toBe("refused");
      input.setSelectionRange(0, 0);
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input.value).toBe("refused");
    });
  });

  describe("hint row", () => {
    it("offers discovery hints on an empty composer", () => {
      const { container } = renderPanel();
      expect(container.textContent).toContain("commands");
      expect(container.textContent).toContain("history");
    });

    it("drops discovery hints once a draft is in progress", () => {
      // A mid-word "/" types a literal slash and ↑ walks the draft's rows, so both
      // hints would be advertising something that does not happen.
      const { container, input } = renderPanel();
      type(input, "some prose");
      expect(container.textContent).not.toContain("history");
      expect(container.textContent).toContain("send");
    });

    it("keeps ^O available while the palette is open", () => {
      // The SET of hints is stable and only the ORDER adapts: a control that vanishes
      // because another surface opened is the "new chrome" the cockpit ruled out.
      const { container, input } = renderPanel();
      type(input, "/s");
      expect(container.textContent).toContain("^O");
    });

    it("emits ^O exactly once, whatever the state", () => {
      // Promotion, not duplication: the hint moves to the front when it leads and
      // stays at the back otherwise, but it appears once either way.
      for (const state of [BASE, CAPTURED_STATES.streaming, CAPTURED_STATES.toolBatch]) {
        const { container, input, unmount } = renderPanel(state as Partial<AssistantSessionState>);
        for (const draft of ["", "/s", "some prose"]) {
          type(input, draft);
          const occurrences = (container.textContent ?? "").split("^O").length - 1;
          expect(occurrences, `"${draft}" emitted ^O ${occurrences} times`).toBe(1);
        }
        unmount();
      }
    });

    it("says 'add' rather than 'send' while a turn is running", () => {
      const { container, input } = renderPanel(CAPTURED_STATES.streaming);
      type(input, "steer it");
      expect(container.textContent).toContain("add");
    });
  });
});
