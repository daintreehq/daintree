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
import { planListedChoice } from "../../../shared/utils/terminalChoice.js";
import { redrawFor } from "./answerRedraw.js";

const DIALOG = ["❯ 1. Yes", "  2. No, exit"].join("\n");

/**
 * A terminal that draws each key it is sent, the way an agent's list moves
 * its highlight; `redraw` stands in for an agent drawing something else.
 */
function fakePty() {
  const state = {
    generation: 1,
    spawnedAt: 100,
    isExited: false,
    writes: [] as string[],
    redraw: redrawFor as (screen: string, data: string) => string,
  };
  const pty = {
    getLiveGeneration: () => state.generation,
    isLiveGeneration: (_id: string, generation: number) => generation === state.generation,
    getTerminalAsync: async () => ({ spawnedAt: state.spawnedAt, isExited: state.isExited }),
    getTerminalProjectId: () => "project-1",
    getSerializedStateAsync: async () => null,
    write: (_id: string, data: string) => {
      state.writes.push(data);
      screen.text = state.redraw(screen.text, data);
    },
  } as unknown as AnswerPtyClient;
  return { pty, state };
}

const keyGap = () => new Promise((resolve) => setTimeout(resolve, 20));

const HINT = " Esc to cancel";
const options = ["❯ 1. Yes", "  2. Maybe", "  3. Not now", "  4. No"];
const DIALOG_A = [
  " Bash command",
  "   rm -rf build",
  " Do you want to proceed?",
  ...options,
  "",
  HINT,
].join("\n");
const DIALOG_B = [
  " Bash command",
  "   git push --force",
  " Do you want to proceed?",
  ...options,
  "",
  HINT,
].join("\n");
/** How a paired device's answer plans: only from the list on screen. */
const listed = {
  stillAllowed: () => null,
  plan: (text: string, label: string) => planListedChoice(text, label),
};

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
    // The first answer's arrow was drawn, so "Yes" is now one row up.
    expect(state.writes).toEqual(["\x1b[B", "\r", "\x1b[A", "\r"]);
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

  it("answers a stable dialog several rows away, waiting for each arrow to be drawn", async () => {
    const { pty, state } = fakePty();
    screen.text = DIALOG_A;
    // The agent draws each arrow late, after the answer's first look.
    state.redraw = (text, data) => {
      if (data !== "\r") setTimeout(() => (screen.text = redrawFor(text, data)), 150);
      return text;
    };
    await answerRunByLabel({ pty, runId: "run-1", spawnedAt: 100, label: "No", ...listed });
    expect(state.writes).toEqual(["\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
  });

  it("answers an option several rows above the highlight", async () => {
    const { pty, state } = fakePty();
    screen.text = DIALOG_A.replace("❯ 1. Yes", "  1. Yes").replace("  4. No", "❯ 4. No");
    await answerRunByLabel({ pty, runId: "run-1", spawnedAt: 100, label: "Yes", ...listed });
    expect(state.writes).toEqual(["\x1b[A", "\x1b[A", "\x1b[A", "\r"]);
  });

  it("presses nothing into a question other than the one its asker was shown", async () => {
    const { pty, state } = fakePty();
    screen.text = DIALOG_B;
    let checked: string | null = null;
    await expect(
      answerRunByLabel({
        pty,
        runId: "run-1",
        spawnedAt: 100,
        label: "No",
        ...listed,
        checkQuestion: (question) => {
          checked = question;
          return "The question changed since this device showed it.";
        },
      })
    ).rejects.toMatchObject({
      userMessage: "The question changed since this device showed it. Nothing was pressed.",
    });
    expect(checked).toContain("git push --force");
    expect(state.writes).toEqual([]);
  });

  it("presses no Enter when another question with the same options replaces the dialog between keys", async () => {
    const { pty, state } = fakePty();
    screen.text = DIALOG_A;
    state.redraw = () => DIALOG_B;
    const refused = await answerRunByLabel({
      pty,
      runId: "run-1",
      spawnedAt: 100,
      label: "No",
      ...listed,
    }).catch((error: { userMessage: string }) => error.userMessage);
    expect(state.writes).toEqual(["\x1b[B"]);
    expect(refused).toContain("The question changed");
    // Keys went in, so it never says nothing was pressed.
    expect(refused).toContain("Enter wasn't pressed, so nothing was chosen");
    expect(refused).not.toContain("Nothing was pressed");
  });

  it("presses no Enter when the dialog closes between keys", async () => {
    const { pty, state } = fakePty();
    screen.text = DIALOG_A;
    state.redraw = () => "Done.\n────────────\n> \n────────────";
    await expect(
      answerRunByLabel({ pty, runId: "run-1", spawnedAt: 100, label: "No", ...listed })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("nothing was chosen") });
    expect(state.writes).toEqual(["\x1b[B"]);
  });

  it("presses no Enter when something else moves the highlight between keys", async () => {
    const { pty, state } = fakePty();
    screen.text = DIALOG_A;
    // Someone at the desktop presses Down too.
    state.redraw = (text, data) => redrawFor(redrawFor(text, data), "\x1b[B");
    await expect(
      answerRunByLabel({ pty, runId: "run-1", spawnedAt: 100, label: "Not now", ...listed })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("Something else moved") });
    expect(state.writes).toEqual(["\x1b[B"]);
  });

  it("presses no Enter when the highlight never moves", async () => {
    const { pty, state } = fakePty();
    screen.text = DIALOG_A;
    state.redraw = (text) => text;
    await expect(
      answerRunByLabel({ pty, runId: "run-1", spawnedAt: 100, label: "Maybe", ...listed })
    ).rejects.toMatchObject({ userMessage: expect.stringContaining("didn't show the highlight") });
    expect(state.writes).toEqual(["\x1b[B"]);
  });

  it("takes only a non-empty label of bounded length", () => {
    expect(isAnswerLabel("Yes")).toBe(true);
    expect(isAnswerLabel("  ")).toBe(false);
    expect(isAnswerLabel("x".repeat(201))).toBe(false);
    expect(isAnswerLabel(3)).toBe(false);
  });
});
