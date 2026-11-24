import type { ForgePullRequestTerm } from "@shared/types/forge";

/** How a forge names a pull request and writes its number. */
export interface PullRequestWords {
  /** Mid-sentence: "pull request", "merge request". */
  noun: string;
  /** Sentence-initial: "Pull request", "Merge request". */
  title: string;
  /** "PR", "MR". */
  short: string;
  /** The number as the forge writes it: `#42`, `!42`. */
  ref: (prNumber: number) => string;
}

const WORDS: Record<ForgePullRequestTerm, PullRequestWords> = {
  "pull-request": {
    noun: "pull request",
    title: "Pull request",
    short: "PR",
    ref: (prNumber) => `#${prNumber}`,
  },
  "merge-request": {
    noun: "merge request",
    title: "Merge request",
    short: "MR",
    ref: (prNumber) => `!${prNumber}`,
  },
};

/** Omitted reads as "pull-request", the word every forge used before one could say otherwise. */
export function pullRequestWords(term: ForgePullRequestTerm = "pull-request"): PullRequestWords {
  return WORDS[term];
}
