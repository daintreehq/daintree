import { describe, test } from "vitest";
import { markdownTargetLine, markdownTargets } from "../markdownHeadingTargets";

// Following a same-document link in the Markdown editor (#17788). The first
// link on a document version parses it into an index; every later link on the
// same unchanged text is a lookup in that index. The document is the issue's
// shape: 600 headings, each over a paragraph with emphasis, a link and inline
// code, about 56,000 characters.
//
//   npx vitest bench --run src/components/Markdown/__bench__/markdownHeadingTargets.bench.ts

const SECTIONS = 600;

const source = Array.from(
  { length: SECTIONS },
  (_, i) =>
    `## Section ${i}\n\nThe *${i}th* step reads [the spec](./spec-${i}.md) and calls \`step${i}()\` once.\n`
).join("\n");

const href = `#section-${SECTIONS / 2}`;

describe(`following a link in a ${source.length.toLocaleString("en-US")}-character document`, () => {
  test("every link parses the document", async ({ bench }) => {
    await bench("every link parses the document", () => {
      markdownTargetLine(source, href);
    }).run();
  });
  test("first link on a version: parse and index", async ({ bench }) => {
    await bench("first link on a version: parse and index", () => {
      markdownTargets(source).lineOf(href);
    }).run();
  });
  const targets = markdownTargets(source);
  test("later links on the same version: index lookup", async ({ bench }) => {
    await bench("later links on the same version: index lookup", () => {
      targets.lineOf(href);
    }).run();
  });
});
