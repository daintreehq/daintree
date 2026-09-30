import { randomInt } from "crypto";

/**
 * A prompt whose correct answer never appears in the prompt itself. Agent TUIs
 * echo what was typed, so checking for a word from the prompt passes whether or
 * not the model replied — the answer here is a random lowercase token reversed
 * and upper-cased, which only a model that read the prompt can produce.
 */
export interface NonceChallenge {
  prompt: string;
  token: string;
  answer: string;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export function createNonceChallenge(length = 6): NonceChallenge {
  let token = "";
  // A palindrome's answer is just the token upper-cased, so reversing would
  // prove nothing about the model having read it.
  while (token.length === 0 || token === [...token].reverse().join("")) {
    token = Array.from({ length }, () => LETTERS[randomInt(LETTERS.length)]).join("");
  }
  const answer = [...token].reverse().join("").toUpperCase();
  return {
    prompt: `Reverse the letters of ${token} and reply with only the result in capital letters.`,
    token,
    answer,
  };
}

/** Case-sensitive: the echoed prompt holds the lowercase token, never the answer. */
export function containsChallengeAnswer(terminalText: string, challenge: NonceChallenge): boolean {
  return terminalText.includes(challenge.answer);
}
