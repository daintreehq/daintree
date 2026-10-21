import { beforeEach, describe, expect, it, vi } from "vitest";

const screen = { text: "" };
vi.mock("../plugin/pluginTerminalScreenRead.js", () => ({
  readPluginTerminalScreen: vi.fn(async () => ({
    status: "ok",
    text: screen.text,
    lineCount: 1,
    truncated: false,
  })),
}));

import { answerRunByLabel, isAnswerLabel, type AnswerPtyClient } from "../terminalAnswer.js";

const DIALOG = ["❯ 1. Yes", "  2. No, exit"].join("\n");

function fakePty() {
  const state = { generation: 1, spawnedAt: 100, isExited: false, writes: [] as string[] };
  const pty = {
    getLiveGeneration: () => state.generation,
    isLiveGeneration: (_id: string, generation: number) => generation === state.generation,
    getTerminalAsync: async () => ({ spawnedAt: state.spawnedAt, isExited: state.isExited }),
    getTerminalProjectId: () => "project-1",
    getSerializedStateAsync: async () => null,
    write: (_id: string, data: string) => {
      state.writes.push(data);
    },
  } as unknown as AnswerPtyClient;
  return { pty, state };
}

const keyGap = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("answerRunByLabel", () => {
  beforeEach(() => {
    screen.text = DIALOG;
  });

  it("presses the keys planned from the screen now, never keys of the asker's", async () => {
    const { pty, state } = fakePty();
    await answerRunByLabel({
      pty,
      runId: "run-1",
      spawnedAt: 100,
      label: "No, exit",
      stillAllowed: () => null,
    });
    expect(state.writes).toEqual(["\x1b[B", "\r"]);
  });

  it("presses nothing when the label isn't drawn or the terminal was respawned", async () => {
    const { pty, state } = fakePty();
    await expect(
      answerRunByLabel({
        pty,
        runId: "run-1",
        spawnedAt: 100,
        label: "Always",
        stillAllowed: () => null,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("Nothing was pressed") });
    await expect(
      answerRunByLabel({
        pty,
        runId: "run-1",
        spawnedAt: 99,
        label: "Yes",
        stillAllowed: () => null,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("moved on") });
    expect(state.writes).toEqual([]);
  });

  it("stops at the first key its caller no longer allows, with the caller's words", async () => {
    const { pty, state } = fakePty();
    let allowed = true;
    const pressing = answerRunByLabel({
      pty,
      runId: "run-1",
      spawnedAt: 100,
      label: "No, exit",
      stillAllowed: () => (allowed ? null : "This device was removed. Nothing more was pressed."),
    });
    await keyGap();
    allowed = false;
    await expect(pressing).rejects.toMatchObject({
      userMessage: "This device was removed. Nothing more was pressed.",
    });
    expect(state.writes).toEqual(["\x1b[B"]);
  });

  it("answers a run once at a time across callers, and frees it once done", async () => {
    const { pty, state } = fakePty();
    const first = answerRunByLabel({
      pty,
      runId: "run-1",
      spawnedAt: 100,
      label: "No, exit",
      stillAllowed: () => null,
    });
    await keyGap();
    await expect(
      answerRunByLabel({
        pty,
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        stillAllowed: () => null,
      })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("Still answering") });
    await first;
    state.generation = 2;
    await answerRunByLabel({
      pty,
      runId: "run-1",
      spawnedAt: 100,
      label: "Yes",
      stillAllowed: () => null,
    });
    expect(state.writes).toEqual(["\x1b[B", "\r", "\r"]);
  });

  it("stops when the terminal is respawned under the same id between keys", async () => {
    const { pty, state } = fakePty();
    const pressing = answerRunByLabel({
      pty,
      runId: "run-1",
      spawnedAt: 100,
      label: "No, exit",
      stillAllowed: () => null,
    });
    await keyGap();
    state.generation = 2;
    await expect(pressing).rejects.toMatchObject({
      userMessage: expect.stringContaining("moved on"),
    });
    expect(state.writes).toEqual(["\x1b[B"]);
  });

  it("takes only a non-empty label of bounded length", () => {
    expect(isAnswerLabel("Yes")).toBe(true);
    expect(isAnswerLabel("  ")).toBe(false);
    expect(isAnswerLabel("x".repeat(201))).toBe(false);
    expect(isAnswerLabel(3)).toBe(false);
  });
});
