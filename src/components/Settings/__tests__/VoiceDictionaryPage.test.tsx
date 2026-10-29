// @vitest-environment jsdom
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceDictionaryPage } from "../VoiceDictionaryPage";
import { MAX_DICTIONARY_IMPORT_TERMS } from "../voiceDictionaryImport";
import {
  acceptSuggestion,
  addDictionaryEntry,
  removeDictionaryEntry,
  updateDictionaryEntry,
  type AddDictionaryEntryInput,
  type DictionaryEntryChanges,
} from "@shared/utils/voiceDictionary";
import type {
  HeardAsConflict,
  SuggestedDictionaryEntry,
  VoiceDictionaryChange,
  VoiceDictionaryEntry,
  VoiceDictionaryState,
} from "@shared/types";

const term = (value: string): VoiceDictionaryEntry => ({
  term: value,
  heardAs: [],
  source: "manual",
  addedAt: 1,
});

function install(dictionaryOverrides: Record<string, unknown>) {
  const voiceDictionary = {
    add: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    acceptSuggestion: vi.fn(),
    dismissSuggestion: vi.fn(),
    recordSuggestions: vi.fn(),
    ...dictionaryOverrides,
  };
  Object.defineProperty(window, "electron", {
    value: { voiceDictionary },
    configurable: true,
    writable: true,
  });
  return voiceDictionary;
}

// Answers like main: the dictionary model run over what main holds, conflicts and all.
function mainLike(
  initial: VoiceDictionaryEntry[] = [],
  suggested: SuggestedDictionaryEntry[] = []
) {
  let state: VoiceDictionaryState = { dictionary: initial, suggestedDictionary: suggested };
  const answer = (
    apply: (state: VoiceDictionaryState, conflicts: HeardAsConflict[]) => VoiceDictionaryState
  ): VoiceDictionaryChange => {
    const conflicts: HeardAsConflict[] = [];
    state = apply(state, conflicts);
    return { ...state, conflicts };
  };
  return {
    add: vi.fn(async (input: AddDictionaryEntryInput) =>
      answer((s, c) => ({ ...s, dictionary: addDictionaryEntry(s.dictionary, input, 1, c) }))
    ),
    update: vi.fn(
      async ({ term: key, changes }: { term: string; changes: DictionaryEntryChanges }) =>
        answer((s, c) => ({
          ...s,
          dictionary: updateDictionaryEntry(s.dictionary, key, changes, c),
        }))
    ),
    remove: vi.fn(async ({ term: key }: { term: string }) =>
      answer((s) => ({ ...s, dictionary: removeDictionaryEntry(s.dictionary, key) }))
    ),
    acceptSuggestion: vi.fn(async ({ word }: { word: string }) =>
      answer((s, c) => acceptSuggestion(s, word, 1, undefined, c))
    ),
  };
}

const mainLikeAdd = (initial: VoiceDictionaryEntry[] = []) => mainLike(initial).add;

// Stands in for the voice tab: shows whatever dictionary main returned.
// With `retry`, a change that fails runs once more, as the tab's Retry button would.
function PageWith({
  initial,
  suggestions = [],
  retry = false,
}: {
  initial: VoiceDictionaryEntry[];
  suggestions?: SuggestedDictionaryEntry[];
  retry?: boolean;
}) {
  const [entries, setEntries] = useState<VoiceDictionaryEntry[]>(initial);
  return (
    <VoiceDictionaryPage
      entries={entries}
      suggestions={suggestions}
      failure={null}
      onBack={() => {}}
      onChange={async (_label, run, onSaved) => {
        const next = await run().catch((error: unknown) => {
          if (!retry) throw error;
          return run();
        });
        setEntries(next.dictionary);
        onSaved?.();
        return true;
      }}
    />
  );
}

const Page = () => <PageWith initial={[]} />;

const addField = () => screen.getByLabelText<HTMLTextAreaElement>("Add terms");

afterEach(() => {
  vi.clearAllMocks();
});

