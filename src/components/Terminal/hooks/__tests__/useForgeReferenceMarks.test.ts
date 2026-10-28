// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ForgeReferenceLookupResult } from "@shared/types/forge";

vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

const getReferencesByNumbers =
  vi.fn<(cwd: string, numbers: number[]) => Promise<ForgeReferenceLookupResult[] | null>>();

vi.mock("@/clients", () => ({
  forgeClient: {
    getReferencesByNumbers: (cwd: string, numbers: number[]) =>
      getReferencesByNumbers(cwd, numbers),
  },
}));

import { forgeReferenceField, rescanForgeReferences } from "../../inputEditorExtensions";
import { invalidateForgeReferences } from "@/services/forgeReferenceLookup";
import { REFERENCE_LOOKUP_SETTLE_MS, useForgeReferenceMarks } from "../useForgeReferenceMarks";

const CWD = "/repo";

/** Main's answer: every number in `found` is an open issue, the rest name nothing. */
function answerWith(found: number[]) {
  return async (_cwd: string, numbers: number[]): Promise<ForgeReferenceLookupResult[]> =>
    numbers.map((number) =>
      found.includes(number)
        ? {
            number,
            status: "found",
            reference: { kind: "issue", number, title: `Issue ${number}`, state: "open" },
          }
        : { number, status: "not_found" }
    );
}

interface Props {
  cwd: string | null;
  paused: boolean;
  value: string;
}

let view: EditorView;

function type(text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

function marked(): string[] {
  return [...view.dom.querySelectorAll(".cm-forge-ref")].map((el) => el.textContent ?? "");
}

function render(initial: Partial<Props> = {}) {
  const editorViewRef = { current: view };
  return renderHook(
    (props: Props) => useForgeReferenceMarks({ editorViewRef, terminalId: "t1", ...props }),
    { initialProps: { cwd: CWD, paused: false, value: view.state.doc.toString(), ...initial } }
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  invalidateForgeReferences();
  getReferencesByNumbers.mockReset();
  getReferencesByNumbers.mockImplementation(answerWith([7, 14843]));
  view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({ doc: "", extensions: [forgeReferenceField] }),
  });
});

afterEach(() => {
  view.destroy();
  vi.useRealTimers();
});

describe("useForgeReferenceMarks (#14849)", () => {
  it("asks once the draft has settled, then marks what was found", async () => {
    type("merge #14843 and #99, then #14843");
    render();
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS - 1);
    expect(getReferencesByNumbers).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(getReferencesByNumbers).toHaveBeenCalledExactlyOnceWith(CWD, [14843, 99]);
    expect(marked()).toEqual(["#14843", "#14843"]);
  });

  it("asks about the number typed, not each prefix of it", async () => {
    const hook = render();
    for (const draft of ["#1", "#14", "#148", "#1484", "#14843"]) {
      type(draft);
      hook.rerender({ cwd: CWD, paused: false, value: draft });
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    expect(getReferencesByNumbers).toHaveBeenCalledExactlyOnceWith(CWD, [14843]);
  });

  it("marks a number already known at once, without asking again", async () => {
    type("#7");
    const hook = render();
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    type("");
    hook.rerender({ cwd: CWD, paused: false, value: "" });
    expect(marked()).toEqual([]);

    type("see #7");
    hook.rerender({ cwd: CWD, paused: false, value: "see #7" });
    expect(marked()).toEqual(["#7"]);
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    expect(getReferencesByNumbers).toHaveBeenCalledTimes(1);
  });

  it("looks nothing up and marks nothing without a cwd", async () => {
    type("#7");
    const hook = render();
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    expect(marked()).toEqual(["#7"]);

    hook.rerender({ cwd: null, paused: false, value: "#7 again" });
    expect(marked()).toEqual([]);
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    expect(getReferencesByNumbers).toHaveBeenCalledTimes(1);
  });

  it("keeps what's known but asks nothing new while paused", async () => {
    type("#7");
    const hook = render();
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);

    type("#7 #14843");
    hook.rerender({ cwd: CWD, paused: true, value: "#7 #14843" });
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    expect(marked()).toEqual(["#7"]);
    expect(getReferencesByNumbers).toHaveBeenCalledTimes(1);
  });

  it("looks a restored draft up when asked to rescan", async () => {
    render();
    // A popped stash: the view's whole state is replaced, no document change.
    view.setState(EditorState.create({ doc: "see #14843", extensions: [forgeReferenceField] }));
    rescanForgeReferences(view);
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    expect(getReferencesByNumbers).toHaveBeenCalledExactlyOnceWith(CWD, [14843]);
    expect(marked()).toEqual(["#14843"]);
  });

  it("clears and re-reads its marks when the cache is invalidated", async () => {
    type("#7");
    render();
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    expect(marked()).toEqual(["#7"]);

    invalidateForgeReferences();
    expect(marked()).toEqual([]);
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    expect(getReferencesByNumbers).toHaveBeenCalledTimes(2);
    expect(marked()).toEqual(["#7"]);
  });

  it("asks nothing once unmounted", async () => {
    type("#7");
    const hook = render();
    hook.unmount();
    await vi.advanceTimersByTimeAsync(REFERENCE_LOOKUP_SETTLE_MS);
    expect(getReferencesByNumbers).not.toHaveBeenCalled();
  });
});
