import { randomInt } from "crypto";

/**
 * A prompt whose correct answer never appears in the prompt itself. Agent TUIs
 * echo what was typed, so checking for a word from the prompt passes whether or
 * not the model replied — the answer here is a random lowercase token
 * upper-cased, which only a model that read the prompt can produce. Spelling
 * tasks like reversal fail on tokenization rather than on whether a reply came
 * back, so the transform stays one every model gets right.
 */
export interface NonceChallenge {
  prompt: string;
  token: string;
  answer: string;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export function createNonceChallenge(length = 6): NonceChallenge {
  const token = Array.from({ length }, () => LETTERS[randomInt(LETTERS.length)]).join("");
  return {
    prompt: `Reply with only the word ${token} written in capital letters.`,
    token,
    answer: token.toUpperCase(),
  };
}

/** Case-sensitive: the echoed prompt holds the lowercase token, never the answer. */
export function containsChallengeAnswer(terminalText: string, challenge: NonceChallenge): boolean {
  return terminalText.includes(challenge.answer);
}