describe("VoiceDictionaryPage", () => {
  it("keeps what was typed while an add was in flight", async () => {
    let finish: (state: VoiceDictionaryChange) => void = () => {};
    install({ add: vi.fn(() => new Promise((resolve) => (finish = resolve))) });
    render(<Page />);

    const input = addField();
    fireEvent.change(input, { target: { value: "Daintree" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Zust" } });
    finish({ dictionary: [term("Daintree")], suggestedDictionary: [], conflicts: [] });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Daintree" })).toBeTruthy()
    );
    expect(input.value).toBe("Zust");
  });

  it("adds a paste up to the import cap and says how many it left out", async () => {
    const add = mainLikeAdd();
    install({ add });
    const { container } = render(<Page />);

    const lines = Array.from({ length: MAX_DICTIONARY_IMPORT_TERMS + 2 }, (_, i) => `term${i}`);
    fireEvent.change(addField(), { target: { value: lines.join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(container.textContent).toContain(
        `Added ${MAX_DICTIONARY_IMPORT_TERMS} terms. Left out 2 terms past the first ${MAX_DICTIONARY_IMPORT_TERMS}`
      )
    );
    expect(add).toHaveBeenCalledTimes(MAX_DICTIONARY_IMPORT_TERMS);
  });

  it("reports what a paste changed, not how many terms it held (#15233)", async () => {
    const stored = [term("Daintree"), { ...term("Zustand"), heardAs: ["zoo stand"] }];
    install({ add: mainLikeAdd(stored) });
    const { container } = render(<PageWith initial={stored} />);

    fireEvent.change(addField(), {
      target: { value: "daintree\nzoo stand -> Zustand\nzu stand -> Zustand\nVitest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Added 1 term. Added 1 heard-as phrase to 1 existing term. 1 term was already in the dictionary"
      )
    );
  });

  it("says a paste of terms already stored added nothing", async () => {
    const stored = [term("Daintree"), term("Zustand")];
    install({ add: mainLikeAdd(stored) });
    const { container } = render(<PageWith initial={stored} />);

    fireEvent.change(addField(), { target: { value: "Daintree, Zustand" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(container.textContent).toContain("2 terms were already in the dictionary")
    );
    expect(container.textContent).not.toMatch(/Added \d/);
  });

  describe("a heard-as phrase another term already has", () => {
    const zustand = { ...term("Zustand"), heardAs: ["zoo stand"] };

    it("asks before a hand add takes it, and moves it on Move", async () => {
      const main = mainLike([zustand]);
      install(main);
      const { container } = render(<PageWith initial={[zustand]} />);

      fireEvent.change(addField(), { target: { value: "Zoo Stand -> Zoostand" } });
      fireEvent.keyDown(addField(), { key: "Enter" });
      expect(container.textContent).toContain(
        "“Zoo Stand” already belongs to Zustand. Move it to Zoostand?"
      );
      expect(main.add).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Move phrase" }));
      await waitFor(() => expect(addField().value).toBe(""));
      expect(main.add).toHaveBeenCalledWith({
        term: "Zoostand",
        heardAs: ["Zoo Stand"],
        heardAsConflict: "move",
      });
      expect(container.textContent).toContain('Heard as "Zoo Stand"');
      expect(container.textContent).not.toContain('Heard as "zoo stand"');
    });

    it("keeps the draft on Cancel, and drops the question once the draft changes", () => {
      const main = mainLike([zustand]);
      install(main);
      render(<PageWith initial={[zustand]} />);

      fireEvent.change(addField(), { target: { value: "zoo stand -> Zoostand" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("button", { name: "Move phrase" })).toBeNull();
      expect(addField().value).toBe("zoo stand -> Zoostand");
      expect(document.activeElement).toBe(addField());

      fireEvent.keyDown(addField(), { key: "Enter" });
      expect(screen.getByRole("button", { name: "Move phrase" })).toBeTruthy();
      fireEvent.change(addField(), { target: { value: "zu stand -> Zoostand" } });
      expect(screen.queryByRole("button", { name: "Move phrase" })).toBeNull();
      expect(main.add).not.toHaveBeenCalled();
    });

    it("asks the same question when main refuses a phrase this page hadn't seen taken", async () => {
      const main = mainLike([zustand]);
      install(main);
      const { container } = render(<PageWith initial={[]} />);

      fireEvent.change(addField(), { target: { value: "zoo stand -> Zoostand" } });
      fireEvent.keyDown(addField(), { key: "Enter" });

      expect(await screen.findByRole("button", { name: "Move phrase" })).toBeTruthy();
      expect(main.add).toHaveBeenCalledWith({ term: "Zoostand", heardAs: ["zoo stand"] });
      expect(container.textContent).toContain('Heard as "zoo stand"');
      expect(addField().value).toBe("zoo stand -> Zoostand");
    });

    it("leaves a pasted phrase out and says which term has it", async () => {
      const main = mainLike([zustand]);
      install(main);
      const { container } = render(<PageWith initial={[zustand]} />);

      fireEvent.change(addField(), { target: { value: "zoo stand -> Zoostand\nVite" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      await waitFor(() =>
        expect(container.textContent).toContain(
          "Added 2 terms. Left out 1 heard-as phrase: “zoo stand” already belongs to Zustand"
        )
      );
      expect(main.add).toHaveBeenCalledWith({
        term: "Zoostand",
        heardAs: ["zoo stand"],
        source: "imported",
        heardAsConflict: "skip",
      });
    });

    it("asks before an edit takes it, and moves it on Move", async () => {
      const main = mainLike([zustand, term("Zoostand")]);
      install(main);
      const { container } = render(<PageWith initial={[zustand, term("Zoostand")]} />);

      fireEvent.click(screen.getByRole("button", { name: "Edit Zoostand" }));
      const heard = screen.getByLabelText("Heard-as phrases for Zoostand");
      fireEvent.change(heard, { target: { value: "zoo stand" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(container.textContent).toContain(
        "“zoo stand” already belongs to Zustand. Move it to Zoostand?"
      );
      expect(main.update).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(document.activeElement).toBe(heard);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      fireEvent.click(screen.getByRole("button", { name: "Move phrase" }));

      await waitFor(() =>
        expect(screen.queryByLabelText("Heard-as phrases for Zoostand")).toBeNull()
      );
      expect(main.update).toHaveBeenCalledWith({
        term: "Zoostand",
        changes: { term: "Zoostand", heardAs: ["zoo stand"], heardAsConflict: "move" },
      });
      expect(container.textContent.match(/Heard as "zoo stand"/g)).toHaveLength(1);
    });

    it("keeps the editor open and asks when main refuses an edit, on a retry too", async () => {
      const main = mainLike([zustand, term("Zoostand")]);
      const update = vi.fn(main.update).mockRejectedValueOnce(new Error("EROFS"));
      install({ ...main, update });
      render(<PageWith initial={[term("Zustand"), term("Zoostand")]} retry />);

      fireEvent.click(screen.getByRole("button", { name: "Edit Zoostand" }));
      fireEvent.change(screen.getByLabelText("Heard-as phrases for Zoostand"), {
        target: { value: "zoo stand" },
      });
      const save = screen.getByRole("button", { name: "Save" });
      act(() => save.focus());
      fireEvent.click(save);
      expect(update).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Move phrase" })).toBeNull();

      await waitFor(() => expect(screen.getByRole("button", { name: "Move phrase" })).toBeTruthy());
      expect(update).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText("Heard-as phrases for Zoostand")).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    });

    it("says a refused add wasn't saved when the draft has moved on", async () => {
      let finish: (state: VoiceDictionaryChange) => void = () => {};
      install({ add: vi.fn(() => new Promise((resolve) => (finish = resolve))) });
      const { container } = render(<PageWith initial={[]} />);

      fireEvent.change(addField(), { target: { value: "zoo stand -> Zoostand" } });
      fireEvent.keyDown(addField(), { key: "Enter" });
      fireEvent.change(addField(), { target: { value: "Vite" } });
      await act(async () =>
        finish({
          dictionary: [zustand],
          suggestedDictionary: [],
          conflicts: [{ phrase: "zoo stand", owner: "Zustand" }],
        })
      );

      expect(container.textContent).toContain(
        "Didn't add Zoostand: “zoo stand” already belongs to Zustand"
      );
      expect(addField().value).toBe("Vite");
      expect(screen.queryByRole("button", { name: "Move phrase" })).toBeNull();
    });

    it("reports a paste's left-out phrases once when the batch is retried", async () => {
      const main = mainLike([zustand]);
      let calls = 0;
      const add = vi.fn((input: AddDictionaryEntryInput) => {
        calls++;
        return calls === 2 ? Promise.reject(new Error("EROFS")) : main.add(input);
      });
      install({ add });
      const { container } = render(<PageWith initial={[zustand]} retry />);

      fireEvent.change(addField(), {
        target: { value: "zoo stand -> Zoostand\nzoo stand -> Zoo\nVite" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      await waitFor(() => expect(container.textContent).toContain("Left out"));
      expect(container.textContent).toContain(
        "Added 3 terms. Left out 2 heard-as phrases: “zoo stand” already belongs to Zustand"
      );
    });

    it("marks a phrase stored twice on the entry it never fires for", () => {
      install({});
      const { container } = render(
        <PageWith initial={[zustand, { ...term("Zoo"), heardAs: ["Zoo  Stand"] }]} />
      );
      expect(container.textContent).toContain("Not used: “Zoo  Stand” already belongs to Zustand");
      expect(container.textContent.match(/Not used/g)).toHaveLength(1);
    });

    it("says which phrase an added suggestion was learned without", async () => {
      const suggestion = { word: "Zoostand", utterance: "zoo stand", suggestedAt: 1, frequency: 1 };
      install(mainLike([zustand], [suggestion]));
      const { container } = render(<PageWith initial={[zustand]} suggestions={[suggestion]} />);

      fireEvent.click(screen.getByRole("button", { name: "Add Zoostand to dictionary" }));
      await waitFor(() =>
        expect(container.textContent).toContain(
          "Added Zoostand, but “zoo stand” already belongs to Zustand"
        )
      );
    });

    it("says nothing extra when an added suggestion keeps its phrase", async () => {
      const suggestion = { word: "Vite", utterance: "veet", suggestedAt: 1, frequency: 1 };
      const main = mainLike([zustand], [suggestion]);
      install(main);
      const { container } = render(<PageWith initial={[zustand]} suggestions={[suggestion]} />);

      fireEvent.click(screen.getByRole("button", { name: "Add Vite to dictionary" }));
      await waitFor(() => expect(container.textContent).toContain('Heard as "veet"'));
      expect(container.textContent).not.toContain("already belongs");
    });

    it("restores a removed term without a phrase another term took meanwhile", async () => {
      const zoostand = { ...term("Zoostand"), heardAs: ["zoo stand"] };
      const main = mainLike([zoostand]);
      install(main);
      const { container } = render(<PageWith initial={[zoostand]} />);

      fireEvent.click(screen.getByRole("button", { name: "Remove Zoostand" }));
      await screen.findByRole("button", { name: "Undo" });
      await main.add({ term: "Zustand", heardAs: ["zoo stand"] });
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));

      await waitFor(() =>
        expect(container.textContent).toContain(
          "Restored Zoostand without 1 heard-as phrase: “zoo stand” already belongs to Zustand"
        )
      );
      expect(main.add).toHaveBeenLastCalledWith(
        expect.objectContaining({ term: "Zoostand", heardAsConflict: "skip" })
      );
    });

    it("keeps that report in view while an earlier removal can still be undone", async () => {
      const zoostand = { ...term("Zoostand"), heardAs: ["zoo stand"] };
      const main = mainLike([term("Vite"), zoostand]);
      install(main);
      const { container } = render(<PageWith initial={[term("Vite"), zoostand]} />);

      fireEvent.click(screen.getByRole("button", { name: "Remove Vite" }));
      await screen.findByText("Removed Vite");
      fireEvent.click(screen.getByRole("button", { name: "Remove Zoostand" }));
      await screen.findByText("Removed Zoostand");
      await main.add({ term: "Zustand", heardAs: ["zoo stand"] });
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));

      await waitFor(() => expect(container.textContent).toContain("Restored Zoostand without"));
      expect(screen.getByText("Removed Vite")).toBeTruthy();
    });

    it("restores a removed term without a report when nothing took its phrases", async () => {
      const zoostand = { ...term("Zoostand"), heardAs: ["zoo stand"] };
      install(mainLike([zoostand]));
      const { container } = render(<PageWith initial={[zoostand]} />);

      fireEvent.click(screen.getByRole("button", { name: "Remove Zoostand" }));
      fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
      await screen.findByRole("button", { name: "Remove Zoostand" });
      expect(container.textContent).not.toContain("Restored");
    });
  });
});
