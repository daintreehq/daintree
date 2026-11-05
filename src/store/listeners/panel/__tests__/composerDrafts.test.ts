// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportComposerDrafts } = vi.hoisted(() => ({
  reportComposerDrafts: vi.fn<(keys: string[]) => Promise<void>>(),
}));

vi.mock("@/clients/decisionsClient", () => ({
  decisionsClient: { reportComposerDrafts },
}));

import { useTerminalInputStore } from "@/store/terminalInputStore";
import { draftKeysWithText, setupComposerDraftListeners } from "../composerDrafts";

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

  it("sends the set again with the next change after a report fails", async () => {
    reportComposerDrafts.mockRejectedValueOnce(new Error("gone"));
    start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    useTerminalInputStore.getState().setDraftInput("t1", " ", "p1");
    // Only whitespace: the same empty set, sent again since the first failed.
    expect(sent()).toEqual([[], []]);
  });
});
