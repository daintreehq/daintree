import { planChoice, type ChoicePlan } from "../../shared/utils/terminalChoice.js";
import { AppError } from "../utils/errorTypes.js";
import { readPluginTerminalScreen } from "./plugin/pluginTerminalScreenRead.js";
import type { PtyClient } from "./PtyClient.js";

export const MAX_ANSWER_LABEL_LENGTH = 200;
/** Rows read to find the option being chosen; dialogs sit at the bottom. */
export const ANSWER_SCREEN_LINES = 40;
/** Between keys, so a TUI reading a burst as one chunk still sees each one. */
const ANSWER_KEY_GAP_MS = 80;

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

/**
 * Pick the option a run's dialog shows by its label. The keys are planned
 * from the screen as it is now, so an option that is no longer drawn presses
 * nothing, and the asker never supplies keys of its own. `stillAllowed` is
 * asked before every key, not just the first: it answers a refusal to stop
 * with, or null to go on, so standing lost mid-answer stops the rest.
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
}): Promise<void> {
  const { pty, runId, spawnedAt, label, stillAllowed, plan: planKeys = planChoice } = options;
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
    for (const [index, key] of plan.keys.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, ANSWER_KEY_GAP_MS));
      // Every key is for the terminal the screen was read from: a restart
      // under the same id between keys stops the rest.
      if (generation !== null && !pty.isLiveGeneration(runId, generation)) {
        throw answerRefused(MOVED_ON);
      }
      const refusal = stillAllowed();
      if (refusal !== null) throw answerRefused(refusal);
      pty.write(runId, ANSWER_KEY_SEQUENCES[key] ?? key);
    }
  } finally {
    answering.delete(runId);
  }
}
