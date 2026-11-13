// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DecisionsModelEvaluation,
  DecisionsModelState,
  SetDecisionsModelPayload,
} from "@shared/types/decisionsModel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsModelSection } from "../DecisionsModelSection";
import { useDecisionsModel } from "../useDecisionsModel";

function state(overrides: Partial<DecisionsModelState> = {}): DecisionsModelState {
  return {
    revision: 0,
    learning: false,
    adapter: null,
    history: { state: "closed", stored: false },
    evaluation: null,
    running: null,
    lastRun: null,
    answeringFrom: null,
    ...overrides,
  };
}

const EVALUATION: DecisionsModelEvaluation = {
  adapter: "claude",
  evaluatedAt: 1_761_955_200_000,
  report: {
    total: 60,
    scored: 50,
    answered: 40,
    matched: 37,
    abstained: 10,
    buckets: [
      { lo: 0, hi: 0.5, answered: 0, matched: 0 },
      { lo: 0.5, hi: 0.9, answered: 8, matched: 5 },
      { lo: 0.9, hi: 1, answered: 32, matched: 32 },
    ],
    abstainReasons: { "insufficient-history": 10 },
    byKind: { choice: { answered: 40, matched: 37 } },
    targetAccuracy: 0.9,
    minSamples: 30,
    recommendedThreshold: 0.9,
  },
  autoAnswerThreshold: null,
  thresholds: [{ threshold: 0.9, answered: 32, matched: 32 }],
};

const getModel = vi.fn<() => Promise<DecisionsModelState>>();
const setModel = vi.fn<(payload: SetDecisionsModelPayload) => Promise<DecisionsModelState>>();
const startModelEvaluation = vi.fn<() => Promise<DecisionsModelState>>();
const cancelModelEvaluation = vi.fn<(payload: { runId: string }) => Promise<DecisionsModelState>>();
const setModelThreshold = vi.fn();
const clearModelHistory = vi.fn<() => Promise<DecisionsModelState>>();
const statusListeners = new Set<() => void>();

function Section({ active = true, proxyAllowlisted = false }) {
  const read = useDecisionsModel(active);
  return (
    <TooltipProvider>
      <DecisionsModelSection model={read} proxyAllowlisted={proxyAllowlisted} />
    </TooltipProvider>
  );
}

async function renderSection(props: { active?: boolean; proxyAllowlisted?: boolean } = {}) {
  const view = render(<Section {...props} />);
  await act(async () => {});
  return view;
}

function learningSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", { name: /Learn from your answers/ }) as HTMLButtonElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Longer than a dialog's exit animation, so one that closed has left the DOM by then. */
const EXIT_ALLOWANCE_MS = 300;

/** A dialog plays its exit before it leaves the DOM. */
async function gone() {
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}

function row(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found;
}

