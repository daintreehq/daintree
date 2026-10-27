import {
  CORRECTION_GUARD_LIMITS,
  type CorrectionGuardLimits,
} from "../../../electron/services/voiceCorrectionGuard";

/**
 * The edit budgets the benchmark lands replies under (`--guards`). A guard
 * never changes what the model proposes, so every reply a run recorded is
 * landed again under each budget, exactly as the service would land it,
 * without sending anything. `v11` is a frozen copy of the budget production
 * used before #14786; `production` is whatever ships now.
 */

export interface GuardVariant {
  description: string;
  limits: CorrectionGuardLimits;
}

const V11: CorrectionGuardLimits = {
  removedRatio: 0.15,
  addedRatio: 0.15,
  minRemoved: 4,
  minAdded: 2,
  minAllowanceRemoved: 2,
};

export const GUARD_VARIANTS: Readonly<Record<string, GuardVariant>> = {
  v11: { description: "the edit budget production used before #14786", limits: V11 },
  production: {
    description: "the edit budget production uses now",
    limits: CORRECTION_GUARD_LIMITS,
  },
  remove20: {
    description: "drops up to 20% of the words, adds up to 15%",
    limits: { ...V11, removedRatio: 0.2 },
  },
  remove25: {
    description: "drops up to 25% of the words, adds up to 15%",
    limits: { ...V11, removedRatio: 0.25 },
  },
  remove35: {
    description: "drops up to 35% of the words, adds up to 15%",
    limits: { ...V11, removedRatio: 0.35 },
  },
  floor6: {
    description: "v11 with a short passage allowed to drop six words",
    limits: { ...V11, minRemoved: 6, minAllowanceRemoved: 4 },
  },
};

/**
 * Cleanups that lose meaning, landed under every guard, so a looser budget
 * shows what it would let through. Some no word count can see (a dropped
 * "Yeah" that answered the agent, two names swapped); those are listed so
 * the report says so rather than implying the guard covers them.
 */
export interface AdversarialProposal {
  caseId: string;
  harm: string;
  proposal: string;
}

export const ADVERSARIAL_PROPOSALS: readonly AdversarialProposal[] = [
  {
    caseId: "tics-scroll-runon:deepgram",
    harm: "drops the closing constraint",
    proposal:
      "The problem is when you switch projects, the terminal loses its scroll position, and then when you come back it jumps to the top, and that's really annoying. Can you save the scroll offset when the view hides and restore it when it shows again?",
  },
  {
    caseId: "tics-notify-runon:openai",
    harm: "drops the last instruction",
    proposal:
      "When the agent finishes, we play the done sound and we also flash the dock icon and we show a toast, and it's too much. Can you make it so it only plays the sound if the window is focused, and only does the toast and the dock flash if it isn't?",
  },
  {
    caseId: "long-continuous:openai",
    harm: "drops what the test must prove",
    proposal:
      "I want you to go through the OpenAI transcription provider and trace every path where audio arrives before the session is ready, then write a Vitest test that sends three chunks during the handshake after the session.updated event arrives.",
  },
  {
    caseId: "ramble-send-wait:openai",
    harm: "drops half of what to log",
    proposal:
      "I want you to look at the voice recording service, and the bit where the send waits for cleanup. Right now it waits two seconds, which is fine for short stuff, but for a long prompt the cleanup often takes longer than that, so the raw text goes out. Can you add some logging so we can see how often that happens? Don't change the wait itself yet.",
  },
  {
    caseId: "ramble-range-store:openai",
    harm: "summarises",
    proposal:
      "The failing dictation range store test checks the edited flag: the correction lands after the user types, so the whole range is flagged. Write a failing test, then flag only the touched ranges. Don't touch the orchestrator subscription, it's fine.",
  },
  {
    caseId: "pull-request:openai",
    harm: "adds an instruction",
    proposal: "Looks good. Open a pull request against develop and merge it.",
  },
  {
    caseId: "regression-a-question-cleaned-never-answered",
    harm: "answers the question",
    proposal:
      "Why does the worktree dashboard re-render every time a terminal prints output? Because it subscribes to the whole store.",
  },
  {
    caseId: "tics-agents:grok",
    harm: "swaps who does what",
    proposal:
      "Ask Codex to review it, and if it's happy, hand it to Claude Code for the tests. I want them working in parallel, not waiting on each other.",
  },
  {
    caseId: "lookalike-yeah-answer:openai",
    harm: "drops the Yeah that answers the agent",
    proposal: "Update the stories too.",
  },
  {
    caseId: "lookalike-just:grok",
    harm: "drops the just that means only",
    proposal: "Run the unit tests for the guard, not the whole suite.",
  },
  {
    caseId: "tics-sidebar:grok",
    harm: "states a guess as fact",
    proposal:
      "The worktree sidebar flickers when an agent finishes, and it's re-rendering the whole list. Can you memoize the rows so only the one that changed re-renders?",
  },
];
