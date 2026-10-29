// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceDictionaryPage } from "../VoiceDictionaryPage";
import { MAX_DICTIONARY_IMPORT_TERMS } from "../voiceDictionaryImport";
import type { VoiceDictionaryEntry, VoiceDictionaryState } from "@shared/types";

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

// Answers like main: the dictionary so far, with each add folded in.
function mainLikeAdd(initial: VoiceDictionaryEntry[] = []) {
  let dictionary = initial;
  return vi.fn(async ({ term: value, heardAs = [] }: { term: string; heardAs?: string[] }) => {
    const existing = dictionary.find((entry) => entry.term.toLowerCase() === value.toLowerCase());
    if (!existing) {
      dictionary = [...dictionary, { ...term(value), heardAs }];
    } else {
      const merged = [...new Set([...existing.heardAs, ...heardAs])];
      if (merged.length > existing.heardAs.length) {
        dictionary = dictionary.map((entry) =>
          entry === existing ? { ...existing, heardAs: merged } : entry
        );
      }
    }
    return { dictionary, suggestedDictionary: [] } satisfies VoiceDictionaryState;
  });
}

// Stands in for the voice tab: shows whatever dictionary main returned.
function PageWith({ initial }: { initial: VoiceDictionaryEntry[] }) {
  const [entries, setEntries] = useState<VoiceDictionaryEntry[]>(initial);
  return (
    <VoiceDictionaryPage
      entries={entries}
      suggestions={[]}
      failure={null}
      onBack={() => {}}
      onChange={async (_label, run, onSaved) => {
        const next = await run();
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
    let finish: (state: VoiceDictionaryState) => void = () => {};
    install({ add: vi.fn(() => new Promise((resolve) => (finish = resolve))) });
    render(<Page />);

    const input = addField();
    fireEvent.change(input, { target: { value: "Daintree" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Zust" } });
    finish({ dictionary: [term("Daintree")], suggestedDictionary: [] });

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
});
