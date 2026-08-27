// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantQuestionCard } from "../AssistantQuestionCard";
import type { AssistantQuestion } from "@/store/assistantStore";

/**
 * The question sheet's KEYBOARD, which is most of its value.
 *
 * What it renders is checked by the e2e suite against a real engine. What cannot be seen
 * there, and is where this surface goes quietly wrong, is which keys mean what: a digit
 * that answers when it should be typing into a filter commits a choice nobody made, and
 * a cursor left pointing at a filtered-out row answers with an option that is not on
 * screen. Both are silent — the engine takes the index and the turn continues.
 */

function question(count: number, overrides: Partial<AssistantQuestion> = {}): AssistantQuestion {
  return {
    questionId: "qst_1",
    turnId: "t1",
    toolCallId: "c1",
    question: "Which worktree should the migration run in?",
    options: Array.from({ length: count }, (_, i) => ({
      label: String.fromCharCode(65 + i),
      text: `option ${i + 1} text`,
    })),
    defaultIndex: 0,
    requestedAt: 0,
    ...overrides,
  };
}

/**
 * Renders the sheet inside a stand-in for the panel, with focus already in it.
 *
 * Both halves matter. The sheet only takes the keyboard when the assistant already had
 * it — a question arrives asynchronously, and stealing focus from a terminal someone is
 * typing in would turn their next keystroke into an answer — so a bare render would
 * never focus at all and every keyboard test would be checking the wrong thing.
 */
function mount(q: AssistantQuestion) {
  const onAnswer = vi.fn().mockReturnValue(true);
  render(
    <div data-assistant-surface="">
      <button type="button" data-testid="elsewhere-in-panel" autoFocus>
        composer
      </button>
      <AssistantQuestionCard question={q} onAnswer={onAnswer} />
    </div>
  );
  return { onAnswer, card: screen.getByRole("group", { name: "Question" }) };
}

/** A tick, so an awaited answer's `.finally` has run. */
const settle = () => act(async () => {});

/**
 * The status line while a CHOICE is being applied, rendered in isolation.
 *
 * Exists so the dismissal test can assert the two decisions read DIFFERENTLY without
 * either of them copying the sentence out of the component.
 */
function statusWhileChoosing(): string {
  const view = render(
    <div data-assistant-surface="">
      <AssistantQuestionCard
        question={question(3, { questionId: "qst_probe" })}
        onAnswer={vi.fn().mockReturnValue(new Promise<boolean>(() => {}))}
      />
    </div>
  );
  // Scoped to the probe's OWN container: testing-library's queries default to
  // document.body, so an unscoped lookup finds whichever card rendered first — which,
  // for the caller below, is the very card it is trying to compare against.
  const scope = within(view.container);
  fireEvent.click(scope.getAllByRole("option")[0]!);
  const text = scope.getByRole("status").textContent?.trim() ?? "";
  view.unmount();
  return text;
}

/** The row the cursor is on, by its text. */
function selected(): string {
  const active = screen
    .queryAllByRole("option")
    .find((o) => o.getAttribute("aria-selected") === "true");
  return active?.textContent ?? "";
}

function filterBox(): HTMLInputElement {
  return screen.getByRole("combobox", { name: "Filter options" }) as HTMLInputElement;
}

/** Types into the filter the way a person does — one keydown per character, then the value. */
function typeFilter(text: string) {
  const input = filterBox();
  for (const char of text) {
    fireEvent.keyDown(input, { key: char });
    fireEvent.change(input, { target: { value: input.value + char } });
  }
}

// jsdom implements no layout, so it ships no scrollIntoView at all. The sheet calls it
// on every cursor move to keep the highlighted row in a scrolling list visible.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