beforeEach(() => {
  for (const mock of [
    getModel,
    setModel,
    startModelEvaluation,
    cancelModelEvaluation,
    setModelThreshold,
    clearModelHistory,
  ]) {
    mock.mockReset();
  }
  statusListeners.clear();
  Object.defineProperty(window, "electron", {
    value: {
      decisions: {
        getModel,
        setModel,
        startModelEvaluation,
        cancelModelEvaluation,
        setModelThreshold,
        clearModelHistory,
      },
      events: {
        on: (name: string, listener: () => void) => {
          if (name !== "decisions:status-changed") return () => {};
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("Decisions → Decision model", () => {
  it("reads nothing while Decisions is off, and offers nothing to change", async () => {
    await renderSection({ active: false });
    expect(getModel).not.toHaveBeenCalled();
    expect(statusListeners.size).toBe(0);
    expect(learningSwitch().getAttribute("aria-checked")).toBe("false");
    expect(learningSwitch().disabled).toBe(true);
  });

  it("asks before learning first turns on, and turns it on only on agreement", async () => {
    getModel.mockResolvedValue(state());
    setModel.mockResolvedValue(
      state({
        revision: 1,
        learning: true,
        consentedAt: 5,
        history: { state: "open", count: 0 },
      })
    );
    await renderSection();

    fireEvent.click(learningSwitch());
    const dialog = screen.getByRole("dialog");
    // It says what is kept here and where a CLI sends it.
    expect(dialog.textContent).toContain("Kept on this computer, not encrypted");
    for (const provider of ["Anthropic", "OpenAI", "Google"]) {
      expect(dialog.textContent).toContain(provider);
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(setModel).not.toHaveBeenCalled();
    expect(learningSwitch().getAttribute("aria-checked")).toBe("false");

    fireEvent.click(learningSwitch());
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: "Turn on learning" })
      );
    });
    expect(setModel).toHaveBeenCalledExactlyOnceWith({
      learning: true,
      adapter: null,
      consent: true,
    });
    expect(learningSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the agreement open and locked until main answers, then hands focus back to the switch", async () => {
    getModel.mockResolvedValue(state());
    const saving = deferred<DecisionsModelState>();
    setModel.mockReturnValue(saving.promise);
    await renderSection();

    learningSwitch().focus();
    fireEvent.click(learningSwitch());
    const accept = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Turn on learning",
    });
    act(() => accept.focus());
    await act(async () => {
      fireEvent.click(accept);
    });
    expect(setModel).toHaveBeenCalledExactlyOnceWith({
      learning: true,
      adapter: null,
      consent: true,
    });
    // Past any exit animation, still open over a switch that can't take focus
    // yet, and Cancel can't take back what's being saved.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXIT_ALLOWANCE_MS));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(learningSwitch().disabled).toBe(true);

    await act(async () => saving.resolve(state({ revision: 1, learning: true, consentedAt: 5 })));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(learningSwitch().disabled).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(learningSwitch()));
  });

  it("closes the agreement on a failed save too, with the failure in the section", async () => {
    getModel.mockResolvedValue(state());
    const saving = deferred<DecisionsModelState>();
    setModel.mockReturnValue(saving.promise);
    await renderSection();

    learningSwitch().focus();
    fireEvent.click(learningSwitch());
    const accept = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Turn on learning",
    });
    act(() => accept.focus());
    await act(async () => {
      fireEvent.click(accept);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXIT_ALLOWANCE_MS));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    await act(async () => saving.reject(new Error("store is locked")));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(row("decisions-model").textContent).toContain("store is locked");
    expect(learningSwitch().getAttribute("aria-checked")).toBe("false");
    await vi.waitFor(() => expect(document.activeElement).toBe(learningSwitch()));
  });

  it("turns learning on again without asking once agreed, keeping the CLI chosen", async () => {
    getModel.mockResolvedValue(state({ consentedAt: 5, adapter: "gemini" }));
    setModel.mockResolvedValue(state({ revision: 1, learning: true, consentedAt: 5 }));
    await renderSection();

    await act(async () => {
      fireEvent.click(learningSwitch());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setModel).toHaveBeenCalledExactlyOnceWith({ learning: true, adapter: "gemini" });
  });

  it("says where each CLI sends, and saves the one chosen", async () => {
    getModel.mockResolvedValue(
      state({ learning: true, consentedAt: 5, history: { state: "open", count: 3 } })
    );
    setModel.mockResolvedValue(
      state({
        revision: 1,
        learning: true,
        adapter: "codex",
        consentedAt: 5,
        history: { state: "open", count: 3 },
      })
    );
    await renderSection();

    const choices = screen.getByRole("radiogroup");
    const codex = within(choices).getByRole("radio", { name: /Codex CLI/ });
    expect(codex.textContent).toContain("OpenAI");
    expect(within(choices).getByRole("radio", { name: /None/ }).textContent).toContain(
      "Nothing is sent"
    );

    await act(async () => {
      fireEvent.click(codex);
    });
    expect(setModel).toHaveBeenCalledExactlyOnceWith({ learning: true, adapter: "codex" });
  });

  it("offers no CLI or evaluation while learning is off, and says why", async () => {
    getModel.mockResolvedValue(
      state({ consentedAt: 5, history: { state: "closed", stored: true } })
    );
    await renderSection();

    const choices = screen.getByRole("radiogroup");
    for (const radio of within(choices).getAllByRole("radio")) {
      expect(radio.hasAttribute("disabled")).toBe(true);
    }
    expect(document.body.textContent).toContain("Turn on learning to choose an agent CLI");
    expect(screen.queryByRole("button", { name: /^Evaluate/ })).toBeNull();
    // What it learned before can still be cleared.
    expect(
      (screen.getByRole("button", { name: "Clear history" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("shows the report by confidence before any automatic answer, with nothing chosen", async () => {
    getModel.mockResolvedValue(
      state({
        learning: true,
        adapter: "claude",
        consentedAt: 5,
        history: { state: "open", count: 60 },
        evaluation: EVALUATION,
      })
    );
    await renderSection();

    const report = row("decisions-model-report");
    expect(report.textContent).toContain("matched your answer on 37 of 40 (93%)");
    const table = within(report).getByRole("table");
    const rows = within(table).getAllByRole("row");
    // A header, then one row per band.
    expect(rows).toHaveLength(EVALUATION.report.buckets.length + 1);
    expect(rows[2]!.textContent).toContain("5 of 8 (63%)");
    expect(rows[3]!.textContent).toContain("0.90 to 1.00");
    expect(rows[1]!.textContent).toContain("—");

    expect(row("decisions-model-threshold").textContent).toContain("Don't answer automatically");
    expect(row("decisions-model-answering").textContent).toContain("Not answering");
  });

  it("chooses a threshold from the report's own, for the report it was read from", async () => {
    const learning = state({
      learning: true,
      adapter: "claude",
      consentedAt: 5,
      history: { state: "open", count: 60 },
      evaluation: EVALUATION,
    });
    getModel.mockResolvedValue(learning);
    setModelThreshold.mockResolvedValue({
      ...learning,
      revision: 1,
      evaluation: { ...EVALUATION, autoAnswerThreshold: 0.9 },
      answeringFrom: 0.9,
    });
    await renderSection();

    const trigger = within(row("decisions-model-threshold")).getByRole("combobox");
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    });
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual([
      "Don't answer automatically",
      "At confidence 0.90 or higher: matched 32 of 32 (100%)",
    ]);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("option", { name: /0\.90 or higher/ }), { key: "Enter" });
    });

    expect(setModelThreshold).toHaveBeenCalledExactlyOnceWith({
      threshold: 0.9,
      evaluatedAt: EVALUATION.evaluatedAt,
    });
    expect(within(row("decisions-model-threshold")).getByRole("combobox").textContent).toContain(
      "0.90 or higher"
    );
    expect(row("decisions-model-answering").textContent).toContain("Answering in your place");
  });

  it("recovers a failed threshold choice by reading the model again, and says when that fails", async () => {
    const learning = state({
      learning: true,
      adapter: "claude",
      consentedAt: 5,
      history: { state: "open", count: 60 },
      evaluation: EVALUATION,
    });
    getModel.mockResolvedValueOnce(learning);
    setModelThreshold.mockRejectedValueOnce(new Error("The decision model's evaluation changed"));
    // The read after the failure, then a Reload that fails, then one that works.
    getModel.mockResolvedValueOnce(learning);
    getModel.mockRejectedValueOnce(new Error("Decisions has stopped"));
    getModel.mockResolvedValueOnce({ ...learning, revision: 2 });
    await renderSection();

    const trigger = within(row("decisions-model-threshold")).getByRole("combobox");
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("option", { name: /0\.90 or higher/ }), { key: "Enter" });
    });
    expect(screen.getByText("Couldn't change when the model answers")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    });
    expect(screen.queryByText("Couldn't change when the model answers")).toBeNull();
    expect(screen.getByText("Couldn't read the decision model's settings")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.queryByText("Couldn't read the decision model's settings")).toBeNull();
  });

  it("offers Clear history for a history that couldn't be opened", async () => {
    getModel.mockResolvedValue(
      state({ learning: true, consentedAt: 5, history: { state: "unavailable" } })
    );
    await renderSection();
    const clear = within(row("decisions-model-history")).getByRole("button", {
      name: "Clear history",
    });
    expect(clear.hasAttribute("disabled")).toBe(false);
    expect(row("decisions-model-history").textContent).toContain("couldn't be opened");
  });

  it("retries a failed cancel for the run it named, not a newer one", async () => {
    const run = (runId: string) => ({
      runId,
      adapter: "claude" as const,
      startedAt: 1,
      historyCount: 12,
    });
    const learning = state({
      learning: true,
      adapter: "claude",
      consentedAt: 5,
      history: { state: "open", count: 12 },
    });
    getModel.mockResolvedValueOnce({ ...learning, running: run("run-a") });
    // After the failure, main shows another window's newer run.
    getModel.mockResolvedValue({ ...learning, revision: 5, running: run("run-b") });
    cancelModelEvaluation.mockRejectedValueOnce(new Error("Decisions has stopped"));
    cancelModelEvaluation.mockResolvedValue({ ...learning, revision: 6 });
    await renderSection();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(screen.getByText("Couldn't cancel the evaluation")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(cancelModelEvaluation.mock.calls.map(([payload]) => payload.runId)).toEqual([
      "run-a",
      "run-a",
    ]);
  });

  it("says what answers now, and that questions without a gate still need the person while Policy says so", async () => {
    getModel.mockResolvedValue(
      state({
        learning: true,
        adapter: "claude",
        consentedAt: 5,
        history: { state: "open", count: 60 },
        evaluation: { ...EVALUATION, autoAnswerThreshold: 0.9 },
        answeringFrom: 0.9,
      })
    );
    const { unmount } = await renderSection();
    const answering = row("decisions-model-answering").textContent ?? "";
    expect(answering).toContain("Answering in your place");
    expect(answering).toContain("0.90 or higher");
    expect(answering).toContain("Allow proxy answers is off");
    unmount();

    await renderSection({ proxyAllowlisted: true });
    expect(row("decisions-model-answering").textContent).not.toContain(
      "Allow proxy answers is off"
    );
  });

  it("starts an evaluation, and cancels the run it shows", async () => {
    const learning = state({
      learning: true,
      adapter: "claude",
      consentedAt: 5,
      history: { state: "open", count: 12 },
    });
    getModel.mockResolvedValue(learning);
    const run = { runId: "run-1", adapter: "claude" as const, startedAt: 1, historyCount: 12 };
    startModelEvaluation.mockResolvedValue({ ...learning, revision: 1, running: run });
    cancelModelEvaluation.mockResolvedValue({ ...learning, revision: 2, running: run });
    await renderSection();

    expect(row("decisions-model-evaluate").textContent).toContain("sends them to Anthropic");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
    });
    expect(startModelEvaluation).toHaveBeenCalledOnce();
    expect(row("decisions-model-evaluate").textContent).toContain("goes on if you close Settings");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(cancelModelEvaluation).toHaveBeenCalledExactlyOnceWith({ runId: "run-1" });
  });

  it("asks for a CLI before an evaluation can start", async () => {
    getModel.mockResolvedValue(
      state({ learning: true, consentedAt: 5, history: { state: "open", count: 4 } })
    );
    await renderSection();
    expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(row("decisions-model-evaluate").textContent).toContain("Choose an agent CLI first");
  });

  it("clears the history only once confirmed", async () => {
    const learning = state({
      learning: true,
      consentedAt: 5,
      history: { state: "open", count: 7 },
    });
    getModel.mockResolvedValue(learning);
    clearModelHistory.mockResolvedValue({
      ...learning,
      revision: 1,
      history: { state: "open", count: 0 },
    });
    await renderSection();
    const clearButton = () =>
      within(row("decisions-model-history")).getByRole("button", {
        name: "Clear history",
      }) as HTMLButtonElement;

    fireEvent.click(clearButton());
    let dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("7 answers");
    expect(dialog.textContent).toContain("Learning stays on");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(clearModelHistory).not.toHaveBeenCalled();
    await gone();

    fireEvent.click(clearButton());
    dialog = screen.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));
    });
    expect(clearModelHistory).toHaveBeenCalledOnce();
    await gone();
    // Nothing is stored now, so there is nothing to clear.
    expect(clearButton().disabled).toBe(true);
  });

  it("keeps the newest answer when an older read lands after it", async () => {
    let answer!: (value: DecisionsModelState) => void;
    getModel.mockResolvedValueOnce(state({ revision: 3, consentedAt: 5 }));
    getModel.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await renderSection();

    await act(async () => {
      for (const listener of [...statusListeners]) listener();
    });
    await act(async () => answer(state({ revision: 2, learning: true, consentedAt: 5 })));
    expect(learningSwitch().getAttribute("aria-checked")).toBe("false");
  });
});
