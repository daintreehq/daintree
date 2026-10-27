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

/**
 * Where URLs run in `text`: from each `://` to the whitespace that ends its
 * run, so a `#12` there (`?page=#12`) is part of the URL. One forward pass, so
 * a long pasted run costs no more than its length.
 */
function urlSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = text.indexOf("://");
  while (from !== -1) {
    let to = from + 3;
    while (to < text.length && !/\s/.test(text[to]!)) to++;
    spans.push([from, to]);
    from = text.indexOf("://", to);
  }
  return spans;
}

export function getAllIssueReferences(text: string): IssueReferenceToken[] {
  if (!text.includes("#")) return [];
  const urls = urlSpans(text);
  let url = 0;
  const tokens: IssueReferenceToken[] = [];
  for (const match of text.matchAll(ISSUE_REFERENCE)) {
    while (url < urls.length && urls[url]![1] <= match.index) url++;
    if (url < urls.length && urls[url]![0] < match.index) continue;
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      number: Number(match[1]),
    });
  }
  return tokens;
}
