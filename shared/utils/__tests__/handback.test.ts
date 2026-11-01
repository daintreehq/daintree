import { describe, expect, it } from "vitest";
import {
  appendHandbackInstruction,
  buildHandbackInstruction,
  isHandbackCode,
  mintHandbackCode,
  withoutHandbackInstruction,
} from "../handback.js";
import { HANDBACK_CODE_TOKEN } from "../../types/handback.js";

describe("buildHandbackInstruction", () => {
  const instruction = buildHandbackInstruction("k7f3qa");

  it("ends with the marker line for the minted code", () => {
    expect(instruction.endsWith("DAINTREE-DONE-k7f3qa: <summary> END-k7f3qa")).toBe(true);
  });

  it("carries the code in exactly one marker pair", () => {
    expect(instruction.match(/DAINTREE-DONE-k7f3qa/g)).toHaveLength(1);
    expect(instruction.match(/END-k7f3qa/g)).toHaveLength(1);
    expect(instruction).not.toContain(HANDBACK_CODE_TOKEN);
  });

  it("stays on one line, so a launch that flattens newlines keeps it intact", () => {
    expect(instruction).not.toMatch(/[\r\n]/);
  });

  it("starts both markers with a letter, so no TUI renders them as markup", () => {
    const markers = instruction.match(/\S*(?:DAINTREE-DONE|END)-k7f3qa/g) ?? [];
    expect(markers).toHaveLength(2);
    for (const marker of markers) expect(marker).toMatch(/^[A-Za-z]/);
  });
});

describe("buildHandbackInstruction for a scheduled run (#15982)", () => {
  const instruction = buildHandbackInstruction("k7f3qa", "run");

  it("offers both reports for the minted code, each with the echo placeholder", () => {
    expect(instruction).toContain("DAINTREE-DONE-k7f3qa: <summary> END-k7f3qa");
    expect(instruction).toContain("DAINTREE-NEEDS-YOU-k7f3qa: <summary> END-k7f3qa");
    expect(instruction).not.toContain(HANDBACK_CODE_TOKEN);
  });

  it("names the done marker first, as the ordinary instruction does", () => {
    expect(instruction.indexOf("DAINTREE-DONE-")).toBeLessThan(
      instruction.indexOf("DAINTREE-NEEDS-YOU-")
    );
    expect(instruction.indexOf("DAINTREE-DONE-")).toBe(
      instruction.indexOf("DAINTREE-") // no other marker comes before it
    );
  });

  it("stays on one line, with every marker starting with a letter", () => {
    expect(instruction).not.toMatch(/[\r\n]/);
    const markers = instruction.match(/\S*(?:DAINTREE-DONE|DAINTREE-NEEDS-YOU|END)-k7f3qa/g) ?? [];
    expect(markers).toHaveLength(4);
    for (const marker of markers) expect(marker).toMatch(/^[A-Za-z]/);
  });

  it("is only ever the run's: the default instruction offers done alone", () => {
    expect(buildHandbackInstruction("k7f3qa")).not.toContain("NEEDS-YOU");
  });
});

describe("appendHandbackInstruction", () => {
  it("appends the instruction after one blank line, as the last thing", () => {
    expect(appendHandbackInstruction("Fix the bug", "k7f3qa")).toBe(
      `Fix the bug\n\n${buildHandbackInstruction("k7f3qa")}`
    );
  });

  it("drops trailing line breaks so the gap stays one blank line", () => {
    expect(appendHandbackInstruction("Fix the bug\r\n\n", "k7f3qa")).toBe(
      `Fix the bug\n\n${buildHandbackInstruction("k7f3qa")}`
    );
  });

  it("leaves interior text untouched", () => {
    const text = "line one\n\n  indented line two  ";
    expect(appendHandbackInstruction(text, "k7f3qa").startsWith(`${text}\n\n`)).toBe(true);
  });
});

describe("withoutHandbackInstruction", () => {
  it("gives back the caller's text from what was submitted", () => {
    const text = "line one\n\n  indented line two  ";
    expect(withoutHandbackInstruction(appendHandbackInstruction(text, "k7f3qa"), "k7f3qa")).toBe(
      text
    );
  });

  it("gives back the caller's text from a scheduled run's launch prompt too", () => {
    const text = "Triage the new issues";
    expect(
      withoutHandbackInstruction(appendHandbackInstruction(text, "k7f3qa", "run"), "k7f3qa")
    ).toBe(text);
  });

  it("leaves text that doesn't end with this code's instruction as it is", () => {
    const other = appendHandbackInstruction("Fix the bug", "zzzzzz");
    expect(withoutHandbackInstruction(other, "k7f3qa")).toBe(other);
    expect(withoutHandbackInstruction("Fix the bug", "k7f3qa")).toBe("Fix the bug");
  });
});

describe("mintHandbackCode", () => {
  it("mints six characters from [a-z0-9]", () => {
    for (let i = 0; i < 200; i++) {
      const code = mintHandbackCode();
      expect(code).toMatch(/^[a-z0-9]{6}$/);
      expect(isHandbackCode(code)).toBe(true);
    }
  });

  it("mints a fresh code each time", () => {
    const codes = new Set(Array.from({ length: 200 }, () => mintHandbackCode()));
    expect(codes.size).toBe(200);
  });
});

describe("isHandbackCode", () => {
  it("rejects anything but six lowercase alphanumerics", () => {
    expect(isHandbackCode("K7F3QA")).toBe(false);
    expect(isHandbackCode("k7f3q")).toBe(false);
    expect(isHandbackCode("k7f3qa1")).toBe(false);
    expect(isHandbackCode("k7f-qa")).toBe(false);
    expect(isHandbackCode(123456)).toBe(false);
    expect(isHandbackCode(undefined)).toBe(false);
  });
});
