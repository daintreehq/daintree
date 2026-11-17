import { describe, expect, it } from "vitest";
import { markdownTargetLine } from "../markdownHeadingTargets";

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

  it("counts lines the same in a CRLF document", () => {
    expect(markdownTargetLine(PLAN.replaceAll("\n", "\r\n"), "#risks-1")).toBe(11);
  });
});