describe("AssistantQuestionCard", () => {
  it("starts on the option the engine asked for, not the first one", () => {
    mount(question(3, { defaultIndex: 2 }));
    expect(selected()).toContain("option 3 text");
  });

  it("clamps a NEGATIVE default as well as an over-large one", () => {
    // Both directions are the same class of bug on the far side of the wire, and only
    // one of them was covered — a negative index would leave the cursor pointing at
    // nothing and Enter answering with an index the engine rejects.
    mount(question(3, { defaultIndex: -4 }));
    expect(selected()).toContain("option 1 text");
  });

  it("clamps a default the engine put out of range", () => {
    // Out of range is a bug on the far side of the wire, and the sheet still has to be
    // answerable: a cursor at index 9 of three options highlights nothing, so Enter
    // either does nothing or answers with an index the engine will reject.
    mount(question(3, { defaultIndex: 9 }));
    expect(selected()).toContain("option 3 text");
  });

  it("moves with the arrows and answers the HIGHLIGHTED option on Enter", () => {
    const { onAnswer, card } = mount(question(4));
    fireEvent.keyDown(card, { key: "ArrowDown" });
    fireEvent.keyDown(card, { key: "ArrowDown" });
    expect(selected()).toContain("option 3 text");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledWith("qst_1", 2);
  });

  it("stops at both ends rather than wrapping", () => {
    // Wrapping is how a held-down arrow lands somewhere unrelated to where the user
    // thinks they are. Home and End are the way to the ends.
    const { card } = mount(question(3));
    fireEvent.keyDown(card, { key: "ArrowUp" });
    fireEvent.keyDown(card, { key: "ArrowUp" });
    expect(selected()).toContain("option 1 text");
    fireEvent.keyDown(card, { key: "End" });
    expect(selected()).toContain("option 3 text");
    fireEvent.keyDown(card, { key: "ArrowDown" });
    expect(selected()).toContain("option 3 text");
    fireEvent.keyDown(card, { key: "Home" });
    expect(selected()).toContain("option 1 text");
  });

  it("answers on a number key, by POSITION, on a short list", () => {
    const { onAnswer, card } = mount(question(3));
    fireEvent.keyDown(card, { key: "2" });
    expect(onAnswer).toHaveBeenCalledWith("qst_1", 1);
  });

  it("answers on the engine's own letter, case-insensitively", () => {
    const { onAnswer, card } = mount(question(3));
    fireEvent.keyDown(card, { key: "c" });
    expect(onAnswer).toHaveBeenCalledWith("qst_1", 2);
  });

  it("ignores a number past the end of the list", () => {
    const { onAnswer, card } = mount(question(3));
    fireEvent.keyDown(card, { key: "7" });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("leaves a modified key alone", () => {
    // Cmd-C over a selected option is a copy, not an answer to option C.
    const { onAnswer, card } = mount(question(3));
    fireEvent.keyDown(card, { key: "c", metaKey: true });
    fireEvent.keyDown(card, { key: "2", ctrlKey: true });
    fireEvent.keyDown(card, { key: "c", altKey: true });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("dismisses on Escape", () => {
    const { onAnswer, card } = mount(question(3));
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onAnswer).toHaveBeenCalledWith("qst_1", -1);
  });

  it("dismisses from the Dismiss button", () => {
    const { onAnswer } = mount(question(3));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onAnswer).toHaveBeenCalledWith("qst_1", -1);
  });

  it("leaves Enter and Space UNTOUCHED on the focused Dismiss button, and keeps Escape", () => {
    // The sheet's key handler sits above Dismiss, which is a tab stop. It used to take
    // Enter there — preventDefault-ing the button's own activation and answering the
    // highlighted option instead, so on `/backend` a control reading "Dismiss" persisted
    // a backend choice. Then the over-correction: handing the button EVERY key deleted
    // the sheet's two-stage Escape for the one user most likely to be standing on it.
    //
    // The assertion is `defaultPrevented`, not "nothing happened". `fireEvent.keyDown`
    // does not synthesize the browser's native button activation, so a test that only
    // checked for a missing answer would pass just as well if the sheet had swallowed
    // the key — which is the actual bug. Leaving the default INTACT is what lets the
    // browser turn Enter and Space into a click on the real thing.
    const { onAnswer } = mount(question(3));
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    dismiss.focus();

    for (const key of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      dismiss.dispatchEvent(event);
      expect(event.defaultPrevented, `the sheet swallowed ${key} on Dismiss`).toBe(false);
    }
    expect(onAnswer, "the sheet answered an option from the Dismiss button").not.toHaveBeenCalled();

    // Escape stays the SHEET's, because a button has no native meaning for it — handing
    // every key to the button deleted the two-stage Escape entirely.
    fireEvent.keyDown(dismiss, { key: "Escape" });
    expect(onAnswer).toHaveBeenCalledWith("qst_1", -1);
  });

  it("takes the highlighted option on Space, as a listbox does", () => {
    const { onAnswer, card } = mount(question(3));
    fireEvent.keyDown(card, { key: "ArrowDown" });
    fireEvent.keyDown(card, { key: " " });
    expect(onAnswer).toHaveBeenCalledWith("qst_1", 1);
  });

  it("freezes on a DISMISSAL too, not only on a choice", () => {
    // A dismissal has a round trip of its own — acceptance and the engine's
    // `question:answered` are separate events — so between them the sheet would sit
    // there looking answerable, swallowing every further action in silence.
    const onAnswer = vi.fn().mockReturnValue(new Promise<boolean>(() => {}));
    render(
      <div data-assistant-surface="">
        <AssistantQuestionCard question={question(3)} onAnswer={onAnswer} />
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    const card = screen.getByRole("group", { name: "Question" });
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    // …and the acknowledgement lives OUTSIDE that busy subtree, or assistive technology
    // may hold it back until busy clears — which on a successful answer never happens,
    // because the sheet unmounts instead.
    expect(screen.getByRole("listbox").contains(screen.getByRole("status"))).toBe(false);
    // No row is claimed: the answer is "none of them".
    expect(selected()).toBe("");
    // Frozen: the arrows no longer move anything.
    fireEvent.keyDown(card, { key: "ArrowDown" });
    expect(selected()).toBe("");
    // …and the status distinguishes THIS decision from the other one. Asserted as a
    // difference rather than as the sentence, which is microcopy and will be reworded.
    const dismissing = screen.getByRole("status").textContent?.trim() ?? "";
    expect(dismissing).not.toBe("");
    expect(dismissing).not.toBe(statusWhileChoosing());
  });

  it("freezes VISIBLY once an answer is in flight", () => {
    // The latch alone froze delivery and nothing else: arrows still moved the highlight,
    // the filter still took text, every control still looked live. The sheet could sit
    // showing option B highlighted while option A was the answer being applied.
    let settleAnswer = (_: boolean) => {};
    const onAnswer = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        settleAnswer = resolve;
      })
    );
    render(
      <div data-assistant-surface="">
        <AssistantQuestionCard question={question(3)} onAnswer={onAnswer} />
      </div>
    );
    const card = screen.getByRole("group", { name: "Question" });
    fireEvent.click(screen.getAllByRole("option")[0]!);

    // The submitted row is the one shown, and the arrows cannot move off it.
    expect(selected()).toContain("option 1 text");
    fireEvent.keyDown(card, { key: "ArrowDown" });
    expect(selected()).toContain("option 1 text");
    // …and the LIST reports itself busy rather than looking answerable.
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(
      true
    );

    // A refused delivery hands it all back.
    settleAnswer(false);
  });

  it("answers ONCE, however many times it is told to", () => {
    // The sheet stays on screen until the engine's `question:answered` comes back, so
    // every control on it is live for a round trip: a double-click sends the same answer
    // twice, and an Escape after a click dismisses a question already answered.
    const { onAnswer, card } = mount(question(3));
    const first = screen.getAllByRole("option")[0]!;
    fireEvent.click(first);
    fireEvent.click(first);
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith("qst_1", 0);
  });

  it("shows the labels the ENGINE sent, not ones of its own", () => {
    // The label is an identity: it travels on the wire, into the transcript, and into
    // what the model is told the user chose. A surface that generated its own would
    // disagree with all three about which option "B" was.
    //
    // Deliberately NON-canonical labels. Against the usual A/B/C a component that
    // regenerated the alphabet itself would pass this test while being exactly the bug
    // it is meant to catch, so the fixture has to be something no generator would emit.
    const q = question(3);
    q.options = [
      { label: "X", text: "first" },
      { label: "Y", text: "second" },
      { label: "Z", text: "third" },
    ];
    const { onAnswer } = mount(q);
    const rows = screen.getAllByRole("option");
    expect(rows.map((r) => within(r).getByText(/^[A-Z]$/).textContent)).toEqual(["X", "Y", "Z"]);
    // …and the accelerator follows the engine's letter, not the position's letter.
    fireEvent.keyDown(screen.getByRole("group", { name: "Question" }), { key: "y" });
    expect(onAnswer).toHaveBeenCalledWith("qst_1", 1);
  });

  it("keeps itself answerable when the engine never received the answer", async () => {
    // The sheet stays up until the engine confirms, so it latches on the first answer to
    // stop a double-click sending two. If the answer never LEFT — no live session, an
    // IPC that answered `delivered: false` — that latch would strand a visible sheet
    // that ignores every retry until the question times out.
    const onAnswer = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(
      <div data-assistant-surface="">
        <AssistantQuestionCard question={question(3)} onAnswer={onAnswer} />
      </div>
    );
    const rows = screen.getAllByRole("option");
    fireEvent.click(rows[0]!);
    // Still latched while delivery is in flight: a click landing mid-round-trip is
    // swallowed rather than queued behind an answer that may yet succeed.
    fireEvent.click(rows[1]!);
    expect(onAnswer).toHaveBeenCalledTimes(1);

    await settle();
    fireEvent.click(rows[1]!);
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenLastCalledWith("qst_1", 1);

    // …and it latches for good once one is actually delivered.
    await settle();
    fireEvent.click(rows[2]!);
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it("keeps itself answerable when the answer THROWS", async () => {
    // A handler that rejects is a failed answer like any other, and the latch has to
    // reopen for it too — but the rejection must not escape as an unhandled one, which
    // in Electron is a console error at best and a crash report at worst.
    const onAnswer = vi.fn().mockRejectedValueOnce(new Error("ipc gone")).mockResolvedValue(true);
    const unhandled: unknown[] = [];
    const trap = (e: PromiseRejectionEvent) => {
      unhandled.push(e.reason);
      e.preventDefault();
    };
    window.addEventListener("unhandledrejection", trap);
    try {
      render(
        <div data-assistant-surface="">
          <AssistantQuestionCard question={question(3)} onAnswer={onAnswer} />
        </div>
      );
      const rows = screen.getAllByRole("option");
      fireEvent.click(rows[0]!);
      await settle();
      fireEvent.click(rows[1]!);
      expect(onAnswer).toHaveBeenCalledTimes(2);
      await settle();
      expect(unhandled, "the rejected answer escaped as an unhandled rejection").toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", trap);
    }
  });

  it("does NOT take the keyboard when focus is outside the assistant", () => {
    // A question arrives asynchronously — the model can ask thirty seconds into a turn,
    // by which point the user may be typing in a terminal. Grabbing focus there is bad
    // on its own and worse here: on a short list their very next character is an
    // accelerator, so a stolen focus turns an ordinary keystroke into an answer to a
    // question they have not read.
    render(
      <>
        <button type="button" data-testid="elsewhere" autoFocus>
          a terminal
        </button>
        <div data-assistant-surface="">
          <AssistantQuestionCard question={question(3)} onAnswer={vi.fn()} />
        </div>
      </>
    );
    expect(document.activeElement).toBe(screen.getByTestId("elsewhere"));
  });

  it("never points at a row that is not on screen", () => {
    // `aria-activedescendant` naming an element that is not in the document is read as
    // nothing at all, silently — and the cursor indexes the ORIGINAL list, so every
    // filter keystroke is a chance to leave it pointing at a row just removed.
    mount(question(8));
    const list = screen.getByRole("listbox");
    for (const step of ["o", "p", "t", "i", "o", "n", " ", "6", "x", "y"]) {
      fireEvent.keyDown(filterBox(), { key: step });
      fireEvent.change(filterBox(), { target: { value: filterBox().value + step } });
      const active =
        list.getAttribute("aria-activedescendant") ??
        filterBox().getAttribute("aria-activedescendant");
      if (active) expect(document.getElementById(active), `dangling ${active}`).not.toBeNull();
    }
  });

  it("SHOWS the number that answers each row, not only accepts it", () => {
    // A keycap is an instruction. Digits answering while nothing on screen says so left
    // the fastest way to use this sheet as folklore in a footer hint — which is how it
    // started: a numbered terminal menu the user could read, replaced by lettered rows
    // they could not.
    mount(question(3));
    const rows = screen.getAllByRole("option");
    expect(rows.map((r) => within(r).getByText(/^[1-9]$/).textContent)).toEqual(["1", "2", "3"]);
  });

  it("drops the number when the filter takes the keys it names", () => {
    // The digit is the accelerator's label, and past the threshold the accelerator is
    // gone — a keycap for a key that types into the search box is an instruction that
    // does something else.
    mount(question(8));
    expect(screen.queryAllByText(/^[1-9]$/)).toHaveLength(0);
  });

  it("gives a NEW question a fresh sheet, not the last one's state", () => {
    // The latch, the cursor and the filter all belong to one question. The call site
    // keys this component on the question id so a new one mounts fresh; without that,
    // the new question would render for a commit under the previous one's closed latch
    // and ignore the first answer given to it.
    const onAnswer = vi.fn().mockReturnValue(true);
    const { rerender } = render(
      <div data-assistant-surface="">
        <AssistantQuestionCard key="qst_1" question={question(3)} onAnswer={onAnswer} />
      </div>
    );
    fireEvent.click(screen.getAllByRole("option")[0]!);
    expect(onAnswer).toHaveBeenCalledTimes(1);

    const next = question(3, { questionId: "qst_2", defaultIndex: 2 });
    rerender(
      <div data-assistant-surface="">
        <AssistantQuestionCard key="qst_2" question={next} onAnswer={onAnswer} />
      </div>
    );
    expect(selected()).toContain("option 3 text");
    fireEvent.click(screen.getAllByRole("option")[1]!);
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenLastCalledWith("qst_2", 1);
  });

  it("offers no filter box on a list that fits in one glance", () => {
    mount(question(3));
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  describe("with enough options to filter", () => {
    it("focuses the filter box and narrows the list to what matches", () => {
      mount(question(8));
      expect(filterBox()).toBe(document.activeElement);
      typeFilter("option 7");
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(selected()).toContain("option 7 text");
    });

    it("does NOT let a digit answer while there is a filter to type into", () => {
      // The whole reason the accelerators are conditional. A question whose options are
      // ports or branch names is exactly where "8" as the first character of a search
      // would instead commit an answer nobody chose.
      const { onAnswer } = mount(question(8));
      typeFilter("8");
      expect(onAnswer).not.toHaveBeenCalled();
      expect(filterBox().value).toBe("8");
    });

    it("answers with the option that is actually on screen after filtering", () => {
      // The cursor indexes the ORIGINAL list, so a filter that removes the row under it
      // must move it — otherwise Enter answers with something the filter ruled out.
      const { onAnswer } = mount(question(8));
      typeFilter("option 6");
      fireEvent.keyDown(filterBox(), { key: "Enter" });
      expect(onAnswer).toHaveBeenCalledWith("qst_1", 5);
    });

    it("leaves Home and End to the filter's own caret", () => {
      // In a text field these are the caret's keys. Taking them for a list the arrows
      // already reach both ends of makes an ordinary input behave unlike every other one
      // in the app.
      //
      // `defaultPrevented`, not "the row did not move". Swallowing the key and moving
      // nothing looks identical from the selection's side and is the actual bug — the
      // caret would stop working while the list stayed put.
      mount(question(8));
      typeFilter("option");
      const before = selected();
      for (const key of ["Home", "End"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        filterBox().dispatchEvent(event);
        expect(event.defaultPrevented, `the sheet swallowed ${key} in the filter`).toBe(false);
      }
      expect(selected()).toBe(before);
    });

    it("freezes the FILTER too, once an answer is in flight", () => {
      // The freeze test above uses a short list, which has no filter at all — so a
      // filter that stayed editable through submission would pass it while letting the
      // list change under an answer already committed.
      const onAnswer = vi.fn().mockReturnValue(new Promise<boolean>(() => {}));
      render(
        <div data-assistant-surface="">
          <AssistantQuestionCard question={question(8)} onAnswer={onAnswer} />
        </div>
      );
      typeFilter("option");
      fireEvent.click(screen.getAllByRole("option")[0]!);

      // `readOnly`, which is what actually stops a person typing. Asserted as the
      // property rather than by firing a change event: `fireEvent.change` sets `.value`
      // directly and dispatches, so it walks straight past `readOnly` and would "prove"
      // a freeze that does not exist in either direction.
      expect(filterBox().readOnly).toBe(true);
      // …and the keys the sheet owns are frozen with it.
      const before = selected();
      fireEvent.keyDown(filterBox(), { key: "ArrowDown" });
      expect(selected()).toBe(before);
    });

    it("announces an empty result outside the listbox", () => {
      // A listbox may only contain options, so "No option matches" inside it was neither
      // an option nor a status — a screen reader had nothing to read, and the list went
      // silent exactly when the user needed to know their filter matched nothing.
      mount(question(8));
      typeFilter("nope");
      // The STRUCTURE, not the wording: a non-empty status that lives outside the
      // listbox. Asserting the sentence would just copy the microcopy into a second
      // place and fail the day it is reworded.
      const status = screen.getByRole("status");
      expect(status.textContent?.trim()).not.toBe("");
      expect(screen.getByRole("listbox").contains(status)).toBe(false);
    });

    it("takes Escape as CLEAR first and only then as dismiss", () => {
      const { onAnswer } = mount(question(8));
      typeFilter("option 3");
      fireEvent.keyDown(filterBox(), { key: "Escape" });
      expect(onAnswer).not.toHaveBeenCalled();
      expect(filterBox().value).toBe("");
      fireEvent.keyDown(filterBox(), { key: "Escape" });
      expect(onAnswer).toHaveBeenCalledWith("qst_1", -1);
    });

    it("refuses to answer when nothing matches", () => {
      const { onAnswer } = mount(question(8));
      typeFilter("nope");
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      fireEvent.keyDown(filterBox(), { key: "Enter" });
      expect(onAnswer).not.toHaveBeenCalled();
      expect(screen.getByText("No option matches")).toBeTruthy();
    });

    it("matches on every term, in any order", () => {
      // Substring per term rather than one contiguous match: "7 option" is the same
      // query as "option 7", which is what someone typing a branch and a status expects.
      mount(question(8));
      typeFilter("7 option");
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
  });
});
