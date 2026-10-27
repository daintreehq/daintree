import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalInputStore, type SentPrompt } from "@/store/terminalInputStore";
import { recentPromptsFor, selectRecentPrompts } from "../voiceRecentPrompts";

const HOUR = 60 * 60_000;

function sends(count: number, sentAt = (seq: number) => seq): SentPrompt[] {
  return Array.from({ length: count }, (_, seq) => ({
    text: `prompt ${seq}`,
    sentAt: sentAt(seq),
    seq,
  })).slice(-6);
}

describe("selectRecentPrompts", () => {
  it("shows up to six, oldest first, from a start that moves three sends at a time", () => {
    const shown = (count: number) =>
      selectRecentPrompts(sends(count), count).map((text) => Number(text.split(" ")[1]));

    expect(shown(0)).toEqual([]);
    expect(shown(1)).toEqual([0]);
    expect(shown(6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(shown(7)).toEqual([3, 4, 5, 6]);
    expect(shown(8)).toEqual([3, 4, 5, 6, 7]);
    expect(shown(9)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(shown(10)).toEqual([6, 7, 8, 9]);
  });

  // The cached prefix is the prompts the last cleanup was shown: a send that
  // doesn't move the window only adds one after them.
  it("keeps what the last cleanup was shown in front after a send, until the window moves", () => {
    for (let count = 1; count < 30; count++) {
      const before = selectRecentPrompts(sends(count), count);
      const after = selectRecentPrompts(sends(count + 1), count + 1);
      const moved = count >= 6 && (count - 6) % 3 === 0;
      if (moved) expect(after.slice(0, before.length)).not.toEqual(before);
      else expect(after).toEqual([...before, `prompt ${count}`]);
    }
  });

  it("leaves out sends over an hour old", () => {
    const now = 10 * HOUR;
    const older = sends(4, (seq) => (seq < 2 ? now - HOUR - 1 : now - HOUR));
    expect(selectRecentPrompts(older, now)).toEqual(["prompt 2", "prompt 3"]);
    expect(selectRecentPrompts(sends(3, () => 0), now)).toEqual([]);
  });
});

describe("recentPromptsFor", () => {
  beforeEach(() => {
    useTerminalInputStore.setState({ sentPrompts: new Map() });
  });

  it("reads what was sent to that terminal, as it was written", () => {
    const store = useTerminalInputStore.getState();
    store.recordSentPrompt("term-1", "Compare Terra with Luna", 1_000);
    store.recordSentPrompt("term-2", "Elsewhere", 1_000);
    store.recordSentPrompt("term-1", "Now check @src/voice.ts", 2_000);

    expect(recentPromptsFor("term-1", 3_000)).toEqual([
      "Compare Terra with Luna",
      "Now check @src/voice.ts",
    ]);
    expect(recentPromptsFor("term-3", 3_000)).toEqual([]);
  });
});
