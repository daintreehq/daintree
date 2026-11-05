// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportComposerDrafts } = vi.hoisted(() => ({
  reportComposerDrafts: vi.fn<(keys: string[]) => Promise<void>>(),
}));

vi.mock("@/clients/decisionsClient", () => ({
  decisionsClient: { reportComposerDrafts },
}));

import { useTerminalInputStore } from "@/store/terminalInputStore";
import {
  COMPOSER_DRAFT_REFRESH_MS,
  COMPOSER_DRAFT_RETRY_MS,
  draftKeysWithText,
  setupComposerDraftListeners,
} from "../composerDrafts";

describe("composer draft reports (#16282)", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    reportComposerDrafts.mockReset();
    reportComposerDrafts.mockResolvedValue(undefined);
    useTerminalInputStore.setState({ draftInputs: new Map() });
  });

  afterEach(() => {
    stop?.();
    stop = null;
  });

  const start = () => {
    const d = setupComposerDraftListeners();
    stop = () => d.dispose();
  };
  const sent = () => reportComposerDrafts.mock.calls.map((call) => call[0]);

  it("counts only drafts with more than whitespace", () => {
    const drafts = new Map([
      ["p1:t2", "fix it"],
      ["p1:t1", "  \n"],
      ["t3", "x"],
    ]);
    expect(draftKeysWithText(drafts)).toEqual(["p1:t2", "t3"]);
  });

  it("reports the whole set at the start, so a reload replaces what the view said before", () => {
    useTerminalInputStore.getState().setDraftInput("t1", "half a thought", "p1");
    start();
    expect(sent()).toEqual([["p1:t1"]]);
  });

  it("reports when a draft appears or empties, never per keystroke", () => {
    start();
    const store = useTerminalInputStore.getState();
    store.setDraftInput("t1", "h", "p1");
    store.setDraftInput("t1", "he", "p1");
    store.setDraftInput("t1", "hello", "p1");
    store.setDraftInput("t1", "", "p1");
    expect(sent()).toEqual([[], ["p1:t1"], []]);
  });

  it("leaves out a draft for another host's terminal", () => {
    expect(
      draftKeysWithText(
        new Map([
          ["isolated-composer:host-b:t1", "reply"],
          ["isolated-composer:t2", "reply"],
        ])
      )
    ).toEqual(["isolated-composer:t2"]);
  });

  it("never lets a client that throws break the listeners' setup", async () => {
    reportComposerDrafts.mockImplementationOnce(() => {
      throw new TypeError("no decisions namespace");
    });
    expect(() => start()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  describe("on a timer", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sends a report that failed again, without waiting for another edit", async () => {
      reportComposerDrafts.mockRejectedValueOnce(new Error("gone"));
      useTerminalInputStore.getState().setDraftInput("t1", "half a thought", "p1");
      start();
      await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_RETRY_MS - 1);
      expect(sent()).toEqual([["p1:t1"]]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent()).toEqual([["p1:t1"], ["p1:t1"]]);
    });

    it("repeats a view's drafts now and then, and says nothing more while it holds none", async () => {
      start();
      await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_REFRESH_MS * 2);
      expect(sent()).toEqual([[]]);

      useTerminalInputStore.getState().setDraftInput("t1", "half a thought", "p1");
      await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_REFRESH_MS);
      expect(sent()).toEqual([[], ["p1:t1"], ["p1:t1"]]);
    });

    it("stops repeating once disposed", async () => {
      useTerminalInputStore.getState().setDraftInput("t1", "half a thought", "p1");
      start();
      stop?.();
      stop = null;
      await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_REFRESH_MS * 2);
      expect(sent()).toEqual([["p1:t1"]]);
    });
  });
});
