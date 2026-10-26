// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { DictionaryLearnPrompt } from "../DictionaryLearnPrompt";
import { useDictionaryLearnPromptStore } from "@/store/dictionaryLearnPromptStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";

const acceptSuggestion = vi.fn(() => Promise.resolve());
const dismissSuggestion = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(window, {
    electron: { voiceDictionary: { acceptSuggestion, dismissSuggestion } },
  });
  acceptSuggestion.mockClear();
  dismissSuggestion.mockClear();
  useTerminalInputStore.setState({ draftInputs: new Map() });
  useDictionaryLearnPromptStore.setState({ prompts: new Map() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const offer = () =>
  act(() => {
    useDictionaryLearnPromptStore
      .getState()
      .offer("t1", { word: "Zustand", utterance: "zoo stand" });
  });

describe("DictionaryLearnPrompt", () => {
  it("offers the pair and adds it on Add", () => {
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    expect(screen.getByRole("status").textContent).toContain("Zustand");
    expect(screen.getByRole("status").textContent).toContain("zoo stand");
    fireEvent.click(screen.getByText("Add"));
    expect(acceptSuggestion).toHaveBeenCalledWith({ word: "Zustand" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses on Dismiss", () => {
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    fireEvent.click(screen.getByText("Dismiss"));
    expect(dismissSuggestion).toHaveBeenCalledWith({ word: "Zustand" });
    expect(acceptSuggestion).not.toHaveBeenCalled();
  });

  it("clears on the next keystroke without answering", () => {
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    act(() => useTerminalInputStore.getState().setDraftInput("t1", "n"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(dismissSuggestion).not.toHaveBeenCalled();
  });

  it("clears by itself after a few seconds", () => {
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
