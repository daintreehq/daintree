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

const settle = () => act(async () => {});

describe("DictionaryLearnPrompt", () => {
  it("offers the pair and adds it on Add", async () => {
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    expect(screen.getByRole("status").textContent).toContain("Zustand");
    expect(screen.getByRole("status").textContent).toContain("zoo stand");
    fireEvent.click(screen.getByText("Add"));
    expect(acceptSuggestion).toHaveBeenCalledWith({ word: "Zustand", utterance: "zoo stand" });
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses on Dismiss", async () => {
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    fireEvent.click(screen.getByText("Dismiss"));
    expect(dismissSuggestion).toHaveBeenCalledWith({ word: "Zustand", utterance: "zoo stand" });
    expect(acceptSuggestion).not.toHaveBeenCalled();
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the line until the save settles, and takes one answer at a time", async () => {
    let finish: () => void = () => {};
    acceptSuggestion.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    fireEvent.click(screen.getByText("Add"));
    fireEvent.click(screen.getByText("Add"));
    fireEvent.click(screen.getByText("Dismiss"));
    expect(acceptSuggestion).toHaveBeenCalledTimes(1);
    expect(dismissSuggestion).not.toHaveBeenCalled();
    // Saving outlasts the visible window: the line is still waiting on main.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("status").textContent).toContain("Zustand");

    await act(async () => finish());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says a failed Add didn't happen and retries the same pair (#15233)", async () => {
    acceptSuggestion.mockRejectedValueOnce(new Error("disk full"));
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    fireEvent.click(screen.getByText("Add"));
    await settle();

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Couldn't add \u201cZustand\u201d");
    // A failure stays put: it isn't on the clock.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    fireEvent.click(screen.getByText("Retry"));
    expect(acceptSuggestion).toHaveBeenCalledTimes(2);
    expect(acceptSuggestion).toHaveBeenLastCalledWith({ word: "Zustand", utterance: "zoo stand" });
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a failure that lands after the composer was typed into", async () => {
    let fail: (error: Error) => void = () => {};
    acceptSuggestion.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (fail = reject))
    );
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    fireEvent.click(screen.getByText("Add"));
    act(() => useTerminalInputStore.getState().setDraftInput("t1", "next message"));
    await act(async () => fail(new Error("disk full")));

    expect(screen.getByRole("status").textContent).toContain("Couldn't add");
    fireEvent.click(screen.getByRole("button", { name: /Dismiss the offer to learn/ }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(acceptSuggestion).toHaveBeenCalledTimes(1);
  });

  it("keeps an offer that replaced another while focus stayed on the line", () => {
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    act(() => screen.getByRole("button", { name: "Add" }).focus());
    act(() => {
      useDictionaryLearnPromptStore
        .getState()
        .offer("t1", { word: "Vitest", utterance: "vee test" });
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole("status").textContent).toContain("Vitest");

    act(() => screen.getByRole("button", { name: "Add" }).blur());
    act(() => {
      vi.advanceTimersByTime(8_500);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says a failed Dismiss didn't happen", async () => {
    dismissSuggestion.mockRejectedValueOnce(new Error("disk full"));
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    fireEvent.click(screen.getByText("Dismiss"));
    await settle();
    expect(screen.getByRole("status").textContent).toContain("Couldn't dismiss");
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("leaves a newer offer alone when an older answer settles", async () => {
    let finish: () => void = () => {};
    acceptSuggestion.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    fireEvent.click(screen.getByText("Add"));
    act(() => {
      useDictionaryLearnPromptStore
        .getState()
        .offer("t1", { word: "Vitest", utterance: "vee test" });
    });
    await act(async () => finish());
    expect(screen.getByRole("status").textContent).toContain("Vitest");
    expect(screen.getByText("Add")).toBeTruthy();
  });

  it("holds while the pointer is on it, then gives a fresh interval once it leaves", () => {
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    const status = screen.getByRole("status");
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    fireEvent.pointerEnter(status);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole("status")).toBeTruthy();

    fireEvent.pointerLeave(status);
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("holds while focus is inside, including moving between its buttons", () => {
    render(<DictionaryLearnPrompt terminalId="t1" />);
    offer();
    const add = screen.getByRole("button", { name: "Add" });
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    act(() => add.focus());
    act(() => dismiss.focus());
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("hands the keyboard back to the composer when it goes with focus inside", async () => {
    const onReturnFocus = vi.fn();
    render(<DictionaryLearnPrompt terminalId="t1" onReturnFocus={onReturnFocus} />);
    offer();
    const add = screen.getByRole("button", { name: "Add" });
    act(() => add.focus());
    fireEvent.click(add);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
    expect(onReturnFocus).toHaveBeenCalledTimes(1);
  });

  it("doesn't take focus when it expires with the keyboard elsewhere", () => {
    const onReturnFocus = vi.fn();
    render(<DictionaryLearnPrompt terminalId="t1" onReturnFocus={onReturnFocus} />);
    offer();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(onReturnFocus).not.toHaveBeenCalled();
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
