import { describe, expect, it } from "vitest";
import { markdownTargetLine, markdownTargets } from "../markdownHeadingTargets";

const PLAN = [
  "# Plan", // 1
  "", // 2
  "- [Risks](#risks)", // 3
  "", // 4
  "## Risks", // 5
  "", // 6
  "```md", // 7
  "## Risks", // 8: inside a fence, not a heading
  "```", // 9
  "", // 10
  "Risks", // 11: a setext heading, the second "Risks"
  "-----", // 12
  "", // 13
  "### Use `slug()` [here](./x.md) &amp; now", // 14
  "", // 15
  "Claim.[^note]", // 16
  "", // 17
  "[^note]: The source.", // 18
].join("\n");

describe("markdownTargetLine (#17335)", () => {
  it("finds the heading a link names, numbering repeats as the rendered document does", () => {
    expect(markdownTargetLine(PLAN, "#plan")).toBe(1);
    expect(markdownTargetLine(PLAN, "#risks")).toBe(5);
    expect(markdownTargetLine(PLAN, "#risks-1")).toBe(11);
  });

  it("slugs the heading's rendered text, not its source", () => {
    expect(markdownTargetLine(PLAN, "#use-slug-here--now")).toBe(14);
  });

  it("never counts front matter, whose `#` lines are YAML comments (#17334)", () => {
    const source = ["---", "# Risks", "title: Plan", "---", "", "# Risks", "", "## Risks"];

    expect(markdownTargetLine(source.join("\n"), "#risks")).toBe(6);
    expect(markdownTargetLine(source.join("\n"), "#risks-1")).toBe(8);
    expect(markdownTargetLine(source.join("\r\n"), "#risks-1")).toBe(8);
    expect(markdownTargetLine(`\uFEFF${source.join("\n")}`, "#risks")).toBe(6);
    expect(markdownTargetLine(source.join("\n"), "#risks-2")).toBeNull();

    const toml = "+++\n# Risks\n+++\n\n## Risks\n\n## Risks\n";
    expect(markdownTargetLine(toml, "#risks")).toBe(5);
    expect(markdownTargetLine(toml, "#risks-1")).toBe(7);
  });

  it("takes a link written with the prefix, and footnotes by their ids", () => {
    expect(markdownTargetLine(PLAN, "#user-content-risks-1")).toBe(11);
    expect(markdownTargetLine(PLAN, "#user-content-fn-note")).toBe(18);
    expect(markdownTargetLine(PLAN, "#user-content-fnref-note")).toBe(16);
  });

  it("finds nothing for a missing, bare or differently cased fragment", () => {
    expect(markdownTargetLine(PLAN, "#nowhere")).toBeNull();
    expect(markdownTargetLine(PLAN, "#")).toBeNull();
    expect(markdownTargetLine(PLAN, "#Risks")).toBeNull();
    expect(markdownTargetLine(PLAN, "./other.md#risks")).toBeNull();
  });

  it("reads each source afresh", () => {
    expect(markdownTargetLine("## Risks\n", "#risks")).toBe(1);
    expect(markdownTargetLine("Intro.\n\n## Risks\n", "#risks")).toBe(3);
    expect(markdownTargetLine("## Other\n", "#risks")).toBeNull();
  });

  // GitHub's order: the prefixed reading first, so a heading that slugs to a
  // footnote's id outranks the footnote, in Edit mode as in Rendered.
  it("prefers a heading whose id is the fragment prefixed again", () => {
    const source = "## user-content-fn-note\n\nClaim.[^note]\n\n[^note]: Source.\n";
    expect(markdownTargetLine(source, "#user-content-fn-note")).toBe(1);
    expect(markdownTargetLine(source, "#user-content-fnref-note")).toBe(3);
  });

  // Two elements minting one id: the rendered document scrolls to the first.
  it("lands on the first element that carries an id", () => {
    const source = "## fn-note\n\nClaim.[^note]\n\n[^note]: Source.\n";
    expect(markdownTargetLine(source, "#user-content-fn-note")).toBe(1);
    expect(markdownTargetLine(source, "#user-content-fnref-note")).toBe(3);
  });

  it("counts lines the same in a CRLF document", () => {
    expect(markdownTargetLine(PLAN.replaceAll("\n", "\r\n"), "#risks-1")).toBe(11);
  });

  it("finds a non-ASCII heading by its encoded fragment, repeats included", () => {
    const source = "## Café\n\n## Café\n";
    expect(markdownTargetLine(source, "#caf%C3%A9")).toBe(1);
    expect(markdownTargetLine(source, "#café-1")).toBe(3);
    expect(markdownTargetLine(source, "#caf%C3%A9-1")).toBe(3);
  });

  it("lands a repeated footnote's back-links on each of its references", () => {
    const source = "Claim.[^é]\n\nAgain.[^é]\n\n[^é]: Source.\n";
    expect(markdownTargetLine(source, "#user-content-fnref-%C3%A9")).toBe(1);
    expect(markdownTargetLine(source, "#user-content-fnref-%C3%A9-2")).toBe(3);
    expect(markdownTargetLine(source, "#user-content-fn-%C3%A9")).toBe(5);
  });

  it("tries an encoded fragment decoded before it tries it as written", () => {
    // The heading's id is `user-content-fn-é`; the footnote's, `user-content-fn-%C3%A9`.
    const source = "## fn-é\n\nClaim.[^é]\n\n[^é]: Source.\n";
    expect(markdownTargetLine(source, "#user-content-fn-%C3%A9")).toBe(1);
  });
});

describe("markdownTargets (#17788)", () => {
  it("answers every link in its source from one parse, as each lookup alone would", () => {
    const source = ["---", "# Risks", "---", "", PLAN].join("\n");
    const hrefs = [
      "#plan",
      "#risks",
      "#risks-1",
      "#user-content-risks-1",
      "#use-slug-here--now",
      "#user-content-fn-note",
      "#user-content-fnref-note",
      "#nowhere",
      "#",
    ];
    const targets = markdownTargets(source);

    const lines = hrefs.map((href) => targets.lineOf(href));

    expect(lines).toEqual([5, 9, 15, 15, 18, 22, 20, null, null]);
    // Asked twice, an index answers the same: a lookup changes nothing in it.
    expect(hrefs.map((href) => targets.lineOf(href))).toEqual(lines);
  });

  it("keeps each source's answers in its own index", () => {
    const first = markdownTargets("## Risks\n");
    const second = markdownTargets("Intro.\n\n## Risks\n\n## Risks\n");

    expect(first.lineOf("#risks")).toBe(1);
    expect(first.lineOf("#risks-1")).toBeNull();
    expect(second.lineOf("#risks")).toBe(3);
    expect(second.lineOf("#risks-1")).toBe(5);
  });
});
