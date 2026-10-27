/** A bare `#N`: a number that may name an issue or pull request in the project's repository. */
export interface IssueReferenceToken {
  start: number;
  end: number;
  number: number;
}

/**
 * `#` and a number standing on their own. Not inside a word (`abc#12`), a path
 * (`page/#12`), an HTML entity (`&#123;`), another repository's reference
 * (`owner/repo#12`) or a run of `#`s, and not followed by more of a word
 * (`#12abc`, `#fff`). Nine digits at most, so every number fits a GraphQL
 * `Int`; a longer run is no reference at all, and a leading zero never is.
 */
const ISSUE_REFERENCE = /(?<![\p{L}\p{M}\p{N}_#&/\\])#([1-9]\d{0,8})(?![\p{L}\p{M}\p{N}_])/gu;

/** Whether `index` sits in a whitespace-delimited run that holds a URL (`?page=#12`). */
function insideUrl(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  return text.slice(start, index).includes("://");
}

export function getAllIssueReferences(text: string): IssueReferenceToken[] {
  if (!text.includes("#")) return [];
  const tokens: IssueReferenceToken[] = [];
  for (const match of text.matchAll(ISSUE_REFERENCE)) {
    if (insideUrl(text, match.index)) continue;
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      number: Number(match[1]),
    });
  }
  return tokens;
}
