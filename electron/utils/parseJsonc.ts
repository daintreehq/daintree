import { stripUtf8Bom } from "./stripUtf8Bom.js";

/**
 * Parses JSON with Comments, the format VS Code and the Dev Container spec use
 * for files like `devcontainer.json`: `//` and block comments plus trailing
 * commas before `}` or `]`. Strings are copied verbatim, so a URL's `//` or a
 * glob's `/*` survives. Anything else that is not JSON still throws.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(stripUtf8Bom(text))));
}

function stringEnd(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  // Leaves an unterminated string in place for JSON.parse to reject.
  return Math.min(j + 1, text.length);
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      // An unclosed comment is a broken file, not a comment to the end.
      if (end === -1) throw new SyntaxError("unterminated block comment");
      // Keeps tokens on either side apart: `1/**/2` must not become `12`.
      out += " ";
      i = end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let prev = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      prev = ch;
      i = end;
      continue;
    }
    // `{,}` and `[,]` have nothing for the comma to trail, so they stay invalid.
    if (ch === "," && prev !== "{" && prev !== "[" && prev !== ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out;
}
