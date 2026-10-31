import { planChoice, type ChoicePlan } from "../../shared/utils/terminalChoice.js";
import { AppError } from "../utils/errorTypes.js";
import { readPluginTerminalScreen } from "./plugin/pluginTerminalScreenRead.js";
import type { PtyClient } from "./PtyClient.js";

export const MAX_ANSWER_LABEL_LENGTH = 200;
/** Rows read to find the option being chosen; dialogs sit at the bottom. */
export const ANSWER_SCREEN_LINES = 40;
/** Between keys, so a TUI reading a burst as one chunk still sees each one. */
const ANSWER_KEY_GAP_MS = 80;
/** How long a key's redraw may take to show before the answer stops waiting for it. */
const ANSWER_REDRAW_WAIT_MS = 1_000;
const ANSWER_REDRAW_POLL_MS = 40;

const ANSWER_KEY_SEQUENCES: Record<string, string> = {
  Up: "\x1b[A",
  Down: "\x1b[B",
  Enter: "\r",
};

/**
 * Runs a one-key answer is still pressing keys into, whoever asked: Canopy's
 * panel and a paired device share it, so two answers never interleave.
 */
const answering = new Set<string>();

export type AnswerPtyClient = Pick<
  PtyClient,
  | "getLiveGeneration"
  | "isLiveGeneration"
  | "getTerminalAsync"
  | "getTerminalProjectId"
  | "getSerializedStateAsync"
  | "write"
>;

/** Why a one-key answer pressed nothing, in words the asker shows as is. */
export function answerRefused(reason: string): AppError {
  return new AppError({ code: "NOT_FOUND", message: reason, userMessage: reason });
}

export function isAnswerLabel(label: unknown): label is string {
  return (
    typeof label === "string" && label.trim() !== "" && label.length <= MAX_ANSWER_LABEL_LENGTH
  );
}

const MOVED_ON = "That terminal has moved on since the list showed it.";
/** Every key but the last is an arrow, so an answer stopped after its first key chose nothing. */
const NOTHING_CHOSEN =
  "The highlight was moved, but Enter wasn't pressed, so nothing was chosen. Check the screen before answering again.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/**
 * Wait for the screen to show the question the keys were planned on, with
 * its highlight where the `sent` keys put it, so the next key lands where it
 * was planned to. The terminal may take a moment to draw the last arrow;
 * anything else (another question, a closed dialog, a highlight someone else
 * moved) stops the answer before another key goes in.
 */
async function awaitPlannedScreen(options: {
  pty: AnswerPtyClient;
  runId: string;
  label: string;
  planKeys: (screen: string, label: string) => ChoicePlan;
  planned: { keys: string[]; question: string };
  sent: number;
}): Promise<void> {
  const { pty, runId, label, planKeys, planned, sent } = options;
  const stop = (reason: string) => answerRefused(`${reason} ${NOTHING_CHOSEN}`);
  const remaining = planned.keys.slice(sent);
  const lastKeyNotDrawn = planned.keys.slice(sent - 1);
  const deadline = Date.now() + ANSWER_REDRAW_WAIT_MS;
  for (;;) {
    const screen = await readPluginTerminalScreen(pty, runId, null, ANSWER_SCREEN_LINES);
    if (screen.status !== "ok") throw stop("Couldn't read the terminal to check the question.");
    const now = planKeys(screen.text, label);
    if (!now.ok || now.question !== planned.question) {
      throw stop("The question changed or closed while it was being answered.");
    }
    if (sameKeys(now.keys, remaining)) return;
    if (!sameKeys(now.keys, lastKeyNotDrawn)) {
      throw stop("Something else moved the highlight while it was being answered.");
    }
    if (Date.now() >= deadline) throw stop("The terminal didn't show the highlight moving.");
    await sleep(ANSWER_REDRAW_POLL_MS);
  }
}

/**
 * Pick the option a run's dialog shows by its label. The keys are planned
 * from the screen as it is now, so an option that is no longer drawn presses
 * nothing, and the asker never supplies keys of its own. Before each key
 * after the first the screen is read again, and the answer stops unless it
 * still shows the same question with the highlight where the answer's own
 * keys moved it. `stillAllowed` is asked before every key, not just the
 * first: it answers a refusal to stop with, or null to go on, so standing
 * lost mid-answer stops the rest.
 */
export async function answerRunByLabel(options: {
  pty: AnswerPtyClient;
  runId: string;
  spawnedAt: number;
  label: string;
  stillAllowed: () => string | null;
  /**
   * How the label becomes keys. Canopy's panel picks from options it was
   * shown and keeps `planChoice`; a caller that must stay inside the list on
   * screen passes `planListedChoice`.
   */
  plan?: (screen: string, label: string) => ChoicePlan;
  /**
   * Whether the question the keys were planned on is the one the asker was
   * shown: a refusal to stop with, or null to go on. Asked once, before any
   * key; from there the question must stay the one planned on.
   */
  checkQuestion?: (question: string) => string | null;
}): Promise<void> {
  const {
    pty,
    runId,
    spawnedAt,
    label,
    stillAllowed,
    plan: planKeys = planChoice,
    checkQuestion,
  } = options;
  // One answer at a time per run: a second, planned from a screen the first
  // is still pressing keys into, would land its Enter on whatever dialog
  // comes next.
  if (answering.has(runId)) {
    throw answerRefused("Still answering that agent. Nothing more was pressed.");
  }
  answering.add(runId);
  try {
    const generation = pty.getLiveGeneration(runId);
    const record = await pty.getTerminalAsync(runId);
    // Nothing is pressed unless the dialog is still there to answer.
    if (!record || record.spawnedAt !== spawnedAt || record.isExited === true) {
      throw answerRefused(MOVED_ON);
    }
    const screen = await readPluginTerminalScreen(pty, runId, null, ANSWER_SCREEN_LINES);
    if (screen.status !== "ok") {
      throw answerRefused("Couldn't read the terminal to find that option.");
    }
    const plan = planKeys(screen.text, label);
    if (!plan.ok) throw answerRefused(`${plan.reason} Nothing was pressed.`);
    const shownOther = checkQuestion?.(plan.question) ?? null;
    if (shownOther !== null) throw answerRefused(`${shownOther} Nothing was pressed.`);
    for (const [index, key] of plan.keys.entries()) {
      if (index > 0) {
        await sleep(ANSWER_KEY_GAP_MS);
        await awaitPlannedScreen({ pty, runId, label, planKeys, planned: plan, sent: index });
      }
      // Every key is for the terminal the screen was read from: a restart
      // under the same id between keys stops the rest.
      if (generation !== null && !pty.isLiveGeneration(runId, generation)) {
        throw answerRefused(index > 0 ? `${MOVED_ON} ${NOTHING_CHOSEN}` : MOVED_ON);
      }
      const refusal = stillAllowed();
      if (refusal !== null) throw answerRefused(refusal);
      pty.write(runId, ANSWER_KEY_SEQUENCES[key] ?? key);
    }
  } finally {
    answering.delete(runId);
  }
}
